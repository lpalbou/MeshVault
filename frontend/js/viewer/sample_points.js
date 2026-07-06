/**
 * sample_points — deterministic, area-weighted surface sampling (backlog 039 compare).
 *
 * Produces N world-space points distributed uniformly over the model's surface area.
 * This is the geometric fingerprint the compare pipeline registers and measures — it
 * must be:
 * - AREA-weighted (not per-vertex): vertex density is an artifact of tessellation, not
 *   shape. A dense head next to a 2-triangle wall must not bias toward the head.
 * - DETERMINISTIC (seeded RNG): the same model must produce the same samples across
 *   calls/sessions, so comparisons are reproducible.
 * - WORLD-space: after user transforms (rotate/center), samples reflect what's shown.
 *
 * Sampling: cumulative-area table over all triangles, binary search per sample,
 * uniform barycentric coordinates (sqrt trick for uniformity within the triangle).
 */

import * as THREE from "three";

const MAX_POINTS = 20000;

/** mulberry32 — tiny deterministic PRNG; quality is ample for surface sampling. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function samplePoints(viewer, opts = {}) {
    if (!viewer._currentModel) return { error: "No model loaded" };
    const count = Math.max(16, Math.min(MAX_POINTS, opts.count || 4096));
    const rand = mulberry32(opts.seed !== undefined ? opts.seed : 42);
    const model = viewer._currentModel;
    model.updateMatrixWorld(true);

    // Pass 1: collect triangles (world space) + cumulative areas.
    const tris = [];        // flat entries {a,b,c} as Vector3
    const cumArea = [];
    let total = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    model.traverse((child) => {
        if (!child.isMesh || !child.geometry) return;
        const pos = child.geometry.getAttribute("position");
        if (!pos) return;
        const idx = child.geometry.getIndex();
        const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
        const mw = child.matrixWorld;
        const vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
        for (let t = 0; t < triCount; t++) {
            a.fromBufferAttribute(pos, vi(t, 0)).applyMatrix4(mw);
            b.fromBufferAttribute(pos, vi(t, 1)).applyMatrix4(mw);
            c.fromBufferAttribute(pos, vi(t, 2)).applyMatrix4(mw);
            const area = triArea(a, b, c);
            if (!(area > 0) || !Number.isFinite(area)) continue;  // degenerate/NaN
            total += area;
            tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            cumArea.push(total);
        }
    });
    if (cumArea.length === 0) return { error: "Model has no sampleable surface" };

    // Rounding precision must be RELATIVE to model size: a fixed 1e-5 absolute round
    // would dominate sub-millimeter models. Round to ~1e-6 of the bbox diagonal.
    const bbox = new THREE.Box3().setFromObject(model);
    const span = bbox.getSize(new THREE.Vector3()).length() || 1;
    const roundP = Math.max(3, Math.min(9, Math.ceil(-Math.log10(span * 1e-6))));
    const rnd = (v) => Number(v.toFixed(roundP));

    // Pass 2: draw samples.
    const points = new Array(count);
    for (let i = 0; i < count; i++) {
        const r = rand() * total;
        // Binary search the cumulative table for the triangle containing r.
        let lo = 0, hi = cumArea.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cumArea[mid] < r) lo = mid + 1; else hi = mid;
        }
        const o = lo * 9;
        // Uniform barycentric point: P = (1-√u)A + √u(1-v)B + √u·v·C
        const su = Math.sqrt(rand());
        const v = rand();
        const w0 = 1 - su, w1 = su * (1 - v), w2 = su * v;
        points[i] = [
            rnd(w0 * tris[o] + w1 * tris[o + 3] + w2 * tris[o + 6]),
            rnd(w0 * tris[o + 1] + w1 * tris[o + 4] + w2 * tris[o + 7]),
            rnd(w0 * tris[o + 2] + w1 * tris[o + 5] + w2 * tris[o + 8]),
        ];
    }
    return {
        count,
        seed: opts.seed !== undefined ? opts.seed : 42,
        surfaceArea: Number(total.toPrecision(5)),
        points,
    };
}

const _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _cr = new THREE.Vector3();
function triArea(a, b, c) {
    _ab.subVectors(b, a); _ac.subVectors(c, a);
    return _cr.crossVectors(_ab, _ac).length() / 2;
}
