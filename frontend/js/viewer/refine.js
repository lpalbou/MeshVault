/**
 * refine_region — agent-controlled ADAPTIVE MESH REFINEMENT (backlog: adaptive
 * resolution; the coarsening half is simplify_region).
 *
 * Concept: Blender-Dyntopo-style "detail size", but as an EXPLICIT deterministic
 * op with quantified returns (agent ergonomics: inspect → refine → sculpt), not
 * an implicit brush side effect. Algorithm: iterative CONFORMAL passes — mark
 * long edges inside the brush, split every marked edge in BOTH incident
 * triangles (no T-junctions by construction), repeat until the region meets the
 * target edge length or the budget stops a pass. Per the adversarial design
 * review this is red-green refinement, and the two "green rules" are the part
 * that bounds quality:
 *
 * - 2-marked → RED closure: a triangle with exactly two marked edges gets its
 *   third edge marked (monotone; removes the sliver-prone diagonal case).
 * - Quality-gated RED upgrade: before green-splitting a 1-marked triangle,
 *   check the worst child's min angle; below ~12° mark all three edges instead.
 *   Red splits PRESERVE a thin triangle's angles — this is the rule that stays
 *   safe across repeated agent invocations (the primary usage loop), where
 *   per-call green bookkeeping cannot. Without it, rim-band slivers accumulate
 *   until they fall under fix_mesh's degenerate threshold and get dropped,
 *   reopening real holes (the failure class capping.js documents).
 *
 * Determinism at seams: midpoints are CREATED per raw index pair (each UV-seam
 * side gets its own midpoint with its own interpolated UVs) but their POSITIONS
 * are computed from the CANONICAL endpoint positions — IEEE-754 addition is
 * commutative and ×0.5 exact, so both seam sides produce bit-identical
 * midpoints that weld on the next pass. Painting adapts automatically: UVs
 * interpolate inside their island, the paint layer canvas is untouched.
 *
 * Budget semantics: max_triangles caps ADDED triangles per command; growth is
 * exactly computable after closure (+1 per green, +3 per red), so each pass is
 * pre-flighted and the op stops on PASS BOUNDARIES only (a completed-passes
 * result is conformal and resumable — re-issue the command to continue).
 */

import * as THREE from "three";
import { dropMorphs, hasActiveMorphInfluence } from "./morphs.js";
import { collapsePass, flipPass, valenceShare } from "./remesh_passes.js";
import { resolveRadius, ensureFreshNormals } from "./sculpt.js";

const MAX_PASSES = 8;                    // edges halve per pass; budget hits first
const MIN_CHILD_ANGLE_DEG = 12;          // quality gate: green splits below this go red
const DEFAULT_ADDED_CAP = 100000;
const MAX_ADDED_CAP = 300000;            // matches INSPECT_TRIANGLE_BUDGET (SwiftShader)

const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;

function requireActive(viewer) {
    const entry = viewer._activeEntry();
    if (!entry) throw new Error("No object loaded. load / add_model / add_primitive first.");
    if (entry.skinned) {
        throw new Error("refine_region on skinned (rigged) models is not supported — "
            + "topology edits corrupt the bind pose.");
    }
    if (viewer._timeline && viewer._timeline.playing) {
        throw new Error("The timeline is PLAYING — pause_timeline before mesh edits.");
    }
    if (hasActiveMorphInfluence(entry)) {
        throw new Error("A morph influence is nonzero — the region would be chosen "
            + "against the DISPLAYED morphed surface but refined on the base. "
            + "set_morph weights to 0 first (refining drops morphs — export_glb "
            + "to keep them).");
    }
    return entry;
}

/** Decode a geometry into plain working arrays (accessor reads: quantized/
 *  interleaved safe). Index becomes explicit; soups get an identity index. */
function decodeWorking(geometry) {
    // Bulk-replay normal deferral: this copies the normal attribute into the
    // rebuilt geometry — stale values would bake into the replica.
    ensureFreshNormals(geometry);
    const attrs = [];
    for (const name of Object.keys(geometry.attributes)) {
        const src = geometry.getAttribute(name);
        const itemSize = src.itemSize;
        const data = new Array(src.count * itemSize);
        for (let i = 0; i < src.count; i++) {
            for (let c = 0; c < itemSize; c++) data[i * itemSize + c] = src.getComponent(i, c);
        }
        attrs.push({ name, itemSize, data });
    }
    const srcIndex = geometry.getIndex();
    const vertCount = geometry.getAttribute("position").count;
    const index = srcIndex
        ? Array.from({ length: srcIndex.count }, (_, i) => srcIndex.getX(i))
        : Array.from({ length: vertCount }, (_, i) => i);
    const groups = (geometry.groups || []).map((g) => ({ ...g }));
    return { attrs, index, groups };
}

/** Canonical weld ids over a working position array (repair.js quantization rule). */
function canonOf(posData, quant) {
    const count = posData.length / 3;
    const byKey = new Map();
    const canonical = new Int32Array(count);
    for (let i = 0; i < count; i++) {
        const k = `${Math.round(posData[i * 3] / quant)}_${Math.round(posData[i * 3 + 1] / quant)}_${Math.round(posData[i * 3 + 2] / quant)}`;
        const seen = byKey.get(k);
        canonical[i] = seen !== undefined ? seen : (byKey.set(k, i), i);
    }
    return canonical;
}

