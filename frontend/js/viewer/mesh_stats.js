/**
 * mesh_stats — numeric surface-quality statistics + issue localization (backlog 037).
 *
 * Why: connectivity QA (watertight/manifold) gives the WRONG quality verdict on real
 * reconstruction meshes — a topologically perfect mesh can be perceptual garbage
 * (depth-spike shredding), while the visually best iteration carries minor defects.
 * These statistics turn "looks shredded in screenshots" into numbers a text-only agent
 * can compare across model iterations in one call:
 *
 * - dihedral roughness: mean/p95 angle between adjacent face normals. Smooth organic
 *   surfaces sit well under ~15° mean; depth-spike or heavy-banding surfaces spike it.
 * - edge-length distribution (min/median/p95/max) — tessellation uniformity.
 * - sliver percentage, surface area, absolute volume.
 * - issue LOCATIONS: representative world-space points for open/non-manifold edges and
 *   degenerate triangles, chosen greedily for spread — feed them to `focus {point}`.
 *
 * Budget-bounded like describe_scene's QA: above the triangle cap it returns counts
 * only, with `skipped: true` so an agent never mistakes "skipped" for "clean".
 */

import * as THREE from "three";

const TRIANGLE_BUDGET = 300_000;
const MAX_LOCALIZED = 5;      // representative points per issue kind
const MAX_SAMPLES = 2000;     // raw candidates collected before spreading

export function meshStatistics(viewer, opts = {}) {
    if (!viewer._currentModel) return { loaded: false, error: "No model loaded" };
    const model = viewer._currentModel;
    model.updateMatrixWorld(true);

    const perMesh = [];
    let totalTris = 0;
    model.traverse((child) => {
        if (child.isMesh && child.geometry) {
            const pos = child.geometry.getAttribute("position");
            const idx = child.geometry.getIndex();
            totalTris += Math.floor((idx ? idx.count : (pos ? pos.count : 0)) / 3);
        }
    });
    if (totalTris > TRIANGLE_BUDGET) {
        return {
            loaded: true, skipped: true, triangles: totalTris,
            note: `Statistics skipped: ${totalTris.toLocaleString()} triangles exceeds the ${TRIANGLE_BUDGET.toLocaleString()} budget.`,
        };
    }

    let id = 0;
    model.traverse((child) => {
        if (!child.isMesh || !child.geometry) { return; }
        const meshId = id++;
        const stats = analyzeMesh(child);
        if (stats) perMesh.push({ id: meshId, name: child.name || "(unnamed)", ...stats });
    });

    // Aggregate across meshes (weighted by triangle count where it makes sense).
    const agg = aggregate(perMesh);
    return { loaded: true, skipped: false, total: agg, meshes: perMesh };
}

