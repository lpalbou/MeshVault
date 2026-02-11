"""
FBX 6100 → OBJ converter.

Parses the FBX binary format (version < 7000) and extracts geometry data
to produce a Wavefront OBJ file that Three.js can load.

The FBX binary format stores data as a tree of nodes, each with typed
properties. Geometry lives in nodes like:
  - Vertices (float64 array: x,y,z,x,y,z,...)
  - PolygonVertexIndex (int32 array: indices, negative = polygon end)
  - Normals (float64 array, optional)
  - UV / UVIndex (float64/int32 arrays, optional)

This parser handles:
  - FBX binary format versions 5000-6100 (32-bit offsets)
  - Raw and zlib-compressed property arrays
  - Multiple geometry nodes (multi-mesh models)
"""

import struct
import zlib
import logging
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, BinaryIO

logger = logging.getLogger(__name__)

# FBX binary magic header
FBX_MAGIC = b"Kaydara FBX Binary  \x00"


@dataclass
class FBXProperty:
    """A single property value from an FBX node."""
    type_code: str
    value: object


@dataclass
class FBXNode:
    """A node in the FBX tree structure."""
    name: str
    properties: list[FBXProperty] = field(default_factory=list)
    children: list["FBXNode"] = field(default_factory=list)

    def find(self, name: str) -> Optional["FBXNode"]:
        """Find a direct child node by name."""
        for child in self.children:
            if child.name == name:
                return child
        return None

    def find_all(self, name: str) -> list["FBXNode"]:
        """Find all direct children with the given name."""
        return [c for c in self.children if c.name == name]

    def find_recursive(self, name: str) -> list["FBXNode"]:
        """Find all descendants with the given name (depth-first)."""
        results = []
        for child in self.children:
            if child.name == name:
                results.append(child)
            results.extend(child.find_recursive(name))
        return results


@dataclass
class GeometryData:
    """Extracted geometry from an FBX file."""
    vertices: list[float] = field(default_factory=list)   # [x,y,z, x,y,z, ...]
    indices: list[int] = field(default_factory=list)       # polygon vertex indices
    normals: list[float] = field(default_factory=list)     # [nx,ny,nz, ...]
    uvs: list[float] = field(default_factory=list)         # [u,v, u,v, ...]
    uv_indices: list[int] = field(default_factory=list)    # UV index mapping


def get_fbx_version(file_path: str) -> Optional[int]:
    """
    Read the FBX version from a file header.

    Handles both binary FBX (Kaydara header) and ASCII FBX (; FBX x.y.z).
    Returns the version number (e.g., 6100, 7400) or None if not a valid FBX.
    """
    try:
        with open(file_path, "rb") as f:
            header = f.read(27)

            # Binary FBX: starts with "Kaydara FBX Binary  \x00"
            if header[:21] == FBX_MAGIC:
                version = struct.unpack("<I", header[23:27])[0]
                return version

            # ASCII FBX: starts with "; FBX x.y.z project file"
            try:
                text = header.decode("ascii", errors="ignore")
                if text.startswith("; FBX"):
                    # Parse version from "; FBX 6.1.0 project file"
                    import re
                    match = re.search(r"FBX\s+(\d+)\.(\d+)", text)
                    if match:
                        major = int(match.group(1))
                        minor = int(match.group(2))
                        return major * 1000 + minor * 100
            except Exception:
                pass

        return None
    except Exception:
        return None


def is_ascii_fbx(file_path: str) -> bool:
    """Check if an FBX file is ASCII format (not binary)."""
    try:
        with open(file_path, "rb") as f:
            return f.read(5) == b"; FBX"
    except Exception:
        return False