const EDGE_K = 16777216;
const edgeKey = (a, b) => (a < b ? a * EDGE_K + b : b * EDGE_K + a);

/** Min interior angle (radians) of triangle (a,b,c) given flat xyz arrays. */
function minAngle(pos, a, b, c) {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    const l2ab = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2;
    const l2bc = (bx - cx) ** 2 + (by - cy) ** 2 + (bz - cz) ** 2;
    const l2ca = (cx - ax) ** 2 + (cy - ay) ** 2 + (cz - az) ** 2;
    if (l2ab === 0 || l2bc === 0 || l2ca === 0) return 0;
    // Law of cosines per corner.
    const angle = (l2u, l2v, l2w) => {
        const cos = (l2u + l2v - l2w) / (2 * Math.sqrt(l2u * l2v));
        return Math.acos(Math.max(-1, Math.min(1, cos)));
    };
    return Math.min(angle(l2ab, l2ca, l2bc), angle(l2ab, l2bc, l2ca),
                    angle(l2bc, l2ca, l2ab));
}

/**
 * One conformal refinement pass over a working mesh.
 * Returns null when nothing is marked, or the executed pass's report; when the
 * budget disallows the pass, returns {wouldAdd} without mutating (caller stops).
 */
function refinePass(work, matrixWorld, center, r2, targetEdge, quant, budgetLeft, stats) {
    const pos = work.attrs.find((a) => a.name === "position").data;
    const canonical = canonOf(pos, quant);
    const index = work.index;
    const triCount = Math.floor(index.length / 3);
    const e = matrixWorld.elements;
    const wx = (i) => e[0] * pos[i * 3] + e[4] * pos[i * 3 + 1] + e[8] * pos[i * 3 + 2] + e[12];
    const wy = (i) => e[1] * pos[i * 3] + e[5] * pos[i * 3 + 1] + e[9] * pos[i * 3 + 2] + e[13];
    const wz = (i) => e[2] * pos[i * 3] + e[6] * pos[i * 3 + 1] + e[10] * pos[i * 3 + 2] + e[14];

    // --- mark long edges whose WORLD midpoint lies in the brush --------------
    const marked = new Set();
    const t2 = targetEdge * targetEdge;
    let sawRegionEdge = false;
    for (let t = 0; t < triCount; t++) {
        for (let k = 0; k < 3; k++) {
            const i = index[t * 3 + k], j = index[t * 3 + (k + 1) % 3];
            const ci = canonical[i], cj = canonical[j];
            if (ci === cj) continue;                       // degenerate: never mark
            const mx = (wx(ci) + wx(cj)) / 2 - center.x;
            const my = (wy(ci) + wy(cj)) / 2 - center.y;
            const mz = (wz(ci) + wz(cj)) / 2 - center.z;
            if (mx * mx + my * my + mz * mz > r2) continue;
            sawRegionEdge = true;
            const dx = wx(ci) - wx(cj), dy = wy(ci) - wy(cj), dz = wz(ci) - wz(cj);
            if (dx * dx + dy * dy + dz * dz > t2) marked.add(edgeKey(ci, cj));
        }
    }
    stats.sawRegionEdge = stats.sawRegionEdge || sawRegionEdge;
    if (marked.size === 0) return null;

    // --- closure: 2-marked → red; quality-gated red upgrade (monotone) -------
    // CASCADE CLAMP (perf gauntlet #1): the closure used to propagate marks
    // without any spatial bound — on sliver-bearing stock the quality gate
    // red-marked whole slivers, the 2-marked closure transported the marks
    // outward, and a r=0.3 request flooded 93% of its added triangles OUTSIDE
    // the requested ball (198k added, parameter-independent). Marks may now
    // only GROW within 1.5× the brush radius; 2-marked triangles beyond the
    // clamp emit a conformal 1→3 split instead (both their marked edges are
    // still split in BOTH incident triangles — no T-junctions).
    const clampR2 = r2 * 2.25;
    const primaryMarked = marked.size;
    const minRad = (MIN_CHILD_ANGLE_DEG * Math.PI) / 180;
    const triEdgeKeys = (t) => {
        const a = canonical[index[t * 3]], b = canonical[index[t * 3 + 1]], c = canonical[index[t * 3 + 2]];
        return [a === b ? null : edgeKey(a, b), b === c ? null : edgeKey(b, c),
                c === a ? null : edgeKey(c, a)];
    };
    const edgeInClamp = (ci, cj) => {
        const mx = (wx(ci) + wx(cj)) / 2 - center.x;
        const my = (wy(ci) + wy(cj)) / 2 - center.y;
        const mz = (wz(ci) + wz(cj)) / 2 - center.z;
        return mx * mx + my * my + mz * mz <= clampR2;
    };
    const edgeEnds = (t, kIdx) => [canonical[index[t * 3 + kIdx]],
                                   canonical[index[t * 3 + (kIdx + 1) % 3]]];
    let changed = true;
    while (changed) {
        changed = false;
        for (let t = 0; t < triCount; t++) {
            const keys = triEdgeKeys(t);
            const flags = keys.map((k) => (k !== null && marked.has(k)));
            const n = flags.filter(Boolean).length;
            if (n === 2) {
                // RED closure: the 2-marked "choose a diagonal" case is the
                // sliver factory — mark the third edge, but only within the
                // clamp; beyond it the 1→3 emission bounds the cascade.
                const kIdx = flags.indexOf(false);
                const k = keys[kIdx];
                if (k !== null && !marked.has(k)) {
                    const [ci, cj] = edgeEnds(t, kIdx);
                    if (edgeInClamp(ci, cj)) { marked.add(k); changed = true; }
                }
            } else if (n === 1) {
                // Quality gate: would the green split make a sliver? Children of
                // green-splitting (a,b) at m: (a,m,c) + (m,b,c), in LOCAL space
                // (fix_mesh's degeneracy thresholds are local).
                const kIdx = flags.indexOf(true);
                const a = index[t * 3 + kIdx], b = index[t * 3 + (kIdx + 1) % 3],
                      c = index[t * 3 + (kIdx + 2) % 3];
                const ca = canonical[a], cb = canonical[b];
                // Midpoint (canonical endpoints) appended virtually for the check.
                const m = pos.length / 3;
                pos.push((pos[ca * 3] + pos[cb * 3]) * 0.5,
                         (pos[ca * 3 + 1] + pos[cb * 3 + 1]) * 0.5,
                         (pos[ca * 3 + 2] + pos[cb * 3 + 2]) * 0.5);
                const worst = Math.min(minAngle(pos, a, m, c), minAngle(pos, m, b, c));
                pos.length -= 3;                            // pop the probe vertex
                // RELATIVE gate (perf gauntlet #1): green splits of a sliver
                // produce sliver children by inheritance — the old ABSOLUTE
                // 12° floor red-marked every such triangle, and red children
                // of slivers are SIMILAR to their parents, so each pass
                // re-triggered (the quadrupling flood). A green split that is
                // not meaningfully WORSE than its parent stays green.
                const parentWorst = minAngle(pos, a, b, c);
                if (worst < minRad && worst < parentWorst * 0.9) {
                    let grew = false;
                    for (let kk = 0; kk < 3; kk++) {
                        const k = keys[kk];
                        if (k !== null && !marked.has(k)) {
                            const [ci, cj] = edgeEnds(t, kk);
                            if (edgeInClamp(ci, cj)) { marked.add(k); grew = true; }
                        }
                    }
                    if (grew) changed = true;
                }
            }
        }
    }
    stats.primaryMarked = (stats.primaryMarked || 0) + primaryMarked;
    stats.totalMarked = (stats.totalMarked || 0) + marked.size;

    // --- pre-flight growth (+1 per green, +2 per two-marked, +3 per red) ------
    let adds = 0;
    for (let t = 0; t < triCount; t++) {
        const n = triEdgeKeys(t).filter((k) => k !== null && marked.has(k)).length;
        adds += n === 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : 0;
    }
    if (adds === 0) return null;
    if (adds > budgetLeft) return { wouldAdd: adds };

    // --- execute: split, emitting per-triangle IN ORIGINAL ORDER (groups) ----
    const midByRawPair = new Map();      // raw-pair key -> new raw index
    const midpoint = (i, j) => {
        const key = edgeKey(i, j);
        let m = midByRawPair.get(key);
        if (m !== undefined) return m;
        const ci = canonical[i], cj = canonical[j];
        for (const attr of work.attrs) {
            const { name, itemSize, data } = attr;
            if (name === "position") {
                // CANONICAL endpoints: bit-identical across seam sides.
                data.push((data[ci * 3] + data[cj * 3]) * 0.5,
                          (data[ci * 3 + 1] + data[cj * 3 + 1]) * 0.5,
                          (data[ci * 3 + 2] + data[cj * 3 + 2]) * 0.5);
                continue;
            }
            const out = [];
            for (let c = 0; c < itemSize; c++) {
                out.push((data[i * itemSize + c] + data[j * itemSize + c]) * 0.5);
            }
            if (name === "normal" || name.startsWith("tangent")) {
                const len = Math.hypot(out[0], out[1], out[2]);
                if (len > 1e-12) { out[0] /= len; out[1] /= len; out[2] /= len; }
                if (name.startsWith("tangent") && itemSize === 4) {
                    out[3] = data[i * itemSize + 3];   // handedness: constant per side
                }
            }
            data.push(...out);
        }
        // Every attribute array (position included) was extended by exactly one
        // entry above — the new raw index is the new vertex count minus one.
        m = pos.length / 3 - 1;
        midByRawPair.set(key, m);
        return m;
    };

    const newIndex = [];
    const outCount = new Array(triCount);
    // Local squared length for the two-marked diagonal choice (deterministic:
    // strict comparison, raw-index tie-break; midpoint raw ids are allocation-
    // ordered and allocation order is the triangle emission order).
    const len2 = (i, j) => {
        const dx = pos[i * 3] - pos[j * 3];
        const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
        const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        return dx * dx + dy * dy + dz * dz;
    };
    // Two-marked conformal 1→3: marked edges (p,s) and (s,q) share vertex s.
    // Emit the ear (m1, s, m2), then split the quad (p, m1, m2, q) along its
    // shorter diagonal.
    const split2 = (p, s, q, m1, m2) => {
        newIndex.push(m1, s, m2);
        const dPm2 = len2(p, m2), dM1q = len2(m1, q);
        const usePm2 = dPm2 < dM1q
            || (dPm2 === dM1q && edgeKey(p, m2) < edgeKey(m1, q));
        if (usePm2) newIndex.push(p, m1, m2, p, m2, q);
        else newIndex.push(p, m1, q, m1, m2, q);
    };
    for (let t = 0; t < triCount; t++) {
        const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
        const keys = triEdgeKeys(t);
        const mAB = keys[0] !== null && marked.has(keys[0]);
        const mBC = keys[1] !== null && marked.has(keys[1]);
        const mCA = keys[2] !== null && marked.has(keys[2]);
        const n = (mAB ? 1 : 0) + (mBC ? 1 : 0) + (mCA ? 1 : 0);
        const before = newIndex.length;
        if (n === 0) {
            newIndex.push(a, b, c);
        } else if (n === 3) {
            // RED 1→4.
            const ab = midpoint(a, b), bc = midpoint(b, c), ca2 = midpoint(c, a);
            newIndex.push(a, ab, ca2, ab, b, bc, ca2, bc, c, ab, bc, ca2);
        } else if (n === 2) {
            // Beyond the cascade clamp: conformal 1→3 (both marked edges are
            // split; the third edge is NOT touched, bounding the flood).
            if (mAB && mBC) split2(a, b, c, midpoint(a, b), midpoint(b, c));
            else if (mBC && mCA) split2(b, c, a, midpoint(b, c), midpoint(c, a));
            else split2(c, a, b, midpoint(c, a), midpoint(a, b));
        } else {
            // GREEN 1→2 about the single marked edge (winding preserved).
            if (mAB) { const m = midpoint(a, b); newIndex.push(a, m, c, m, b, c); }
            else if (mBC) { const m = midpoint(b, c); newIndex.push(a, b, m, a, m, c); }
            else { const m = midpoint(c, a); newIndex.push(a, b, m, m, b, c); }
        }
        outCount[t] = (newIndex.length - before) / 3;
    }

    // Rebuild group ranges by prefix sums (triangles were emitted in order).
    if (work.groups.length > 0) {
        let cursor = 0;
        for (const g of work.groups) {
            const firstTri = Math.floor(g.start / 3);
            const triN = Math.floor(g.count / 3);
            let trisOut = 0;
            for (let t = firstTri; t < firstTri + triN && t < triCount; t++) trisOut += outCount[t];
            g.start = cursor;
            g.count = trisOut * 3;
            cursor += trisOut * 3;
        }
    }
    work.index = newIndex;
    return { edgesSplit: marked.size, added: adds,
             verticesAdded: midByRawPair.size };
}

