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
export { FALLOFFS };

/** Meshes of the ACTIVE object (sculpt/paint targets). */
function activeMeshes(viewer) {
    const model = viewer._currentModel;
    if (!model) throw new Error("No model loaded. load / add_model / add_primitive first.");
    const meshes = [];
    model.traverse((c) => { if (c.isMesh && c.geometry) meshes.push(c); });
    if (meshes.length === 0) throw new Error("Active object has no meshes.");
    return meshes;
}

/**
 * The "wrong active object" trap-killer (T2 finding): when a brush misses the
 * ACTIVE object entirely, check whether the point actually sits on ANOTHER
 * object and name it — after split_object the new part silently becomes
 * active, and every subsequent brush lands on the wrong mesh with a generic
 * miss error. Returns an error suffix ("" when no better owner exists).
 */
export function wrongObjectHint(viewer, worldPoint) {
    if (!worldPoint || viewer._objects.length < 2) return "";
    const p = new THREE.Vector3(...worldPoint);
    const active = viewer._activeEntry();
    let best = null, bestD = Infinity;
    for (const entry of viewer._objects) {
        if (entry === active) continue;
        const box = new THREE.Box3().setFromObject(entry.wrapper);
        if (box.isEmpty()) continue;
        const d = box.distanceToPoint(p);
        if (d < bestD) { bestD = d; best = entry; }
    }
    if (best && bestD < 1e-3) {
        return ` The point sits on object ${best.id} ('${best.name}') but the `
            + `ACTIVE object is ${active.id} ('${active.name}') — `
            + `set_active_object {id: ${best.id}} first.`;
    }
    return "";
}

export function assertNotSkinned(viewer) {
    const entry = viewer._activeEntry();
    if (entry && entry.skinned) {
        throw new Error(
            "Sculpting/painting skinned (rigged) models is not supported — vertex "
            + "edits corrupt the bind pose. Use set_object_transform to place it, "
            + "or sculpt a primitive/static mesh instead.");
    }
    // A world-space brush on a MOVING target smears the stroke across poses and
    // bakes a transient animation pose into permanent vertex data.
    if (viewer._timeline && viewer._timeline.playing) {
        throw new Error(
            "The timeline is PLAYING — sculpt/paint on a moving object would bake "
            + "a transient pose into the geometry. pause_timeline (or seek_timeline) "
            + "first, then edit.");
    }
}

/**
 * Prepare a geometry for in-place vertex mutation: dequantize (KHR quantization)
 * and de-interleave position/normal so our writes own their buffers. The entry's
 * reset snapshot stays valid — it stores accessor-DECODED floats and restores via
 * setXYZ (layout-independent).
 */
export function ensureMutable(geometry) {
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
        entry.geometryRev++;     // invalidates detect_parts partitions
        entry.stats = viewer._computeStats(entry.model);
        viewer._lastStats = entry.stats;
    }
    viewer.invalidate();
}

// ---------------------------------------------------------------------------
// Single-slot texture-brush undo (backlog 050 gauntlet: every stamp was a
// one-way door — clear_paint nukes ALL layers including earlier good repairs).
// Each brush COMMAND stashes the pre-write canvas rect(s); undo_paint restores
// the most recent command's rects exactly once.
// ---------------------------------------------------------------------------

const PATCH_TEXEL_CAP = 2048 * 2048;   // don't pin >16 MB of undo bytes
let _lastPaintOp = null;

/**
 * Start a new undoable brush op. `group` (opts.undo_group) merges CONSECUTIVE
 * calls into one undo unit — the human UI slices a drag into many stroke
 * commands (flush cadence), and "undo" must mean the GESTURE, not the last
 * 100 ms slice (gauntlet finding). Agents batching one logical stroke across
 * calls can use the same token.
 */
export function beginPaintOp(action, group) {
    if (group && _lastPaintOp && _lastPaintOp.group === group) return;
    _lastPaintOp = { action, group: group || null, patches: [] };
}

/** Stash the CURRENT canvas content of a rect about to be overwritten. */
export function stashPaintPatch(action, layer, x, y, w, h) {
    if (w <= 0 || h <= 0 || w * h > PATCH_TEXEL_CAP) return;
    if (!_lastPaintOp) beginPaintOp(action);
    _lastPaintOp.patches.push({
        layer, layerSize: layer.size, x, y,
        data: layer.ctx.getImageData(x, y, w, h),
    });
}

/** Restore the last brush op's pre-write texels (one-shot). */
export function undoPaint(viewer) {
    if (!_lastPaintOp || _lastPaintOp.patches.length === 0) {
        throw new Error(
            "Nothing to undo — ONE brush call is remembered (the slot is "
            + "consumed by undo and replaced by each new paint/blur/clone/"
            + "mirror call). clear_paint removes ALL paint layers instead.");
    }
    let restored = 0, stale = 0;
    // REVERSED: within a grouped gesture, rects overlap — the earliest patch
    // holds the pristine content and must be applied last so it wins.
    for (const p of [..._lastPaintOp.patches].reverse()) {
        // The layer object survives, but resize_texture reallocates its canvas
        // (size changes) and clear_paint detaches it — skip those safely.
        if (!p.layer || !p.layer.ctx || p.layer.size !== p.layerSize) {
            stale++;
            continue;
        }
        try {
            p.layer.ctx.putImageData(p.data, p.x, p.y);
            p.layer.texture.needsUpdate = true;
            restored++;
        } catch {
            stale++;
        }
    }
    const action = _lastPaintOp.action;
    _lastPaintOp = null;
    _gestureAlpha = null;   // the composited alphas no longer exist on canvas
    viewer.invalidate();
    const out = { undone: action, restoredPatches: restored };
    if (stale) {
        out.stalePatches = stale;
        out.note = "Some patches were stale (layer resized or cleared since) "
            + "and were skipped.";
    }
    return out;
}

/**
 * Gesture-scoped alpha ledger: with undo_group set, overlapping slices of one
 * gesture COMPOSE toward the requested opacity instead of compounding past it
 * (a slow 0.05-opacity wiggle otherwise stacked to ~0.44 across its ~9 flush
 * slices — painter semantics must hold per GESTURE, not per command).
 * Map: layer -> Map(texelKey -> alpha already applied this gesture).
 */
let _gestureAlpha = null;

function gestureAlphaMap(group, layer) {
    if (!group) return null;
    if (!_gestureAlpha || _gestureAlpha.group !== group) {
        _gestureAlpha = { group, layers: new Map() };
    }
    let m = _gestureAlpha.layers.get(layer);
    if (!m) { m = new Map(); _gestureAlpha.layers.set(layer, m); }
    return m;
}

/**
 * Pre-build the sculpt caches (mutable buffers + weld/adjacency maps) for the
 * ACTIVE object without touching any state flags — the human UI calls this on
 * sculpt-mode entry so the first stamp of a gesture doesn't pay the weld-map
 * build mid-drag (visible hitch at ~120k triangles). Routing a zero-strength
 * sculpt command instead would falsely mark the entry modified/sculpted.
 */
export function prewarmSculptCaches(viewer) {
    const entry = viewer._activeEntry();
    if (!entry || entry.skinned) return { warmed: 0 };
    let warmed = 0;
    const seen = new Set();
    entry.model.traverse((c) => {
        if (!c.isMesh || !c.geometry || seen.has(c.geometry)) return;
        seen.add(c.geometry);
        ensureMutable(c.geometry);
        getWeld(c.geometry);
        warmed++;
    });
    return { warmed };
}

