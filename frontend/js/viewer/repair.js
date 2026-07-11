/**
 * Mesh + texture inspection and repair (backlog 046, track ii).
 *
 * simplify_region uses a REGION-RESTRICTED Melax-style edge collapse with real
 * locked vertices — r170's SimplifyModifier has no boundary locking (its border
 * "preservation" is a soft cost that erodes under averaged-cost selection), so
 * a compact constrained collapse is implemented here instead. Key invariant
 * (verified against the Melax design): a collapse NEVER MOVES a surviving
 * vertex — u is removed, its faces rewire onto v, v keeps position AND UV.
 * Locked vertices may RECEIVE collapses but are never moved/removed, so the
 * region boundary stays bit-exact (no cracks) and the paint layer needs no
 * touch-up (texels don't move; only interpolation across bigger triangles).
 */

import * as THREE from "three";
import { ensureMutable } from "./sculpt.js";

const REGION_VERTEX_CAP = 50000;
const INSPECT_TRIANGLE_BUDGET = 300000;

const r3 = (v) => Math.round(v * 1000) / 1000;
const r1 = (v) => Math.round(v * 10) / 10;

function requireActive(viewer) {
    const entry = viewer._activeEntry();
    if (!entry) throw new Error("No object loaded. load / add_model / add_primitive first.");
    if (entry.skinned) {
        throw new Error("Mesh repair on skinned (rigged) models is not supported — "
            + "vertex/topology edits corrupt the bind pose.");
    }
    if (viewer._timeline && viewer._timeline.playing) {
        throw new Error("The timeline is PLAYING — pause_timeline before mesh edits.");
    }
    return entry;
}

function meshesOf(entry) {
    const meshes = [];
    entry.model.traverse((c) => { if (c.isMesh && c.geometry) meshes.push(c); });
    return meshes;
}

function triCountOf(geometry) {
    const index = geometry.getIndex();
    const pos = geometry.getAttribute("position");
    return Math.floor(index ? index.count / 3 : (pos ? pos.count / 3 : 0));
}

function resolveRadius(viewer, opts, command) {
    if (opts.radius > 0) return opts.radius;
    if (opts.radius_rel > 0) {
        const box = new THREE.Box3().setFromObject(viewer._currentModel);
        const sphereR = box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length() / 2;
        if (sphereR > 0) return opts.radius_rel * sphereR;
    }
    throw new Error(`${command} requires radius > 0 (world units) or radius_rel > 0.`);
}

/** Relative-tolerance position weld map for one geometry. */
function weldMap(geometry) {
    const pos = geometry.getAttribute("position");
    geometry.computeBoundingBox();
    const diag = geometry.boundingBox
        ? geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1 : 1;
    const quant = diag * 1e-6;
    const byKey = new Map();
    const canonical = new Int32Array(pos.count);
    const members = new Map();
    for (let i = 0; i < pos.count; i++) {
        const k = `${Math.round(pos.getX(i) / quant)}_${Math.round(pos.getY(i) / quant)}_${Math.round(pos.getZ(i) / quant)}`;
        const seen = byKey.get(k);
        canonical[i] = seen !== undefined ? seen : (byKey.set(k, i), i);
        let list = members.get(canonical[i]);
        if (!list) { list = []; members.set(canonical[i], list); }
        list.push(i);
    }
    return { canonical, members };
}

// ---------------------------------------------------------------------------
// simplify_region — boundary-locked, region-restricted edge collapse
// ---------------------------------------------------------------------------

/**
 * Constrained Melax collapse on a triangle subset.
 * @param positions Float32Array-backed accessor (raw vertex indices)
 * @param tris      triangle list [[a,b,c], ...] (raw indices)
 * @param locked    Set of raw vertex indices that must never move/disappear
 * @param keepRatio fraction of UNLOCKED vertices to keep
 * @returns surviving triangle list (raw indices)
 */