function aggregate(perMesh) {
    const total = {
        triangles: 0, surfaceArea: 0, volume: 0, sliverPct: 0,
        openEdges: 0, nonManifoldEdges: 0, degenerate: 0,
        dihedral: { meanDeg: 0, p95Deg: 0 },
        edgeLength: { min: Infinity, median: 0, p95: 0, max: 0 },
        issuePoints: { openEdges: [], nonManifold: [], degenerate: [] },
    };
    let tris = 0;
    let anyOpenVolume = false;
    for (const m of perMesh) {
        tris += m.triangles;
        total.triangles += m.triangles;
        total.surfaceArea += m.surfaceArea;
        if (m.volume === null) anyOpenVolume = true;
        else total.volume += m.volume;
        total.sliverPct += m.sliverPct * m.triangles;
        total.openEdges += m.openEdges;
        total.nonManifoldEdges += m.nonManifoldEdges;
        total.degenerate += m.degenerate;
        total.dihedral.meanDeg += m.dihedral.meanDeg * m.triangles;
        total.dihedral.p95Deg = Math.max(total.dihedral.p95Deg, m.dihedral.p95Deg);
        total.edgeLength.min = Math.min(total.edgeLength.min, m.edgeLength.min);
        total.edgeLength.max = Math.max(total.edgeLength.max, m.edgeLength.max);
        total.edgeLength.median += m.edgeLength.median * m.triangles;
        total.edgeLength.p95 = Math.max(total.edgeLength.p95, m.edgeLength.p95);
        for (const k of ["openEdges", "nonManifold", "degenerate"]) {
            total.issuePoints[k].push(...m.issuePoints[k]);
        }
    }
    if (tris > 0) {
        total.sliverPct = r4(total.sliverPct / tris);
        total.dihedral.meanDeg = r2(total.dihedral.meanDeg / tris);
        total.edgeLength.median = sci(total.edgeLength.median / tris);
    }
    // With multiple meshes, total median/mean are triangle-weighted combinations of the
    // per-mesh values, NOT true global statistics — flag it so agents read per-mesh
    // entries when precision matters (e.g. bimodal scenes like a housing + tiny screw).
    if (perMesh.length > 1) {
        total.edgeLength.approx = true;
        total.dihedral.approx = true;
    }
    if (!Number.isFinite(total.edgeLength.min)) total.edgeLength.min = 0;
    total.surfaceArea = sci(total.surfaceArea);
    // Volume is only reported for closed meshes; if any mesh is open, the total would
    // be misleading (see analyzeMesh). null = "not computable", not zero.
    total.volume = anyOpenVolume ? null : sci(total.volume);
    total.edgeLength.min = sci(total.edgeLength.min);
    total.edgeLength.max = sci(total.edgeLength.max);
    total.edgeLength.p95 = sci(total.edgeLength.p95);
    for (const k of ["openEdges", "nonManifold", "degenerate"]) {
        total.issuePoints[k] = spread(total.issuePoints[k], MAX_LOCALIZED);
    }
    return total;
}

