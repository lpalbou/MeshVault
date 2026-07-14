/**
 * Cut-face capping (backlog 051): close the hollow faces a split_object plane
 * cut leaves open — the black gashes visible in every articulation render.
 *
 * Design constraints (from the 051 adversarial review):
 * - The rim is NOT "vertices near the plane" (whole-triangle classification
 *   scatters rim vertices up to a triangle's extent off the plane — any
 *   tolerance is wrong). The rim is the set of edges that BECAME open because
 *   of the split: welded edges with multiplicity 1 on one side and >0 on the
 *   other, computed from the pre-split classification. Pre-existing open
 *   boundaries never qualify by construction.
 * - Cap triangles use DUPLICATED rim vertices (same position, cap normal,
 *   cap UV) — reusing rim indices would inherit side-wall normals/UVs AND
 *   corrupt the walls' texturing. Duplication also makes rim positions
 *   multi-member welds, which simplify_region already hard-locks as seams.
 * - Triangulation: project the loop onto the cut plane, ear-clip in 2D for
 *   quality; verify every rim edge is used exactly once; fall back to a
 *   centroid fan (closure guaranteed by construction) when ear-clipping
 *   cannot complete cleanly. Closure is then RECOUNTED, never assumed.
 * - Orientation per loop from the projected signed area against the target
 *   normal (extracted side faces −n, remainder +n, n = the signed
 *   classification normal), computed in MESH-LOCAL space.
 * - UV policy (v0): collapse cap UVs to one rim vertex's UV — a flat sample
 *   of the adjacent real surface. Never create paint layers, never touch
 *   material colors, zero budget, zero post-commit canvas writes.
 */

import * as THREE from "three";

/**
 * Weld map for a geometry (positions quantized at 1e-6 × bbox diagonal — the
 * same rule the repair/articulation topology uses).
 */
function weldCanon(geometry) {
    const pos = geometry.getAttribute("position");
    geometry.computeBoundingBox();
    const diag = geometry.boundingBox
        ? geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1 : 1;
    const quant = diag * 1e-6;
    const byKey = new Map();
    const canonOf = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
        const k = `${Math.round(pos.getX(i) / quant)}_${Math.round(pos.getY(i) / quant)}_${Math.round(pos.getZ(i) / quant)}`;
        let c = byKey.get(k);
        if (c === undefined) { c = i; byKey.set(k, c); }
        canonOf[i] = c;
    }
    return canonOf;
}

/**
 * Walk rim edges (canonical pairs) into closed loops; disclose leftovers.
 *
 * Junction handling (051 field finding B1): re-cutting through an EXISTING
 * cap crosses the previous rim ring at points where cap-duplicate and wall
 * vertices weld together — every crossing is a 4-degree junction, and a
 * naive "reject on branch" walk skipped the entire remaining rim (256 edges,
 * a permanent hole). At junctions the walk now continues by ANGLE: pick the
 * leftmost turn in the cap plane (`project` maps a canonical vertex to 2D),
 * which decomposes tangent/crossing boundaries into simple non-crossing
 * loops — the standard planar boundary-tracing rule.
 */
