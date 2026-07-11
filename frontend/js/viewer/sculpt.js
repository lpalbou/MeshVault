/**
 * Sculpting + texture painting for AI agents (backlog 045).
 *
 * Design constraints (agent-first, shaped by adversarial review):
 * - WORLD-SPACE brushes: falloff on world-space vertex positions (correct under
 *   any wrapper placement/scale, incl. non-uniform); displaced world positions
 *   map back through each mesh's inverse world matrix (position-space transform
 *   preserves magnitudes — no direction-normalization trap).
 * - WELDED vertices: displacements are computed once per canonical POSITION and
 *   written to every duplicate, so UV/normal seams never tear (inflate/smooth on
 *   raw per-vertex normals would split every textured mesh at its seams).
 * - SHARED-GEOMETRY dedup: glTF instancing reuses one BufferGeometry across
 *   meshes — every stamp touches each geometry exactly once (else double
 *   displacement). Sculpting a shared geometry edits all its instances.
 * - Normals/bounds recomputed once per COMMAND, not per stamp (a 64-stamp stroke
 *   must not pay 64 normal recomputes + renders).
 * - Deterministic, in-place position mutation (reset-to-snapshot stays the undo),
 *   token-bounded returns.
 */

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const FALLOFFS = {
    // t = distance / radius in [0, 1] → weight in [0, 1]
    smooth: (t) => (1 - t * t) * (1 - t * t),          // C1 dome (default)
    linear: (t) => 1 - t,
    sharp: (t) => (1 - t) * (1 - t),
};

/** Meshes of the ACTIVE object (sculpt/paint targets). */
function activeMeshes(viewer) {
    const model = viewer._currentModel;
    if (!model) throw new Error("No model loaded. load / add_model / add_primitive first.");
    const meshes = [];
    model.traverse((c) => { if (c.isMesh && c.geometry) meshes.push(c); });
    if (meshes.length === 0) throw new Error("Active object has no meshes.");
    return meshes;
}

function assertNotSkinned(viewer) {
    const entry = viewer._activeEntry();
    if (entry && entry.skinned) {
        throw new Error(
            "Sculpting/painting skinned (rigged) models is not supported — vertex "
            + "edits corrupt the bind pose. Use set_object_transform to place it, "
            + "or sculpt a primitive/static mesh instead.");
    }
}

/**
 * Prepare a geometry for in-place vertex mutation: dequantize (KHR quantization)
 * and de-interleave position/normal so our writes own their buffers. The entry's
 * reset snapshot stays valid — it stores accessor-DECODED floats and restores via
 * setXYZ (layout-independent).
 */
function ensureMutable(geometry) {
    for (const name of ["position", "normal"]) {
        const attr = geometry.getAttribute(name);
        if (!attr) continue;
        if (attr.isInterleavedBufferAttribute || attr.normalized
            || !(attr.array instanceof Float32Array)) {
            const out = new Float32Array(attr.count * attr.itemSize);
            for (let i = 0; i < attr.count; i++) {
                out[i * attr.itemSize] = attr.getX(i);
                if (attr.itemSize > 1) out[i * attr.itemSize + 1] = attr.getY(i);
                if (attr.itemSize > 2) out[i * attr.itemSize + 2] = attr.getZ(i);
            }
            geometry.setAttribute(name, new THREE.BufferAttribute(out, attr.itemSize));
        }
    }
}

/**
 * Weld map + adjacency for a geometry (cached on geometry.userData._mvSculpt).
 * canonical[i] = canonical vertex id for vertex i (same quantized position);
 * members: canonical id → all duplicate indices; neighbors: canonical id →
 * Set of canonical ids linked by triangle edges. Connectivity never changes
 * during sculpting (positions move together per weld), so the cache lives until
 * the geometry object is replaced (simplify/recompute retake snapshots anyway).
 */
function getWeld(geometry) {
    if (geometry.userData._mvSculpt) return geometry.userData._mvSculpt;
    const pos = geometry.getAttribute("position");
    geometry.computeBoundingBox();
    const diag = geometry.boundingBox
        ? geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1 : 1;
    const quant = diag * 1e-6;
    const byKey = new Map();
    const canonical = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
        const k = `${Math.round(pos.getX(i) / quant)}_${Math.round(pos.getY(i) / quant)}_${Math.round(pos.getZ(i) / quant)}`;
        const seen = byKey.get(k);
        if (seen !== undefined) canonical[i] = seen;
        else { byKey.set(k, i); canonical[i] = i; }
    }
    const members = new Map();
    for (let i = 0; i < pos.count; i++) {
        const c = canonical[i];
        let list = members.get(c);
        if (!list) { list = []; members.set(c, list); }
        list.push(i);
    }
    const neighbors = new Map();
    const index = geometry.getIndex();
    const triCount = Math.floor(index ? index.count / 3 : pos.count / 3);
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const link = (a, b) => {
        if (a === b) return;
        let s = neighbors.get(a);
        if (!s) { s = new Set(); neighbors.set(a, s); }
        s.add(b);
    };
    for (let t = 0; t < triCount; t++) {
        const a = canonical[idxOf(t, 0)], b = canonical[idxOf(t, 1)], c = canonical[idxOf(t, 2)];
        link(a, b); link(b, a); link(b, c); link(c, b); link(a, c); link(c, a);
    }
    const weld = { canonical, members, neighbors };
    geometry.userData._mvSculpt = weld;
    return weld;
}