/** Single pass over one mesh's triangles in WORLD space. */
function analyzeMesh(mesh) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute("position");
    if (!pos || pos.count === 0) return null;
    const idx = geo.getIndex();
    const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
    if (triCount === 0) return null;
    const mw = mesh.matrixWorld;

    // Position weld (same policy as describe_scene) so seams don't fake boundaries.
    if (!geo.boundingBox) geo.computeBoundingBox();
    const scale = Math.max(1e-30, geo.boundingBox.max.distanceTo(geo.boundingBox.min));
    const q = 1e-6 * scale;
    const canon = new Map();
    const canonOf = new Int32Array(pos.count);
    let nextId = 0;
    for (let i = 0; i < pos.count; i++) {
        const key = `${Math.round(pos.getX(i) / q)},${Math.round(pos.getY(i) / q)},${Math.round(pos.getZ(i) / q)}`;
        let cid = canon.get(key);
        if (cid === undefined) { cid = nextId++; canon.set(key, cid); }
        canonOf[i] = cid;
    }
    const nVerts = Math.max(1, nextId);

    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
    const edgeInfo = new Map();     // numeric key → {count, nx,ny,nz (first face normal), mx,my,mz (midpoint)}
    const edgeLengths = [];
    const dihedrals = [];
    const degeneratePts = [];
    let area2sum = 0, vol6 = 0, sliver = 0;

    const vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
    for (let t = 0; t < triCount; t++) {
        const i0 = vi(t, 0), i1 = vi(t, 1), i2 = vi(t, 2);
        a.fromBufferAttribute(pos, i0).applyMatrix4(mw);
        b.fromBufferAttribute(pos, i1).applyMatrix4(mw);
        c.fromBufferAttribute(pos, i2).applyMatrix4(mw);
        ab.subVectors(b, a); ac.subVectors(c, a);
        n.crossVectors(ab, ac);
        const area2 = n.lengthSq();
        const lenSq = ab.lengthSq() * ac.lengthSq();
        if (area2 < 1e-12 * lenSq) {
            sliver += 1;
            if (degeneratePts.length < MAX_SAMPLES) {
                degeneratePts.push([(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3]);
            }
            continue;
        }
        const area = Math.sqrt(area2) / 2;
        area2sum += area;
        vol6 += a.x * (b.y * c.z - b.z * c.y) + a.y * (b.z * c.x - b.x * c.z) + a.z * (b.x * c.y - b.y * c.x);
        n.normalize();

        const corners = [[i0, i1, a, b], [i1, i2, b, c], [i2, i0, c, a]];
        for (const [u, v, p1, p2] of corners) {
            const cu = canonOf[u], cv = canonOf[v];
            if (cu === cv) continue;
            edgeLengths.push(p1.distanceTo(p2));
            const key = cu < cv ? cu * nVerts + cv : cv * nVerts + cu;
            const e = edgeInfo.get(key);
            if (!e) {
                edgeInfo.set(key, {
                    count: 1, nx: n.x, ny: n.y, nz: n.z,
                    mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2, mz: (p1.z + p2.z) / 2,
                });
            } else {
                e.count += 1;
                if (e.count === 2) {
                    // Dihedral: angle between this face's normal and the first face's.
                    const dot = Math.min(1, Math.max(-1, e.nx * n.x + e.ny * n.y + e.nz * n.z));
                    dihedrals.push(Math.acos(dot) * (180 / Math.PI));
                }
            }
        }
    }

    let openEdges = 0, nonManifoldEdges = 0;
    const openPts = [], nmPts = [];
    for (const e of edgeInfo.values()) {
        if (e.count === 1) {
            openEdges += 1;
            if (openPts.length < MAX_SAMPLES) openPts.push([e.mx, e.my, e.mz]);
        } else if (e.count > 2) {
            nonManifoldEdges += 1;
            if (nmPts.length < MAX_SAMPLES) nmPts.push([e.mx, e.my, e.mz]);
        }
    }

    edgeLengths.sort((x, y) => x - y);
    dihedrals.sort((x, y) => x - y);
    const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
    const mean = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

    return {
        triangles: triCount,
        surfaceArea: sci(area2sum),
        // Signed-volume sums are only translation-invariant for CLOSED surfaces; on an
        // open mesh the number silently changes with the origin (verified live: a pure
        // `center` changed it). Report null rather than a plausible-looking lie.
        volume: openEdges === 0 ? sci(Math.abs(vol6) / 6) : null,
        sliverPct: r4(triCount ? (sliver / triCount) * 100 : 0),
        degenerate: sliver,
        openEdges,
        nonManifoldEdges,
        edgeLength: {
            min: sci(edgeLengths[0] || 0),
            median: sci(pct(edgeLengths, 0.5)),
            p95: sci(pct(edgeLengths, 0.95)),
            max: sci(edgeLengths[edgeLengths.length - 1] || 0),
        },
        // Roughness: how much adjacent faces disagree. Smooth surface → small angles.
        dihedral: { meanDeg: r2(mean(dihedrals)), p95Deg: r2(pct(dihedrals, 0.95)) },
        issuePoints: {
            openEdges: spread(openPts, MAX_LOCALIZED),
            nonManifold: spread(nmPts, MAX_LOCALIZED),
            degenerate: spread(degeneratePts, MAX_LOCALIZED),
        },
    };
}

/** Greedy farthest-point selection: up to k representative points, spatially spread. */
function spread(points, k) {
    if (points.length <= k) return points.map(roundPt);
    const chosen = [points[0]];
    while (chosen.length < k) {
        let best = null, bestD = -1;
        for (const p of points) {
            let d = Infinity;
            for (const c of chosen) {
                const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
                d = Math.min(d, dx * dx + dy * dy + dz * dz);
            }
            if (d > bestD) { bestD = d; best = p; }
        }
        chosen.push(best);
    }
    return chosen.map(roundPt);
}

const roundPt = (p) => p.map((v) => Math.round(v * 1000) / 1000);
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
/** Compact numeric formatting: significant digits without float noise. */
const sci = (v) => (v === 0 ? 0 : Number(v.toPrecision(4)));