function walkLoops(rimEdges, project) {
    const adj = new Map();   // canon -> [{to, edgeIdx}]
    rimEdges.forEach(([a, b], i) => {
        if (!adj.has(a)) adj.set(a, []);
        if (!adj.has(b)) adj.set(b, []);
        adj.get(a).push({ to: b, edgeIdx: i });
        adj.get(b).push({ to: a, edgeIdx: i });
    });
    const used = new Uint8Array(rimEdges.length);
    const loops = [];
    let skipped = 0;

    const pickByAngle = (cur, prev, candidates) => {
        if (candidates.length === 1 || !prev) return candidates[0];
        const [cx, cy] = project(cur);
        const [px, py] = project(prev);
        const inx = cx - px, iny = cy - py;
        let best = candidates[0], bestAngle = -Infinity;
        for (const cand of candidates) {
            const [tx, ty] = project(cand.to);
            const dx = tx - cx, dy = ty - cy;
            // Signed turn angle from the incoming direction; leftmost wins.
            const angle = Math.atan2(inx * dy - iny * dx, inx * dx + iny * dy);
            if (angle > bestAngle) { bestAngle = angle; best = cand; }
        }
        return best;
    };

    for (let start = 0; start < rimEdges.length; start++) {
        if (used[start]) continue;
        const origin = rimEdges[start][0];
        const loop = [origin];
        let prev = null;
        let cur = origin;
        const walkEdges = new Set();
        let ok = false;
        for (let step = 0; step <= rimEdges.length; step++) {
            const nexts = (adj.get(cur) || []).filter(
                (e) => !used[e.edgeIdx] && !walkEdges.has(e.edgeIdx));
            if (nexts.length === 0) break;
            const e = pickByAngle(cur, prev, nexts);
            walkEdges.add(e.edgeIdx);
            prev = cur;
            cur = e.to;
            if (cur === origin) { ok = true; break; }
            // Revisits of NON-origin vertices are legitimate at junctions
            // (tangent loops); each occurrence gets its own cap duplicate.
            loop.push(cur);
        }
        if (ok && loop.length >= 3) {
            for (const ei of walkEdges) used[ei] = 1;
            loops.push(loop);
        } else {
            // Mark the failed walk's edges used so we don't retry them forever.
            for (const ei of walkEdges) used[ei] = 1;
            skipped += walkEdges.size || 1;
        }
    }
    return { loops, skippedEdges: skipped };
}

/** Ear-clip a 2D polygon (index list into pts). Returns triangles or null.
 *  minArea2 = twice the minimum acceptable triangle area, in the SAME scale
 *  fix_mesh's degenerate pass uses — ears thinner than that would be emitted
 *  here and dropped there, silently REOPENING pinholes (field-audit finding:
 *  the old bbox-relative epsilon sat ~3 orders of magnitude below it). */
function earClip(pts, minArea2) {
    const n = pts.length;
    if (n < 3) return null;
    const epsArea = Math.max(1e-30, minArea2);

    const idx = [...Array(n).keys()];
    const cross = (o, a, b) =>
        (pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1])
        - (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]);
    const inTri = (p, a, b, c) => {
        const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
        const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
        const posi = (d1 > 0) || (d2 > 0) || (d3 > 0);
        return !(neg && posi);
    };
    const tris = [];
    let guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
        let clipped = false;
        for (let i = 0; i < idx.length; i++) {
            const prev = idx[(i - 1 + idx.length) % idx.length];
            const cur = idx[i];
            const next = idx[(i + 1) % idx.length];
            const area2 = cross(prev, cur, next);
            // Strictly convex ears only: zero-area ears yield degenerate cap
            // triangles that fix_mesh later drops (reopening pinholes).
            if (area2 <= epsArea) continue;
            let contains = false;
            for (const j of idx) {
                if (j === prev || j === cur || j === next) continue;
                if (inTri(j, prev, cur, next)) { contains = true; break; }
            }
            if (contains) continue;
            tris.push([prev, cur, next]);
            idx.splice(i, 1);
            clipped = true;
            break;
        }
        if (!clipped) return null;   // collinear runs / self-intersections
    }
    if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
    return tris;
}

/**
 * Cap the rims of ONE geometry in place-by-replacement.
 *
 * @param geometry   BufferGeometry (freshly extracted side of a split)
 * @param rimEdges   [[i, j], ...] vertex-index pairs IN THIS GEOMETRY
 * @param targetNormalLocal THREE.Vector3 — the direction every cap must face
 *                   (mesh-local; extracted side −n, remainder +n)
 * @returns {geometry, report} — a NEW geometry with caps appended, plus
 *          {loops, capTriangles, skippedEdges, fallbackFans, uvMode}
 */