function collapseRegion(posAttr, tris, locked, keepRatio) {
    // Adjacency + face lists per vertex (raw indices — seams were pre-locked).
    const faces = tris.map((t, i) => ({ v: [t[0], t[1], t[2]], alive: true, id: i }));
    const vertFaces = new Map();
    const neighbors = new Map();
    const link = (a, b) => {
        let s = neighbors.get(a);
        if (!s) { s = new Set(); neighbors.set(a, s); }
        s.add(b);
    };
    for (const f of faces) {
        for (let k = 0; k < 3; k++) {
            const a = f.v[k], b = f.v[(k + 1) % 3];
            link(a, b); link(b, a);
            let list = vertFaces.get(a);
            if (!list) { list = []; vertFaces.set(a, list); }
            list.push(f);
        }
    }
    const vp = (i, out) => out.fromBufferAttribute(posAttr, i);
    const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
    const _ab = new THREE.Vector3(), _cb = new THREE.Vector3();

    const faceNormal = (f, out) => {
        vp(f.v[0], _a); vp(f.v[1], _b); vp(f.v[2], _c);
        _cb.subVectors(_c, _b); _ab.subVectors(_a, _b);
        return out.copy(_cb.cross(_ab)).normalize();
    };

    // Melax edge cost: edgelength × curvature (dihedral-based).
    const nu = new THREE.Vector3(), nf = new THREE.Vector3();
    const edgeCost = (u, v) => {
        const len = vp(u, _a).distanceTo(vp(v, _b));
        let curvature = 0;
        const uFaces = (vertFaces.get(u) || []).filter((f) => f.alive);
        const sideFaces = uFaces.filter((f) => f.v.includes(v));
        for (const f of uFaces) {
            let minCurv = 1;
            faceNormal(f, nf);
            for (const sf of sideFaces) {
                const dot = nf.dot(faceNormal(sf, nu));
                minCurv = Math.min(minCurv, (1 - dot) / 2);
            }
            curvature = Math.max(curvature, minCurv);
        }
        if (sideFaces.length < 2) curvature = 1;   // region-internal border
        return len * curvature;
    };

    const best = new Map();   // u -> {v, cost}
    const computeVertexCost = (u) => {
        if (locked.has(u)) { best.delete(u); return; }
        const ns = neighbors.get(u);
        if (!ns || ns.size === 0) { best.set(u, { v: null, cost: -0.01 }); return; }
        let bv = null, bc = Infinity;
        for (const v of ns) {
            const c = edgeCost(u, v);
            if (c < bc) { bc = c; bv = v; }
        }
        best.set(u, { v: bv, cost: bc });
    };

    const unlocked = [...neighbors.keys()].filter((v) => !locked.has(v));
    for (const u of unlocked) computeVertexCost(u);

    const targetRemovals = Math.floor(unlocked.length * (1 - keepRatio));
    let removed = 0;
    while (removed < targetRemovals) {
        // Cheapest candidate (linear scan — region is capped at 50k verts).
        let u = null, rec = null;
        for (const [cu, crec] of best) {
            if (!rec || crec.cost < rec.cost) { u = cu; rec = crec; }
        }
        if (u === null || !Number.isFinite(rec.cost)) break;
        const v = rec.v;
        best.delete(u);
        if (v === null) { removed++; continue; }

        // Collapse u -> v: v NEVER MOVES (boundary-exactness invariant).
        const uFaces = (vertFaces.get(u) || []).filter((f) => f.alive);
        const affected = new Set([v]);
        for (const f of uFaces) {
            if (f.v.includes(v)) {
                f.alive = false;   // face straddling the edge degenerates
            } else {
                for (let k = 0; k < 3; k++) if (f.v[k] === u) f.v[k] = v;
                let list = vertFaces.get(v);
                if (!list) { list = []; vertFaces.set(v, list); }
                list.push(f);
            }
            for (const w of f.v) affected.add(w);
        }
        // Rewire adjacency.
        const uN = neighbors.get(u) || new Set();
        for (const w of uN) {
            neighbors.get(w).delete(u);
            if (w !== v) { link(v, w); link(w, v); }
            affected.add(w);
        }
        neighbors.delete(u);
        vertFaces.delete(u);
        removed++;
        for (const w of affected) {
            if (!locked.has(w) && neighbors.has(w)) computeVertexCost(w);
        }
    }
    return { tris: faces.filter((f) => f.alive).map((f) => f.v), removed };
}

/**
 * simplify_region — decimate ONLY the brush region of the ACTIVE object.
 * Boundary ring, mesh borders and seam welds are LOCKED (no cracks, no seam
 * tears); ratio = fraction of region (unlocked) vertices to KEEP.
 */