def convert_fbx_to_obj(fbx_path: str, obj_path: str) -> bool:
    """
    Convert an FBX file (version < 7000, binary or ASCII) to Wavefront OBJ.

    Args:
        fbx_path: Path to the input FBX file.
        obj_path: Path to write the output OBJ file.

    Returns:
        True if conversion succeeded, False otherwise.
    """
    try:
        # Handle ASCII FBX separately
        if is_ascii_fbx(fbx_path):
            return _convert_ascii_fbx_to_obj(fbx_path, obj_path)

        version = get_fbx_version(fbx_path)
        if version is None:
            logger.error(f"Not a valid FBX file: {fbx_path}")
            return False

        logger.info(f"Parsing FBX binary version {version}: {fbx_path}")

        # Parse the FBX tree
        root = _parse_fbx_binary(fbx_path, version)
        if root is None:
            return False

        # Extract geometry data from the tree
        geometries = _extract_geometries(root)
        if not geometries:
            logger.error("No geometry found in FBX file")
            return False

        logger.info(f"Found {len(geometries)} geometry/geometries")

        # Write OBJ file
        _write_obj(geometries, obj_path)
        logger.info(f"Converted to OBJ: {obj_path}")
        return True

    except Exception as e:
        logger.error(f"FBX conversion failed: {e}", exc_info=True)
        return False


# ========================================
# Binary FBX Parser
# ========================================

def _parse_fbx_binary(file_path: str, version: int) -> Optional[FBXNode]:
    """Parse a binary FBX file into a node tree."""
    try:
        with open(file_path, "rb") as f:
            # Skip header: 21 (magic) + 2 (padding) + 4 (version) = 27 bytes
            f.read(27)

            root = FBXNode(name="__root__")

            # For versions < 7500, offsets are 32-bit
            # For versions >= 7500, offsets are 64-bit
            use_64bit = version >= 7500

            while True:
                node = _read_node(f, version, use_64bit)
                if node is None:
                    break
                root.children.append(node)

            return root
    except Exception as e:
        logger.error(f"FBX parse error: {e}")
        return None


def _read_node(f: BinaryIO, version: int, use_64bit: bool) -> Optional[FBXNode]:
    """Read a single FBX node record."""
    if use_64bit:
        data = f.read(25)  # 8+8+8+1
        if len(data) < 25:
            return None
        end_offset, num_props, prop_list_len = struct.unpack("<QQQ", data[:24])
        name_len = data[24]
    else:
        data = f.read(13)  # 4+4+4+1
        if len(data) < 13:
            return None
        end_offset, num_props, prop_list_len = struct.unpack("<III", data[:12])
        name_len = data[12]

    # Null node sentinel (all zeros)
    if end_offset == 0:
        return None

    name_bytes = f.read(name_len)
    name = name_bytes.decode("ascii", errors="replace")

    node = FBXNode(name=name)

    # Read properties
    for _ in range(num_props):
        prop = _read_property(f)
        if prop is not None:
            node.properties.append(prop)

    # Read child nodes (everything until end_offset)
    while f.tell() < end_offset:
        child = _read_node(f, version, use_64bit)
        if child is None:
            # Null sentinel or end of children
            break
        node.children.append(child)

    # Ensure we're at the right position
    if f.tell() != end_offset:
        f.seek(end_offset)

    return node


def _read_property(f: BinaryIO) -> Optional[FBXProperty]:
    """Read a single FBX property value."""
    type_code_byte = f.read(1)
    if not type_code_byte:
        return None

    tc = chr(type_code_byte[0])

    # Scalar types
    if tc == "Y":  # int16
        val = struct.unpack("<h", f.read(2))[0]
    elif tc == "C":  # bool (1 byte)
        val = struct.unpack("<?", f.read(1))[0]
    elif tc == "I":  # int32
        val = struct.unpack("<i", f.read(4))[0]
    elif tc == "F":  # float32
        val = struct.unpack("<f", f.read(4))[0]
    elif tc == "D":  # float64
        val = struct.unpack("<d", f.read(8))[0]
    elif tc == "L":  # int64
        val = struct.unpack("<q", f.read(8))[0]

    # Array types
    elif tc == "f":  # float32 array
        val = _read_array(f, "<f", 4)
    elif tc == "d":  # float64 array
        val = _read_array(f, "<d", 8)
    elif tc == "i":  # int32 array
        val = _read_array(f, "<i", 4)
    elif tc == "l":  # int64 array
        val = _read_array(f, "<q", 8)
    elif tc == "b":  # bool array
        val = _read_array(f, "<?", 1)

    # String and raw data
    elif tc == "S":  # string
        length = struct.unpack("<I", f.read(4))[0]
        val = f.read(length).decode("utf-8", errors="replace")
    elif tc == "R":  # raw bytes
        length = struct.unpack("<I", f.read(4))[0]
        val = f.read(length)

    else:
        logger.warning(f"Unknown FBX property type: {tc}")
        return None

    return FBXProperty(type_code=tc, value=val)