/** Affected canonical welds of one mesh: {c, world, w} within the brush. */
function gatherWelds(mesh, weld, centerWorld, radius, falloffFn) {
    const pos = mesh.geometry.getAttribute("position");
    const m = mesh.matrixWorld;
    const v = new THREE.Vector3();
    const hits = [];
    const r2 = radius * radius;
    for (const [c] of weld.members) {
        v.fromBufferAttribute(pos, c).applyMatrix4(m);
        const d2 = v.distanceToSquared(centerWorld);
        if (d2 > r2) continue;
        hits.push({ c, world: v.clone(), w: falloffFn(Math.sqrt(d2) / radius) });
    }
    return hits;
}

/** Area-weighted average world normal over affected welds (duplicates averaged). */
function averageWorldNormal(mesh, weld, hits) {
    if (!mesh.geometry.getAttribute("normal")) mesh.geometry.computeVertexNormals();
    const nAttr = mesh.geometry.getAttribute("normal");
    const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const n = new THREE.Vector3();
    const acc = new THREE.Vector3();
    for (const h of hits) {
        n.set(0, 0, 0);
        for (const i of weld.members.get(h.c)) {
            n.x += nAttr.getX(i); n.y += nAttr.getY(i); n.z += nAttr.getZ(i);
        }
        n.applyMatrix3(nm);
        if (n.lengthSq() > 1e-12) acc.addScaledVector(n.normalize(), h.w);
    }
    return acc.lengthSq() > 1e-12 ? acc.normalize() : new THREE.Vector3(0, 1, 0);
}

/** World normal of one weld (duplicates averaged). */
function weldWorldNormal(mesh, weld, c, nm, out) {
    const nAttr = mesh.geometry.getAttribute("normal");
    out.set(0, 0, 0);
    for (const i of weld.members.get(c)) {
        out.x += nAttr.getX(i); out.y += nAttr.getY(i); out.z += nAttr.getZ(i);
    }
    out.applyMatrix3(nm);
    return out.lengthSq() > 1e-12 ? out.normalize() : out.set(0, 1, 0);
}

/** Write a displaced WORLD position back to all duplicates of a weld. */
function writeWeldWorld(mesh, weld, c, worldPos, inv, tmp) {
    const pos = mesh.geometry.getAttribute("position");
    tmp.copy(worldPos).applyMatrix4(inv);
    for (const i of weld.members.get(c)) {
        pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
    }
}

// ---------------------------------------------------------------------------
// Sculpt
// ---------------------------------------------------------------------------

/** One brush stamp on one mesh geometry. Returns affected weld count. */
function stampGeometry(viewer, mesh, opts, stats) {
    const geometry = mesh.geometry;
    ensureMutable(geometry);
    const weld = getWeld(geometry);
    const falloffFn = FALLOFFS[opts.falloff || "smooth"];
    const center = opts._centerV;
    const hits = gatherWelds(mesh, weld, center, opts.radius, falloffFn);
    if (hits.length === 0) return 0;

    const tool = opts.tool || "draw";
    const strength = opts.strength !== undefined ? opts.strength : (
        tool === "smooth" || tool === "flatten" || tool === "pinch"
            ? 0.5 : opts.radius * 0.25);
    const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
    const tmp = new THREE.Vector3();
    const pos = geometry.getAttribute("position");

    if (tool === "draw" || tool === "grab") {
        const dir = opts.direction
            ? new THREE.Vector3(...opts.direction).normalize()
            : (tool === "draw" ? averageWorldNormal(mesh, weld, hits)
                               : new THREE.Vector3(0, 1, 0));
        for (const h of hits) {
            const d = strength * h.w;
            stats.maxDisplacement = Math.max(stats.maxDisplacement, Math.abs(d));
            writeWeldWorld(mesh, weld, h.c, h.world.addScaledVector(dir, d), inv, tmp);
        }
    } else if (tool === "inflate") {
        const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
        const n = new THREE.Vector3();
        for (const h of hits) {
            weldWorldNormal(mesh, weld, h.c, nm, n);
            const d = strength * h.w;
            stats.maxDisplacement = Math.max(stats.maxDisplacement, Math.abs(d));
            writeWeldWorld(mesh, weld, h.c, h.world.addScaledVector(n, d), inv, tmp);
        }
    } else if (tool === "smooth") {
        const m = mesh.matrixWorld;
        const nb = new THREE.Vector3();
        const lambda = Math.min(0.5, 0.5 * strength);
        const moves = [];
        for (const h of hits) {
            const ns = weld.neighbors.get(h.c);
            if (!ns || ns.size === 0) continue;
            nb.set(0, 0, 0);
            for (const other of ns) {
                nb.add(tmp.fromBufferAttribute(pos, other).applyMatrix4(m));
            }
            nb.divideScalar(ns.size);
            const target = h.world.clone().lerp(nb, lambda * h.w);
            moves.push([h.c, target, target.distanceTo(h.world)]);
        }
        for (const [c, target, d] of moves) {
            stats.maxDisplacement = Math.max(stats.maxDisplacement, d);
            writeWeldWorld(mesh, weld, c, target, inv, tmp);
        }
    } else if (tool === "flatten") {
        const planeNormal = opts.direction
            ? new THREE.Vector3(...opts.direction).normalize()
            : averageWorldNormal(mesh, weld, hits);
        const centroid = new THREE.Vector3();
        let wSum = 0;
        for (const h of hits) { centroid.addScaledVector(h.world, h.w); wSum += h.w; }
        centroid.divideScalar(Math.max(1e-9, wSum));
        for (const h of hits) {
            const dist = tmp.copy(h.world).sub(centroid).dot(planeNormal);
            const target = h.world.clone().addScaledVector(planeNormal, -dist);
            const blended = h.world.clone().lerp(target, strength * h.w);
            stats.maxDisplacement = Math.max(stats.maxDisplacement, blended.distanceTo(h.world));
            writeWeldWorld(mesh, weld, h.c, blended, inv, tmp);
        }
    } else if (tool === "pinch") {
        for (const h of hits) {
            const blended = h.world.clone().lerp(center, strength * h.w * 0.5);
            stats.maxDisplacement = Math.max(stats.maxDisplacement, blended.distanceTo(h.world));
            writeWeldWorld(mesh, weld, h.c, blended, inv, tmp);
        }
    } else {
        throw new Error(`Unknown tool '${tool}'. Use draw|inflate|smooth|flatten|pinch|grab.`);
    }
    return hits.length;
}