export function simplifyRegion(viewer, opts = {}) {
    const entry = requireActive(viewer);
    const radius = resolveRadius(viewer, opts, "simplify_region");
    const ratio = opts.ratio;
    if (!(ratio > 0 && ratio < 1)) {
        throw new Error("simplify_region requires ratio in (0,1) — the fraction of "
            + "region vertices to KEEP (0.25 ≈ 4× coarser).");
    }
    const center = new THREE.Vector3(...(opts.center || []));
    if (!opts.center || opts.center.length !== 3) {
        throw new Error("simplify_region requires center: [x,y,z] (world — use "
            + "pick, raycast, inspect_region or get_bounds).");
    }

    const meshes = meshesOf(entry);
    entry.model.updateMatrixWorld(true);
    const r2 = radius * radius;
    let before = 0, after = 0, removedVerts = 0;
    let lockedRing = 0, lockedSeams = 0, lockedBorders = 0;
    const seenGeometries = new Set();
    const v = new THREE.Vector3();

    for (const mesh of meshes) {
        if (seenGeometries.has(mesh.geometry)) continue;   // instancing dedup
        seenGeometries.add(mesh.geometry);
        ensureMutable(mesh.geometry);
        const geometry = mesh.geometry;
        const pos = geometry.getAttribute("position");
        const index = geometry.getIndex();
        const triCount = triCountOf(geometry);
        const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
        const m = mesh.matrixWorld;

        // Select triangles whose ALL THREE vertices are inside the brush
        // (straddlers stay exterior — the ring lands inside the brush).
        const inside = new Uint8Array(pos.count);
        for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(m);
            if (v.distanceToSquared(center) <= r2) inside[i] = 1;
        }
        const selected = [];
        const rest = [];
        for (let t = 0; t < triCount; t++) {
            const a = idxOf(t, 0), b = idxOf(t, 1), c = idxOf(t, 2);
            if (inside[a] && inside[b] && inside[c]) selected.push([a, b, c]);
            else rest.push([a, b, c]);
        }
        if (selected.length < 8) continue;

        const regionVerts = new Set();
        for (const t of selected) for (const vi of t) regionVerts.add(vi);
        if (regionVerts.size > REGION_VERTEX_CAP) {
            throw new Error(`Region covers ${regionVerts.size.toLocaleString()} vertices `
                + `(> ${REGION_VERTEX_CAP.toLocaleString()} cap) — reduce the radius, `
                + "or use `simplify` for whole-model decimation.");
        }

        // Locks: (a) ring — region verts also used by exterior triangles;
        // (b) seam welds — multi-member welds (UV seams / normal creases);
        // (c) OPEN-BOUNDARY rims — vertices on edges with only one face in the
        //     WHOLE mesh (split-cut rims, open bottoms). A cost-function
        //     deterrent is NOT enough: decimating the two sides of a cut
        //     independently makes the rims diverge into visible gashes with no
        //     warning (T3 gauntlet finding — the last silent-corruption path).
        const locked = new Set();
        for (const t of rest) {
            for (const vi of t) if (regionVerts.has(vi)) { locked.add(vi); }
        }
        lockedRing += locked.size;
        const { canonical, members } = weldMap(geometry);
        for (const list of members.values()) {
            if (list.length > 1) {
                for (const vi of list) {
                    if (regionVerts.has(vi) && !locked.has(vi)) {
                        locked.add(vi);
                        lockedSeams++;
                    }
                }
            }
        }
        // Global open-edge scan (welded), then lock every region vertex whose
        // weld participates in an open edge.
        const { edgeCount } = meshTopology(geometry, new Map());
        const openCanon = new Set();
        for (const [key, count] of edgeCount) {
            if (count !== 1) continue;
            openCanon.add(Math.floor(key / 16777216));
            openCanon.add(key % 16777216);
        }
        for (const vi of regionVerts) {
            if (!locked.has(vi) && openCanon.has(canonical[vi])) {
                locked.add(vi);
                lockedBorders++;
            }
        }

        before += selected.length;
        const { tris: survivors, removed } = collapseRegion(pos, selected, locked, ratio);
        after += survivors.length;
        removedVerts += removed;

        // Stitch: exterior triangles + surviving region triangles, compacted.
        const newIndex = [];
        for (const t of rest) newIndex.push(t[0], t[1], t[2]);
        for (const t of survivors) newIndex.push(t[0], t[1], t[2]);
        const remap = new Map();
        const compact = new Array(newIndex.length);
        for (let i = 0; i < newIndex.length; i++) {
            const vi = newIndex[i];
            let ni = remap.get(vi);
            if (ni === undefined) { ni = remap.size; remap.set(vi, ni); }
            compact[i] = ni;
        }
        const geo = new THREE.BufferGeometry();
        for (const name of Object.keys(geometry.attributes)) {
            const attr = geometry.getAttribute(name);
            const out = new Float32Array(remap.size * attr.itemSize);
            for (const [vi, ni] of remap) {
                for (let c = 0; c < attr.itemSize; c++) {
                    out[ni * attr.itemSize + c] = attr.getComponent(vi, c);
                }
            }
            geo.setAttribute(name, new THREE.BufferAttribute(out, attr.itemSize));
        }
        geo.setIndex(compact);
        // Local normals: interior surviving vertices get recomputed normals from
        // the new faces; ring/exterior keep originals (copied above) — shading
        // continuity across the ring beats interior consistency. Approximation:
        // recompute only when normals existed.
        if (geo.getAttribute("normal")) {
            recomputeInteriorNormals(geo, remap, locked);
        }
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        mesh.geometry.dispose();
        mesh.geometry = geo;
    }

    if (before === 0) {
        throw new Error("Brush region contains no fully-inside triangles — check "
            + "center (world coords — use pick or inspect_region) and radius, or "
            + "enlarge the radius (straddling triangles don't count).");
    }

    // Geometry replaced: snapshot baseline moves, partitions invalidate.
    const hadEdits = !!entry.originalState;
    entry.originalState = null;
    entry.geometryRev++;
    entry._partition = null;
    entry.modified = true;
    entry.sculpted = true;
    entry.stats = viewer._computeStats(entry.model);
    viewer._lastStats = entry.stats;
    viewer.invalidate();

    // The baseline warning is only true when a baseline existed (T2 finding:
    // boilerplate on a pristine mesh is misleading noise).
    let note = "Boundary ring locked — no cracks; seam welds and open rims "
        + "(cut edges) locked (hard-edged/seam-dense regions decimate less "
        + "than requested).";
    if (hadEdits) {
        note = "reset baseline moved: earlier sculpt/bake edits are now permanent. " + note;
    }
    return {
        region: { trianglesBefore: before, trianglesAfter: after },
        object: { triangles: entry.stats.faces },
        requestedRatio: ratio,
        achievedRatio: before ? r3(after / before) : 1,
        locked: { ring: lockedRing, seams: lockedSeams, borders: lockedBorders },
        verticesRemoved: removedVerts,
        note,
    };
}