/** World-space edge stats (median/p95) over region edges of ALL refined
 *  geometries — closes the loop numerically with inspect_region. */
function regionEdgeStats(jobs, center, r2) {
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), mid = new THREE.Vector3();
    const lens = [];
    for (const job of jobs) {
        const pos = job.work.attrs.find((a) => a.name === "position").data;
        const index = job.work.index;
        const e = job.mesh.matrixWorld.elements;
        const w = (i, out) => out.set(
            e[0] * pos[i * 3] + e[4] * pos[i * 3 + 1] + e[8] * pos[i * 3 + 2] + e[12],
            e[1] * pos[i * 3] + e[5] * pos[i * 3 + 1] + e[9] * pos[i * 3 + 2] + e[13],
            e[2] * pos[i * 3] + e[6] * pos[i * 3 + 1] + e[10] * pos[i * 3 + 2] + e[14]);
        const seen = new Set();
        for (let t = 0; t < index.length / 3; t++) {
            for (let k = 0; k < 3; k++) {
                const i = index[t * 3 + k], j = index[t * 3 + (k + 1) % 3];
                const key = edgeKey(i, j);
                if (seen.has(key)) continue;
                seen.add(key);
                w(i, va); w(j, vb);
                mid.addVectors(va, vb).multiplyScalar(0.5).sub(center);
                if (mid.lengthSq() > r2) continue;
                lens.push(va.distanceTo(vb));
            }
        }
    }
    if (!lens.length) return null;
    lens.sort((x, y) => x - y);
    return { median: r4(lens[Math.floor(lens.length / 2)]),
             p95: r4(lens[Math.floor(lens.length * 0.95)]) };
}