/** Finalize geometries once per COMMAND: normals, bounds, stats, repaint. */
function finalizeSculpt(viewer, touchedGeometries) {
    for (const geometry of touchedGeometries) {
        geometry.getAttribute("position").needsUpdate = true;
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
    }
    const entry = viewer._activeEntry();
    if (entry) {
        entry.modified = true;
        entry.sculpted = true;   // precise audit trail: geometry was edited
        entry.stats = viewer._computeStats(entry.model);
        viewer._lastStats = entry.stats;
    }
    viewer.invalidate();
}

/**
 * Resolve the brush radius: absolute `radius` (world units) or `radius_rel`
 * (fraction of the ACTIVE object's bounding-sphere radius — scale-free, so an
 * agent needn't know if the model is 2 units or 2000).
 */
function resolveRadius(viewer, opts, command) {
    if (opts.radius > 0) return opts.radius;
    if (opts.radius_rel > 0) {
        const model = viewer._currentModel;
        const box = new THREE.Box3().setFromObject(model);
        const sphereR = box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length() / 2;
        if (sphereR > 0) return opts.radius_rel * sphereR;
    }
    throw new Error(
        `${command} requires radius > 0 (world units) or radius_rel > 0 `
        + "(fraction of the active object's bounding-sphere radius).");
}

function applyStamps(viewer, opts, points) {
    assertNotSkinned(viewer);
    const meshes = activeMeshes(viewer);
    opts.radius = resolveRadius(viewer, opts, "sculpt");
    if (!FALLOFFS[opts.falloff || "smooth"]) {
        throw new Error(`Unknown falloff '${opts.falloff}'. Use smooth|linear|sharp.`);
    }
    const entry = viewer._activeEntry();
    // First mutation of this entry? Take the reset snapshot before touching
    // vertices (snapshots are lazy — see viewer _ensureResetSnapshot).
    viewer._ensureResetSnapshot(entry);

    const stats = { maxDisplacement: 0 };
    let affected = 0;
    const touched = new Set();
    const seenGeometries = new Set();

    for (const p of points) {
        opts._centerV = new THREE.Vector3(...p);
        seenGeometries.clear();
        for (const mesh of meshes) {
            // glTF instancing shares one geometry across meshes — stamp each
            // geometry ONCE or instances get double displacement.
            if (seenGeometries.has(mesh.geometry)) continue;
            seenGeometries.add(mesh.geometry);
            mesh.updateMatrixWorld(true);
            const n = stampGeometry(viewer, mesh, opts, stats);
            if (n > 0) {
                affected += n;
                touched.add(mesh.geometry);
            }
        }
    }

    if (touched.size === 0) {
        // A silent no-op wastes the agent's next (expensive) verification render —
        // fail loudly with the fix (adversarial requirement: errors must teach).
        throw new Error(
            "Brush touched no vertices. Check center (world coords — use pick, "
            + "raycast or get_bounds) and radius (or radius_rel); or the mesh is "
            + "too coarse here (primitives: raise segment params).");
    }
    finalizeSculpt(viewer, touched);
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const s = entry && entry.stats ? entry.stats : null;
    return {
        tool: opts.tool || "draw",
        stamps: points.length,
        affected,
        maxDisplacement: r4(stats.maxDisplacement),
        // Post-sculpt object size — quantified feedback so the agent can steer
        // WITHOUT paying a 10-60 s SwiftShader verification render every stamp.
        newSize: s ? [r4(s.width), r4(s.height), r4(s.depth)] : null,
    };
}

/**
 * One sculpt stamp. opts: tool draw|inflate|smooth|flatten|pinch|grab;
 * center [x,y,z] world; radius world units; strength (world units for
 * draw/inflate/grab, 0..1 for smooth/flatten/pinch); direction? [x,y,z];
 * falloff smooth|linear|sharp.
 */
export function sculptStamp(viewer, opts) {
    return applyStamps(viewer, opts, [opts.center]);
}

