/**
 * Remesh passes — the collapse and flip halves of Botsch–Kobbelt incremental
 * remeshing (split + relax live in refine.js). Together they close the gap
 * the field kept hitting: brushes are metric-only maps on frozen topology, so
 * triangle quality decays monotonically; splitting alone (the old
 * regularize_region) never removes needle triangles or high-valence poles.
 *
 * Design rules (adversarial review consensus):
 * - Determinism is a hard invariant (observe-seat replay): decisions compare
 *   squared lengths / signed areas only (no acos in decision paths), all
 *   iteration is in canonical index order, ties break on canonical ids,
 *   budgets are counts — never wall-clock.
 * - Locks match simplify_region exactly: multi-member welds (UV seams /
 *   material creases), open rims (mod-2 boundary edges), and the region
 *   boundary ring stay bit-exact. Open edges are additionally excluded from
 *   ALL ops so `openEdges` is strictly invariant under remesh.
 * - Collapse safety: link condition + degenerate-area guard (fix_mesh's
 *   emit==drop threshold) + normal fold-over + NO-NEW-LONG-EDGE (collapsing
 *   below 4/5·L must not create edges above 4/3·L — the anti-oscillation
 *   predicate; without it split and collapse ping-pong forever).
 * - Flip criterion: strict valence-deviation decrease (target 6 interior,
 *   4 boundary), refused across material groups, across UV islands, when the
 *   opposite edge already exists, when a new triangle would fold or go
 *   degenerate, or when a new triangle's UV winding would invert.
 */

// Mirrors refine.js (shared canonical edge-key space).
const EDGE_K = 16777216;
const edgeKey = (a, b) => (a < b ? a * EDGE_K + b : b * EDGE_K + a);

/** Shared topology decode over a working mesh (canonical ids, adjacency,
 *  edge usage, member counts, per-triangle group ids, world transform). */
function buildTopology(work, matrixWorld, quant) {
    const posA = work.attrs.find((a) => a.name === "position");
    const pos = posA.data;
    const count = pos.length / 3;
    const index = work.index;
    const triCount = Math.floor(index.length / 3);

    const byKey = new Map();
    const canonical = new Int32Array(count);
    const memberCount = new Map();
    for (let i = 0; i < count; i++) {
        const k = `${Math.round(pos[i * 3] / quant)}_${Math.round(pos[i * 3 + 1] / quant)}_${Math.round(pos[i * 3 + 2] / quant)}`;
        const seen = byKey.get(k);
        canonical[i] = seen !== undefined ? seen : (byKey.set(k, i), i);
        memberCount.set(canonical[i], (memberCount.get(canonical[i]) || 0) + 1);
    }

    const e = matrixWorld.elements;
    const wpt = (c) => [
        e[0] * pos[c * 3] + e[4] * pos[c * 3 + 1] + e[8] * pos[c * 3 + 2] + e[12],
        e[1] * pos[c * 3] + e[5] * pos[c * 3 + 1] + e[9] * pos[c * 3 + 2] + e[13],
        e[2] * pos[c * 3] + e[6] * pos[c * 3 + 1] + e[10] * pos[c * 3 + 2] + e[14],
    ];

    // Per-triangle material group id (prefix ranges; -1 = ungrouped).
    const groupOf = new Int32Array(triCount).fill(-1);
    (work.groups || []).forEach((g, gi) => {
        const t0 = Math.floor(g.start / 3), tn = Math.floor(g.count / 3);
        for (let t = t0; t < Math.min(triCount, t0 + tn); t++) groupOf[t] = gi;
    });

    const edgeUse = new Map();          // canonical key -> use count
    const edgeTris = new Map();         // canonical key -> [triangle ids]
    const trisOf = new Map();           // canon -> [triangle ids]
    const neighbors = new Map();        // canon -> Set<canon>
    const link = (a, b) => {
        let s = neighbors.get(a);
        if (!s) { s = new Set(); neighbors.set(a, s); }
        s.add(b);
    };
    for (let t = 0; t < triCount; t++) {
        const a = canonical[index[t * 3]], b = canonical[index[t * 3 + 1]],
              c = canonical[index[t * 3 + 2]];
        if (a === b || b === c || c === a) continue;
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            const key = edgeKey(u, v);
            edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
            let lst = edgeTris.get(key);
            if (!lst) { lst = []; edgeTris.set(key, lst); }
            lst.push(t);
            link(u, v); link(v, u);
        }
        for (const v of [a, b, c]) {
            let lst = trisOf.get(v);
            if (!lst) { lst = []; trisOf.set(v, lst); }
            lst.push(t);
        }
    }
    const openCanon = new Set();
    for (const [key, use] of edgeUse) {
        if (use === 1) {
            openCanon.add(Math.floor(key / EDGE_K));
            openCanon.add(key % EDGE_K);
        }
    }
    return { pos, count, index, triCount, canonical, memberCount, wpt,
             groupOf, edgeUse, edgeTris, trisOf, neighbors, openCanon };
}