def _read_array(f: BinaryIO, fmt: str, elem_size: int) -> list:
    """
    Read an FBX array property.

    Arrays can be raw or zlib-compressed.
    """
    header = f.read(12)
    if len(header) < 12:
        return []

    array_length, encoding, compressed_length = struct.unpack("<III", header)

    if encoding == 0:
        # Raw data
        raw = f.read(array_length * elem_size)
    elif encoding == 1:
        # Zlib compressed
        compressed = f.read(compressed_length)
        try:
            raw = zlib.decompress(compressed)
        except zlib.error:
            logger.warning("Failed to decompress FBX array data")
            return []
    else:
        logger.warning(f"Unknown FBX array encoding: {encoding}")
        f.read(compressed_length)
        return []

    # Unpack the array
    count = len(raw) // elem_size
    if count != array_length:
        # Use actual data length, be flexible
        count = min(count, array_length)

    return list(struct.unpack(f"<{count}{fmt[1]}", raw[:count * elem_size]))


# ========================================
# Geometry Extraction
# ========================================

def _extract_geometries(root: FBXNode) -> list[GeometryData]:
    """
    Extract all geometry data from the FBX node tree.

    Searches for Vertices and PolygonVertexIndex nodes,
    which contain the mesh data regardless of FBX version.
    """
    geometries = []

    # Strategy 1: Look for Geometry nodes in the Objects section
    objects_node = root.find("Objects")
    if objects_node:
        # In FBX 6100, geometry can be under Model nodes directly
        # In FBX 7000+, it's in separate Geometry nodes
        geom_nodes = objects_node.find_recursive("Vertices")
        processed_parents = set()

        for verts_node in geom_nodes:
            # Walk up to find the parent that has both Vertices and PolygonVertexIndex
            # (the verts_node IS the Vertices node, its parent has PolygonVertexIndex)
            pass

    # Strategy 2: Recursive search for Vertices + PolygonVertexIndex pairs
    # This is more robust and works across FBX versions
    _find_geometry_pairs(root, geometries)

    return geometries


def _extract_property_values(node: FBXNode, cast_fn=float) -> list:
    """
    Extract numeric values from an FBX node's properties.

    Handles two storage formats:
    - FBX 7000+: single array property (type 'd', 'f', 'i', 'l')
    - FBX 6100:  many individual scalar properties (type 'D', 'F', 'I', 'L')
    """
    if not node or not node.properties:
        return []

    first = node.properties[0]

    # Array property (FBX 7000+ style)
    if isinstance(first.value, list):
        return [cast_fn(v) for v in first.value]

    # Individual scalar properties (FBX 6100 style)
    return [cast_fn(p.value) for p in node.properties
            if isinstance(p.value, (int, float))]


def _find_geometry_pairs(node: FBXNode, geometries: list[GeometryData]):
    """
    Recursively find nodes that contain both Vertices and PolygonVertexIndex
    children, and extract geometry from them.

    Handles both FBX 6100 (scalar properties) and FBX 7000+ (array properties).
    """
    verts_node = node.find("Vertices")
    indices_node = node.find("PolygonVertexIndex")

    if verts_node and indices_node:
        geo = GeometryData()

        # Extract vertices (float values: x,y,z,x,y,z,...)
        geo.vertices = _extract_property_values(verts_node, float)

        # Extract polygon indices (int values)
        geo.indices = _extract_property_values(indices_node, int)

        # Extract normals (optional)
        normals_layer = node.find("LayerElementNormal")
        if normals_layer:
            normals_node = normals_layer.find("Normals")
            geo.normals = _extract_property_values(normals_node, float)

        # Extract UVs (optional)
        uv_layer = node.find("LayerElementUV")
        if uv_layer:
            uv_node = uv_layer.find("UV")
            geo.uvs = _extract_property_values(uv_node, float)

            uvi_node = uv_layer.find("UVIndex")
            geo.uv_indices = _extract_property_values(uvi_node, int)

        if geo.vertices and geo.indices:
            geometries.append(geo)
    else:
        # Recurse into children
        for child in node.children:
            _find_geometry_pairs(child, geometries)