/**
 * Per-gesture undo support for the human UI (backlog 054): snapshot the ACTIVE
 * object's decoded positions before a brush gesture, restore on undo. One slot,
 * panel-owned; distinct from the entry's reset snapshot (which restores the
 * ORIGINAL geometry and would also revert bakes/simplify).
 */
export function snapshotActivePositions(viewer) {
    const entry = viewer._activeEntry();
    if (!entry || entry.skinned) return null;
    const geometries = [];
    const seen = new Set();
    entry.model.traverse((c) => {
        if (!c.isMesh || !c.geometry || seen.has(c.geometry)) return;
        seen.add(c.geometry);
        const pos = c.geometry.getAttribute("position");
        if (!pos) return;
        // Accessor-decoded copy (quantized/interleaved safe — same rule as the
        // reset snapshots).
        const arr = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
            arr[i * 3] = pos.getX(i);
            arr[i * 3 + 1] = pos.getY(i);
            arr[i * 3 + 2] = pos.getZ(i);
        }
        geometries.push({ geometry: c.geometry, positions: arr, count: pos.count });
    });
    return geometries.length ? { entryId: entry.id, geometries } : null;
}

/** Restore a snapshotActivePositions() snapshot. Returns true when applied. */
export function restorePositionsSnapshot(viewer, snap) {
    const entry = viewer._activeEntry();
    if (!snap || !entry || entry.id !== snap.entryId) return false;
    const touched = [];
    for (const g of snap.geometries) {
        const pos = g.geometry.getAttribute("position");
        // Geometry replaced since the snapshot (simplify/split) — skip safely.
        if (!pos || pos.count !== g.count) continue;
        for (let i = 0; i < g.count; i++) {
            pos.setXYZ(i, g.positions[i * 3], g.positions[i * 3 + 1],
                       g.positions[i * 3 + 2]);
        }
        touched.push(g.geometry);
    }
    if (touched.length) finalizeSculpt(viewer, touched);
    return touched.length > 0;
}

/**
 * Resolve the brush radius: absolute `radius` (world units) or `radius_rel`
 * (fraction of the ACTIVE object's bounding-sphere radius — scale-free, so an
 * agent needn't know if the model is 2 units or 2000).
 */
export function resolveRadius(viewer, opts, command) {
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
            + "too coarse here (primitives: raise segment params)."
            + wrongObjectHint(viewer, points[0]));
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
const PAINT_MAX_SIZE = 4096;   // "xhigh" tier
// Per-process texel budget: painting is canvas + GPU memory per mesh; a
// fill_paint over a 200-mesh model must not OOM the shared headless Chromium.
// 32M texels ≈ 128 MB canvas + ~130-170 MB GL worst case (+0.3 GB over the
// ~0.9 GB baseline — the measured-safe default): two xhigh (4096²=16.7M)
// layers, or 32 default layers. Mipmaps are disabled ≥2048 (33% memory tax +
// CPU mip-gen per upload under SwiftShader).
const PAINT_TEXEL_BUDGET = 32 * 1024 * 1024;
let paintTexelsAllocated = 0;

/** Budget introspection for get_state / paint results (agents must see the
 *  budget BEFORE it bites — adversarial requirement). */