/** Area-weighted normals for interior (non-locked) vertices of a compacted geometry. */
function recomputeInteriorNormals(geo, remap, lockedRaw) {
    const lockedNew = new Set();
    for (const [vi, ni] of remap) if (lockedRaw.has(vi)) lockedNew.add(ni);
    const pos = geo.getAttribute("position");
    const nor = geo.getAttribute("normal");
    const index = geo.getIndex();
    const acc = new Float32Array(pos.count * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const cb = new THREE.Vector3(), ab = new THREE.Vector3();
    for (let i = 0; i < index.count; i += 3) {
        const ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2);
        a.fromBufferAttribute(pos, ia);
        b.fromBufferAttribute(pos, ib);
        c.fromBufferAttribute(pos, ic);
        cb.subVectors(c, b); ab.subVectors(a, b); cb.cross(ab);
        for (const vi of [ia, ib, ic]) {
            acc[vi * 3] += cb.x; acc[vi * 3 + 1] += cb.y; acc[vi * 3 + 2] += cb.z;
        }
    }
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
        if (lockedNew.has(i)) continue;   // ring keeps its original shading
        n.set(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]);
        if (n.lengthSq() > 1e-12) {
            n.normalize();
            nor.setXYZ(i, n.x, n.y, n.z);
        }
    }
    nor.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// fix_mesh — targeted repair passes
// ---------------------------------------------------------------------------

/** Count degenerate triangles + boundary edges of one geometry (welded).
 *
 *  openEdges counts edges over ALL triangles — INCLUDING degenerates — so the
 *  number agrees with get_mesh_stats on the same mesh (T2 finding: excluding
 *  degenerates here read 439 while stats read 0 for the identical geometry).
 *  Dropping degenerates (fix_mesh) then HONESTLY raises openEdges: the crack
 *  was real, previously bridged by zero-area faces. */