# ========================================
# OBJ Writer
# ========================================

def _write_obj(geometries: list[GeometryData], obj_path: str):
    """
    Write geometry data to a Wavefront OBJ file.

    FBX uses a polygon index scheme where negative values indicate
    the last vertex of a polygon: actual_index = ~negative_value (bitwise NOT).
    """
    path = Path(obj_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    vertex_offset = 0
    normal_offset = 0
    uv_offset = 0

    with open(obj_path, "w") as f:
        f.write(f"# Converted from FBX by MeshVault\n")
        f.write(f"# Geometries: {len(geometries)}\n\n")

        for gi, geo in enumerate(geometries):
            if len(geometries) > 1:
                f.write(f"o Mesh_{gi}\n")

            # Write vertices
            num_verts = len(geo.vertices) // 3
            for i in range(num_verts):
                x = geo.vertices[i * 3]
                y = geo.vertices[i * 3 + 1]
                z = geo.vertices[i * 3 + 2]
                f.write(f"v {x:.6f} {y:.6f} {z:.6f}\n")

            # Write normals (if per-vertex or per-polygon-vertex)
            has_normals = len(geo.normals) > 0
            if has_normals:
                num_normals = len(geo.normals) // 3
                for i in range(num_normals):
                    nx = geo.normals[i * 3]
                    ny = geo.normals[i * 3 + 1]
                    nz = geo.normals[i * 3 + 2]
                    f.write(f"vn {nx:.6f} {ny:.6f} {nz:.6f}\n")

            # Write UVs
            has_uvs = len(geo.uvs) > 0
            if has_uvs:
                num_uvs = len(geo.uvs) // 2
                for i in range(num_uvs):
                    u = geo.uvs[i * 2]
                    v = geo.uvs[i * 2 + 1]
                    f.write(f"vt {u:.6f} {v:.6f}\n")

            # Write faces
            # FBX polygon indices: positive = vertex index, negative = last vertex
            # of polygon (actual index = ~value, i.e. bitwise NOT)
            f.write(f"\n")

            polygon = []
            normal_idx = 0  # Running index for per-polygon-vertex normals

            for raw_idx in geo.indices:
                if raw_idx < 0:
                    # Last vertex of this polygon
                    actual = ~raw_idx
                    polygon.append((actual, normal_idx))
                    normal_idx += 1

                    # Write the face
                    face_parts = []
                    for vi, ni in polygon:
                        # OBJ indices are 1-based
                        v_idx = vi + 1 + vertex_offset

                        if has_normals and has_uvs and geo.uv_indices:
                            # v/vt/vn
                            uv_i = geo.uv_indices[ni - len(polygon) + polygon.index((vi, ni))] if ni < len(geo.uv_indices) else 0
                            n_idx = ni + 1 + normal_offset
                            uv_idx = uv_i + 1 + uv_offset
                            face_parts.append(f"{v_idx}/{uv_idx}/{n_idx}")
                        elif has_normals:
                            # v//vn
                            n_idx = ni + 1 + normal_offset
                            face_parts.append(f"{v_idx}//{n_idx}")
                        else:
                            face_parts.append(f"{v_idx}")

                    f.write(f"f {' '.join(face_parts)}\n")
                    polygon = []
                else:
                    polygon.append((raw_idx, normal_idx))
                    normal_idx += 1

            # Update offsets for next geometry
            vertex_offset += num_verts
            if has_normals:
                normal_offset += len(geo.normals) // 3
            if has_uvs:
                uv_offset += len(geo.uvs) // 2

            f.write(f"\n")

    total_verts = sum(len(g.vertices) // 3 for g in geometries)
    total_faces = sum(
        sum(1 for idx in g.indices if idx < 0) for g in geometries
    )
    logger.info(f"OBJ written: {total_verts} vertices, {total_faces} faces")


# =============================================================
# ASCII FBX Parser (for FBX 6.x text format)
# =============================================================

def _convert_ascii_fbx_to_obj(fbx_path: str, obj_path: str) -> bool:
    """
    Convert an ASCII FBX file to Wavefront OBJ format.

    ASCII FBX 6.x stores geometry in a text tree structure.
    Vertices are in "Vertices:" arrays, faces in "PolygonVertexIndex:".
    """
    import re

    logger.info(f"Parsing ASCII FBX: {fbx_path}")

    try:
        with open(fbx_path, "r", errors="replace") as f:
            content = f.read()

        # Extract all Vertices blocks
        all_vertices = []
        all_indices = []

        # Find Vertices: x,y,z,x,y,z,...
        vert_pattern = re.compile(
            r"Vertices:\s*([\d\s.,eE+-]+?)(?=\n\s*\w|\n\s*})",
            re.DOTALL
        )
        idx_pattern = re.compile(
            r"PolygonVertexIndex:\s*([\d\s.,eE+-]+?)(?=\n\s*\w|\n\s*})",
            re.DOTALL
        )
        normal_pattern = re.compile(
            r"Normals:\s*([\d\s.,eE+-]+?)(?=\n\s*\w|\n\s*})",
            re.DOTALL
        )

        vert_matches = vert_pattern.findall(content)
        idx_matches = idx_pattern.findall(content)
        normal_matches = normal_pattern.findall(content)

        if not vert_matches:
            logger.error("No vertices found in ASCII FBX")
            return False

        # Parse all geometry blocks
        geometries = []
        for i, vert_text in enumerate(vert_matches):
            # Parse vertices
            nums = [float(x) for x in re.findall(r'[+-]?\d+\.?\d*(?:[eE][+-]?\d+)?', vert_text)]
            vertices = nums

            # Parse indices
            indices = []
            if i < len(idx_matches):
                indices = [int(x) for x in re.findall(r'-?\d+', idx_matches[i])]

            # Parse normals (optional)
            normals = []
            if i < len(normal_matches):
                normals = [float(x) for x in re.findall(r'[+-]?\d+\.?\d*(?:[eE][+-]?\d+)?', normal_matches[i])]

            if vertices and indices:
                geometries.append({
                    "vertices": vertices,
                    "indices": indices,
                    "normals": normals,
                })

        if not geometries:
            logger.error("No usable geometry found in ASCII FBX")
            return False

        # Write OBJ
        with open(obj_path, "w") as f:
            f.write(f"# Converted from ASCII FBX by MeshVault\n")
            f.write(f"# Geometries: {len(geometries)}\n\n")

            vertex_offset = 0
            normal_offset = 0

            for gi, geo in enumerate(geometries):
                verts = geo["vertices"]
                indices = geo["indices"]
                normals = geo["normals"]
                num_verts = len(verts) // 3
                has_normals = len(normals) >= 3

                f.write(f"o Mesh_{gi}\n")

                # Write vertices
                for vi in range(num_verts):
                    x = verts[vi * 3]
                    y = verts[vi * 3 + 1]
                    z = verts[vi * 3 + 2]
                    f.write(f"v {x} {y} {z}\n")

                # Write normals
                if has_normals:
                    num_normals = len(normals) // 3
                    for ni in range(num_normals):
                        f.write(f"vn {normals[ni*3]} {normals[ni*3+1]} {normals[ni*3+2]}\n")

                # Write faces from PolygonVertexIndex
                # Negative index = end of polygon (bitwise NOT to get actual index)
                polygon = []
                normal_idx = 0
                for raw_idx in indices:
                    if raw_idx < 0:
                        actual_idx = ~raw_idx
                        polygon.append(actual_idx)
                        # Write the face
                        face_parts = []
                        for vi in polygon:
                            v = vi + 1 + vertex_offset
                            if has_normals and normal_idx < len(normals) // 3:
                                n = normal_idx + 1 + normal_offset
                                face_parts.append(f"{v}//{n}")
                                normal_idx += 1
                            else:
                                face_parts.append(str(v))
                                normal_idx += 1
                        f.write(f"f {' '.join(face_parts)}\n")
                        polygon = []
                    else:
                        polygon.append(raw_idx)

                vertex_offset += num_verts
                if has_normals:
                    normal_offset += len(normals) // 3
                f.write("\n")

        total_v = sum(len(g["vertices"]) // 3 for g in geometries)
        logger.info(f"ASCII FBX → OBJ: {total_v} vertices written to {obj_path}")
        return True

    except Exception as e:
        logger.error(f"ASCII FBX conversion failed: {e}")
        return False