export function paintBudgetInfo() {
    return {
        texelsUsed: paintTexelsAllocated,
        texelsBudget: PAINT_TEXEL_BUDGET,
        usedFraction: Math.round((paintTexelsAllocated / PAINT_TEXEL_BUDGET) * 1000) / 1000,
    };
}

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
    applyLayerFiltering(texture, dim);
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
export function uvToPixel(layer, u, v) {
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
    // One undo unit per COMMAND — or per GESTURE when undo_group is given.
    beginPaintOp("paint", opts.undo_group);
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
    let rasterized = 0;
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
            // Gesture ledger: alpha already applied to each texel THIS gesture
            // (undo_group). A new slice only tops the texel up to its target —
            // total composite = max slice alpha, never the compounded product.
            const ledger = gestureAlphaMap(opts.undo_group, layer);
            let painted = 0;
            for (const [key, alpha] of acc) {
                let eff = alpha;
                if (ledger) {
                    const prev = ledger.get(key) || 0;
                    if (alpha <= prev + 0.004) continue;
                    eff = (alpha - prev) / (1 - prev);
                    ledger.set(key, alpha);
                }
                const px = key % dim;
                const py = (key - px) / dim;
                const o = ((py - minPY) * w + (px - minPX)) * 4;
                data[o] = Math.round(data[o] * (1 - eff) + cr * eff);
                data[o + 1] = Math.round(data[o + 1] * (1 - eff) + cg * eff);
                data[o + 2] = Math.round(data[o + 2] * (1 - eff) + cb * eff);
                data[o + 3] = 255;
                alphaSum += alpha;
                painted++;
            }
            stashPaintPatch("paint", layer, minPX, minPY, img.width, img.height);
            layer.ctx.putImageData(img, minPX, minPY);
            pixels += painted;
            rasterized += acc.size;
            paintedLayers.add(layer);
        }
    }

    if (uvLess > 0 && paintedLayers.size === 0 && rasterized === 0) {
        throw new Error(
            "The touched meshes have no UV coordinates, so texture painting has "
            + "nowhere to land. Paint works on primitives (add_primitive) and "
            + "UV-mapped models; STL/PLY meshes have no UVs.");
    }
    // A grouped slice that lands entirely on texels the SAME gesture already
    // covered is a quiet success, not a miss — only zero RASTERIZED texels
    // means the brush genuinely touched nothing.
    if (rasterized === 0) {
        // Loud failure with the fix — see the sculpt miss rationale.
        throw new Error(
            "Brush touched no surface. Check center (world coords — use pick, "
            + "raycast or get_bounds) and radius (or radius_rel)."
            + wrongObjectHint(viewer, points[0]));
    }
    for (const layer of paintedLayers) layer.texture.needsUpdate = true;
    const entry = viewer._activeEntry();
    if (entry) entry.modified = true;
    viewer.invalidate();
    const meanAlpha = pixels > 0
        ? Math.round((alphaSum / pixels) * 1000) / 1000 : 0;
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
    // Budget visibility BEFORE it bites: warn crossing 75%.
    const budget = paintBudgetInfo();
    if (budget.usedFraction >= 0.75) {
        notes.push(`Paint budget ${Math.round(budget.usedFraction * 100)}% used — `
            + "prefer smaller texture_size tiers or clear_paint unused layers.");
    }
    // A layer's size is fixed at creation — a mismatched request must not lie.
    if (opts.texture_size) {
        for (const layer of paintedLayers) {
            if (layer.size !== opts.texture_size) {
                notes.push(`texture_size ${opts.texture_size} ignored — the layer `
                    + `already exists at ${layer.size}. Use resize_texture to change it.`);
                break;
            }
        }
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

// ---------------------------------------------------------------------------
// Texture repair brushes (backlog 046) + layer resizing
// ---------------------------------------------------------------------------

/** A repair brush needs a READABLE base: refuse when the material had a real
 *  texture that could not be drawn into the layer (KTX2/GPU-only) — otherwise
 *  "repair" silently blurs a flat-color stand-in of the real texture. */
export function ensureRepairableLayer(viewer, mesh, size) {
    const material = paintTargetMaterial(mesh);
    const prev = material.map;
    if (prev && !(material.userData && material.userData._mvPaint)) {
        const img = prev.image;
        const drawable = img && ((typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement)
            || (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement)
            || (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap));
        if (!drawable) {
            throw new Error(
                "This material's texture is GPU-only (compressed KTX2 or "
                + "unreadable) and cannot be read back for repair. Repaint the "
                + "area with paint/fill_paint instead.");
        }
    }
    return ensurePaintLayer(viewer, mesh, size);
}

/** Collect the texel footprint of a world-space brush on a mesh (reuses the
 *  paint rasterization): Map(texelKey -> {alpha, world, n}) — `n` is the owning
 *  triangle's world normal (mirror_paint's two-sheet guard needs it). */
export function brushFootprint(mesh, layer, center, radius, hardness, falloffFn) {
    const geometry = mesh.geometry;
    const uvAttr = geometry.getAttribute("uv");
    if (!uvAttr) return null;
    mesh.updateMatrixWorld(true);
    const m = mesh.matrixWorld;
    const pos = geometry.getAttribute("position");
    const index = geometry.getIndex();
    const triCount = Math.floor(index ? index.count / 3 : pos.count / 3);
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const p = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    const r2 = radius * radius;
    const dim = layer.size;
    const acc = new Map();
    for (let t = 0; t < triCount; t++) {
        const i0 = idxOf(t, 0), i1 = idxOf(t, 1), i2 = idxOf(t, 2);
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        p.copy(a).add(b).add(c).divideScalar(3);
        const triR = Math.max(a.distanceTo(p), b.distanceTo(p), c.distanceTo(p));
        if (p.distanceToSquared(center) > (radius + triR) ** 2) continue;
        e1.copy(b).sub(a); e2.copy(c).sub(a);
        const triN = e1.clone().cross(e2).normalize();
        const [u0, v0] = uvToPixel(layer, uvAttr.getX(i0), uvAttr.getY(i0));
        const [u1, v1] = uvToPixel(layer, uvAttr.getX(i1), uvAttr.getY(i1));
        const [u2, v2] = uvToPixel(layer, uvAttr.getX(i2), uvAttr.getY(i2));
        const minU = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
        const maxU = Math.min(dim - 1, Math.ceil(Math.max(u0, u1, u2)));
        const minV = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
        const maxV = Math.min(dim - 1, Math.ceil(Math.max(v0, v1, v2)));
        if (maxU < minU || maxV < minV) continue;
        if ((maxU - minU) * (maxV - minV) > dim * dim) continue;
        const denom = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
        if (Math.abs(denom) < 1e-9) continue;
        for (let py = minV; py <= maxV; py++) {
            for (let px = minU; px <= maxU; px++) {
                const l0 = ((v1 - v2) * (px + 0.5 - u2) + (u2 - u1) * (py + 0.5 - v2)) / denom;
                const l1 = ((v2 - v0) * (px + 0.5 - u2) + (u0 - u2) * (py + 0.5 - v2)) / denom;
                const l2 = 1 - l0 - l1;
                if (l0 < -0.02 || l1 < -0.02 || l2 < -0.02) continue;
                p.set(a.x * l0 + b.x * l1 + c.x * l2,
                      a.y * l0 + b.y * l1 + c.y * l2,
                      a.z * l0 + b.z * l1 + c.z * l2);
                const d2 = p.distanceToSquared(center);
                if (d2 > r2) continue;
                const tN = Math.sqrt(d2) / radius;
                const soft = tN <= hardness
                    ? 1 : falloffFn((tN - hardness) / Math.max(1e-6, 1 - hardness));
                if (soft <= 0.004) continue;
                const key = py * dim + px;
                const prev = acc.get(key);
                if (!prev || soft > prev.alpha) {
                    acc.set(key, { alpha: soft, world: [p.x, p.y, p.z],
                                   n: [triN.x, triN.y, triN.z] });
                }
            }
        }
    }
    return acc;
}

/**
 * blur_paint — Gaussian-soften the paint layer inside the brush footprint
 * (defect smoothing). Reads from a snapshot buffer (no in-place feedback);
 * kernel taps are masked to the brush coverage so atlas neighbors that are
 * not surface neighbors don't bleed in.
 */
export function blurPaint(viewer, opts = {}) {
    assertNotSkinned(viewer);
    const meshes = activeMeshes(viewer);
    beginPaintOp("blur_paint", opts.undo_group);
    const radius = resolveRadius(viewer, opts, "blur_paint");
    const strength = opts.strength !== undefined ? Math.max(0, Math.min(1, opts.strength)) : 0.5;
    const center = new THREE.Vector3(...(opts.center || []));
    if (!opts.center || opts.center.length !== 3) {
        throw new Error("blur_paint requires center: [x,y,z] (world — use pick).");
    }
    let blurred = 0;
    let blurAlphaSum = 0;
    for (const mesh of meshes) {
        if (!mesh.geometry.getAttribute("uv")) continue;
        const layer = ensureRepairableLayer(viewer, mesh, opts.texture_size);
        const foot = brushFootprint(mesh, layer, center, radius, 0.8, FALLOFFS.smooth);
        if (!foot || foot.size === 0) continue;
        const dim = layer.size;
        // Snapshot the whole touched bbox once.
        let minX = dim, maxX = 0, minY = dim, maxY = 0;
        for (const key of foot.keys()) {
            const px = key % dim, py = (key - px) / dim;
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
        const pad = 4;
        minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
        maxX = Math.min(dim - 1, maxX + pad); maxY = Math.min(dim - 1, maxY + pad);
        const w = maxX - minX + 1, h = maxY - minY + 1;
        const srcImg = layer.ctx.getImageData(minX, minY, w, h);
        const dstImg = layer.ctx.getImageData(minX, minY, w, h);
        const src = srcImg.data, dst = dstImg.data;
        const sigma = Math.max(1, Math.round(strength * 6));
        const inFoot = (px, py) => foot.has(py * dim + px);
        for (const [key, rec] of foot) {
            const px = key % dim, py = (key - px) / dim;
            let r = 0, g = 0, b2 = 0, wsum = 0;
            for (let dy = -sigma; dy <= sigma; dy++) {
                for (let dx = -sigma; dx <= sigma; dx++) {
                    const qx = px + dx, qy = py + dy;
                    if (qx < minX || qx > maxX || qy < minY || qy > maxY) continue;
                    if (!inFoot(qx, qy)) continue;    // masked to the footprint
                    const g2 = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
                    const o = ((qy - minY) * w + (qx - minX)) * 4;
                    r += src[o] * g2; g += src[o + 1] * g2; b2 += src[o + 2] * g2;
                    wsum += g2;
                }
            }
            if (wsum <= 0) continue;
            const o = ((py - minY) * w + (px - minX)) * 4;
            const alpha = rec.alpha * strength;
            dst[o] = Math.round(dst[o] * (1 - alpha) + (r / wsum) * alpha);
            dst[o + 1] = Math.round(dst[o + 1] * (1 - alpha) + (g / wsum) * alpha);
            dst[o + 2] = Math.round(dst[o + 2] * (1 - alpha) + (b2 / wsum) * alpha);
            blurred++;
            blurAlphaSum += alpha;
        }
        stashPaintPatch("blur_paint", layer, minX, minY, dstImg.width, dstImg.height);
        layer.ctx.putImageData(dstImg, minX, minY);
        layer.texture.needsUpdate = true;
    }
    if (blurred === 0) {
        throw new Error("Blur brush touched no painted surface — check center "
            + "(world coords — use pick) and radius; the mesh needs UVs and a "
            + "readable texture." + wrongObjectHint(viewer, opts.center));
    }
    const entry = viewer._activeEntry();
    if (entry) entry.modified = true;
    viewer.invalidate();
    return { blurred, meanAlpha: Math.round((blurAlphaSum / blurred) * 1000) / 1000,
             strength };
}

/**
 * clone_paint — heal brush: copy texels from one surface region to another via
 * WORLD-SPACE correspondence (UV-delta cloning is incoherent across islands).
 * For each destination texel: world position P → P' = P + (from − to) → nearest
 * source-region triangle → its own UVs → bilinear sample from a pre-write
 * snapshot. from/to must be on the SAME object with agreeing normals (≤45°).
 */
export function clonePaint(viewer, opts = {}) {
    assertNotSkinned(viewer);
    const meshes = activeMeshes(viewer);
    beginPaintOp("clone_paint", opts.undo_group);
    const radius = resolveRadius(viewer, opts, "clone_paint");
    if (!opts.from || opts.from.length !== 3 || !opts.to || opts.to.length !== 3) {
        throw new Error("clone_paint requires from:[x,y,z] and to:[x,y,z] "
            + "(world — use pick on a clean area and on the defect).");
    }
    const from = new THREE.Vector3(...opts.from);
    const to = new THREE.Vector3(...opts.to);
    const offset = from.clone().sub(to);
    const strength = opts.strength !== undefined ? Math.max(0, Math.min(1, opts.strength)) : 1;
    const falloffFn = FALLOFFS[opts.falloff || "smooth"] || FALLOFFS.smooth;

    let cloned = 0;
    let alphaSum = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const p = new THREE.Vector3();

    for (const mesh of meshes) {
        const geometry = mesh.geometry;
        const uvAttr = geometry.getAttribute("uv");
        if (!uvAttr) continue;
        const layer = ensureRepairableLayer(viewer, mesh, opts.texture_size);
        mesh.updateMatrixWorld(true);
        const m = mesh.matrixWorld;
        const pos = geometry.getAttribute("position");
        const index = geometry.getIndex();
        const triCount = Math.floor(index ? index.count / 3 : pos.count / 3);
        const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);

        // Source candidate triangles (centroid prefilter around `from`) + the
        // source anchor normal for the 45° agreement check.
        const srcTris = [];
        let srcNormal = null, srcD2 = Infinity;
        const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
        for (let t = 0; t < triCount; t++) {
            a.fromBufferAttribute(pos, idxOf(t, 0)).applyMatrix4(m);
            b.fromBufferAttribute(pos, idxOf(t, 1)).applyMatrix4(m);
            c.fromBufferAttribute(pos, idxOf(t, 2)).applyMatrix4(m);
            p.copy(a).add(b).add(c).divideScalar(3);
            const triR = Math.max(a.distanceTo(p), b.distanceTo(p), c.distanceTo(p));
            const d2 = p.distanceToSquared(from);
            if (d2 > (radius * 1.5 + triR) ** 2) continue;
            srcTris.push(t);
            if (d2 < srcD2) {
                srcD2 = d2;
                e1.copy(b).sub(a); e2.copy(c).sub(a);
                srcNormal = e1.clone().cross(e2).normalize();
            }
        }
        if (!srcTris.length) continue;

        const foot = brushFootprint(mesh, layer, to, radius,
            opts.hardness !== undefined ? opts.hardness : 0.6, falloffFn);
        if (!foot || foot.size === 0) continue;

        // Destination anchor normal (nearest tri to `to`).
        let dstNormal = null, dstD2 = Infinity;
        for (let t = 0; t < triCount; t++) {
            a.fromBufferAttribute(pos, idxOf(t, 0)).applyMatrix4(m);
            b.fromBufferAttribute(pos, idxOf(t, 1)).applyMatrix4(m);
            c.fromBufferAttribute(pos, idxOf(t, 2)).applyMatrix4(m);
            p.copy(a).add(b).add(c).divideScalar(3);
            const d2 = p.distanceToSquared(to);
            if (d2 < dstD2) {
                dstD2 = d2;
                e1.copy(b).sub(a); e2.copy(c).sub(a);
                dstNormal = e1.clone().cross(e2).normalize();
            }
        }
        if (srcNormal && dstNormal && srcNormal.dot(dstNormal) < Math.cos(Math.PI / 4)) {
            throw new Error("clone_paint: source and destination surfaces face "
                + "different directions (> 45°) — pure-translation cloning would "
                + "smear unrelated texture. Pick a source on a similarly-oriented "
                + "surface.");
        }

        // Snapshot the WHOLE canvas once (source rect may overlap destination).
        const snapshot = layer.ctx.getImageData(0, 0, layer.size, layer.size);
        const snap = snapshot.data;
        const dim = layer.size;

        // Sample source color at world point P' via the source triangles' UVs.
        const tri = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3() };
        const bary = new THREE.Vector3();
        const target = new THREE.Vector3();
        const sampleSource = (world) => {
            target.set(world[0] + offset.x, world[1] + offset.y, world[2] + offset.z);
            let bestD = Infinity, bestUV = null;
            const closest = new THREE.Vector3();
            const triangle = new THREE.Triangle();
            for (const t of srcTris) {
                const i0 = idxOf(t, 0), i1 = idxOf(t, 1), i2 = idxOf(t, 2);
                tri.a.fromBufferAttribute(pos, i0).applyMatrix4(m);
                tri.b.fromBufferAttribute(pos, i1).applyMatrix4(m);
                tri.c.fromBufferAttribute(pos, i2).applyMatrix4(m);
                triangle.set(tri.a, tri.b, tri.c);
                triangle.closestPointToPoint(target, closest);
                const d = closest.distanceToSquared(target);
                if (d < bestD) {
                    bestD = d;
                    triangle.getBarycoord(closest, bary);
                    const u = uvAttr.getX(i0) * bary.x + uvAttr.getX(i1) * bary.y + uvAttr.getX(i2) * bary.z;
                    const vv = uvAttr.getY(i0) * bary.x + uvAttr.getY(i1) * bary.y + uvAttr.getY(i2) * bary.z;
                    bestUV = [u, vv];
                }
            }
            if (!bestUV || bestD > radius * radius) return null;
            const [sx, sy] = uvToPixel(layer, bestUV[0], bestUV[1]);
            const px = Math.max(0, Math.min(dim - 1, Math.round(sx)));
            const py = Math.max(0, Math.min(dim - 1, Math.round(sy)));
            const o = (py * dim + px) * 4;
            return [snap[o], snap[o + 1], snap[o + 2]];
        };

        let minX = dim, maxX = 0, minY = dim, maxY = 0;
        for (const key of foot.keys()) {
            const px = key % dim, py = (key - px) / dim;
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
        const w = maxX - minX + 1;
        const img = layer.ctx.getImageData(minX, minY, w, maxY - minY + 1);
        const data = img.data;
        for (const [key, rec] of foot) {
            const color = sampleSource(rec.world);
            if (!color) continue;
            const px = key % dim, py = (key - px) / dim;
            const o = ((py - minY) * w + (px - minX)) * 4;
            const alpha = rec.alpha * strength;
            data[o] = Math.round(data[o] * (1 - alpha) + color[0] * alpha);
            data[o + 1] = Math.round(data[o + 1] * (1 - alpha) + color[1] * alpha);
            data[o + 2] = Math.round(data[o + 2] * (1 - alpha) + color[2] * alpha);
            data[o + 3] = 255;
            cloned++;
            alphaSum += alpha;
        }
        stashPaintPatch("clone_paint", layer, minX, minY, img.width, img.height);
        layer.ctx.putImageData(img, minX, minY);
        layer.texture.needsUpdate = true;
    }
    if (cloned === 0) {
        throw new Error("Clone brush landed nothing — check from/to (world coords "
            + "— use pick on a clean source area and on the defect) and radius; "
            + "clone_paint works within ONE object's texture."
            + wrongObjectHint(viewer, opts.to));
    }
    const entry = viewer._activeEntry();
    if (entry) entry.modified = true;
    viewer.invalidate();
    return { cloned, meanAlpha: Math.round((alphaSum / cloned) * 1000) / 1000 };
}

/** resize_texture — re-allocate the ACTIVE object's paint layers at a new size.
 *  filter:"smooth" (default) for downscale quality; "nearest" preserves crisp
 *  square-stamp edges on upscale. */
export function resizeTexture(viewer, opts = {}) {
    const meshes = activeMeshes(viewer);
    const size = opts.size;
    if (!(size >= 64 && size <= PAINT_MAX_SIZE)) {
        throw new Error(`resize_texture requires size 64..${PAINT_MAX_SIZE} `
            + "(or tiers low/medium/high/xhigh).");
    }
    const filter = opts.filter || "smooth";
    let resized = 0, before = null;
    for (const mesh of meshes) {
        const stash = mesh._mvOriginalMaterial || mesh.material;
        const material = Array.isArray(stash) ? null : stash;
        const layer = material && material.userData && material.userData._mvPaint;
        if (!layer || layer.size === size) continue;
        const delta = size * size - layer.size * layer.size;
        if (delta > 0 && paintTexelsAllocated + delta > PAINT_TEXEL_BUDGET) {
            throw new Error("Paint budget exceeded by the resize — clear_paint "
                + "unused layers or choose a smaller size.");
        }
        before = before || layer.size;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = filter !== "nearest";
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(layer.canvas, 0, 0, size, size);
        paintTexelsAllocated = Math.max(0, paintTexelsAllocated + delta);
        layer.texture.dispose();
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = layer.flipY;
        applyLayerFiltering(texture, size);
        material.map = texture;
        material.needsUpdate = true;
        Object.assign(layer, { canvas, ctx, texture, size });
        resized++;
    }
    if (resized === 0) {
        throw new Error("No paint layers to resize on the active object (paint/"
            + "fill_paint first; resize_texture only touches PAINT layers — "
            + "authored textures are downsampled at export instead).");
    }
    viewer.invalidate();
    return { resizedLayers: resized, from: before, to: size, ...paintBudgetInfo() };
}

/** Big layers skip mipmaps (SwiftShader: 33% memory tax + CPU mip-gen per upload). */
function applyLayerFiltering(texture, size) {
    if (size >= 2048) {
        texture.generateMipmaps = false;
        texture.minFilter = THREE.LinearFilter;
    }
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

/**
 * Deep-copy a cloned material's paint layer (clone_object support). Material
 * cloning copies userData by reference — without this, the clone would SHARE the
 * original's canvas and painting one would repaint both. Charges the texel
 * budget for the copy (two independent canvases genuinely cost double).
 */
export function clonePaintLayer(material) {
    const layer = material.userData && material.userData._mvPaint;
    if (!layer) return;
    if (paintTexelsAllocated + layer.size * layer.size > PAINT_TEXEL_BUDGET) {
        delete material.userData._mvPaint;
        material.map = layer.prevMap || null;
        throw new Error(
            "Paint memory budget exceeded while cloning paint layers — "
            + "clear_paint unused layers or resize_texture down, then clone.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = layer.size;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(layer.canvas, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = layer.flipY;
    if (layer.texture) {
        texture.wrapS = layer.texture.wrapS;
        texture.wrapT = layer.texture.wrapT;
    }
    material.map = texture;
    material.needsUpdate = true;
    paintTexelsAllocated += layer.size * layer.size;
    material.userData._mvPaint = {
        canvas, ctx, texture, size: layer.size, flipY: layer.flipY,
        prevMap: layer.prevMap, prevColor: layer.prevColor,
    };
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
        // UV at the hit — THE diagnostic for texture-to-mesh misalignment:
        // pick a 3D feature, then render_texture {marker: this uv} to SEE where
        // that surface point samples in texture space.
        uv: h.uv ? [r4(h.uv.x), r4(h.uv.y)] : null,
        distance: r4(h.distance),
        objectId: entry ? entry.id : null,
        objectName: entry ? entry.name : null,
    };
}

// ---------------------------------------------------------------------------
// Texture-space introspection + UV repair (backlog 047)
// ---------------------------------------------------------------------------

/**
 * Render the ACTIVE object's texture into a canvas: the texture image itself,
 * optionally the UV WIREFRAME overlaid (where the mesh actually samples), and
 * optional crosshair markers at given UVs. This is the agent's EYE in texture
 * space — a mesh-vs-texture misalignment is invisible in 3D renders alone but
 * obvious when the UV wireframe sits shifted against the texture features.
 */
export function renderTexture(viewer, opts = {}) {
    const meshes = activeMeshes(viewer);
    const size = Math.max(128, Math.min(2048, opts.size || 1024));
    // Find the first mesh whose material has a drawable map.
    let mesh = null, material = null, image = null;
    for (const m of meshes) {
        const stash = m._mvOriginalMaterial || m.material;
        const mat = Array.isArray(stash) ? stash[0] : stash;
        const img = mat && mat.map && mat.map.image;
        const drawable = img && ((typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement)
            || (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement)
            || (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap));
        if (drawable) { mesh = m; material = mat; image = img; break; }
    }
    if (!mesh) {
        throw new Error("No drawable texture on the active object (compressed "
            + "KTX2 or untextured). fill_paint first to create a readable layer.");
    }
    const flipY = material.map.flipY;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#222";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(image, 0, 0, size, size);

    // UV → canvas pixel (canvas row 0 = texture row 0; respect flipY so the
    // view matches how the texture is SAMPLED, not stored).
    const px = (u) => u * size;
    const py = (v) => (flipY ? (1 - v) : v) * size;

    if (opts.wireframe !== false) {
        const uv = mesh.geometry.getAttribute("uv");
        const index = mesh.geometry.getIndex();
        const pos = mesh.geometry.getAttribute("position");
        const triCount = Math.floor(index ? index.count / 3 : pos.count / 3);
        const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
        // Decimate the overlay above ~40k triangles (canvas line cost).
        const step = Math.max(1, Math.ceil(triCount / 40000));
        ctx.strokeStyle = "rgba(0, 255, 140, 0.28)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let t = 0; t < triCount; t += step) {
            const a = idxOf(t, 0), b = idxOf(t, 1), c = idxOf(t, 2);
            ctx.moveTo(px(uv.getX(a)), py(uv.getY(a)));
            ctx.lineTo(px(uv.getX(b)), py(uv.getY(b)));
            ctx.lineTo(px(uv.getX(c)), py(uv.getY(c)));
            ctx.closePath();
        }
        ctx.stroke();
    }
    // Chart outline: highlight the UV ISLAND containing a given point (orange)
    // — makes "which chart is this feature in" visible in a fragmented atlas.
    if (opts.outline_island_of) {
        const hit = islandAtUV(mesh, opts.outline_island_of);
        if (hit) {
            const { ofVertex } = uvIslands(mesh.geometry);
            const uv = mesh.geometry.getAttribute("uv");
            const index = mesh.geometry.getIndex();
            const pos = mesh.geometry.getAttribute("position");
            const triCount = Math.floor(index ? index.count / 3 : pos.count / 3);
            const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
            ctx.strokeStyle = "rgba(255, 160, 0, 0.9)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let t = 0; t < triCount; t++) {
                const a = idxOf(t, 0);
                if (ofVertex[a] !== hit.island) continue;
                const b2 = idxOf(t, 1), c2 = idxOf(t, 2);
                ctx.moveTo(px(uv.getX(a)), py(uv.getY(a)));
                ctx.lineTo(px(uv.getX(b2)), py(uv.getY(b2)));
                ctx.lineTo(px(uv.getX(c2)), py(uv.getY(c2)));
                ctx.closePath();
            }
            ctx.stroke();
        }
    }
    // Markers: open crosshair per given UV (from pick results). The center gap
    // keeps the measured texels VISIBLE (cycle-2: solid crosshairs occluded the
    // exact pixels being measured); labels optional and offset outside.
    const markers = opts.markers || (opts.marker ? [opts.marker] : []);
    const mr = Math.max(4, Math.min(60, opts.marker_size || 14));
    markers.forEach((m, i) => {
        const x = px(m[0]), y = py(m[1]);
        ctx.strokeStyle = "#ff3355";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, mr, 0, Math.PI * 2);
        // Crosshair arms START at the circle — the center stays unobscured.
        ctx.moveTo(x - mr * 1.7, y); ctx.lineTo(x - mr, y);
        ctx.moveTo(x + mr, y); ctx.lineTo(x + mr * 1.7, y);
        ctx.moveTo(x, y - mr * 1.7); ctx.lineTo(x, y - mr);
        ctx.moveTo(x, y + mr); ctx.lineTo(x, y + mr * 1.7);
        ctx.stroke();
        if (opts.labels !== false) {
            ctx.fillStyle = "#ff3355";
            ctx.font = "bold 15px monospace";
            ctx.fillText(`M${i} (${m[0].toFixed(3)}, ${m[1].toFixed(3)})`,
                         x + mr * 1.8, y - mr * 1.2);
        }
    });
    // Zoom crop: re-render a UV-space window scaled to the full output — the
    // measurement view for tiny charts in fragmented atlases.
    if (opts.crop_center) {
        const half = Math.max(0.01, Math.min(0.5, (opts.crop_size || 0.2) / 2));
        const cx = opts.crop_center[0], cy = opts.crop_center[1];
        const sxU = Math.max(0, Math.min(1 - 2 * half, cx - half));
        const syV = Math.max(0, Math.min(1 - 2 * half, cy - half));
        const sx = sxU * size;
        const sy = (flipY ? (1 - syV - 2 * half) : syV) * size;
        const crop = document.createElement("canvas");
        crop.width = crop.height = size;
        const cctx = crop.getContext("2d");
        cctx.imageSmoothingEnabled = false;
        cctx.drawImage(canvas, sx, sy, 2 * half * size, 2 * half * size, 0, 0, size, size);
        cctx.strokeStyle = "#ffd75e";
        cctx.font = "bold 14px monospace";
        cctx.fillStyle = "#ffd75e";
        cctx.fillText(`crop u:[${sxU.toFixed(3)}..${(sxU + 2 * half).toFixed(3)}] `
            + `v:[${syV.toFixed(3)}..${(syV + 2 * half).toFixed(3)}]`, 8, 18);
        return crop.toDataURL("image/png");
    }
    return canvas.toDataURL("image/png");
}