export function capGeometry(geometry, rimEdges, targetNormalLocal, opts = {}) {
    const report = { loops: 0, capTriangles: 0, skippedEdges: 0,
                     fallbackFans: 0, uvMode: "none" };
    if (!rimEdges.length) return { geometry, report };

    const canonOf = weldCanon(geometry);
    // Canonicalize + dedupe rim edges; keep one raw representative per canon.
    const seen = new Set();
    const canonEdges = [];
    for (const [a, b] of rimEdges) {
        const ca = canonOf[a], cb = canonOf[b];
        if (ca === cb) continue;
        const key = Math.min(ca, cb) * 16777216 + Math.max(ca, cb);
        if (seen.has(key)) continue;
        seen.add(key);
        canonEdges.push([ca, cb]);
    }
    const pos = geometry.getAttribute("position");
    const n = targetNormalLocal.clone().normalize();
    // Plane basis (u ⊥ v ⊥ n, right-handed: u × v = n).
    const u = Math.abs(n.x) < 0.9
        ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    u.cross(n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);

    // 2D projector for the angular junction rule in the loop walk.
    const projTmp = new THREE.Vector3();
    const project = (ci) => {
        projTmp.fromBufferAttribute(pos, ci);
        return [projTmp.dot(u), projTmp.dot(v)];
    };
    const { loops, skippedEdges } = walkLoops(canonEdges, project);
    report.skippedEdges = skippedEdges;
    if (!loops.length) return { geometry, report };

    // Degenerate threshold in fix_mesh's OWN scale (area > diag × 1e-7): ears
    // below it must not be emitted (they'd be dropped later, reopening holes).
    geometry.computeBoundingBox();
    const diag = geometry.boundingBox
        ? geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1 : 1;
    const minArea2 = 2 * diag * 1e-7;   // area2 = 2 × area

    const names = Object.keys(geometry.attributes);
    const attrs = {};
    for (const name of names) attrs[name] = geometry.getAttribute(name);
    const hasUV = !!attrs.uv;
    report.uvMode = hasUV ? "rim-sample" : "none";

    // {rep, uvRep} — rep supplies copied attributes (color/tangent…);
    // uvRep is the LOOP ANCHOR whose UV every cap vertex of the loop takes:
    // per-vertex rim UVs would make cap triangles INTERPOLATE across the
    // atlas, sweeping unrelated islands (field-audit BUG-1 — the "stretched
    // garbage" this item exists to kill). One anchor = one flat sample.
    const extraVerts = [];
    const extraTris = [];    // indices into (pos.count + extraVerts)
    const p = new THREE.Vector3();

    for (const loop of loops) {
        // Project onto the cap plane.
        const pts2 = loop.map((ci) => {
            p.fromBufferAttribute(pos, ci);
            return [p.dot(u), p.dot(v)];
        });
        // Signed area: positive = CCW in (u,v) = geometric normal +n.
        let area2 = 0;
        for (let i = 0; i < pts2.length; i++) {
            const [x1, y1] = pts2[i];
            const [x2, y2] = pts2[(i + 1) % pts2.length];
            area2 += x1 * y2 - x2 * y1;
        }
        const ordered = area2 >= 0 ? loop.slice() : loop.slice().reverse();
        const ordPts = area2 >= 0 ? pts2 : pts2.slice().reverse();

        // Duplicate rim vertices for this loop's cap (UV = the loop anchor's).
        // Anchor choice matters on fragmented atlases: a random rim vertex is
        // a one-texel color LOTTERY (051 field: an olive-gray cap on a wooden
        // chest). When the caller supplies a texel sampler, pick the rim
        // vertex whose color is CLOSEST TO THE MEDIAN of all rim texels — the
        // most representative flat sample, deterministic.
        let anchor = ordered[0];
        if (opts.sampleRimColor && attrs.uv) {
            const samples = ordered
                .map((ci) => ({ ci, rgb: opts.sampleRimColor(
                    attrs.uv.getX(ci), attrs.uv.getY(ci)) }))
                .filter((s) => s.rgb);
            if (samples.length >= 3) {
                const med = [0, 1, 2].map((k) => {
                    const vals = samples.map((s) => s.rgb[k]).sort((x, y) => x - y);
                    return vals[Math.floor(vals.length / 2)];
                });
                let bestD = Infinity;
                for (const s of samples) {
                    const d = (s.rgb[0] - med[0]) ** 2 + (s.rgb[1] - med[1]) ** 2
                        + (s.rgb[2] - med[2]) ** 2;
                    if (d < bestD) { bestD = d; anchor = s.ci; }
                }
            }
        }
        const capIdx = [];
        for (const ci of ordered) {
            capIdx.push(pos.count + extraVerts.length);
            extraVerts.push({ rep: ci, uvRep: anchor });
        }

        const tris = earClip(ordPts, minArea2);
        if (!tris) {
            // Centroid fan: closure by construction (every rim edge used once).
            report.fallbackFans++;
            const centroid = new THREE.Vector3();
            for (const ci of ordered) {
                centroid.add(p.fromBufferAttribute(pos, ci));
            }
            centroid.divideScalar(ordered.length);
            const centroidIdx = pos.count + extraVerts.length;
            extraVerts.push({ rep: anchor, uvRep: anchor,
                              overridePos: centroid.clone() });
            for (let i = 0; i < ordered.length; i++) {
                extraTris.push([centroidIdx, capIdx[i],
                                capIdx[(i + 1) % ordered.length]]);
            }
            report.capTriangles += ordered.length;
        } else {
            for (const [a, b, c] of tris) {
                extraTris.push([capIdx[a], capIdx[b], capIdx[c]]);
            }
            report.capTriangles += tris.length;
        }
        report.loops++;
    }

    // ---- rebuild the geometry with appended cap vertices/triangles ---------
    const out = new THREE.BufferGeometry();
    const oldCount = pos.count;
    const newCount = oldCount + extraVerts.length;
    for (const name of names) {
        const src = attrs[name];
        const size = src.itemSize;
        const arr = new Float32Array(newCount * size);
        for (let i = 0; i < oldCount; i++) {
            for (let c = 0; c < size; c++) arr[i * size + c] = src.getComponent(i, c);
        }
        extraVerts.forEach((ev, k) => {
            const dst = (oldCount + k) * size;
            if (name === "position" && ev.overridePos) {
                arr[dst] = ev.overridePos.x;
                arr[dst + 1] = ev.overridePos.y;
                arr[dst + 2] = ev.overridePos.z;
            } else if (name === "normal") {
                arr[dst] = n.x; arr[dst + 1] = n.y; arr[dst + 2] = n.z;
            } else if (name.startsWith("uv")) {
                // ONE anchor UV per loop — a flat sample of the adjacent
                // surface. Per-vertex rim UVs would interpolate across the
                // atlas (smeared multi-island streaks on fragmented atlases).
                for (let c = 0; c < size; c++) {
                    arr[dst + c] = src.getComponent(ev.uvRep, c);
                }
            } else {
                // position (plain), color/tangent (copied from the rim rep —
                // zeros would NaN tangent shaders).
                for (let c = 0; c < size; c++) {
                    arr[dst + c] = src.getComponent(ev.rep, c);
                }
            }
        });
        out.setAttribute(name, new THREE.BufferAttribute(arr, size));
    }
    const oldIndex = geometry.getIndex();
    const oldTriCount = oldIndex ? oldIndex.count : oldCount;
    const newIndex = new Uint32Array(oldTriCount + extraTris.length * 3);
    if (oldIndex) {
        for (let i = 0; i < oldIndex.count; i++) newIndex[i] = oldIndex.getX(i);
    } else {
        for (let i = 0; i < oldCount; i++) newIndex[i] = i;
    }
    extraTris.forEach(([a, b, c], k) => {
        const o = oldTriCount + k * 3;
        newIndex[o] = a; newIndex[o + 1] = b; newIndex[o + 2] = c;
    });
    out.setIndex(new THREE.BufferAttribute(newIndex, 1));
    out.computeBoundingBox();
    out.computeBoundingSphere();
    // Sliver audit: the smallest emitted cap triangle's 3D area, in the same
    // units fix_mesh judges degenerates by (its threshold is diag × 1e-7) —
    // fan slivers below it would reopen as pinholes after a degenerate pass.
    {
        const posOut = out.getAttribute("position");
        const a = new THREE.Vector3(), b2 = new THREE.Vector3(), c = new THREE.Vector3();
        const ab = new THREE.Vector3(), ac = new THREE.Vector3();
        let minA = Infinity;
        for (const [i, j, k] of extraTris) {
            a.fromBufferAttribute(posOut, i);
            b2.fromBufferAttribute(posOut, j);
            c.fromBufferAttribute(posOut, k);
            ab.subVectors(b2, a); ac.subVectors(c, a);
            const area = ab.cross(ac).length() / 2;
            if (area < minA) minA = area;
        }
        report.capMinTriangleArea = Number.isFinite(minA)
            ? Number(minA.toPrecision(3)) : null;
    }
    return { geometry: out, report };
}
