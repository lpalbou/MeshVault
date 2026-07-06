/**
 * Deviation heatmap (backlog 041 v1): paint each vertex of the DISPLAYED model by its
 * distance to another (registered) model's surface, so a user SEES where two shapes
 * differ — the thing counts and screenshots can't show.
 *
 * Distance is computed with a BVH (three-mesh-bvh) over the OTHER model's geometry:
 * for every vertex of the displayed model we query the closest point on the other
 * surface. The colour ramp (blue→green→yellow→red) is normalized to the reference
 * bounding-box diagonal so it reads consistently across scales.
 *
 * Applied as a per-object material override reusing the render-mode stash
 * (`_mvOriginalMaterial`), so `clearDeviationHeatmap` restores cleanly.
 *
 * Accuracy caveat (documented): distance is sampled at the displayed model's VERTICES,
 * so a coarse displayed mesh against a detailed other one under-reports local detail.
 */

import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

/**
 * @param {THREE.Object3D} target  - the DISPLAYED model to paint (vertices get colours)
 * @param {THREE.Object3D} other   - the model to measure distance TO
 * @param {number[]}       matrix4 - column-major 4x4 mapping `other` into `target`'s
 *                                   frame (the registration transform); identity if null
 * @param {number}         diag    - reference bbox diagonal for colour normalization
 * @returns {{min,max,mean,p95,rampMax,unit}} distance stats (world units)
 */
export function applyDeviationHeatmap(target, other, matrix4, diag) {
    const xform = matrix4 ? new THREE.Matrix4().fromArray(matrix4) : new THREE.Matrix4();

    // Build one BVH over ALL of `other`'s triangles, in target-frame world space.
    // Positions are read through the ACCESSOR (getX/Y/Z) and transformed in JS double
    // precision — this correctly handles interleaved / quantized (Int16/normalized)
    // attributes, where reading the raw `.array` or applyMatrix4 would corrupt them.
    other.updateMatrixWorld(true);
    const merged = gatherWorldTriangles(other, xform);
    if (!merged) throw new Error("Other model has no geometry to measure against");
    const bvh = new MeshBVH(merged);

    const target2other = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const hit = {};
    const allDists = [];

    target.updateMatrixWorld(true);
    target.traverse((c) => {
        if (!c.isMesh || !c.geometry) return;
        const pos = c.geometry.getAttribute("position");
        if (!pos) return;
        // Query in the BVH's (merged, target-world) space: transform each target vertex
        // by its own world matrix.
        target2other.copy(c.matrixWorld);
        const colors = new Float32Array(pos.count * 3);
        const dists = new Float32Array(pos.count);
        for (let i = 0; i < pos.count; i++) {
            p.fromBufferAttribute(pos, i).applyMatrix4(target2other);
            bvh.closestPointToPoint(p, hit);
            dists[i] = hit.distance;
            allDists.push(hit.distance);
        }
        c.userData._mvHeatmapDists = dists;
        c.userData._mvHeatmapColors = colors;  // filled after we know the ramp
    });

    // Ramp: cap at the 98th percentile so a few outliers don't wash the whole model to
    // red; floor at ~1% of the diagonal so sub-percent noise (compression, sampling)
    // reads as "matches" (cool) while genuine edits — which exceed the floor and push
    // the p98 up — light up. The exact rampMax is reported so the colours are legible.
    allDists.sort((a, b) => a - b);
    const pct = (q) => allDists.length ? allDists[Math.min(allDists.length - 1, Math.floor(allDists.length * q))] : 0;
    const rampMax = Math.max(pct(0.98), diag * 0.01);

    target.traverse((c) => {
        if (!c.isMesh || !c.userData._mvHeatmapDists) return;
        const dists = c.userData._mvHeatmapDists;
        const colors = c.userData._mvHeatmapColors;
        const col = new THREE.Color();
        for (let i = 0; i < dists.length; i++) {
            rampColor(Math.min(1, dists[i] / rampMax), col);
            colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
        }
        c.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        if (!c._mvOriginalMaterial) c._mvOriginalMaterial = c.material;
        // Unlit: a deviation ramp must read the SAME regardless of scene lighting, or a
        // shadowed red patch looks like a lit blue one. Basic material shows true colours;
        // form is still legible from the silhouette and the ramp gradients.
        c.material = new THREE.MeshBasicMaterial({
            vertexColors: true, side: THREE.DoubleSide,
        });
        delete c.userData._mvHeatmapDists;
        delete c.userData._mvHeatmapColors;
    });

    merged.dispose();
    bvh.geometry = null;

    const mean = allDists.reduce((s, v) => s + v, 0) / (allDists.length || 1);
    return {
        min: round(allDists[0] || 0), max: round(allDists[allDists.length - 1] || 0),
        mean: round(mean), p95: round(pct(0.95)), rampMax: round(rampMax), unit: "world units",
    };
}

/** Restore the pre-heatmap materials and remove the colour attribute. */
export function clearDeviationHeatmap(target) {
    if (!target) return;
    target.traverse((c) => {
        if (!c.isMesh) return;
        if (c._mvOriginalMaterial) {
            if (c.material && c.material !== c._mvOriginalMaterial) c.material.dispose();
            c.material = c._mvOriginalMaterial;
            delete c._mvOriginalMaterial;
        }
        if (c.geometry && c.geometry.getAttribute("color")) c.geometry.deleteAttribute("color");
    });
}

// --- helpers ---

/**
 * Collect every triangle of `object` as a single non-indexed position buffer in world
 * space (then mapped by `xform`). Reads via the accessor so interleaved/quantized
 * attributes are decoded correctly, and expands the index so the BVH sees real triangles.
 */
function gatherWorldTriangles(object, xform) {
    const chunks = [];
    let total = 0;
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    object.traverse((c) => {
        if (!c.isMesh || !c.geometry) return;
        const pos = c.geometry.getAttribute("position");
        if (!pos) return;
        const idx = c.geometry.getIndex();
        const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
        if (triCount === 0) return;
        m.multiplyMatrices(xform, c.matrixWorld);
        const arr = new Float32Array(triCount * 9);
        const vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
        for (let t = 0; t < triCount; t++) {
            for (let k = 0; k < 3; k++) {
                v.fromBufferAttribute(pos, vi(t, k)).applyMatrix4(m);
                const o = t * 9 + k * 3;
                arr[o] = v.x; arr[o + 1] = v.y; arr[o + 2] = v.z;
            }
        }
        chunks.push(arr);
        total += arr.length;
    });
    if (chunks.length === 0) return null;
    const out = new Float32Array(total);
    let o = 0;
    for (const a of chunks) { out.set(a, o); o += a.length; }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.BufferAttribute(out, 3));
    return merged;
}

/** Blue (0) → cyan → green → yellow → red (1) perceptual-ish ramp. */
function rampColor(t, out) {
    const stops = [
        [0.0, 0.15, 0.4, 0.85],  // deep blue = matches
        [0.35, 0.1, 0.8, 0.5],   // green
        [0.7, 0.95, 0.85, 0.15], // yellow
        [1.0, 0.9, 0.15, 0.1],   // red = far
    ];
    for (let i = 0; i < stops.length - 1; i++) {
        const [a, ar, ag, ab] = stops[i];
        const [b, br, bg, bb] = stops[i + 1];
        if (t <= b) {
            const f = (t - a) / (b - a || 1);
            return out.setRGB(ar + (br - ar) * f, ag + (bg - ag) * f, ab + (bb - ab) * f);
        }
    }
    return out.setRGB(0.9, 0.15, 0.1);
}

const round = (v) => Math.round(v * 1e6) / 1e6;