/**
 * UV ISLANDS (charts) of a geometry: triangles connected through shared RAW
 * vertex indices form one island — chart boundaries are exactly where vertices
 * are duplicated with different UVs. Cached on geometry.userData._mvUvIslands
 * (dies with geometry replacement, like the weld cache).
 * Returns { ofVertex: Int32Array (island id per raw vertex), count }.
 */
function uvIslands(geometry) {
    if (geometry.userData._mvUvIslands) return geometry.userData._mvUvIslands;
    const pos = geometry.getAttribute("position");
    const index = geometry.getIndex();
    const triCount = Math.floor(index ? index.count / 3 : pos.count / 3);
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const parent = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) parent[i] = i;
    const find = (x) => {
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    };
    for (let t = 0; t < triCount; t++) {
        const a = find(idxOf(t, 0));
        const b = find(idxOf(t, 1));
        const c = find(idxOf(t, 2));
        parent[b] = a;
        parent[c] = a;
    }
    const ofVertex = new Int32Array(pos.count);
    const idOf = new Map();
    for (let i = 0; i < pos.count; i++) {
        const root = find(i);
        let id = idOf.get(root);
        if (id === undefined) { id = idOf.size; idOf.set(root, id); }
        ofVertex[i] = id;
    }
    const islands = { ofVertex, count: idOf.size };
    geometry.userData._mvUvIslands = islands;
    return islands;
}