/**
 * One tangential-relaxation pass over a working mesh (regularize_region).
 *
 * Moves each relaxable weld toward the average of its canonical neighbors,
 * KEEPING ONLY THE TANGENTIAL COMPONENT (the normal component is subtracted),
 * so the surface shape is preserved to first order while triangle shapes
 * equalize — the standard fix for the stretched facets big grab pulls leave.
 *
 * Relaxable = single-member weld (seams/creases are multi-member and stay
 * put; moving them would tear UVs), not on an open edge, and every incident
 * triangle fully inside the brush (the ring stays bit-exact — no cracks).
 */
function relaxPass(work, matrixWorld, center, r2, lambda) {
    const posA = work.attrs.find((a) => a.name === "position");
    const pos = posA.data;
    const count = pos.length / 3;
    const index = work.index;
    const triCount = Math.floor(index.length / 3);

    // Weld members over CURRENT positions.
    const byKey = new Map();
    const canonical = new Int32Array(count);
    const memberCount = new Map();
    let maxAbs = 1;
    for (let i = 0; i < pos.length; i++) maxAbs = Math.max(maxAbs, Math.abs(pos[i]));
    const quant = maxAbs * 1e-6;
    for (let i = 0; i < count; i++) {
        const k = `${Math.round(pos[i * 3] / quant)}_${Math.round(pos[i * 3 + 1] / quant)}_${Math.round(pos[i * 3 + 2] / quant)}`;
        const seen = byKey.get(k);
        canonical[i] = seen !== undefined ? seen : (byKey.set(k, i), i);
        memberCount.set(canonical[i], (memberCount.get(canonical[i]) || 0) + 1);
    }

    // World-space inside test per canon.
    const e = matrixWorld.elements;
    const insideOf = (c) => {
        const x = pos[c * 3], y = pos[c * 3 + 1], z = pos[c * 3 + 2];
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12] - center.x;
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13] - center.y;
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14] - center.z;
        return wx * wx + wy * wy + wz * wz <= r2;
    };

    // Adjacency, edge use counts, incident-triangle-inside flags, normals.
    const neighbors = new Map();
    const edgeUse = new Map();
    const allTrisInside = new Map();     // canon -> stays true only if every
    const nAcc = new Float64Array(count * 3);
    const link = (a, b) => {
        let s = neighbors.get(a);
        if (!s) { s = new Set(); neighbors.set(a, s); }
        s.add(b);
    };
    for (let t = 0; t < triCount; t++) {
        const a = canonical[index[t * 3]], b = canonical[index[t * 3 + 1]],
              c = canonical[index[t * 3 + 2]];
        if (a === b || b === c || c === a) continue;
        const triIn = insideOf(a) && insideOf(b) && insideOf(c);
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            link(u, v); link(v, u);
            const key = u < v ? u * EDGE_K + v : v * EDGE_K + u;
            edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
        }
        for (const v of [a, b, c]) {
            allTrisInside.set(v, (allTrisInside.get(v) !== false) && triIn);
        }
        // Area-weighted face normal accumulation (local space).
        const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
        const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
        const cx2 = pos[c * 3], cy2 = pos[c * 3 + 1], cz2 = pos[c * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx2 - ax, vy = cy2 - ay, vz = cz2 - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const v of [a, b, c]) {
            nAcc[v * 3] += nx; nAcc[v * 3 + 1] += ny; nAcc[v * 3 + 2] += nz;
        }
    }
    const openCanon = new Set();
    for (const [key, use] of edgeUse) {
        if (use !== 1) continue;
        openCanon.add(Math.floor(key / EDGE_K));
        openCanon.add(key % EDGE_K);
    }

    // Compute all moves first (Jacobi — order independence), then apply.
    const moves = [];
    for (const [c, ns] of neighbors) {
        if (memberCount.get(c) !== 1) continue;          // seam/crease weld
        if (openCanon.has(c)) continue;                  // open rim
        if (allTrisInside.get(c) !== true) continue;     // ring / outside
        if (!ns || ns.size < 3) continue;
        let cx = 0, cy = 0, cz = 0;
        for (const nb of ns) {
            cx += pos[nb * 3]; cy += pos[nb * 3 + 1]; cz += pos[nb * 3 + 2];
        }
        cx = cx / ns.size - pos[c * 3];
        cy = cy / ns.size - pos[c * 3 + 1];
        cz = cz / ns.size - pos[c * 3 + 2];
        // Tangential projection: subtract the normal component.
        let nx = nAcc[c * 3], ny = nAcc[c * 3 + 1], nz = nAcc[c * 3 + 2];
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl > 1e-12) {
            nx /= nl; ny /= nl; nz /= nl;
            const d = cx * nx + cy * ny + cz * nz;
            cx -= d * nx; cy -= d * ny; cz -= d * nz;
        }
        moves.push([c, cx * lambda, cy * lambda, cz * lambda]);
    }
    for (const [c, dx, dy, dz] of moves) {
        pos[c * 3] += dx; pos[c * 3 + 1] += dy; pos[c * 3 + 2] += dz;
    }
    return moves.length;
}