function meshIssueCounts(geometry) {
    const pos = geometry.getAttribute("position");
    const index = geometry.getIndex();
    const triCount = triCountOf(geometry);
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const { canonical } = weldMap(geometry);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const cb = new THREE.Vector3(), ab = new THREE.Vector3();
    geometry.computeBoundingBox();
    const diag = geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1;
    const minArea = (diag * 1e-7) ** 2;
    let degenerate = 0;
    const edges = new Map();
    for (let t = 0; t < triCount; t++) {
        const raw = [idxOf(t, 0), idxOf(t, 1), idxOf(t, 2)];
        const cs = raw.map((vi) => canonical[vi]);
        let isDegenerate = cs[0] === cs[1] || cs[1] === cs[2] || cs[0] === cs[2];
        if (!isDegenerate) {
            a.fromBufferAttribute(pos, raw[0]);
            b.fromBufferAttribute(pos, raw[1]);
            c.fromBufferAttribute(pos, raw[2]);
            cb.subVectors(c, b); ab.subVectors(a, b);
            isDegenerate = cb.cross(ab).lengthSq() / 4 < minArea;
        }
        if (isDegenerate) degenerate++;
        for (let k = 0; k < 3; k++) {
            const e1 = Math.min(cs[k], cs[(k + 1) % 3]);
            const e2 = Math.max(cs[k], cs[(k + 1) % 3]);
            if (e1 === e2) continue;   // collapsed edge of a topological degenerate
            const key = e1 * 16777216 + e2;
            edges.set(key, (edges.get(key) || 0) + 1);
        }
    }
    let openEdges = 0;
    for (const n of edges.values()) if (n === 1) openEdges++;
    return { degenerate, openEdges };
}

/** Signed volume of one geometry (origin-based; valid comparison for closed). */
function signedVolume(geometry) {
    const pos = geometry.getAttribute("position");
    const index = geometry.getIndex();
    const triCount = triCountOf(geometry);
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let vol = 0;
    for (let t = 0; t < triCount; t++) {
        a.fromBufferAttribute(pos, idxOf(t, 0));
        b.fromBufferAttribute(pos, idxOf(t, 1));
        c.fromBufferAttribute(pos, idxOf(t, 2));
        vol += a.dot(b.clone().cross(c)) / 6;
    }
    return vol;
}

/**
 * fix_mesh — safe repair passes on the ACTIVE object.
 * operations: degenerate (drop zero-area/collapsed triangles), normals
 * (recompute vertex normals), flipped_faces (OPT-IN: per-MESH winding reversal,
 * only when closed and signed volume < 0). Returns per-op + issue deltas.
 */
export function fixMesh(viewer, opts = {}) {
    const entry = requireActive(viewer);
    const requested = opts.operations || ["degenerate", "normals"];
    const valid = ["degenerate", "normals", "flipped_faces"];
    for (const op of requested) {
        if (!valid.includes(op)) {
            throw new Error(`Unknown operation '${op}'. Use: ${valid.join(", ")} `
                + "(flipped_faces is opt-in — per-mesh winding reversal on closed "
                + "meshes with negative signed volume).");
        }
    }
    const meshes = meshesOf(entry);
    const beforeCounts = meshes.map((m) => meshIssueCounts(m.geometry));
    const operations = [];
    let changed = false;

    if (requested.includes("degenerate")) {
        let dropped = 0;
        for (const mesh of meshes) {
            ensureMutable(mesh.geometry);
            const geometry = mesh.geometry;
            const pos = geometry.getAttribute("position");
            const index = geometry.getIndex();
            const triCount = triCountOf(geometry);
            const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
            const { canonical } = weldMap(geometry);
            geometry.computeBoundingBox();
            const diag = geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1;
            const minArea = (diag * 1e-7) ** 2;
            const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
            const cb = new THREE.Vector3(), ab = new THREE.Vector3();
            const keep = [];
            for (let t = 0; t < triCount; t++) {
                const raw = [idxOf(t, 0), idxOf(t, 1), idxOf(t, 2)];
                const cs = raw.map((vi) => canonical[vi]);
                let bad = cs[0] === cs[1] || cs[1] === cs[2] || cs[0] === cs[2];
                if (!bad) {
                    a.fromBufferAttribute(pos, raw[0]);
                    b.fromBufferAttribute(pos, raw[1]);
                    c.fromBufferAttribute(pos, raw[2]);
                    cb.subVectors(c, b); ab.subVectors(a, b);
                    bad = cb.cross(ab).lengthSq() / 4 < minArea;
                }
                if (bad) dropped++;
                else keep.push(raw[0], raw[1], raw[2]);
            }
            if (keep.length / 3 !== triCount) {
                geometry.setIndex(keep);
                changed = true;
            }
        }
        operations.push({ op: "degenerate", trianglesDropped: dropped });
    }

    if (requested.includes("flipped_faces")) {
        let flippedMeshes = 0;
        for (const mesh of meshes) {
            const counts = meshIssueCounts(mesh.geometry);
            if (counts.openEdges > 0) continue;   // only closed meshes are decidable
            if (signedVolume(mesh.geometry) < 0) {
                const geometry = mesh.geometry;
                const index = geometry.getIndex();
                if (index) {
                    for (let i = 0; i < index.count; i += 3) {
                        const tmp = index.getX(i + 1);
                        index.setX(i + 1, index.getX(i + 2));
                        index.setX(i + 2, tmp);
                    }
                    index.needsUpdate = true;
                    geometry.computeVertexNormals();
                    flippedMeshes++;
                    changed = true;
                }
            }
        }
        operations.push({ op: "flipped_faces", meshesFlipped: flippedMeshes });
    }

    if (requested.includes("normals")) {
        for (const mesh of meshes) {
            mesh.geometry.computeVertexNormals();
        }
        operations.push({ op: "normals", meshes: meshes.length });
        changed = true;
    }

    const afterCounts = meshes.map((m) => meshIssueCounts(m.geometry));
    const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
    if (changed) {
        entry.originalState = null;
        entry.geometryRev++;
        entry._partition = null;
        entry.modified = true;
        entry.sculpted = true;
        entry.stats = viewer._computeStats(entry.model);
        viewer._lastStats = entry.stats;
        viewer.invalidate();
    }
    return {
        operations,
        issues: {
            openEdges: { before: sum(beforeCounts, "openEdges"), after: sum(afterCounts, "openEdges") },
            degenerate: { before: sum(beforeCounts, "degenerate"), after: sum(afterCounts, "degenerate") },
        },
    };
}

