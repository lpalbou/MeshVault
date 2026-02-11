"""
Archive inspector module - discovers 3D assets inside ZIP and RAR archives.

Responsible for:
- Inspecting archive contents without full extraction
- Identifying 3D assets and their related files within archives
- Extracting specific files from archives for viewing
- Fallback extraction via subprocess (bsdtar, unrar, 7z, unar)
"""

import os
import logging
import zipfile
import tempfile
import shutil
import subprocess
from pathlib import Path, PurePosixPath
from typing import Optional

logger = logging.getLogger(__name__)

try:
    import rarfile
    HAS_RARFILE = True

    # Configure rarfile with the best available extraction tool.
    # Use shutil.which() for reliable detection (not subprocess).
    _rar_candidates = ["bsdtar", "unrar", "7z", "7za", "unar"]
    _rar_extra_paths = [
        "/opt/anaconda3/bin/bsdtar",
        str(Path.home() / "anaconda3/bin/bsdtar"),
        str(Path.home() / "miniconda3/bin/bsdtar"),
        "/opt/homebrew/bin/unrar",
        "/usr/local/bin/unrar",
        "/opt/homebrew/bin/7z",
        "/opt/homebrew/bin/unar",
    ]

    _rar_configured = False

    # Check PATH first
    for _cmd in _rar_candidates:
        _found = shutil.which(_cmd)
        if _found:
            rarfile.UNRAR_TOOL = _found
            try:
                rarfile.tool_setup()
                _rar_configured = True
                logger.info(f"RAR extraction configured with: {_found}")
            except Exception:
                continue
            break

    # Check common non-PATH locations
    if not _rar_configured:
        for _path in _rar_extra_paths:
            if os.path.isfile(_path) and os.access(_path, os.X_OK):
                rarfile.UNRAR_TOOL = _path
                try:
                    rarfile.tool_setup()
                    _rar_configured = True
                    logger.info(f"RAR extraction configured with: {_path}")
                except Exception:
                    continue
                break

    if not _rar_configured:
        logger.info("No RAR extraction tool found — RAR archives will be skipped")

except ImportError:
    HAS_RARFILE = False

from dataclasses import dataclass, field


# Supported 3D extensions (duplicated here to avoid circular imports)
SUPPORTED_3D_EXTENSIONS = {".obj", ".fbx", ".gltf", ".glb", ".stl"}

# Texture and related file extensions
RELATED_EXTENSIONS = {
    ".mtl",
    ".png",
    ".jpg",
    ".jpeg",
    ".tga",
    ".bmp",
    ".tiff",
    ".tif",
    ".webp",
}


@dataclass
class AssetInfo:
    """Represents a discovered 3D asset (mirrors file_browser.AssetInfo)."""
    name: str
    path: str
    extension: str
    size: int
    is_in_archive: bool = False
    archive_path: Optional[str] = None
    inner_path: Optional[str] = None
    related_files: list[str] = field(default_factory=list)