/**
 * Parametric stroke path → stamp points, auto-sampled at spacing ≈ radius/2
 * (the density that produces smooth bands — under-sampling is THE scalloping
 * trap every artist session hit while hand-computing circles externally).
 *
 * path types:
 * - {type:"circle", center:[x,y,z], axis?:[x,y,z]=[0,1,0], radius, start_deg?,
 *    sweep_deg?=360} — ring/band/arc around an axis (sweep_deg < 360 = arc).
 * - {type:"line", from:[x,y,z], to:[x,y,z]} — straight segment.
 */
export function pathToPoints(path, brushRadius) {
    if (!path || typeof path !== "object" || Array.isArray(path)) {
        throw new Error("path must be an object like {type:'circle'|'line', ...}");
    }
    const spacing = Math.max(1e-9, brushRadius / 2);
    const clampCount = (n) => Math.max(2, Math.min(64, Math.ceil(n)));

    if (path.type === "circle") {
        const c = path.center;
        if (!Array.isArray(c) || c.length !== 3) {
            throw new Error("path.circle requires center: [x,y,z]");
        }
        if (!(path.radius > 0)) throw new Error("path.circle requires radius > 0");
        const axis = Array.isArray(path.axis) && path.axis.length === 3
            ? new THREE.Vector3(...path.axis).normalize()
            : new THREE.Vector3(0, 1, 0);
        if (axis.lengthSq() < 1e-12) throw new Error("path.circle axis must be non-zero");
        const sweep = path.sweep_deg !== undefined
            ? Math.max(1, Math.min(360, path.sweep_deg)) : 360;
        const start = (path.start_deg || 0) * Math.PI / 180;
        const sweepRad = sweep * Math.PI / 180;
        const arcLen = path.radius * sweepRad;
        const closed = sweep >= 360;
        const count = clampCount(arcLen / spacing + (closed ? 0 : 1));
        // Orthonormal basis in the circle's plane (stable seed like the square
        // stamp frame: prefer world X, fall back to Z near-parallel).
        const seed = Math.abs(axis.x) < 0.9
            ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        const u = seed.clone().addScaledVector(axis, -axis.dot(seed)).normalize();
        const v = new THREE.Vector3().crossVectors(axis, u);
        const points = [];
        for (let i = 0; i < count; i++) {
            // Closed rings skip the duplicate end point (i/count); arcs include it.
            const t = closed ? i / count : i / (count - 1);
            const ang = start + t * sweepRad;
            points.push([
                c[0] + path.radius * (Math.cos(ang) * u.x + Math.sin(ang) * v.x),
                c[1] + path.radius * (Math.cos(ang) * u.y + Math.sin(ang) * v.y),
                c[2] + path.radius * (Math.cos(ang) * u.z + Math.sin(ang) * v.z),
            ]);
        }
        return points;
    }

    if (path.type === "line") {
        const { from, to } = path;
        if (!Array.isArray(from) || from.length !== 3
            || !Array.isArray(to) || to.length !== 3) {
            throw new Error("path.line requires from: [x,y,z] and to: [x,y,z]");
        }
        const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
        const count = clampCount(len / spacing + 1);
        const points = [];
        for (let i = 0; i < count; i++) {
            const t = i / (count - 1);
            points.push([
                from[0] + (to[0] - from[0]) * t,
                from[1] + (to[1] - from[1]) * t,
                from[2] + (to[2] - from[2]) * t,
            ]);
        }
        return points;
    }

    throw new Error(`Unknown path.type '${path.type}'. Use circle|line.`);
}

/** Resolve a stroke's stamp points: explicit `points` or a parametric `path`. */
function strokePoints(viewer, opts, command) {
    if (opts.points !== undefined && opts.path !== undefined) {
        throw new Error(`${command}: pass either points OR path, not both`);
    }
    if (opts.path !== undefined) {
        // Radius must resolve BEFORE sampling (spacing depends on it).
        opts.radius = resolveRadius(viewer, opts, command);
        return pathToPoints(opts.path, opts.radius);
    }
    const points = opts.points || [];
    if (!Array.isArray(points) || points.length === 0) {
        throw new Error(`${command} requires points: [[x,y,z], ...] or path: {type, ...}`);
    }
    if (points.length > 64) throw new Error(`${command}: max 64 points per call`);
    return points;
}

/** Sculpt along a path (≤64 points, one call — token-efficient strokes). */
export function sculptStroke(viewer, opts) {
    return applyStamps(viewer, opts, strokePoints(viewer, opts, "sculpt_stroke"));
}

// ---------------------------------------------------------------------------
// Painting (texture painting — creates/edits a real texture)
// ---------------------------------------------------------------------------

const PAINT_DEFAULT_SIZE = 1024;
const PAINT_MAX_SIZE = 2048;
// Per-process texel budget: painting is canvas + GPU memory per mesh; a
// fill_paint over a 200-mesh model must not OOM the shared headless Chromium.
const PAINT_TEXEL_BUDGET = 16 * 1024 * 1024;
let paintTexelsAllocated = 0;

/** The ORIGINAL material of a mesh (paint must survive render-mode overrides). */
function paintTargetMaterial(mesh) {
    const stash = mesh._mvOriginalMaterial || mesh.material;
    if (Array.isArray(stash)) {
        throw new Error(
            "This mesh uses multiple materials (material array) — painting it is "
            + "not supported yet. Paint single-material meshes or primitives.");
    }
    return stash;
}