// ---------------------------------------------------------------------------
// inspect_region — the observation that makes adaptive simplification decidable
// ---------------------------------------------------------------------------

/** Welded topology of one geometry, cached per inspect call (grid mode probes
 *  up to 125 cells — rebuilding the weld/edge maps per cell would be O(n³·V)). */
function meshTopology(geometry, cache) {
    let topo = cache.get(geometry);
    if (topo) return topo;
    const { canonical } = weldMap(geometry);
    const index = geometry.getIndex();
    const triCount = triCountOf(geometry);
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const edgeCount = new Map();
    for (let t = 0; t < triCount; t++) {
        const cs = [canonical[idxOf(t, 0)], canonical[idxOf(t, 1)], canonical[idxOf(t, 2)]];
        for (let k = 0; k < 3; k++) {
            const e1 = Math.min(cs[k], cs[(k + 1) % 3]);
            const e2 = Math.max(cs[k], cs[(k + 1) % 3]);
            if (e1 === e2) continue;
            const key = e1 * 16777216 + e2;
            edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
        }
    }
    topo = { canonical, edgeCount };
    cache.set(geometry, topo);
    return topo;
}

function regionStats(viewer, entry, center, radius, topoCache = new Map()) {
    const meshes = meshesOf(entry);
    entry.model.updateMatrixWorld(true);
    const r2 = radius * radius;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    const cb = new THREE.Vector3(), ab = new THREE.Vector3();
    let triangles = 0, area = 0;
    const openEdgeKeys = new Set();
    const edgeLens = [];
    const dihedrals = [];
    const seen = new Set();
    for (const mesh of meshes) {
        if (seen.has(mesh.geometry)) continue;
        seen.add(mesh.geometry);
        const geometry = mesh.geometry;
        const pos = geometry.getAttribute("position");
        const index = geometry.getIndex();
        const triCount = triCountOf(geometry);
        const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
        const m = mesh.matrixWorld;
        const normals = new Map();   // welded edge -> [normal...] (region-local)
        // GLOBAL welded edge counts: an edge is a true crack only if it borders
        // ONE triangle in the WHOLE mesh — counting region-local edges reported
        // every region-perimeter edge as "open" (T2's three-truths finding).
        const { canonical, edgeCount } = meshTopology(geometry, topoCache);
        for (let t = 0; t < triCount; t++) {
            const ia = idxOf(t, 0), ib = idxOf(t, 1), ic = idxOf(t, 2);
            a.fromBufferAttribute(pos, ia).applyMatrix4(m);
            b.fromBufferAttribute(pos, ib).applyMatrix4(m);
            c.fromBufferAttribute(pos, ic).applyMatrix4(m);
            centroid.copy(a).add(b).add(c).divideScalar(3);
            if (centroid.distanceToSquared(center) > r2) continue;
            triangles++;
            cb.subVectors(c, b); ab.subVectors(a, b);
            const cross = cb.clone().cross(ab);
            area += cross.length() / 2;
            edgeLens.push(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
            const n = cross.normalize().clone();
            const cs = [canonical[ia], canonical[ib], canonical[ic]];
            for (let k = 0; k < 3; k++) {
                const e1 = Math.min(cs[k], cs[(k + 1) % 3]);
                const e2 = Math.max(cs[k], cs[(k + 1) % 3]);
                if (e1 === e2) continue;
                const key = e1 * 16777216 + e2;
                if (edgeCount.get(key) === 1) openEdgeKeys.add(key);
                let list = normals.get(key);
                if (!list) { list = []; normals.set(key, list); }
                list.push(n);
            }
        }
        for (const list of normals.values()) {
            if (list.length === 2) {
                const dot = Math.max(-1, Math.min(1, list[0].dot(list[1])));
                dihedrals.push(Math.acos(dot) * 180 / Math.PI);
            }
        }
    }
    edgeLens.sort((x, y) => x - y);
    const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
    const dihedralMean = dihedrals.length
        ? dihedrals.reduce((s, x) => s + x, 0) / dihedrals.length : 0;
    return {
        triangles,
        surfaceArea: r3(area),
        triPerUnit2: area > 0 ? Math.round(triangles / area) : 0,
        edgeLength: { min: r3(pct(edgeLens, 0)), median: r3(pct(edgeLens, 0.5)), p95: r3(pct(edgeLens, 0.95)) },
        dihedralMeanDeg: r1(dihedralMean),
        // TRUE welded cracks touching this region (same basis as get_mesh_stats
        // and fix_mesh) — NOT the region perimeter.
        openEdges: openEdgeKeys.size,
    };
}

/**
 * inspect_region — probe mode (center+radius) or grid mode (N³ cells over the
 * object AABB, sorted by simplification opportunity = flat × dense).
 */
export function inspectRegion(viewer, opts = {}) {
    const entry = viewer._activeEntry();
    if (!entry) throw new Error("No object loaded.");
    const totalTris = entry.stats ? entry.stats.faces : 0;
    if (totalTris > INSPECT_TRIANGLE_BUDGET) {
        return { skipped: true,
                 note: `Object exceeds the ${INSPECT_TRIANGLE_BUDGET.toLocaleString()}-triangle `
                     + "inspection budget." };
    }

    if (opts.grid) {
        const n = Math.max(2, Math.min(5, Math.round(opts.grid)));
        const box = new THREE.Box3().setFromObject(entry.wrapper);
        if (box.isEmpty()) throw new Error("Object has no measurable geometry.");
        const size = box.getSize(new THREE.Vector3());
        const cellR = Math.max(size.x, size.y, size.z) / n * 0.75;
        const cells = [];
        const c = new THREE.Vector3();
        const topoCache = new Map();
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                for (let k = 0; k < n; k++) {
                    c.set(box.min.x + (i + 0.5) * size.x / n,
                          box.min.y + (j + 0.5) * size.y / n,
                          box.min.z + (k + 0.5) * size.z / n);
                    const stats = regionStats(viewer, entry, c, cellR, topoCache);
                    if (stats.triangles < 8) continue;
                    // Opportunity: dense (many tri/unit²) AND flat (low dihedral)
                    const flatness = Math.max(0, 1 - stats.dihedralMeanDeg / 30);
                    cells.push({
                        center: [r3(c.x), r3(c.y), r3(c.z)],
                        radius: r3(cellR),
                        ...stats,
                        opportunity: r3(flatness * Math.log10(1 + stats.triPerUnit2)),
                    });
                }
            }
        }
        cells.sort((x, y) => y.opportunity - x.opportunity);
        const capped = cells.slice(0, 24);
        return {
            mode: "grid", grid: n, cells: capped,
            omitted: Math.max(0, cells.length - capped.length) || undefined,
            note: "cells sorted by simplification opportunity (flat × dense = "
                + "unjustified density). Feed a cell's center+radius into "
                + "simplify_region.",
        };
    }

    if (!opts.center || opts.center.length !== 3) {
        throw new Error("inspect_region needs center:[x,y,z] + radius (probe) "
            + "or grid:2..5 (survey).");
    }
    const radius = resolveRadius(viewer, opts, "inspect_region");
    const center = new THREE.Vector3(...opts.center);
    const stats = regionStats(viewer, entry, center, radius);
    if (stats.triangles === 0) {
        throw new Error("Region contains no triangles — check center (world "
            + "coords: use pick, get_bounds, or describe_scene mesh centers) "
            + "and radius.");
    }
    const objArea = entry.stats && entry.stats.faces ? stats.triangles / entry.stats.faces : 0;
    return { mode: "probe", ...stats, shareOfObject: r3(objArea) };
}