/** Count region edges LONGER than `threshold` (world) — the "stretched
 *  facet" metric regularize_region reports before/after. */
function stretchedCount(jobs, center, r2, threshold) {
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), mid = new THREE.Vector3();
    let n = 0;
    for (const job of jobs) {
        const pos = job.work.attrs.find((a) => a.name === "position").data;
        const index = job.work.index;
        const e = job.mesh.matrixWorld.elements;
        const w = (i, out) => out.set(
            e[0] * pos[i * 3] + e[4] * pos[i * 3 + 1] + e[8] * pos[i * 3 + 2] + e[12],
            e[1] * pos[i * 3] + e[5] * pos[i * 3 + 1] + e[9] * pos[i * 3 + 2] + e[13],
            e[2] * pos[i * 3] + e[6] * pos[i * 3 + 1] + e[10] * pos[i * 3 + 2] + e[14]);
        const seen = new Set();
        for (let t = 0; t < index.length / 3; t++) {
            for (let k = 0; k < 3; k++) {
                const i = index[t * 3 + k], j = index[t * 3 + (k + 1) % 3];
                const key = edgeKey(i, j);
                if (seen.has(key)) continue;
                seen.add(key);
                w(i, va); w(j, vb);
                mid.addVectors(va, vb).multiplyScalar(0.5).sub(center);
                if (mid.lengthSq() > r2) continue;
                if (va.distanceTo(vb) > threshold) n++;
            }
        }
    }
    return n;
}