/** The island id whose UV-nearest vertex contains/borders the given UV point. */
function islandAtUV(mesh, uvPoint) {
    const geometry = mesh.geometry;
    const uv = geometry.getAttribute("uv");
    if (!uv) return null;
    const { ofVertex } = uvIslands(geometry);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < uv.count; i++) {
        const du = uv.getX(i) - uvPoint[0];
        const dv = uv.getY(i) - uvPoint[1];
        const d = du * du + dv * dv;
        if (d < bestD) { bestD = d; best = i; }
    }
    return best >= 0 ? { island: ofVertex[best], distance: Math.sqrt(bestD) } : null;
}

/** Low-res occupancy grid: island id per texel (−1 empty). For bleed checks. */
function islandOccupancy(mesh, res = 256) {
    const geometry = mesh.geometry;
    const uv = geometry.getAttribute("uv");
    const index = geometry.getIndex();
    const pos = geometry.getAttribute("position");
    const triCount = Math.floor(index ? index.count / 3 : pos.count / 3);
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const { ofVertex } = uvIslands(geometry);
    const grid = new Int32Array(res * res).fill(-1);
    for (let t = 0; t < triCount; t++) {
        const i0 = idxOf(t, 0), i1 = idxOf(t, 1), i2 = idxOf(t, 2);
        const island = ofVertex[i0];
        const xs = [uv.getX(i0) * res, uv.getX(i1) * res, uv.getX(i2) * res];
        const ys = [uv.getY(i0) * res, uv.getY(i1) * res, uv.getY(i2) * res];
        const minX = Math.max(0, Math.floor(Math.min(...xs)));
        const maxX = Math.min(res - 1, Math.ceil(Math.max(...xs)));
        const minY = Math.max(0, Math.floor(Math.min(...ys)));
        const maxY = Math.min(res - 1, Math.ceil(Math.max(...ys)));
        // Coarse fill of the triangle's bbox — adequate at 256² for a bleed
        // ESTIMATE (slightly over-marks, which errs on the safe side).
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                grid[y * res + x] = island;
            }
        }
    }
    return grid;
}