const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

/** Triangle normal (unnormalized cross) and squared area from world points. */
function triCross(pa, pb, pc) {
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}
const cross2 = (n) => n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * One collapse pass: remove region edges shorter than 4/5 × target.
 * Mutates work.index (dead triangles dropped, order preserved, groups
 * rebuilt); orphaned vertices stay (renderers ignore them; consistent with
 * refine's tolerance for unused data). Returns {collapsed, trianglesRemoved}.
 */
export function collapsePass(work, matrixWorld, center, r2, targetEdge, quant,
                             minArea2) {
    const T = buildTopology(work, matrixWorld, quant);
    const { pos, index, triCount, canonical, memberCount, wpt, groupOf,
            edgeUse, trisOf, neighbors, openCanon } = T;
    const cx = center.x, cy = center.y, cz = center.z;

    // Region + ring lock: a canon is INTERIOR iff every incident triangle has
    // all three corners inside the brush.
    const insideCache = new Map();
    const inside = (c) => {
        let v = insideCache.get(c);
        if (v === undefined) {
            const p = wpt(c);
            v = (p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2 <= r2;
            insideCache.set(c, v);
        }
        return v;
    };
    const interior = (c) => {
        if (!inside(c)) return false;
        const tris = trisOf.get(c);
        if (!tris) return false;
        for (const t of tris) {
            for (let k = 0; k < 3; k++) {
                if (!inside(canonical[index[t * 3 + k]])) return false;
            }
        }
        return true;
    };
    const movable = (c) => memberCount.get(c) === 1 && !openCanon.has(c)
        && interior(c);

    const shortLimit2 = (targetEdge * 0.8) ** 2;
    const longLimit2 = (targetEdge * (4 / 3)) ** 2;

    // Candidates in deterministic order: by squared length, ties by key.
    const candidates = [];
    for (const key of [...edgeUse.keys()].sort((a, b) => a - b)) {
        if (edgeUse.get(key) !== 2) continue;              // boundary/non-manifold
        const u = Math.floor(key / EDGE_K), v = key % EDGE_K;
        const l2 = d2(wpt(u), wpt(v));
        if (!(l2 > 0) || l2 >= shortLimit2) continue;
        if (!movable(u) && !movable(v)) continue;
        candidates.push([l2, key]);
    }
    candidates.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

    const touched = new Set();
    const deadTri = new Uint8Array(triCount);
    let collapsed = 0;

    for (const [, key] of candidates) {
        let u = Math.floor(key / EDGE_K), v = key % EDGE_K;
        // Collapse the movable endpoint; prefer collapsing u into v with u
        // chosen deterministically (movable, then smaller id).
        if (!movable(u)) { const t = u; u = v; v = t; }
        if (!movable(u)) continue;
        if (touched.has(u) || touched.has(v)) continue;

        const nu = neighbors.get(u), nv = neighbors.get(v);
        if (!nu || !nv) continue;

        // Link condition: common neighbors must be exactly the shared
        // triangles' opposite corners (≤2, each forming a face with u,v).
        const common = [];
        for (const n of nu) if (nv.has(n)) common.push(n);
        if (common.length > 2) continue;
        let linkOk = true;
        for (const n of common) {
            const tris = trisOf.get(n) || [];
            let formsFace = false;
            for (const t of tris) {
                if (deadTri[t]) continue;
                const a = canonical[index[t * 3]], b = canonical[index[t * 3 + 1]],
                      c = canonical[index[t * 3 + 2]];
                const set = [a, b, c];
                if (set.includes(u) && set.includes(v)) { formsFace = true; break; }
            }
            if (!formsFace) { linkOk = false; break; }
        }
        if (!linkOk) continue;

        // Geometric guards over u's surviving triangles (u -> v simulation).
        const pv = wpt(v);
        let safe = true;
        for (const t of trisOf.get(u) || []) {
            if (deadTri[t]) continue;
            const a = canonical[index[t * 3]], b = canonical[index[t * 3 + 1]],
                  c = canonical[index[t * 3 + 2]];
            if (a === v || b === v || c === v) continue;   // dies with the edge
            const p0 = a === u ? pv : wpt(a);
            const p1 = b === u ? pv : wpt(b);
            const p2 = c === u ? pv : wpt(c);
            const nNew = triCross(p0, p1, p2);
            if (cross2(nNew) < minArea2 * 4) { safe = false; break; }   // degenerate
            const nOld = triCross(wpt(a), wpt(b), wpt(c));
            if (dot3(nNew, nOld) <= 0) { safe = false; break; }          // fold-over
        }
        if (!safe) continue;
        // Anti-oscillation: no new edge may exceed 4/3 × target.
        for (const n of nu) {
            if (n === v || nv.has(n)) continue;
            if (d2(pv, wpt(n)) > longLimit2) { safe = false; break; }
        }
        if (!safe) continue;

        // Execute: u is single-member (raw id === canon id) — remap indices.
        for (let k = 0; k < index.length; k++) {
            if (canonical[index[k]] === u) index[k] = v;
        }
        for (const t of trisOf.get(u) || []) {
            const a = canonical[index[t * 3]], b = canonical[index[t * 3 + 1]],
                  c = canonical[index[t * 3 + 2]];
            if (a === b || b === c || c === a) deadTri[t] = 1;
            else {
                let lst = trisOf.get(v);
                if (!lst) { lst = []; trisOf.set(v, lst); }
                lst.push(t);
            }
        }
        // Merge adjacency; lock the whole 1-ring for the rest of this pass
        // (stale valence/link data beyond it).
        for (const n of nu) {
            if (n === u || n === v) continue;
            nv.add(n);
            const nn = neighbors.get(n);
            if (nn) { nn.delete(u); nn.add(v); }
            touched.add(n);
        }
        for (const n of nv) touched.add(n);
        neighbors.delete(u);
        touched.add(u);
        touched.add(v);
        canonical[u] = v;       // future canonical lookups resolve to v
        collapsed++;
    }

    if (collapsed === 0) return { collapsed: 0, trianglesRemoved: 0 };

    // Compact the index (order-preserving) + rebuild groups by prefix sums.
    const newIndex = [];
    const outCount = new Array(triCount);
    for (let t = 0; t < triCount; t++) {
        const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
        const dead = deadTri[t]
            || canonical[a] === canonical[b] || canonical[b] === canonical[c]
            || canonical[c] === canonical[a];
        if (!dead) newIndex.push(a, b, c);
        outCount[t] = dead ? 0 : 1;
    }
    if (work.groups && work.groups.length > 0) {
        let cursor = 0;
        for (const g of work.groups) {
            const t0 = Math.floor(g.start / 3), tn = Math.floor(g.count / 3);
            let trisOut = 0;
            for (let t = t0; t < t0 + tn && t < triCount; t++) trisOut += outCount[t];
            g.start = cursor;
            g.count = trisOut * 3;
            cursor += trisOut * 3;
        }
    }
    const removed = triCount - newIndex.length / 3;
    work.index = newIndex;
    return { collapsed, trianglesRemoved: removed };
}

/**
 * One flip pass: rotate interior region edges whose flip STRICTLY decreases
 * total valence deviation (target 6 interior / 4 boundary). Returns {flipped}.
 */
export function flipPass(work, matrixWorld, center, r2, quant, minArea2) {
    const T = buildTopology(work, matrixWorld, quant);
    const { index, canonical, memberCount, wpt, groupOf, edgeUse, edgeTris,
            openCanon, neighbors } = T;
    const cx = center.x, cy = center.y, cz = center.z;
    const uvA = work.attrs.find((a) => a.name === "uv");

    const insideCache = new Map();
    const inside = (c) => {
        let v = insideCache.get(c);
        if (v === undefined) {
            const p = wpt(c);
            v = (p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2 <= r2;
            insideCache.set(c, v);
        }
        return v;
    };

    // Valence per canon (unique canonical edges).
    const valence = new Map();
    for (const key of edgeUse.keys()) {
        const u = Math.floor(key / EDGE_K), v = key % EDGE_K;
        valence.set(u, (valence.get(u) || 0) + 1);
        valence.set(v, (valence.get(v) || 0) + 1);
    }
    const targetVal = (c) => (openCanon.has(c) ? 4 : 6);
    const dev = (c, delta = 0) => Math.abs((valence.get(c) || 0) + delta - targetVal(c));

    const usedTri = new Set();
    let flipped = 0;

    for (const key of [...edgeTris.keys()].sort((a, b) => a - b)) {
        const tris = edgeTris.get(key);
        if (!tris || tris.length !== 2) continue;
        const [t1, t2] = tris;
        if (usedTri.has(t1) || usedTri.has(t2)) continue;
        if (groupOf[t1] !== groupOf[t2]) continue;         // material boundary
        const a = Math.floor(key / EDGE_K), b = key % EDGE_K;
        // Locks: seams (multi-member welds) and open-rim endpoints stay.
        if (memberCount.get(a) !== 1 || memberCount.get(b) !== 1) continue;
        if (openCanon.has(a) || openCanon.has(b)) continue;
        // Region: all four corners inside the brush.
        const corners1 = [canonical[index[t1 * 3]], canonical[index[t1 * 3 + 1]],
                          canonical[index[t1 * 3 + 2]]];
        const corners2 = [canonical[index[t2 * 3]], canonical[index[t2 * 3 + 1]],
                          canonical[index[t2 * 3 + 2]]];
        const c = corners1.find((x) => x !== a && x !== b);
        const d = corners2.find((x) => x !== a && x !== b);
        if (c === undefined || d === undefined || c === d) continue;
        if (![...corners1, ...corners2].every(inside)) continue;
        // The flipped edge must not already exist.
        if (edgeUse.has(edgeKey(c, d))) continue;
        // Valence: strict improvement.
        const before = dev(a) + dev(b) + dev(c) + dev(d);
        const after = dev(a, -1) + dev(b, -1) + dev(c, 1) + dev(d, 1);
        if (after >= before) continue;

        // Raw corners (for UV winding) and consistent new winding:
        // t1 = (a, b, c) in some rotation; new triangles (a, d, c) + (d, b, c).
        const raw1 = [index[t1 * 3], index[t1 * 3 + 1], index[t1 * 3 + 2]];
        const raw2 = [index[t2 * 3], index[t2 * 3 + 1], index[t2 * 3 + 2]];
        // Rotate raw1 so that canonical order is (a, b, c).
        const rot = (raws, first) => {
            for (let k = 0; k < 3; k++) {
                if (canonical[raws[k]] === first) {
                    return [raws[k], raws[(k + 1) % 3], raws[(k + 2) % 3]];
                }
            }
            return raws;
        };
        let r1 = rot(raw1, a);
        if (canonical[r1[1]] !== b) {
            // t1 winds (a, c, b) — use the mirrored assignment.
            r1 = rot(raw1, b);
            if (canonical[r1[1]] !== a) continue;          // non-manifold weirdness
            // Swap roles of a/b so r1 = (a, b, c) canonically.
            const tmpR = r1;
            r1 = [tmpR[0], tmpR[1], tmpR[2]];
        }
        const rawA = r1[0], rawB = r1[1], rawC = r1[2];
        const rawD = raw2.find((x) => canonical[x] !== a && canonical[x] !== b);
        if (rawD === undefined) continue;

        // Geometry guards on the two new triangles (a,d,c) and (d,b,c).
        const pa = wpt(canonical[rawA]), pb = wpt(canonical[rawB]);
        const pc = wpt(canonical[rawC]), pd = wpt(canonical[rawD]);
        const nOld1 = triCross(pa, pb, pc);
        const nNew1 = triCross(pa, pd, pc);
        const nNew2 = triCross(pd, pb, pc);
        if (cross2(nNew1) < minArea2 * 4 || cross2(nNew2) < minArea2 * 4) continue;
        if (dot3(nNew1, nOld1) <= 0 || dot3(nNew2, nOld1) <= 0) continue;
        // UV winding must not invert (texture fold).
        if (uvA) {
            const uv = uvA.data;
            const suv = (i, j, k) => {
                const ux0 = uv[i * 2], uy0 = uv[i * 2 + 1];
                return (uv[j * 2] - ux0) * (uv[k * 2 + 1] - uy0)
                     - (uv[k * 2] - ux0) * (uv[j * 2 + 1] - uy0);
            };
            const oldS = suv(rawA, rawB, rawC);
            const n1 = suv(rawA, rawD, rawC);
            const n2 = suv(rawD, rawB, rawC);
            if (oldS !== 0 && (Math.sign(n1) !== Math.sign(oldS)
                            || Math.sign(n2) !== Math.sign(oldS))) continue;
        }

        // Execute: rewrite the two triangles in place.
        index[t1 * 3] = rawA; index[t1 * 3 + 1] = rawD; index[t1 * 3 + 2] = rawC;
        index[t2 * 3] = rawD; index[t2 * 3 + 1] = rawB; index[t2 * 3 + 2] = rawC;
        valence.set(a, valence.get(a) - 1);
        valence.set(b, valence.get(b) - 1);
        valence.set(c, (valence.get(c) || 0) + 1);
        valence.set(d, (valence.get(d) || 0) + 1);
        edgeUse.delete(key);
        edgeUse.set(edgeKey(c, d), 2);
        usedTri.add(t1);
        usedTri.add(t2);
        flipped++;
    }
    return { flipped };
}

/** Share of interior single-weld region vertices with valence in [5, 7] —
 *  the regularity number agents can gate on (≥ ~0.9 = clean). */
export function valenceShare(work, matrixWorld, center, r2, quant) {
    const T = buildTopology(work, matrixWorld, quant);
    const { wpt, memberCount, edgeUse, openCanon } = T;
    const cx = center.x, cy = center.y, cz = center.z;
    const valence = new Map();
    for (const key of edgeUse.keys()) {
        const u = Math.floor(key / EDGE_K), v = key % EDGE_K;
        valence.set(u, (valence.get(u) || 0) + 1);
        valence.set(v, (valence.get(v) || 0) + 1);
    }
    let total = 0, good = 0;
    for (const [c, val] of valence) {
        if (memberCount.get(c) !== 1 || openCanon.has(c)) continue;
        const p = wpt(c);
        if ((p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2 > r2) continue;
        total++;
        if (val >= 5 && val <= 7) good++;
    }
    return total > 0 ? Math.round((good / total) * 1000) / 1000 : null;
}