/**
 * regularize_region — equalize facet shapes after heavy sculpting.
 *
 * Big grab pulls stretch triangles into long slivers that shade as ugly
 * streaks and make any later paint smear (the haircut field feedback).
 * Iterates: conformal splits of over-long edges (4/3 × target — the
 * Botsch–Kobbelt incremental-remeshing split rule) + tangential relaxation
 * (shape-preserving to first order). Default target = the region's CURRENT
 * median edge, so zero-config means "equalize at the density you have".
 */
export function regularizeRegion(viewer, opts = {}) {
    const entry = requireActive(viewer);
    const radius = resolveRadius(viewer, opts, "regularize_region");
    if (!opts.center || opts.center.length !== 3) {
        throw new Error("regularize_region requires center: [x,y,z] (world — use "
            + "pick, raycast, inspect_region or get_bounds).");
    }
    const center = new THREE.Vector3(...opts.center);
    const iterations = Math.max(1, Math.min(5,
        opts.iterations !== undefined ? opts.iterations : 3));
    const maxAdded = Math.max(1000, Math.min(MAX_ADDED_CAP,
        opts.max_triangles !== undefined ? opts.max_triangles : DEFAULT_ADDED_CAP));

    entry.model.updateMatrixWorld(true);
    const r2 = radius * radius;

    const jobs = [];
    const seenGeometries = new Set();
    entry.model.traverse((mesh) => {
        if (!mesh.isMesh || !mesh.geometry || seenGeometries.has(mesh.geometry)) return;
        seenGeometries.add(mesh.geometry);
        mesh.geometry.computeBoundingBox();
        const diag = mesh.geometry.boundingBox
            ? mesh.geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1 : 1;
        jobs.push({ mesh, geometry: mesh.geometry, quant: diag * 1e-6,
                    work: decodeWorking(mesh.geometry) });
    });

    // Target edge: explicit, or the region's current MEDIAN (equalize-only).
    let targetEdge = opts.target_edge;
    if (!(targetEdge > 0) && opts.detail_rel > 0) {
        const box = new THREE.Box3().setFromObject(viewer._currentModel);
        const sphereR = box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length() / 2;
        targetEdge = opts.detail_rel * sphereR;
    }
    const esBefore = regionEdgeStats(jobs, center, r2);
    if (!esBefore) {
        throw new Error("Brush region contains no edges — check center (world "
            + "coords — use pick, raycast or inspect_region) and radius.");
    }
    if (!(targetEdge > 0)) targetEdge = esBefore.median;
    const stretchThreshold = targetEdge * 1.5;
    const stretchedBefore = stretchedCount(jobs, center, r2, stretchThreshold);

    const stats = { sawRegionEdge: false };
    let totalAdded = 0, totalSplit = 0, relaxed = 0;
    let totalCollapsed = 0, totalFlipped = 0;
    let trianglesBefore = 0, trianglesAfter = 0;
    for (const job of jobs) trianglesBefore += Math.floor(job.work.index.length / 3);

    // Full Botsch–Kobbelt iteration: split → collapse → flip → relax.
    // Split first (aliasing is irreversible), collapse prunes needles the
    // splits can't fix, flips equalize valences (poles shade as star
    // artifacts), relaxation equalizes shapes on the final connectivity.
    for (let it = 0; it < iterations; it++) {
        for (const job of jobs) {
            const report = refinePass(job.work, job.mesh.matrixWorld, center, r2,
                                      targetEdge * (4 / 3), job.quant,
                                      maxAdded - totalAdded, stats);
            if (report && report.wouldAdd === undefined) {
                totalAdded += report.added;
                totalSplit += report.edgesSplit;
            }
        }
        for (const job of jobs) {
            const minArea2 = (2 * (job.quant * 1e6) * 1e-7) ** 2;  // fix_mesh rule
            const cr = collapsePass(job.work, job.mesh.matrixWorld, center, r2,
                                    targetEdge, job.quant, minArea2);
            totalCollapsed += cr.collapsed;
            const fr = flipPass(job.work, job.mesh.matrixWorld, center, r2,
                                job.quant, minArea2);
            totalFlipped += fr.flipped;
        }
        for (const job of jobs) {
            relaxed += relaxPass(job.work, job.mesh.matrixWorld, center, r2, 0.5);
            relaxed += relaxPass(job.work, job.mesh.matrixWorld, center, r2, 0.5);
        }
    }
    for (const job of jobs) trianglesAfter += Math.floor(job.work.index.length / 3);

    if (totalSplit === 0 && relaxed === 0 && totalCollapsed === 0
        && totalFlipped === 0) {
        return {
            region: { trianglesBefore, trianglesAfter: trianglesBefore,
                      edgeLength: esBefore },
            targetEdge: r4(targetEdge),
            stretchedEdges: { before: stretchedBefore, after: stretchedBefore },
            edgesSplit: 0, collapsed: 0, flipped: 0, relaxedVerts: 0,
            iterations: 0,
            note: "Nothing to regularize (no over-long/short edges, no "
                + "improvable valences, no relaxable interior vertices — "
                + "seams/rims/ring are locked).",
        };
    }

    // Commit (same lifecycle as refine: geometry replaced). Reassign via a
    // full traversal — glTF instancing shares one geometry across MESHES, and
    // assigning only the recorded mesh leaves siblings holding the disposed
    // original (adversarial review R5; latent in refine too, fixed below).
    for (const job of jobs) {
        const { work, mesh, geometry } = job;
        const geo = new THREE.BufferGeometry();
        for (const attr of work.attrs) {
            geo.setAttribute(attr.name,
                new THREE.BufferAttribute(new Float32Array(attr.data), attr.itemSize));
        }
        geo.setIndex(work.index);
        for (const g of work.groups) geo.addGroup(g.start, g.count, g.materialIndex);
        // Relaxation MOVED vertices — normals must follow (the sculpt rule:
        // finalizeSculpt recomputes normals for the same reason).
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        entry.model.traverse((m) => {
            if (m.isMesh && m.geometry === geometry) m.geometry = geo;
        });
        geometry.dispose();
        mesh.geometry = geo;
    }

    const hadEdits = !!entry.originalState;
    entry.originalState = null;
    const morphNote = dropMorphs(viewer, entry, "regularize_region");
    entry.geometryRev++;
    entry._partition = null;
    entry.modified = true;
    entry.sculpted = true;
    entry.stats = viewer._computeStats(entry.model);
    viewer._lastStats = entry.stats;
    viewer.invalidate();

    const esAfter = regionEdgeStats(jobs, center, r2);
    const stretchedAfter = stretchedCount(jobs, center, r2, stretchThreshold);
    let v567 = null;
    for (const job of jobs) {
        const share = valenceShare(job.work, job.mesh.matrixWorld, center, r2,
                                   job.quant);
        if (share !== null) v567 = v567 === null ? share : Math.min(v567, share);
    }
    let note = "Facets equalized (splits + collapses + valence flips + "
        + "tangential relax; seams, open rims and the boundary ring stayed "
        + "locked). Vertices moved WITHIN the surface — expect slight texture "
        + "drift in the region; blur_paint or repaint to tidy.";
    if (hadEdits) {
        note = "reset baseline moved: earlier sculpt/bake edits are now permanent. " + note;
    }
    if (morphNote) note = morphNote + " " + note;

    return {
        region: { trianglesBefore, trianglesAfter,
                  edgeLength: { before: esBefore, after: esAfter } },
        object: { triangles: entry.stats.faces },
        targetEdge: r4(targetEdge),
        stretchedEdges: { before: stretchedBefore, after: stretchedAfter },
        edgesSplit: totalSplit,
        collapsed: totalCollapsed,
        flipped: totalFlipped,
        relaxedVerts: relaxed,
        valence567Share: v567,
        iterations,
        note,
    };
}