/**
 * Transform the ACTIVE object's UV coordinates — the REPAIR for texture-to-mesh
 * misalignment. uv' = pivot + (uv − pivot) · scale + offset.
 * island_of: [u,v] scopes the transform to ONE UV chart (the island containing
 * that point) — fragmented atlases (generated meshes) have per-chart warps
 * that no global affine can fix (cycle-1 forensic finding); moving only the
 * offending chart aligns its feature without dragging every other chart into
 * its neighbors' texels.
 */
export function transformUV(viewer, opts = {}) {
    assertNotSkinned(viewer);
    const meshes = activeMeshes(viewer);
    const offset = opts.offset || [0, 0];
    const scale = opts.scale || [1, 1];
    const pivot = opts.pivot || [0.5, 0.5];
    if (offset[0] === 0 && offset[1] === 0 && scale[0] === 1 && scale[1] === 1) {
        throw new Error("transform_uv needs a non-identity offset and/or scale.");
    }
    let count = 0, meshCount = 0;
    let islandInfo = null;
    const seen = new Set();
    for (const mesh of meshes) {
        if (seen.has(mesh.geometry)) continue;
        seen.add(mesh.geometry);
        const uv = mesh.geometry.getAttribute("uv");
        if (!uv) continue;
        let memberOf = null;
        if (opts.island_of) {
            const hit = islandAtUV(mesh, opts.island_of);
            if (!hit) continue;
            const { ofVertex, count: islandCount } = uvIslands(mesh.geometry);
            memberOf = (i) => ofVertex[i] === hit.island;
            let members = 0;
            for (let i = 0; i < uv.count; i++) if (memberOf(i)) members++;
            islandInfo = { island: hit.island, of: islandCount, vertices: members };
        }
        for (let i = 0; i < uv.count; i++) {
            if (memberOf && !memberOf(i)) continue;
            uv.setXY(i,
                pivot[0] + (uv.getX(i) - pivot[0]) * scale[0] + offset[0],
                pivot[1] + (uv.getY(i) - pivot[1]) * scale[1] + offset[1]);
            count++;
        }
        uv.needsUpdate = true;
        meshCount++;
    }
    if (meshCount === 0) throw new Error("Active object has no UV coordinates.");
    if (opts.island_of && count === 0) {
        throw new Error("No UV island found near island_of — pass a uv from pick.");
    }
    const entry = viewer._activeEntry();
    if (entry) {
        entry.modified = true;
        entry.geometryRev++;
    }
    viewer.invalidate();
    const result = {
        meshes: meshCount, uvsTransformed: count,
        offset, scale, pivot,
        note: "UV edits persist for the session and export with the model; "
            + "`reset` does NOT undo them (reload the file to restore). Verify "
            + "with render_texture/get_texture + a 3D screenshot.",
    };
    if (islandInfo) result.island = islandInfo;
    return result;
}