// ---------------------------------------------------------------------------
// inspect_texture — per-material texture facts + texel density
// ---------------------------------------------------------------------------

export function inspectTexture(viewer) {
    const entry = viewer._activeEntry();
    if (!entry) throw new Error("No object loaded.");
    const meshes = meshesOf(entry);
    entry.model.updateMatrixWorld(true);
    const reports = [];
    const seenMats = new Set();

    for (const mesh of meshes) {
        const stash = mesh._mvOriginalMaterial || mesh.material;
        const mats = Array.isArray(stash) ? stash : [stash];
        const uv = mesh.geometry.getAttribute("uv");
        for (const mat of mats) {
            if (!mat || seenMats.has(mat)) continue;
            seenMats.add(mat);
            const tex = mat.map;
            const report = {
                material: mat.name || "(unnamed)",
                painted: !!(mat.userData && mat.userData._mvPaint) || undefined,
            };
            if (tex && tex.image && tex.image.width) {
                report.map = { width: tex.image.width, height: tex.image.height,
                               colorSpace: tex.colorSpace || "linear" };
            } else {
                report.map = null;
            }
            // Texel density: sqrt(UV-area-in-texels / world-area) per triangle,
            // world-area-weighted percentiles + worst world spots.
            if (uv && report.map) {
                const density = texelDensity(mesh, report.map.width, report.map.height);
                if (density) Object.assign(report, density);
            } else if (!uv) {
                report.note = "mesh has no UVs — painting/repair unavailable";
            }
            reports.push(report);
        }
    }
    return { materials: reports };
}