class ArchiveInspector:
    """Discovers 3D assets inside archives and extracts them for viewing."""

    def __init__(self):
        # Cache of temporary extraction directories: archive_path -> temp_dir
        self._temp_dirs: dict[str, str] = {}

    def inspect(self, archive_path: str) -> list[AssetInfo]:
        """
        Inspect an archive and return a list of 3D assets found inside.

        Args:
            archive_path: Path to the archive file.

        Returns:
            List of AssetInfo for each 3D asset found.
        """
        path = Path(archive_path)
        ext = path.suffix.lower()

        if ext == ".zip":
            return self._inspect_zip(archive_path)
        elif ext == ".rar":
            return self._inspect_rar(archive_path)
        elif ext == ".unitypackage":
            return self._inspect_unitypackage(archive_path)
        return []

    def extract_asset(
        self, archive_path: str, inner_path: str
    ) -> Optional[str]:
        """
        Extract a specific asset (and its related files) from an archive.

        Returns the path to the extracted file in a temporary directory.
        Tries multiple extraction methods for maximum compatibility.

        Args:
            archive_path: Path to the archive.
            inner_path: Path of the asset inside the archive.

        Returns:
            Path to the extracted file, or None if extraction fails.
        """
        path = Path(archive_path)
        ext = path.suffix.lower()

        if ext == ".zip":
            return self._extract_from_zip(archive_path, inner_path)
        elif ext == ".rar":
            return self._extract_from_rar(archive_path, inner_path)
        elif ext == ".unitypackage":
            return self._extract_from_unitypackage(archive_path, inner_path)
        return None

    def get_extracted_related_paths(
        self, archive_path: str, inner_related_files: list[str]
    ) -> list[str]:
        """
        Return absolute temp paths for related files that were extracted
        alongside the main asset.

        This maps archive-internal paths to their extracted filesystem paths.

        Args:
            archive_path: Path to the archive.
            inner_related_files: List of archive-internal paths for related files.

        Returns:
            List of absolute filesystem paths to the extracted related files.
            Only includes paths that actually exist on disk.
        """
        temp_dir = self._temp_dirs.get(archive_path)
        if not temp_dir:
            return []

        resolved = []
        for inner in inner_related_files:
            full = os.path.join(temp_dir, inner)
            if os.path.exists(full):
                resolved.append(full)
        return resolved

    def cleanup(self):
        """Remove all temporary extraction directories."""
        for temp_dir in self._temp_dirs.values():
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception:
                pass
        self._temp_dirs.clear()

    # ==========================================================
    # Inspection (list contents without extraction)
    # ==========================================================

    def _inspect_zip(self, archive_path: str) -> list[AssetInfo]:
        """Inspect a ZIP archive for 3D assets."""
        assets = []
        try:
            with zipfile.ZipFile(archive_path, "r") as zf:
                all_names = zf.namelist()
                for name in all_names:
                    inner_path = PurePosixPath(name)
                    ext = inner_path.suffix.lower()
                    if ext in SUPPORTED_3D_EXTENSIONS:
                        related = self._find_related_in_list(name, all_names)
                        info = zf.getinfo(name)
                        assets.append(AssetInfo(
                            name=inner_path.stem,
                            path=archive_path,
                            extension=ext,
                            size=info.file_size,
                            is_in_archive=True,
                            archive_path=archive_path,
                            inner_path=name,
                            related_files=related,
                        ))
        except (zipfile.BadZipFile, Exception) as e:
            logger.warning(f"Failed to inspect ZIP {archive_path}: {e}")
        return assets

    # ==========================================
    # Unity Package (.unitypackage) Support
    # ==========================================

    def _inspect_unitypackage(self, archive_path: str) -> list[AssetInfo]:
        """
        Inspect a .unitypackage file for 3D assets.

        Unity packages are gzipped tar archives with a specific structure:
        Each asset is stored in a GUID-named folder containing:
          - pathname  : text file with the original Unity project path
          - asset     : the actual file data
          - asset.meta: Unity import settings (ignored)

        We scan for 'pathname' entries, check if they reference supported
        3D formats, and build AssetInfo objects.
        """
        import tarfile

        assets = []
        try:
            with tarfile.open(archive_path, "r:gz") as tar:
                # First pass: build a map of GUID → pathname
                guid_to_path = {}
                guid_to_size = {}

                for member in tar.getmembers():
                    parts = member.name.split("/")
                    if len(parts) == 2 and parts[1] == "pathname":
                        try:
                            f = tar.extractfile(member)
                            if f:
                                pathname = f.read().decode("utf-8").strip()
                                guid = parts[0]
                                guid_to_path[guid] = pathname
                        except Exception:
                            pass
                    elif len(parts) == 2 and parts[1] == "asset":
                        guid = parts[0]
                        guid_to_size[guid] = member.size

                # Second pass: find 3D assets and their related files
                # Group by directory for related file detection
                all_files = {}
                for guid, pathname in guid_to_path.items():
                    ext = Path(pathname).suffix.lower()
                    all_files[pathname] = {
                        "guid": guid,
                        "ext": ext,
                        "size": guid_to_size.get(guid, 0),
                    }

                # Find related files for each 3D asset
                for pathname, info in all_files.items():
                    if info["ext"] not in SUPPORTED_3D_EXTENSIONS:
                        continue

                    name = Path(pathname).stem
                    parent = str(Path(pathname).parent)

                    # Find related files in the same directory
                    related = []
                    for other_path, other_info in all_files.items():
                        if other_path == pathname:
                            continue
                        if str(Path(other_path).parent) != parent:
                            continue
                        if other_info["ext"] in RELATED_EXTENSIONS:
                            related.append(other_path)

                    assets.append(AssetInfo(
                        name=name,
                        path=archive_path,
                        extension=info["ext"],
                        size=info["size"],
                        is_in_archive=True,
                        archive_path=archive_path,
                        inner_path=pathname,
                        related_files=related,
                    ))

        except Exception as e:
            logger.warning(f"Failed to inspect unitypackage {archive_path}: {e}")

        return assets

    def _extract_from_unitypackage(
        self, archive_path: str, inner_path: str
    ) -> Optional[str]:
        """
        Extract a specific asset from a .unitypackage file.

        Finds the GUID folder containing the target pathname,
        extracts the 'asset' file, and renames it to the original filename.
        Also extracts related files from the same directory.
        """
        import tarfile

        temp_dir = self._get_temp_dir(archive_path)

        try:
            with tarfile.open(archive_path, "r:gz") as tar:
                # Build GUID → pathname mapping
                guid_to_path = {}
                for member in tar.getmembers():
                    parts = member.name.split("/")
                    if len(parts) == 2 and parts[1] == "pathname":
                        try:
                            f = tar.extractfile(member)
                            if f:
                                pathname = f.read().decode("utf-8").strip()
                                guid_to_path[parts[0]] = pathname
                        except Exception:
                            pass

                # Reverse map: pathname → GUID
                path_to_guid = {v: k for k, v in guid_to_path.items()}

                # Find the target asset and extract it
                target_guid = path_to_guid.get(inner_path)
                if not target_guid:
                    logger.error(f"Asset not found in unitypackage: {inner_path}")
                    return None

                # Determine which GUIDs to extract (target + related in same dir)
                target_dir = str(Path(inner_path).parent)
                guids_to_extract = {}
                for guid, pathname in guid_to_path.items():
                    if guid == target_guid or str(Path(pathname).parent) == target_dir:
                        ext = Path(pathname).suffix.lower()
                        if ext in SUPPORTED_3D_EXTENSIONS or ext in RELATED_EXTENSIONS:
                            guids_to_extract[guid] = pathname

                # Extract each asset file
                extracted_main = None
                for member in tar.getmembers():
                    parts = member.name.split("/")
                    if len(parts) == 2 and parts[1] == "asset":
                        guid = parts[0]
                        if guid in guids_to_extract:
                            original_name = Path(guids_to_extract[guid]).name
                            output_path = Path(temp_dir) / original_name
                            try:
                                f = tar.extractfile(member)
                                if f:
                                    output_path.write_bytes(f.read())
                                    if guid == target_guid:
                                        extracted_main = str(output_path)
                            except Exception as e:
                                logger.warning(f"Failed to extract {original_name}: {e}")

                return extracted_main

        except Exception as e:
            logger.error(f"Failed to extract from unitypackage: {e}")
            return None

    def _inspect_rar(self, archive_path: str) -> list[AssetInfo]:
        """
        Inspect a RAR archive for 3D assets.

        Uses the rarfile library which is configured at import time
        to use the best available extraction tool (unrar, bsdtar, 7z, unar).
        """
        if not HAS_RARFILE:
            logger.warning("rarfile not available — RAR archives cannot be read")
            return []

        try:
            assets = []
            with rarfile.RarFile(archive_path, "r") as rf:
                all_names = rf.namelist()
                for name in all_names:
                    inner_path = PurePosixPath(name)
                    ext = inner_path.suffix.lower()
                    if ext in SUPPORTED_3D_EXTENSIONS:
                        related = self._find_related_in_list(name, all_names)
                        info = rf.getinfo(name)
                        assets.append(AssetInfo(
                            name=inner_path.stem,
                            path=archive_path,
                            extension=ext,
                            size=info.file_size,
                            is_in_archive=True,
                            archive_path=archive_path,
                            inner_path=name,
                            related_files=related,
                        ))
            return assets
        except Exception as e:
            logger.warning(f"RAR inspection failed for {archive_path}: {e}")
            return []

    # ==========================================================
    # Extraction
    # ==========================================================

    def _extract_from_zip(
        self, archive_path: str, inner_path: str
    ) -> Optional[str]:
        """Extract an asset and related files from a ZIP archive."""
        try:
            temp_dir = self._get_temp_dir(archive_path)

            with zipfile.ZipFile(archive_path, "r") as zf:
                # Extract the main asset
                zf.extract(inner_path, temp_dir)

                # Also extract related files
                all_names = zf.namelist()
                related = self._find_related_in_list(inner_path, all_names)
                for rel in related:
                    try:
                        zf.extract(rel, temp_dir)
                    except Exception:
                        pass

            return os.path.join(temp_dir, inner_path)
        except Exception as e:
            logger.error(f"ZIP extraction failed for {inner_path}: {e}")
            return None

    def _extract_from_rar(
        self, archive_path: str, inner_path: str
    ) -> Optional[str]:
        """
        Extract an asset and related files from a RAR archive.

        Strategy:
        1. Try rarfile library (which delegates to configured tool)
        2. If that fails, fall back to direct subprocess extraction
           (full archive extract — more reliable for problematic RARs)
        """
        if not HAS_RARFILE:
            logger.error("rarfile not available — cannot extract RAR")
            return None

        temp_dir = self._get_temp_dir(archive_path)
        target_path = os.path.join(temp_dir, inner_path)

        # Reuse if already extracted and non-empty
        if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
            return target_path

        # Clean up any empty file from a previous failed attempt
        if os.path.exists(target_path) and os.path.getsize(target_path) == 0:
            os.remove(target_path)

        # Strategy 1: Try rarfile library
        try:
            with rarfile.RarFile(archive_path, "r") as rf:
                rf.extract(inner_path, temp_dir)

                all_names = rf.namelist()
                related = self._find_related_in_list(inner_path, all_names)
                for rel in related:
                    try:
                        rf.extract(rel, temp_dir)
                    except Exception:
                        pass

            if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
                return target_path
            else:
                # rarfile created empty file — clean up and try CLI
                if os.path.exists(target_path):
                    os.remove(target_path)
                raise Exception("rarfile extracted 0-byte file")
        except Exception as e:
            logger.debug(f"rarfile extraction failed, trying direct CLI: {e}")

        # Strategy 2: Direct CLI extraction (full archive)
        # This is more reliable — extracts everything then we pick what we need
        tool = rarfile.UNRAR_TOOL
        if tool:
            try:
                tool_name = os.path.basename(tool)
                if "bsdtar" in tool_name:
                    cmd = [tool, "-xf", archive_path, "-C", temp_dir]
                elif "unrar" in tool_name:
                    cmd = [tool, "x", "-y", "-o+", archive_path, temp_dir + "/"]
                elif "7z" in tool_name:
                    cmd = [tool, "x", f"-o{temp_dir}", "-y", archive_path]
                elif "unar" in tool_name:
                    cmd = [tool, "-o", temp_dir, "-f", archive_path]
                else:
                    cmd = None

                if cmd:
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
                    if result.returncode == 0 and os.path.exists(target_path) and os.path.getsize(target_path) > 0:
                        logger.info(f"RAR extracted via direct CLI: {inner_path}")
                        return target_path
                    else:
                        logger.warning(f"CLI extraction returned {result.returncode}: {result.stderr[:200]}")
            except Exception as e:
                logger.error(f"Direct CLI RAR extraction failed: {e}")

        logger.error(f"All RAR extraction methods failed for {inner_path}")
        return None

    # ==========================================================
    # Utilities
    # ==========================================================

    def _get_temp_dir(self, archive_path: str) -> str:
        """Get or create a temporary directory for an archive."""
        if archive_path not in self._temp_dirs:
            self._temp_dirs[archive_path] = tempfile.mkdtemp(
                prefix="3d_browser_"
            )
        return self._temp_dirs[archive_path]

    def _find_related_in_list(
        self, asset_name: str, all_names: list[str]
    ) -> list[str]:
        """
        Find related files for a 3D asset within an archive's file list.

        Searches:
        1. Same directory (e.g., model.mtl next to model.obj)
        2. Common texture subdirectories (textures/, tex/, maps/)
        3. Any file in the archive whose name contains the asset stem
        """
        asset_path = PurePosixPath(asset_name)
        asset_stem = asset_path.stem.lower()
        asset_dir = str(asset_path.parent)

        # Common texture folder names for direct matching (nearby files)
        direct_texture_dirs = {
            "textures", "texture", "tex", "maps", "map",
            "materials", "material", "mat",
        }
        # Broader fallback directories used only when direct matching finds nothing
        fallback_texture_dirs = direct_texture_dirs | {
            "images", "image", "sourceimages", "sourceimage",
        }

        related = []
        seen = set()

        def add_related(name: str):
            if name not in seen:
                related.append(name)
                seen.add(name)

        for name in all_names:
            if name == asset_name:
                continue
            name_path = PurePosixPath(name)
            name_ext = name_path.suffix.lower()

            if name_ext not in RELATED_EXTENSIONS:
                continue

            name_dir = str(name_path.parent)
            name_stem = name_path.stem.lower()

            # 1. Same directory
            if name_dir == asset_dir:
                add_related(name)
                continue

            # 2. Known texture subdirectory (e.g., textures/diffuse.png)
            if asset_dir == ".":
                # Asset is at root — check if file is in a texture subfolder
                if name_dir.lower() in direct_texture_dirs:
                    add_related(name)
                    continue
            else:
                if name_dir.split("/")[-1].lower() in direct_texture_dirs:
                    add_related(name)
                    continue

            # 3. Filename matches the asset stem (strict prefix/token match).
            # Avoid loose substring matches like "asteroid_1" matching
            # "asteroid_10" or "asteroid_11".
            if (
                name_stem == asset_stem or
                name_stem.startswith(asset_stem + "_") or
                name_stem.startswith(asset_stem + "-") or
                name_stem.startswith(asset_stem + " ")
            ):
                add_related(name)

        # Fallback A:
        # If nothing matched directly, include files from common texture folders
        # anywhere in the archive (useful for packs with shared image banks).
        if not related:
            for name in all_names:
                if name == asset_name:
                    continue
                name_path = PurePosixPath(name)
                name_ext = name_path.suffix.lower()
                if name_ext not in RELATED_EXTENSIONS:
                    continue
                dir_parts = [p.lower() for p in name_path.parent.parts]
                if any(part in fallback_texture_dirs for part in dir_parts):
                    add_related(name)

        # Fallback B (FBX only):
        # Some FBX exports store material names without explicit texture links.
        # Provide a broader candidate pool so frontend can resolve by naming.
        if not related and asset_path.suffix.lower() == ".fbx":
            max_candidates = 200
            for name in all_names:
                if name == asset_name:
                    continue
                name_path = PurePosixPath(name)
                name_ext = name_path.suffix.lower()
                if name_ext in RELATED_EXTENSIONS and name_ext != ".mtl":
                    add_related(name)
                    if len(related) >= max_candidates:
                        break

        return related