/**
 * DRY-RUN bleed check for a UV transform: how much of the transformed
 * region would land on texels currently occupied by OTHER islands (bleed) or
 * leave [0,1]² entirely. Run BEFORE transform_uv to make the alignment-vs-
 * bleed trade-off quantitative (cycle-1 ask: replaces probe-render-revert loops).
 */
export function previewUVTransform(viewer, opts = {}) {
    const meshes = activeMeshes(viewer);
    const offset = opts.offset || [0, 0];
    const scale = opts.scale || [1, 1];
    const pivot = opts.pivot || [0.5, 0.5];
    const res = 256;
    for (const mesh of meshes) {
        const uv = mesh.geometry.getAttribute("uv");
        if (!uv) continue;
        const grid = islandOccupancy(mesh, res);
        const { ofVertex } = uvIslands(mesh.geometry);
        let scopeIsland = null;
        if (opts.island_of) {
            const hit = islandAtUV(mesh, opts.island_of);
            if (!hit) continue;
            scopeIsland = hit.island;
        }
        let inside = 0, bleed = 0, out = 0;
        for (let i = 0; i < uv.count; i++) {
            if (scopeIsland !== null && ofVertex[i] !== scopeIsland) continue;
            const u2 = pivot[0] + (uv.getX(i) - pivot[0]) * scale[0] + offset[0];
            const v2 = pivot[1] + (uv.getY(i) - pivot[1]) * scale[1] + offset[1];
            if (u2 < 0 || u2 > 1 || v2 < 0 || v2 > 1) { out++; continue; }
            const cell = grid[Math.min(res - 1, Math.floor(v2 * res)) * res
                              + Math.min(res - 1, Math.floor(u2 * res))];
            const own = scopeIsland !== null ? scopeIsland : ofVertex[i];
            if (cell !== -1 && cell !== own) bleed++;
            else inside++;
        }
        const total = inside + bleed + out;
        if (total === 0) continue;
        const r3v = (x) => Math.round((x / total) * 1000) / 1000;
        // Thresholds calibrated by the cycle-2 field test: 7% bleed was already
        // disqualifying on a face close-up — "moderate" must start LOW.
        return {
            sampled: total,
            island: scopeIsland,
            clean: r3v(inside),
            bleedFraction: r3v(bleed),
            outOfBoundsFraction: r3v(out),
            verdict: bleed / total >= 0.08
                ? "HIGH bleed — this transform will visibly contaminate other charts"
                : bleed / total >= 0.02
                    ? "moderate bleed — visible on close inspection (faces: usually disqualifying)"
                    : "low bleed — safe to apply",
        };
    }
    throw new Error("Active object has no UV coordinates.");
}

/**
 * UV island statistics — run BEFORE planning island-scoped repairs: a
 * fragmented (photogrammetry-style) atlas with thousands of non-semantic
 * islands means feature≠island and UV surgery cannot succeed (cycle-2
 * falsification — "eye and mouth share island #40" was discovered only after
 * mutating; this query answers it in one call).
 */
export function getUVIslands(viewer, opts = {}) {
    const meshes = activeMeshes(viewer);
    const max = Math.max(1, Math.min(32, opts.max || 12));
    const r4 = (v) => Math.round(v * 10000) / 10000;
    for (const mesh of meshes) {
        const uv = mesh.geometry.getAttribute("uv");
        if (!uv) continue;
        const { ofVertex, count } = uvIslands(mesh.geometry);
        const sizes = new Map();
        for (let i = 0; i < ofVertex.length; i++) {
            sizes.set(ofVertex[i], (sizes.get(ofVertex[i]) || 0) + 1);
        }
        const stats = new Map();   // island -> {n, minU, maxU, minV, maxV}
        for (let i = 0; i < uv.count; i++) {
            const id = ofVertex[i];
            let s = stats.get(id);
            if (!s) {
                s = { n: 0, minU: 2, maxU: -1, minV: 2, maxV: -1 };
                stats.set(id, s);
            }
            s.n++;
            const u = uv.getX(i), v2 = uv.getY(i);
            if (u < s.minU) s.minU = u;
            if (u > s.maxU) s.maxU = u;
            if (v2 < s.minV) s.minV = v2;
            if (v2 > s.maxV) s.maxV = v2;
        }
        const largest = [...stats.entries()]
            .sort((a, b) => b[1].n - a[1].n)
            .slice(0, max)
            .map(([id, s]) => ({
                island: id, vertices: s.n,
                uvBbox: [r4(s.minU), r4(s.minV), r4(s.maxU), r4(s.maxV)],
            }));
        const result = { islandCount: count, totalVertices: ofVertex.length, largest };
        if (opts.at) {
            result.at = opts.at.map((uvPoint) => {
                const hit = islandAtUV(mesh, uvPoint);
                return hit
                    ? { uv: uvPoint, island: hit.island,
                        vertices: sizes.get(hit.island) || 0 }
                    : { uv: uvPoint, island: null };
            });
        }
        if (count > 500) {
            result.note = `FRAGMENTED atlas (${count} islands): features do not own `
                + "islands — island-scoped transform_uv will trade alignment for "
                + "seam blotches. Repair baked-in misalignment with project_paint "
                + "(moves TEXELS through screen space) instead.";
        }
        return result;
    }
    throw new Error("Active object has no UV coordinates.");
}