export function refineRegion(viewer, opts = {}) {
    const entry = requireActive(viewer);
    const radius = resolveRadius(viewer, opts, "refine_region");
    if (!opts.center || opts.center.length !== 3) {
        throw new Error("refine_region requires center: [x,y,z] (world — use pick, "
            + "raycast, inspect_region or get_bounds).");
    }
    const center = new THREE.Vector3(...opts.center);

    // Target edge: world units, or scale-free fraction of the bounding sphere.
    let targetEdge = opts.target_edge;
    if (!(targetEdge > 0) && opts.detail_rel > 0) {
        const box = new THREE.Box3().setFromObject(viewer._currentModel);
        const sphereR = box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length() / 2;
        targetEdge = opts.detail_rel * sphereR;
    }
    if (!(targetEdge > 0)) {
        throw new Error("refine_region requires target_edge > 0 (world units) or "
            + "detail_rel > 0 (fraction of the object's bounding-sphere radius). "
            + "Read inspect_region edgeLength.median first — half of it ≈ 4× "
            + "density; for sculpting, target ≈ brush radius / 5.");
    }
    const maxAdded = Math.max(1000, Math.min(MAX_ADDED_CAP,
        opts.max_triangles !== undefined ? opts.max_triangles : DEFAULT_ADDED_CAP));

    entry.model.updateMatrixWorld(true);
    const r2 = radius * radius;

    // Decode unique geometries (glTF instancing shares them — refine ONCE).
    const jobs = [];
    const seenGeometries = new Set();
    entry.model.traverse((mesh) => {
        if (!mesh.isMesh || !mesh.geometry || seenGeometries.has(mesh.geometry)) return;
        seenGeometries.add(mesh.geometry);
        mesh.geometry.computeBoundingBox();
        const diag = mesh.geometry.boundingBox
            ? mesh.geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1 : 1;
        jobs.push({ mesh, geometry: mesh.geometry, quant: diag * 1e-6,
                    work: decodeWorking(mesh.geometry) });
    });

    const stats = { sawRegionEdge: false };
    let totalAdded = 0, totalSplit = 0, totalVertsAdded = 0;
    let passesMax = 0, budgetHit = false, nextPassNeeds = 0;
    let trianglesBefore = 0, trianglesAfter = 0;

    for (const job of jobs) {
        trianglesBefore += Math.floor(job.work.index.length / 3);
        let passes = 0;
        while (passes < MAX_PASSES) {
            const report = refinePass(job.work, job.mesh.matrixWorld, center, r2,
                                      targetEdge, job.quant, maxAdded - totalAdded, stats);
            if (report === null) break;
            if (report.wouldAdd !== undefined) {
                if (totalAdded === 0) {
                    // Pre-flight refusal: NOTHING was mutated — pure teaching
                    // error carrying the EXACT budget needed (field bug F1-3:
                    // "re-issue to continue" livelocked when the next pass
                    // alone exceeded the cap — passes are indivisible, so the
                    // resume contract must name the number).
                    // FLOOD DIAGNOSIS (perf gauntlet #1): when closure marks
                    // dwarf the primary (length-test) marks, raising the
                    // budget rewards a cascade, not the request — say so.
                    const flooding = stats.primaryMarked > 0
                        && stats.totalMarked > stats.primaryMarked * 10;
                    const floodMsg = flooding
                        ? ` NOTE: ${stats.totalMarked} marked edges from only `
                          + `${stats.primaryMarked} over-target ones — the mesh `
                          + "QUALITY (slivers) is forcing cascades; run "
                          + "regularize_region with an explicit target_edge "
                          + "over this area first, then refine."
                        : "";
                    throw new Error(`The next pass would add ~${report.wouldAdd} `
                        + `triangles (max_triangles ${maxAdded}). Passes are `
                        + `indivisible (conformality): re-issue with `
                        + `max_triangles ≥ ${Math.min(MAX_ADDED_CAP, report.wouldAdd)} `
                        + `(≤${MAX_ADDED_CAP}), shrink radius, or target a larger `
                        + "edge — each halving of target_edge ≈ 4× triangles."
                        + floodMsg);
                }
                budgetHit = true;
                nextPassNeeds = Math.max(nextPassNeeds, report.wouldAdd);
                break;
            }
            totalAdded += report.added;
            totalSplit += report.edgesSplit;
            totalVertsAdded += report.verticesAdded;
            passes++;
        }
        passesMax = Math.max(passesMax, passes);
        trianglesAfter += Math.floor(job.work.index.length / 3);
    }

    if (!stats.sawRegionEdge) {
        throw new Error("Brush region contains no edges — check center (world "
            + "coords — use pick, raycast or inspect_region) and radius.");
    }

    // NO-OP: nothing split — return quantified state WITHOUT destroying the
    // reset baseline, morphs or partitions (a redundant call must cost nothing).
    if (totalAdded === 0) {
        const es = regionEdgeStats(jobs, center, r2);
        return {
            region: { trianglesBefore, trianglesAfter: trianglesBefore,
                      edgeLength: es || undefined },
            object: { triangles: entry.stats ? entry.stats.faces : undefined },
            targetEdge: r4(targetEdge),
            edgesSplit: 0, verticesAdded: 0, passes: 0,
            note: "Region already meets the target edge length — no changes.",
        };
    }

    // Commit: rebuild each refined geometry (fresh object — the sculpt weld
    // cache and symmetry BVH die with the old one; partitions are rev-keyed).
    // Reassign through a full traversal: glTF instancing shares one geometry
    // across meshes, and assigning only the recorded mesh would leave the
    // siblings holding the DISPOSED original (adversarial review R5).
    for (const job of jobs) {
        const { work, mesh, geometry } = job;
        const geo = new THREE.BufferGeometry();
        for (const attr of work.attrs) {
            geo.setAttribute(attr.name,
                new THREE.BufferAttribute(new Float32Array(attr.data), attr.itemSize));
        }
        geo.setIndex(work.index);         // plain array → three auto-upgrades to Uint32
        for (const g of work.groups) geo.addGroup(g.start, g.count, g.materialIndex);
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        entry.model.traverse((m) => {
            if (m.isMesh && m.geometry === geometry) m.geometry = geo;
        });
        geometry.dispose();
        mesh.geometry = geo;
    }

    // Geometry replaced: lazy-null the reset baseline (simplify_region rule —
    // never pre-snapshot a geometry-replacing op), drop morphs loudly,
    // invalidate partitions.
    const hadEdits = !!entry.originalState;
    entry.originalState = null;
    const morphNote = dropMorphs(viewer, entry, "refine_region");
    entry.geometryRev++;
    entry._partition = null;
    entry.modified = true;
    entry.sculpted = true;
    entry.stats = viewer._computeStats(entry.model);
    viewer._lastStats = entry.stats;
    viewer.invalidate();

    const es = regionEdgeStats(jobs, center, r2);
    let note = "Refined conformally (no cracks; UV seams keep welded midpoints). "
        + "Paint layers are untouched — painting the refined area now has finer "
        + "geometric control. Sculpt next; simplify_region coarsens elsewhere.";
    if (budgetHit) {
        note = `BUDGET stopped refinement on a pass boundary (still crack-free) `
            + `— the next pass needs ~${nextPassNeeds} added triangles: re-issue `
            + `with max_triangles ≥ ${Math.min(MAX_ADDED_CAP, nextPassNeeds)} to `
            + "continue. " + note;
    }
    if (hadEdits) {
        note = "reset baseline moved: earlier sculpt/bake edits are now permanent. " + note;
    }
    if (morphNote) note = morphNote + " " + note;

    return {
        region: { trianglesBefore, trianglesAfter, edgeLength: es || undefined },
        object: { triangles: entry.stats.faces },
        targetEdge: r4(targetEdge),
        edgesSplit: totalSplit,
        verticesAdded: totalVertsAdded,
        passes: passesMax,
        budgetHit: budgetHit || undefined,
        nextPassNeeds: budgetHit ? nextPassNeeds : undefined,
        note,
    };
}