function texelDensity(mesh, W, H) {
    const geometry = mesh.geometry;
    const pos = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    const index = geometry.getIndex();
    const triCount = triCountOf(geometry);
    if (triCount === 0 || triCount > INSPECT_TRIANGLE_BUDGET) return null;
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const m = mesh.matrixWorld;
    const items = [];   // {density, areaW, center}
    let zeroUv = 0;
    for (let t = 0; t < triCount; t++) {
        const ia = idxOf(t, 0), ib = idxOf(t, 1), ic = idxOf(t, 2);
        a.fromBufferAttribute(pos, ia).applyMatrix4(m);
        b.fromBufferAttribute(pos, ib).applyMatrix4(m);
        c.fromBufferAttribute(pos, ic).applyMatrix4(m);
        const areaW = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
        if (areaW < 1e-12) continue;
        const u0 = uv.getX(ia) * W, v0 = uv.getY(ia) * H;
        const u1 = uv.getX(ib) * W, v1 = uv.getY(ib) * H;
        const u2 = uv.getX(ic) * W, v2 = uv.getY(ic) * H;
        const areaUV = Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2;
        if (areaUV < 1e-9) { zeroUv++; continue; }
        items.push({
            density: Math.sqrt(areaUV / areaW),
            areaW,
            center: [(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3],
        });
    }
    if (!items.length) return { zeroUvArea: zeroUv || undefined };
    items.sort((x, y) => x.density - y.density);
    const totalArea = items.reduce((s, x) => s + x.areaW, 0);
    const weightedPct = (p) => {
        let acc = 0;
        for (const it of items) {
            acc += it.areaW;
            if (acc >= totalArea * p) return it.density;
        }
        return items[items.length - 1].density;
    };
    // Up to 5 spread-out worst (lowest-density) spots for `focus {point}`.
    const worst = [];
    for (const it of items) {
        if (worst.length >= 5) break;
        const ok = worst.every((w) => {
            const dx = w[0] - it.center[0], dy = w[1] - it.center[1], dz = w[2] - it.center[2];
            return dx * dx + dy * dy + dz * dz > totalArea / items.length;
        });
        if (ok) worst.push(it.center.map(r3));
    }
    return {
        texelDensity: { p5: r1(weightedPct(0.05)), median: r1(weightedPct(0.5)),
                        p95: r1(weightedPct(0.95)) },
        lowestDensitySpots: worst,
        zeroUvArea: zeroUv || undefined,
    };
}