/**
 * PROJECT-PAINT — texture repair through SCREEN space (the correct fix for
 * baked-in misalignment on fragmented atlases, where texel↔feature
 * correspondence exists only on the SURFACE, never in UV space).
 *
 * Renders the CURRENT camera view, then for every texel in the world-space
 * brush: project its surface point to the screen, sample the render at
 * (screen + screen_offset), write back to the texel. Shifting the sampling by
 * +y pixels visually slides the painted content DOWN the surface — regardless
 * of how many UV islands the region shatters into.
 *
 * v1 caveats (documented in the command): occlusion is ignored (use on convex,
 * camera-facing regions — faces from the front are ideal) and the current
 * shading is baked into the copied texels (use the "neutral" preset first).
 */
export async function projectPaint(viewer, opts = {}) {
    assertNotSkinned(viewer);
    const meshes = activeMeshes(viewer);
    const radius = resolveRadius(viewer, opts, "project_paint");
    if (!opts.center || opts.center.length !== 3) {
        throw new Error("project_paint requires center: [x,y,z] (world — use pick).");
    }
    const center = new THREE.Vector3(...opts.center);
    let so = opts.screen_offset || [0, 0];
    const hasSurface = Array.isArray(opts.surface_offset)
        && (opts.surface_offset[0] !== 0 || opts.surface_offset[1] !== 0);
    if (!hasSurface && so[0] === 0 && so[1] === 0) {
        throw new Error("project_paint needs a non-zero screen_offset [dx, dy] "
            + "(pixels in the 1024×1024 projection view) OR surface_offset "
            + "[right, down] (world units — camera-independent; +down slides "
            + "content down the surface).");
    }
    const strength = opts.strength !== undefined ? Math.max(0, Math.min(1, opts.strength)) : 1;
    const falloffFn = FALLOFFS[opts.falloff || "smooth"] || FALLOFFS.smooth;
    const S = 1024;

    // Source: the current view at square aspect, no helpers/ground.
    const dataUrl = viewer.captureImage({ width: S, height: S, hideGround: true });
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = srcCanvas.height = S;
    const srcCtx = srcCanvas.getContext("2d");
    await new Promise((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => { srcCtx.drawImage(img, 0, 0); resolve(); };
        img.onerror = reject;
        img.src = dataUrl;
    });
    const src = srcCtx.getImageData(0, 0, S, S).data;

    // Projection matches the capture: aspect 1.
    const cam = viewer._camera;
    const prevAspect = cam.aspect;
    cam.aspect = 1;
    cam.updateProjectionMatrix();
    const view = cam.matrixWorldInverse.clone();
    const proj = cam.projectionMatrix.clone();
    cam.aspect = prevAspect;
    cam.updateProjectionMatrix();
    const toScreen = (world, out) => {
        out.copy(world).applyMatrix4(view).applyMatrix4(proj);
        return [(out.x * 0.5 + 0.5) * S, (1 - (out.y * 0.5 + 0.5)) * S];
    };

    let painted = 0, alphaSum = 0;
    const tmp = new THREE.Vector3();

    // surface_offset: WORLD units → pixels at the brush depth. Camera-independent:
    // the same correction magnitude from any framing (cycle-4 friction — a 25px
    // front-view offset became 60px in a close-up).
    if (hasSurface) {
        const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
        const [cx, cy] = toScreen(center, tmp);
        const [rx, ry] = toScreen(center.clone().add(camRight), tmp);
        const pxPerUnit = Math.hypot(rx - cx, ry - cy);
        if (pxPerUnit < 1e-6) {
            throw new Error("Cannot derive the pixel scale at this brush depth — "
                + "is the brush center behind the camera?");
        }
        so = [opts.surface_offset[0] * pxPerUnit, opts.surface_offset[1] * pxPerUnit];
    }
    const world = new THREE.Vector3();
    for (const mesh of meshes) {
        if (!mesh.geometry.getAttribute("uv")) continue;
        const layer = ensureRepairableLayer(viewer, mesh, opts.texture_size);
        const foot = brushFootprint(mesh, layer, center, radius,
            opts.hardness !== undefined ? opts.hardness : 0.5, falloffFn);
        if (!foot || foot.size === 0) continue;
        const dim = layer.size;
        let minX = dim, maxX = 0, minY = dim, maxY = 0;
        for (const key of foot.keys()) {
            const px = key % dim, py = (key - px) / dim;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }
        const w = maxX - minX + 1;
        const img = layer.ctx.getImageData(minX, minY, w, maxY - minY + 1);
        const data = img.data;
        for (const [key, rec] of foot) {
            world.set(rec.world[0], rec.world[1], rec.world[2]);
            const [sx, sy] = toScreen(world, tmp);
            const qx = Math.round(sx + so[0]);
            const qy = Math.round(sy + so[1]);
            if (qx < 0 || qx >= S || qy < 0 || qy >= S) continue;
            const o = ((key - (key % dim)) / dim - minY) * w + (key % dim) - minX;
            const so4 = (qy * S + qx) * 4;
            const alpha = rec.alpha * strength;
            data[o * 4] = Math.round(data[o * 4] * (1 - alpha) + src[so4] * alpha);
            data[o * 4 + 1] = Math.round(data[o * 4 + 1] * (1 - alpha) + src[so4 + 1] * alpha);
            data[o * 4 + 2] = Math.round(data[o * 4 + 2] * (1 - alpha) + src[so4 + 2] * alpha);
            data[o * 4 + 3] = 255;
            painted++;
            alphaSum += alpha;
        }
        layer.ctx.putImageData(img, minX, minY);
        layer.texture.needsUpdate = true;
    }
    if (painted === 0) {
        throw new Error("Projection brush landed nothing — check center/radius "
            + "and make sure the region faces the CURRENT camera."
            + wrongObjectHint(viewer, opts.center));
    }
    const entry = viewer._activeEntry();
    if (entry) entry.modified = true;
    viewer.invalidate();
    return {
        painted,
        meanAlpha: Math.round((alphaSum / painted) * 1000) / 1000,
        screenOffset: so,
        note: "Copied texels include the CURRENT shading (capture under the "
            + "'neutral' preset to minimize baked lighting) and occlusion is "
            + "ignored — verify with a fresh screenshot.",
    };
}