/**
 * Ensure a mesh has its OWN paintable CanvasTexture layer. Shared materials are
 * cloned on first paint (painting one mesh must not repaint its siblings). The
 * pre-paint map/color are kept for clear_paint.
 */
function ensurePaintLayer(viewer, mesh, size) {
    let material = paintTargetMaterial(mesh);
    if (material.userData._mvPaint) return material.userData._mvPaint;

    // Clone-on-first-paint when the material is shared with OTHER meshes —
    // checked across ALL scene objects (loaders can share materials between
    // co-loaded copies of the same asset), so painting one never repaints another.
    let shared = false;
    for (const entry of viewer._objects) {
        entry.model.traverse((c) => {
            if (c !== mesh && c.isMesh) {
                const m = c._mvOriginalMaterial || c.material;
                if (m === material) shared = true;
            }
        });
    }
    if (shared) {
        const clone = material.clone();
        clone.userData = { ...material.userData };
        if (mesh._mvOriginalMaterial) mesh._mvOriginalMaterial = clone;
        else mesh.material = clone;
        material = clone;
    }

    const dim = Math.min(PAINT_MAX_SIZE, Math.max(64, size || PAINT_DEFAULT_SIZE));
    if (paintTexelsAllocated + dim * dim > PAINT_TEXEL_BUDGET) {
        throw new Error(
            `Paint memory budget exceeded (${Math.round(PAINT_TEXEL_BUDGET / 1e6)}M texels). `
            + "Use a smaller texture_size, paint fewer meshes, or clear_paint unused layers.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = dim;
    const ctx = canvas.getContext("2d");

    // Base layer: existing texture if drawable, else the AUTHORED base color
    // (fall back to displayed color). Color is neutralized to white so the map
    // alone carries color — otherwise the base tints every stroke.
    const prevMap = material.map || null;
    const img = prevMap && prevMap.image ? prevMap.image : null;
    const drawable = img && ((typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement)
        || (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement)
        || (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap));
    let baseColor = material.userData._mvAuthored && material.userData._mvAuthored.color
        ? material.userData._mvAuthored.color
        : "#" + (material.color ? material.color.getHexString() : "808080");
    if (drawable) {
        try {
            ctx.drawImage(img, 0, 0, dim, dim);
        } catch {
            ctx.fillStyle = baseColor;
            ctx.fillRect(0, 0, dim, dim);
        }
    } else {
        ctx.fillStyle = baseColor;
        ctx.fillRect(0, 0, dim, dim);
        if (material.color) material.color.set(0xffffff);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Inherit the replaced map's orientation: GLB textures are flipY=false,
    // loader textures flipY=true. The splat row formula respects this — getting
    // it wrong V-flips the base layer or the strokes.
    texture.flipY = prevMap ? prevMap.flipY : true;
    if (prevMap) {
        texture.wrapS = prevMap.wrapS;
        texture.wrapT = prevMap.wrapT;
    }
    material.map = texture;
    material.needsUpdate = true;
    paintTexelsAllocated += dim * dim;

    const layer = {
        canvas, ctx, texture, size: dim,
        flipY: texture.flipY,
        prevMap,            // kept (NOT disposed) for clear_paint
        prevColor: baseColor,
    };
    material.userData._mvPaint = layer;
    return layer;
}

/** Remove paint layers from the active object, restoring pre-paint materials. */
export function clearPaint(viewer) {
    const meshes = activeMeshes(viewer);
    let cleared = 0;
    for (const mesh of meshes) {
        const stash = mesh._mvOriginalMaterial || mesh.material;
        const material = Array.isArray(stash) ? null : stash;
        const layer = material && material.userData._mvPaint;
        if (!layer) continue;
        material.map = layer.prevMap || null;
        if (!layer.prevMap && material.color) material.color.set(layer.prevColor);
        material.needsUpdate = true;
        layer.texture.dispose();
        paintTexelsAllocated = Math.max(0, paintTexelsAllocated - layer.size * layer.size);
        delete material.userData._mvPaint;
        cleared++;
    }
    // Paint fully undone: if the geometry was never sculpted/baked, the object is
    // back to its on-disk state — clear the export-dirty flag too.
    const entry = viewer._activeEntry();
    if (entry && cleared > 0 && !entry.sculpted
        && paintedMeshNames(entry.model).length === 0) {
        entry.modified = false;
    }
    viewer.invalidate();
    return { clearedMeshes: cleared };
}

/** UV (u,v in [0,1]) → canvas pixel row/col respecting the layer orientation. */
function uvToPixel(layer, u, v) {
    const x = u * layer.size;
    const y = layer.flipY ? (1 - v) * layer.size : v * layer.size;
    return [x, y];
}

/**
 * Paint one stamp: rasterize affected TRIANGLES in UV space with per-texel
 * world-space falloff — continuous coverage at any mesh density, seam-correct
 * (each triangle owns its own UV island pixels).
 */
export function paintStamp(viewer, opts) {
    return paintPoints(viewer, opts, [opts.center]);
}

/** Paint along a path (≤64 points, one call). */
export function paintStroke(viewer, opts) {
    return paintPoints(viewer, opts, strokePoints(viewer, opts, "paint_stroke"));
}

function paintPoints(viewer, opts, points) {
    assertNotSkinned(viewer);
    const meshes = activeMeshes(viewer);
    const radius = resolveRadius(viewer, opts, "paint");
    const color = new THREE.Color(opts.color !== undefined ? String(opts.color) : "#ff3333");
    const opacity = opts.opacity !== undefined ? Math.max(0, Math.min(1, opts.opacity)) : 1;
    const hardness = opts.hardness !== undefined ? Math.max(0, Math.min(1, opts.hardness)) : 0.6;
    const falloffFn = FALLOFFS[opts.falloff || "smooth"] || FALLOFFS.smooth;
    const square = opts.shape === "square";
    if (opts.shape !== undefined && opts.shape !== "round" && opts.shape !== "square") {
        throw new Error(`Unknown shape '${opts.shape}'. Use round|square.`);
    }
    // Edge clamping: skip triangles facing away from the stamp's anchor normal by
    // more than this angle — stops paint from wrapping around hard edges (a
    // sphere-volume brush at a box edge otherwise bleeds onto the side face).
    const maxNormalDeg = opts.max_normal_angle;
    const cosClamp = maxNormalDeg !== undefined
        ? Math.cos(Math.max(1, Math.min(180, maxNormalDeg)) * Math.PI / 180) : null;

    let pixels = 0;
    let alphaSum = 0;
    const paintedLayers = new Set();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const p = new THREE.Vector3();
    const center = new THREE.Vector3();
    const triN = new THREE.Vector3(), refN = new THREE.Vector3();
    const tang1 = new THREE.Vector3(), tang2 = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    // Square stamps measure Chebyshev distance in the anchor's tangent plane; a
    // square of half-side r inscribes in a circle of r*sqrt(2) — widen prefilters.
    const reachScale = square ? Math.SQRT2 : 1;
    const r2 = radius * radius * reachScale * reachScale;
    let uvLess = 0;

    for (const mesh of meshes) {
        const geometry = mesh.geometry;
        const uvAttr = geometry.getAttribute("uv");
        if (!uvAttr) { uvLess++; continue; }
        mesh.updateMatrixWorld(true);
        const m = mesh.matrixWorld;
        const pos = geometry.getAttribute("position");
        const index = geometry.getIndex();
        const triCount = Math.floor(index ? index.count / 3 : pos.count / 3);
        const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);

        let layer = null;
        // PHASE 1 — accumulate the stamp coverage: texel index -> MAX alpha over
        // all stamps and triangles of THIS CALL. Applying per-triangle directly
        // double-blends texels straddling shared edges (the barycentric edge
        // tolerance overlaps them), which reads as a plaid grid at low opacity —
        // and overlapping stroke stamps compound the same way (T1 finding).
        // Max-accumulation = one clean application capped at `opacity`,
        // exactly a painter's per-stroke opacity semantics.
        const acc = new Map();
        let minPX = Infinity, maxPX = -Infinity, minPY = Infinity, maxPY = -Infinity;

        for (const pt of points) {
            center.set(pt[0], pt[1], pt[2]);

            // Candidate triangles for THIS stamp (centroid prefilter), plus the
            // ANCHOR: the triangle nearest the brush center. Its normal is the
            // stamp's reference frame for edge clamping and square orientation.
            const candidates = [];
            let anchorD2 = Infinity;
            for (let t = 0; t < triCount; t++) {
                const i0 = idxOf(t, 0), i1 = idxOf(t, 1), i2 = idxOf(t, 2);
                a.fromBufferAttribute(pos, i0).applyMatrix4(m);
                b.fromBufferAttribute(pos, i1).applyMatrix4(m);
                c.fromBufferAttribute(pos, i2).applyMatrix4(m);
                p.copy(a).add(b).add(c).divideScalar(3);
                const triR = Math.max(a.distanceTo(p), b.distanceTo(p), c.distanceTo(p));
                const reach = radius * reachScale + triR;
                const d2 = p.distanceToSquared(center);
                if (d2 > reach * reach) continue;
                candidates.push(t);
                if (d2 < anchorD2) {
                    anchorD2 = d2;
                    e1.copy(b).sub(a); e2.copy(c).sub(a);
                    refN.copy(e1.cross(e2)).normalize();
                }
            }
            if (candidates.length === 0) continue;
            if (square || cosClamp !== null) {
                // Tangent frame from the anchor normal (stable for axis-aligned
                // work: prefer world X as the first tangent, fall back to Z).
                const seed = Math.abs(refN.x) < 0.9
                    ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
                tang1.copy(seed).addScaledVector(refN, -refN.dot(seed)).normalize();
                tang2.crossVectors(refN, tang1);
            }

            for (const t of candidates) {
                const i0 = idxOf(t, 0), i1 = idxOf(t, 1), i2 = idxOf(t, 2);
                a.fromBufferAttribute(pos, i0).applyMatrix4(m);
                b.fromBufferAttribute(pos, i1).applyMatrix4(m);
                c.fromBufferAttribute(pos, i2).applyMatrix4(m);

                if (cosClamp !== null) {
                    e1.copy(b).sub(a); e2.copy(c).sub(a);
                    triN.copy(e1.cross(e2)).normalize();
                    if (triN.dot(refN) < cosClamp) continue;
                }

                layer = layer || ensurePaintLayer(viewer, mesh, opts.texture_size);
                const [u0, v0] = uvToPixel(layer, uvAttr.getX(i0), uvAttr.getY(i0));
                const [u1, v1] = uvToPixel(layer, uvAttr.getX(i1), uvAttr.getY(i1));
                const [u2, v2] = uvToPixel(layer, uvAttr.getX(i2), uvAttr.getY(i2));
                const dim = layer.size;
                const minU = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
                const maxU = Math.min(dim - 1, Math.ceil(Math.max(u0, u1, u2)));
                const minV = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
                const maxV = Math.min(dim - 1, Math.ceil(Math.max(v0, v1, v2)));
                if (maxU < minU || maxV < minV) continue;
                // Degenerate or absurdly large UV islands guard.
                if ((maxU - minU) * (maxV - minV) > dim * dim) continue;

                const denom = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
                if (Math.abs(denom) < 1e-9) continue;

                for (let py = minV; py <= maxV; py++) {
                    for (let px = minU; px <= maxU; px++) {
                        const l0 = ((v1 - v2) * (px + 0.5 - u2) + (u2 - u1) * (py + 0.5 - v2)) / denom;
                        const l1 = ((v2 - v0) * (px + 0.5 - u2) + (u0 - u2) * (py + 0.5 - v2)) / denom;
                        const l2 = 1 - l0 - l1;
                        if (l0 < -0.02 || l1 < -0.02 || l2 < -0.02) continue;
                        p.set(
                            a.x * l0 + b.x * l1 + c.x * l2,
                            a.y * l0 + b.y * l1 + c.y * l2,
                            a.z * l0 + b.z * l1 + c.z * l2,
                        );
                        const d2 = p.distanceToSquared(center);
                        if (d2 > r2) continue;
                        let tN;
                        if (square) {
                            // Chebyshev distance in the anchor tangent plane →
                            // crisp axis-aligned quads (checkers, panels, labels).
                            p.sub(center);
                            const du = Math.abs(p.dot(tang1));
                            const dv = Math.abs(p.dot(tang2));
                            tN = Math.max(du, dv) / radius;
                            if (tN > 1) continue;
                        } else {
                            tN = Math.sqrt(d2) / radius;
                            if (tN > 1) continue;
                        }
                        const soft = tN <= hardness
                            ? 1 : falloffFn((tN - hardness) / Math.max(1e-6, 1 - hardness));
                        const alpha = opacity * soft;
                        if (alpha <= 0.004) continue;
                        const key = py * dim + px;
                        const prev = acc.get(key);
                        if (prev === undefined || alpha > prev) acc.set(key, alpha);
                        if (px < minPX) minPX = px;
                        if (px > maxPX) maxPX = px;
                        if (py < minPY) minPY = py;
                        if (py > maxPY) maxPY = py;
                    }
                }
            }
        }

        // PHASE 2 — one blend pass over the touched region.
        if (layer && acc.size > 0) {
            // Blend in sRGB bytes: THREE.Color components are LINEAR working
            // space (r152+ color management), but the canvas is an sRGB texture.
            // Writing linear values paints every non-primary color darker than
            // requested (#00aa00 would land as rgb(0,103,0)). getHexString()
            // converts back to sRGB.
            const hex = parseInt(color.getHexString(), 16);
            const cr = (hex >> 16) & 255, cg = (hex >> 8) & 255, cb = hex & 255;
            const dim = layer.size;
            const w = maxPX - minPX + 1;
            const img = layer.ctx.getImageData(minPX, minPY, w, maxPY - minPY + 1);
            const data = img.data;
            for (const [key, alpha] of acc) {
                const px = key % dim;
                const py = (key - px) / dim;
                const o = ((py - minPY) * w + (px - minPX)) * 4;
                data[o] = Math.round(data[o] * (1 - alpha) + cr * alpha);
                data[o + 1] = Math.round(data[o + 1] * (1 - alpha) + cg * alpha);
                data[o + 2] = Math.round(data[o + 2] * (1 - alpha) + cb * alpha);
                data[o + 3] = 255;
                alphaSum += alpha;
            }
            layer.ctx.putImageData(img, minPX, minPY);
            pixels += acc.size;
            paintedLayers.add(layer);
        }
    }

    if (uvLess > 0 && paintedLayers.size === 0 && pixels === 0) {
        throw new Error(
            "The touched meshes have no UV coordinates, so texture painting has "
            + "nowhere to land. Paint works on primitives (add_primitive) and "
            + "UV-mapped models; STL/PLY meshes have no UVs.");
    }
    if (pixels === 0) {
        // Loud failure with the fix — see the sculpt miss rationale.
        throw new Error(
            "Brush touched no surface. Check center (world coords — use pick, "
            + "raycast or get_bounds) and radius (or radius_rel).");
    }
    for (const layer of paintedLayers) layer.texture.needsUpdate = true;
    const entry = viewer._activeEntry();
    if (entry) entry.modified = true;
    viewer.invalidate();
    const meanAlpha = Math.round((alphaSum / pixels) * 1000) / 1000;
    const result = {
        painted: pixels,
        // Honest visibility feedback: how strongly the average touched texel
        // actually changed. Low meanAlpha = technically-painted-but-invisible —
        // catch it HERE instead of spending a verification render (T1 finding).
        meanAlpha,
        meshes: paintedLayers.size,
        stamps: points.length,
        color: "#" + color.getHexString(),
    };
    const notes = [];
    if (meanAlpha < 0.05) {
        notes.push(`meanAlpha ${meanAlpha} — this paint is nearly invisible. `
            + "Raise opacity and/or hardness (soft falloff scales alpha toward 0 "
            + "at the rim).");
    }
    // Paint targets the ORIGINAL materials — invisible while a solid/normals
    // override is displayed. Say so, or the agent's verify-screenshot loop spins.
    const mode = viewer.getRenderMode && viewer.getRenderMode();
    if (mode === "solid" || mode === "normals") {
        notes.push(`Render mode '${mode}' hides textures — `
            + "set_render_mode textured to SEE the paint.");
    }
    if (notes.length) result.note = notes.join(" ");
    return result;
}

/** Flood the whole paint layer of every UV-mapped mesh with one color. */
export function fillPaint(viewer, opts) {
    assertNotSkinned(viewer);
    const meshes = activeMeshes(viewer);
    const color = new THREE.Color(opts.color !== undefined ? String(opts.color) : "#808080");
    let filled = 0;
    for (const mesh of meshes) {
        if (!mesh.geometry.getAttribute("uv")) continue;
        const layer = ensurePaintLayer(viewer, mesh, opts.texture_size);
        layer.ctx.fillStyle = "#" + color.getHexString();
        layer.ctx.fillRect(0, 0, layer.size, layer.size);
        layer.texture.needsUpdate = true;
        filled++;
    }
    if (filled === 0) {
        throw new Error("No UV-mapped meshes to paint (see paint's UV requirement).");
    }
    const entry = viewer._activeEntry();
    if (entry) entry.modified = true;
    viewer.invalidate();
    return { filledMeshes: filled, color: "#" + color.getHexString() };
}

/** Names of active-object meshes carrying (unsaved) paint layers. */
export function paintedMeshNames(model) {
    const names = [];
    if (!model) return names;
    model.traverse((c) => {
        if (!c.isMesh) return;
        const stash = c._mvOriginalMaterial || c.material;
        const m = Array.isArray(stash) ? stash[0] : stash;
        if (m && m.userData && m.userData._mvPaint) names.push(c.name || "(unnamed)");
    });
    return names;
}

/** Return a model's paint layers to the budget (call on object disposal, BEFORE
 *  material disposal — otherwise long sessions leak budget until paint fails). */
export function releasePaintBudget(model) {
    if (!model) return;
    model.traverse((c) => {
        if (!c.isMesh) return;
        for (const stash of [c._mvOriginalMaterial, c.material]) {
            const mats = Array.isArray(stash) ? stash : (stash ? [stash] : []);
            for (const m of mats) {
                const layer = m && m.userData && m.userData._mvPaint;
                if (!layer) continue;
                paintTexelsAllocated = Math.max(
                    0, paintTexelsAllocated - layer.size * layer.size);
                delete m.userData._mvPaint;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Pick / raycast (the agent hand-eye loop)
// ---------------------------------------------------------------------------

/**
 * Raycast from the CURRENT camera through normalized image coordinates
 * (x right, y DOWN, 0..1, top-left origin — exactly how you read a screenshot).
 * width/height: the SCREENSHOT's dimensions — needed because screenshots can
 * have a different aspect than the live canvas, and un-projecting with the
 * wrong aspect lands up to ~15% off near the edges.
 */
export function pick(viewer, x, y, width, height) {
    const cam = viewer._camera;
    const prevAspect = cam.aspect;
    if (width && height) {
        cam.aspect = width / height;
        cam.updateProjectionMatrix();
    }
    try {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(
            new THREE.Vector2(x * 2 - 1, -(y * 2 - 1)), cam);
        return castInto(viewer, raycaster);
    } finally {
        if (width && height) {
            cam.aspect = prevAspect;
            cam.updateProjectionMatrix();
        }
    }
}

/** Raycast from an explicit world-space origin along a direction. */
export function raycast(viewer, origin, direction) {
    const raycaster = new THREE.Raycaster(
        new THREE.Vector3(...origin),
        new THREE.Vector3(...direction).normalize());
    return castInto(viewer, raycaster);
}

function castInto(viewer, raycaster) {
    viewer._scene.updateMatrixWorld(true);
    const hits = raycaster.intersectObjects(viewer._visibleMeshes(), false);
    if (hits.length === 0) {
        return { hit: false,
                 hint: "Ray hit nothing. frame_all or orbit first so the target is "
                     + "in view, then pick coordinates read off a FRESH screenshot "
                     + "(pass its width/height)." };
    }
    const h = hits[0];
    const entry = viewer._entryForNode(h.object);
    const n = h.face
        ? h.face.normal.clone().applyMatrix3(
            new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld)).normalize()
        : null;
    const r4 = (v) => Math.round(v * 10000) / 10000;
    return {
        hit: true,
        point: [r4(h.point.x), r4(h.point.y), r4(h.point.z)],
        normal: n ? [r4(n.x), r4(n.y), r4(n.z)] : null,
        distance: r4(h.distance),
        objectId: entry ? entry.id : null,
        objectName: entry ? entry.name : null,
    };
}
