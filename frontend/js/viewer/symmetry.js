/**
 * Symmetry detection + mirror healing (backlog 050).
 *
 * The repair class clone_paint cannot cover: when the best donor for a texture
 * defect is the object's own mirrored counterpart (a portrait's clean right eye
 * healing the corrupted left), the correspondence is a REFLECTION, not a
 * translation — clone_paint's 45° same-orientation cone correctly refuses it.
 *
 * Design constraints (from the 050 adversarial review):
 * - All reflection math happens in WRAPPER-LOCAL space: the world map is
 *   P' = W · R · W⁻¹ · P (W = wrapper matrixWorld, R = local Householder
 *   reflection). Reflecting world points across a world-transformed normal is
 *   only valid for rotation + uniform scale — non-uniform scale would silently
 *   corrupt both the correspondence and the normal guard.
 * - NO patch flip anywhere: the per-texel reflected correspondence has
 *   determinant −1, so sampled content arrives intrinsically mirrored. Adding
 *   a 2D flip would produce an orientation-PRESERVING copy (right eye pasted
 *   un-mirrored — tear duct on the temple side). That step is a chirality bug.
 * - The detected plane is bound to entry.geometryRev (sculpt/bake/UV edits
 *   invalidate it); placement changes do NOT (the plane lives in local frame).
 * - detect_symmetry scores with a BVH over merged wrapper-local triangles
 *   (brute force is ~5×10⁸ triangle tests — tens of seconds); mirror_paint
 *   needs no BVH (clone_paint's centroid prefilter around the REFLECTED brush
 *   center covers the small source region).
 * - Robust scoring: median + p90 of reflected-point-to-surface distance
 *   (normalized by the local bbox diagonal) PLUS mean normal agreement —
 *   catches planes that map surface onto surface positionally but with the
 *   wrong orientation. Mean distance alone has heavy tails on open scans.
 */

import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import {
    FALLOFFS,
    assertNoMorphForHeal,
    assertNotSkinned,
    beginPaintOp,
    brushFootprint,
    ensureRepairableLayer,
    resolveRadius,
    stashPaintPatch,
    wrongObjectHint,
} from "./sculpt.js";

// Per-call work budget for the texel×source-triangle correspondence loop.
// Without it a half-head brush on a 120k-face mesh runs ~6 MINUTES of silent
// synchronous scanning (gauntlet finding) — indistinguishable from a hang.
// The budget counts NAIVE pair tests; the centroid prefilter cuts actual work
// ~10-50×, so 600M naive ≈ a few seconds of real computation.
const CORRESPONDENCE_BUDGET = 600e6;

// Verdict thresholds (calibrated on the 047 portrait; printed in every refusal
// so agents can judge the gate themselves).
const STRONG_MEDIAN = 0.01;    // median reflected distance ≤ 1% of bbox diagonal
const STRONG_AGREE = 0.7;
const MODERATE_MEDIAN = 0.025;
const MODERATE_AGREE = 0.5;

const DEFAULT_SAMPLES = 1024;

/** mulberry32 — deterministic PRNG (same generator sample_points uses). */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Merge every mesh of the entry into ONE wrapper-local, non-indexed triangle
 * soup. Positions are read through the accessor (quantized/interleaved safe)
 * and transformed by L = W⁻¹ · meshWorld — meshes inside the model may carry
 * their own node transforms, so "local" always means WRAPPER-local.
 */
function gatherLocalTriangles(entry) {
    const wrapperInv = entry.wrapper.matrixWorld.clone().invert();
    const chunks = [];
    let total = 0;
    const L = new THREE.Matrix4();
    const v = new THREE.Vector3();
    entry.model.updateMatrixWorld(true);
    entry.model.traverse((c) => {
        if (!c.isMesh || !c.geometry) return;
        const pos = c.geometry.getAttribute("position");
        if (!pos) return;
        const idx = c.geometry.getIndex();
        const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
        if (triCount === 0) return;
        L.multiplyMatrices(wrapperInv, c.matrixWorld);
        const arr = new Float32Array(triCount * 9);
        const vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
        for (let t = 0; t < triCount; t++) {
            for (let k = 0; k < 3; k++) {
                v.fromBufferAttribute(pos, vi(t, k)).applyMatrix4(L);
                const o = t * 9 + k * 3;
                arr[o] = v.x; arr[o + 1] = v.y; arr[o + 2] = v.z;
            }
        }
        chunks.push(arr);
        total += arr.length;
    });
    if (!chunks.length) return null;
    const out = new Float32Array(total);
    let o = 0;
    for (const a of chunks) { out.set(a, o); o += a.length; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(out, 3));
    return geo;
}

/** BVH over the entry's wrapper-local surface, cached and keyed by geometryRev. */
function localBVH(entry) {
    const cache = entry._symBVH;
    if (cache && cache.rev === entry.geometryRev) return cache;
    if (cache && cache.geometry) cache.geometry.dispose();
    const geometry = gatherLocalTriangles(entry);
    if (!geometry) throw new Error("Active object has no triangles.");
    const bvh = new MeshBVH(geometry);
    entry._symBVH = { rev: entry.geometryRev, bvh, geometry };
    return entry._symBVH;
}

/**
 * Vertex ids of triangle `f`, read THROUGH the geometry's index when present.
 * MeshBVH construction adds a sorted index to the soup — BVH faceIndex refers
 * to that order, and reading positions at f*3 directly would hit a different
 * triangle (the bug behind a sphere scoring normalAgreement ≈ −0.29).
 */
function triIds(geometry, f) {
    const idx = geometry.getIndex();
    return idx
        ? [idx.getX(f * 3), idx.getX(f * 3 + 1), idx.getX(f * 3 + 2)]
        : [f * 3, f * 3 + 1, f * 3 + 2];
}

/** Face normal of triangle `f` (index-mapped). */
function soupNormal(geometry, f, out) {
    const p = geometry.getAttribute("position");
    const [i0, i1, i2] = triIds(geometry, f);
    const ax = p.getX(i0), ay = p.getY(i0), az = p.getZ(i0);
    out.set(p.getX(i1) - ax, p.getY(i1) - ay, p.getZ(i1) - az);
    _e2.set(p.getX(i2) - ax, p.getY(i2) - ay, p.getZ(i2) - az);
    out.cross(_e2);
    return out.lengthSq() > 1e-20 ? out.normalize() : out.set(0, 1, 0);
}
const _e2 = new THREE.Vector3();

/**
 * Area-weighted deterministic samples over the entry's wrapper-local surface:
 * positions + face normals (needed for the normal-agreement score term).
 */
function localSamples(entry, count, seed) {
    const soup = localBVH(entry).geometry;
    const pos = soup.getAttribute("position");
    const triCount = pos.count / 3;
    const cum = new Float64Array(triCount);
    let total = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
        a.fromBufferAttribute(pos, t * 3);
        b.fromBufferAttribute(pos, t * 3 + 1);
        c.fromBufferAttribute(pos, t * 3 + 2);
        ab.subVectors(b, a); ac.subVectors(c, a);
        const area = cr.crossVectors(ab, ac).length() / 2;
        total += Number.isFinite(area) ? area : 0;
        cum[t] = total;
    }
    if (!(total > 0)) throw new Error("Active object has no sampleable surface.");
    const rand = mulberry32(seed);
    const points = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const n = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
        const r = rand() * total;
        let lo = 0, hi = triCount - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cum[mid] < r) lo = mid + 1; else hi = mid;
        }
        a.fromBufferAttribute(pos, lo * 3);
        b.fromBufferAttribute(pos, lo * 3 + 1);
        c.fromBufferAttribute(pos, lo * 3 + 2);
        const su = Math.sqrt(rand());
        const vv = rand();
        const w0 = 1 - su, w1 = su * (1 - vv), w2 = su * vv;
        points[i * 3] = w0 * a.x + w1 * b.x + w2 * c.x;
        points[i * 3 + 1] = w0 * a.y + w1 * b.y + w2 * c.y;
        points[i * 3 + 2] = w0 * a.z + w1 * b.z + w2 * c.z;
        // Normal from THIS triangle's own vertices (position order) — NOT via
        // soupNormal, which maps through the BVH-reordered index.
        ab.subVectors(b, a); ac.subVectors(c, a);
        n.crossVectors(ab, ac);
        if (n.lengthSq() > 1e-20) n.normalize(); else n.set(0, 1, 0);
        normals[i * 3] = n.x; normals[i * 3 + 1] = n.y; normals[i * 3 + 2] = n.z;
    }
    return { points, normals, count };
}

/** Jacobi eigen-decomposition of a symmetric 3×3 (for PCA candidate axes). */
function eigenSym3(m) {
    // m = [[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]] as a flat row-major 9-array copy.
    const a = m.slice();
    const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let sweep = 0; sweep < 12; sweep++) {
        let off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
        if (off < 1e-12) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            const apq = a[p * 3 + q];
            if (Math.abs(apq) < 1e-14) continue;
            const app = a[p * 3 + p], aqq = a[q * 3 + q];
            const theta = 0.5 * Math.atan2(2 * apq, aqq - app);
            const cs = Math.cos(theta), sn = Math.sin(theta);
            for (let k = 0; k < 3; k++) {
                const akp = a[k * 3 + p], akq = a[k * 3 + q];
                a[k * 3 + p] = cs * akp - sn * akq;
                a[k * 3 + q] = sn * akp + cs * akq;
            }
            for (let k = 0; k < 3; k++) {
                const apk = a[p * 3 + k], aqk = a[q * 3 + k];
                a[p * 3 + k] = cs * apk - sn * aqk;
                a[q * 3 + k] = sn * apk + cs * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
                v[k * 3 + p] = cs * vkp - sn * vkq;
                v[k * 3 + q] = sn * vkp + cs * vkq;
            }
        }
    }
    return [0, 1, 2].map((i) => new THREE.Vector3(v[i], v[3 + i], v[6 + i]).normalize());
}

/** Reflect point p across plane (unit normal nrm through origin o), in place. */
function reflectPoint(p, nrm, o) {
    const d = (p.x - o.x) * nrm.x + (p.y - o.y) * nrm.y + (p.z - o.z) * nrm.z;
    p.x -= 2 * d * nrm.x; p.y -= 2 * d * nrm.y; p.z -= 2 * d * nrm.z;
    return p;
}

/** Reflect direction n across plane normal nrm (no origin term), in place. */
function reflectDir(n, nrm) {
    const d = n.x * nrm.x + n.y * nrm.y + n.z * nrm.z;
    n.x -= 2 * d * nrm.x; n.y -= 2 * d * nrm.y; n.z -= 2 * d * nrm.z;
    return n;
}

function scorePlane(entry, samples, nrm, origin) {
    const { bvh, geometry } = localBVH(entry);
    const p = new THREE.Vector3(), n = new THREE.Vector3(), hitN = new THREE.Vector3();
    const hit = {};
    const dists = new Float32Array(samples.count);
    let agreeSum = 0;
    for (let i = 0; i < samples.count; i++) {
        p.set(samples.points[i * 3], samples.points[i * 3 + 1], samples.points[i * 3 + 2]);
        reflectPoint(p, nrm, origin);
        bvh.closestPointToPoint(p, hit);
        dists[i] = hit.distance;
        n.set(samples.normals[i * 3], samples.normals[i * 3 + 1], samples.normals[i * 3 + 2]);
        reflectDir(n, nrm);
        soupNormal(geometry, hit.faceIndex, hitN);
        agreeSum += n.dot(hitN);
    }
    const sorted = Array.from(dists).sort((x, y) => x - y);
    const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return { median: pct(0.5), p90: pct(0.9), agreement: agreeSum / samples.count };
}

function verdictOf(medianRel, agreement) {
    if (medianRel <= STRONG_MEDIAN && agreement >= STRONG_AGREE) return "strong";
    if (medianRel <= MODERATE_MEDIAN && agreement >= MODERATE_AGREE) return "moderate";
    return "weak";
}

const r4 = (x) => Math.round(x * 10000) / 10000;

/**
 * detect_symmetry — find the active object's dominant mirror plane.
 *
 * Candidates: the 3 wrapper-local axis planes + PCA axes of the surface
 * samples (deduped against near-parallel axis planes), all through the
 * area-weighted sample centroid (bbox centers are biased by one-sided
 * features like a bust's pedestal). The winner is cached on the entry, bound
 * to geometryRev.
 */
export function detectSymmetry(viewer, opts = {}) {
    const entry = viewer._activeEntry();
    if (!entry) throw new Error("No model loaded. load / add_model / add_primitive first.");
    const count = Math.max(128, Math.min(4096, opts.samples || DEFAULT_SAMPLES));
    const samples = localSamples(entry, count, opts.seed !== undefined ? opts.seed : 42);

    // Area centroid + covariance (both from the same sample set — nearly free).
    const cen = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
        cen.x += samples.points[i * 3]; cen.y += samples.points[i * 3 + 1]; cen.z += samples.points[i * 3 + 2];
    }
    cen.divideScalar(count);
    const cov = new Array(9).fill(0);
    for (let i = 0; i < count; i++) {
        const dx = samples.points[i * 3] - cen.x;
        const dy = samples.points[i * 3 + 1] - cen.y;
        const dz = samples.points[i * 3 + 2] - cen.z;
        cov[0] += dx * dx; cov[1] += dx * dy; cov[2] += dx * dz;
        cov[4] += dy * dy; cov[5] += dy * dz; cov[8] += dz * dz;
    }
    cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];

    const axes = [
        { name: "x", n: new THREE.Vector3(1, 0, 0) },
        { name: "y", n: new THREE.Vector3(0, 1, 0) },
        { name: "z", n: new THREE.Vector3(0, 0, 1) },
    ];
    for (const e of eigenSym3(cov)) {
        // Skip PCA axes near-parallel to an axis plane already in the list.
        if (axes.some((a) => Math.abs(a.n.dot(e)) > 0.98)) continue;
        axes.push({ name: `pca(${r4(e.x)},${r4(e.y)},${r4(e.z)})`, n: e });
    }

    // Normalize distances by the LOCAL bbox diagonal (placement-invariant).
    const soup = localBVH(entry).geometry;
    soup.computeBoundingBox();
    const diag = soup.boundingBox.getSize(new THREE.Vector3()).length() || 1;

    const candidates = axes.map(({ name, n }, i) => {
        const s = scorePlane(entry, samples, n, cen);
        return {
            axis: name,
            normal: [r4(n.x), r4(n.y), r4(n.z)],
            medianDistRel: r4(s.median / diag),
            p90DistRel: r4(s.p90 / diag),
            normalAgreement: r4(s.agreement),
            _n: n,
            _pref: i < 3 ? 0 : 1,   // axis planes are canonical; PCA breaks ties last
        };
    });
    // Rank: distance first; when distances tie within tolerance (spheres: EVERY
    // centroid plane mirrors perfectly), prefer the canonical axis planes so
    // the choice is predictable, then agreement.
    const EPS = STRONG_MEDIAN * 0.25;
    candidates.sort((a, b) => {
        if (Math.abs(a.medianDistRel - b.medianDistRel) > EPS) {
            return a.medianDistRel - b.medianDistRel;
        }
        if (a._pref !== b._pref) return a._pref - b._pref;
        return (b.normalAgreement - a.normalAgreement)
            || (a.medianDistRel - b.medianDistRel);
    });
    const best = candidates[0];
    const verdict = verdictOf(best.medianDistRel, best.normalAgreement);

    // Refine the winning plane's origin ALONG ITS NORMAL (the only component
    // that matters for reflection): sample-centroid origins wander with the
    // seed (~cm on a head — a smear at iris scale, gauntlet finding); a 1D
    // scan over the median distance converges both seeds to the true plane.
    let bestOrigin = cen.clone();
    {
        const probe = localSamples(entry, 256, 12345);
        let bestMedian = Infinity;
        for (const stepRel of [-0.02, -0.01, -0.005, -0.0025, 0,
                               0.0025, 0.005, 0.01, 0.02]) {
            const o = cen.clone().addScaledVector(best._n, stepRel * diag);
            const s = scorePlane(entry, probe, best._n, o);
            if (s.median < bestMedian) {
                bestMedian = s.median;
                bestOrigin = o;
            }
        }
    }

    entry.symmetry = {
        normal: best._n.clone(),
        origin: bestOrigin,
        axis: best.axis,
        medianDistRel: best.medianDistRel,
        normalAgreement: best.normalAgreement,
        verdict,
        geometryRev: entry.geometryRev,
    };

    return {
        plane: { axis: best.axis, normal: best.normal,
                 originLocal: [r4(bestOrigin.x), r4(bestOrigin.y), r4(bestOrigin.z)] },
        verdict,
        medianDistRel: best.medianDistRel,
        p90DistRel: best.p90DistRel,
        normalAgreement: best.normalAgreement,
        samples: count,
        geometryRev: entry.geometryRev,
        candidates: candidates.map(({ _n, _pref, ...rest }) => rest),
        note: verdict === "weak"
            ? "No convincing mirror plane — mirror_paint will refuse without an explicit plane."
            : `mirror_paint will heal across the ${best.axis} plane. Geometric symmetry does `
              + "not guarantee TEXTURE symmetry (a thin plate's faces mirror geometrically "
              + "with unrelated content) — verify with a before/after render.",
    };
}

/** Resolve the plane for mirror_paint: explicit param > fresh cache > auto-detect. */
function resolvePlane(viewer, entry, opts) {
    if (opts.plane) {
        const n = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0),
                    z: new THREE.Vector3(0, 0, 1) }[opts.plane];
        let origin;
        if (opts.plane_origin) {
            origin = new THREE.Vector3(...opts.plane_origin);
        } else if (entry.symmetry && entry.symmetry.geometryRev === entry.geometryRev) {
            origin = entry.symmetry.origin;
        } else {
            // Area centroid of a small deterministic sample set — NOT the bbox
            // center (one-sided features bias it).
            const s = localSamples(entry, 256, 42);
            origin = new THREE.Vector3();
            for (let i = 0; i < s.count; i++) {
                origin.x += s.points[i * 3]; origin.y += s.points[i * 3 + 1]; origin.z += s.points[i * 3 + 2];
            }
            origin.divideScalar(s.count);
        }
        // Score the OVERRIDDEN axis and say so when it looks bad — an explicit
        // wrong plane otherwise heals "successfully" with unrelated content and
        // zero warnings (gauntlet probe: plane:"y" imported neck onto a cheek).
        const probe = localSamples(entry, 256, 42);
        const soup = localBVH(entry).geometry;
        soup.computeBoundingBox();
        const diag = soup.boundingBox.getSize(new THREE.Vector3()).length() || 1;
        const s = scorePlane(entry, probe, n, origin);
        const score = {
            medianDistRel: r4(s.median / diag),
            normalAgreement: r4(s.agreement),
            verdict: verdictOf(s.median / diag, s.agreement),
        };
        let note;
        if (score.verdict === "weak") {
            note = `WARNING: the explicit ${opts.plane} plane scores WEAK on this `
                + `object (median ${score.medianDistRel}, agreement `
                + `${score.normalAgreement}) — mirrored content may be unrelated. `
                + "Verify with a render.";
        } else if (entry.symmetry
                   && entry.symmetry.geometryRev === entry.geometryRev
                   && entry.symmetry.axis !== opts.plane) {
            note = `Note: the detected best plane is '${entry.symmetry.axis}' `
                + `(this override uses '${opts.plane}'). Verify with a render.`;
        }
        return { normal: n, origin, axis: opts.plane, explicit: true,
                 autoDetected: false, score, overrideNote: note };
    }
    let sym = entry.symmetry;
    let autoDetected = false;
    if (!sym || sym.geometryRev !== entry.geometryRev) {
        detectSymmetry(viewer, {});
        sym = entry.symmetry;
        autoDetected = true;
    }
    if (sym.verdict === "weak") {
        throw new Error(
            `mirror_paint: the object is not convincingly mirror-symmetric `
            + `(median reflected distance ${sym.medianDistRel} of bbox diagonal, `
            + `normal agreement ${sym.normalAgreement}; gate: median ≤ ${MODERATE_MEDIAN} `
            + `and agreement ≥ ${MODERATE_AGREE}). Use clone_paint with a manual donor, `
            + `or override with plane:"x"|"y"|"z" (+ optional plane_origin:[x,y,z] local) `
            + `if you know better.`);
    }
    return { normal: sym.normal, origin: sym.origin, axis: sym.axis,
             score: { medianDistRel: sym.medianDistRel, normalAgreement: sym.normalAgreement,
                      verdict: sym.verdict },
             explicit: false, autoDetected };
}

/**
 * mirror_paint — heal a brush region from its mirror counterpart.
 *
 * For each destination texel (world position P from the brush footprint):
 * P' = W · R · W⁻¹ · P; find the nearest source triangle around the reflected
 * brush center whose REFLECTED normal agrees with the destination normal;
 * bilinear-sample the pre-write snapshot through that triangle's own UVs;
 * blend with painter semantics. The content arrives intrinsically mirrored —
 * there is deliberately NO 2D flip step (det(map) = −1 already reverses
 * orientation; an extra flip would paste the donor un-mirrored).
 */
export function mirrorPaint(viewer, opts = {}) {
    assertNotSkinned(viewer);
    assertNoMorphForHeal(viewer, "mirror_paint");
    const entry = viewer._activeEntry();
    if (!entry) throw new Error("No model loaded.");
    if (!opts.center || opts.center.length !== 3) {
        throw new Error("mirror_paint requires center: [x,y,z] (world — use pick on the defect).");
    }
    const radius = resolveRadius(viewer, opts, "mirror_paint");
    const strength = opts.strength !== undefined ? Math.max(0, Math.min(1, opts.strength)) : 1;
    const falloffFn = FALLOFFS[opts.falloff || "smooth"] || FALLOFFS.smooth;
    const plane = resolvePlane(viewer, entry, opts);
    beginPaintOp("mirror_paint", opts.undo_group);

    // World-side reflection map A = W · R · W⁻¹ (exact under ANY wrapper
    // transform, including non-uniform scale) + its normal matrix.
    const W = entry.wrapper.matrixWorld.clone();
    const Winv = W.clone().invert();
    const center = new THREE.Vector3(...opts.center);
    const mapPoint = (p) => {
        p.applyMatrix4(Winv);
        reflectPoint(p, plane.normal, plane.origin);
        return p.applyMatrix4(W);
    };
    // Normal transform of the composite affine map: (M⁻¹)ᵀ of its linear part.
    const A3 = new THREE.Matrix3().setFromMatrix4(
        new THREE.Matrix4().multiplyMatrices(
            W,
            new THREE.Matrix4().multiplyMatrices(reflectionMatrix4(plane), Winv)));
    const nrmMat = A3.clone().invert().transpose();

    const reflCenter = mapPoint(center.clone());
    // Prefilter margin: the affine map turns the world brush sphere into an
    // ellipsoid under non-uniform scale — pad by the scale anisotropy.
    const s = entry.wrapper.scale;
    const aniso = Math.max(s.x, s.y, s.z) / Math.max(1e-9, Math.min(s.x, s.y, s.z));
    const srcRadius = radius * 1.5 * aniso;

    let healed = 0, alphaSum = 0, selfSource = 0;
    const skipped = { noSource: 0, normalReject: 0 };
    let crossMeshHint = null;

    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    const e1 = new THREE.Vector3(), eB = new THREE.Vector3();
    const triangle = new THREE.Triangle();
    const bary = new THREE.Vector3();
    const closest = new THREE.Vector3();
    const nTmp = new THREE.Vector3(), nDst = new THREE.Vector3();
    const meshes = [];
    entry.model.traverse((m) => { if (m.isMesh && m.geometry) meshes.push(m); });

    for (const mesh of meshes) {
        const geometry = mesh.geometry;
        const uvAttr = geometry.getAttribute("uv");
        if (!uvAttr) continue;
        mesh.updateMatrixWorld(true);
        const m4 = mesh.matrixWorld;
        const pos = geometry.getAttribute("position");
        const index = geometry.getIndex();
        const triCount = Math.floor(index ? index.count / 3 : pos.count / 3);
        const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);

        // SOURCE candidates around the REFLECTED center — computed BEFORE any
        // layer allocation so untouched meshes never charge the paint budget.
        const srcTris = [];       // {t, n: world normal}
        let srcAnchorN = null, srcD2 = Infinity;
        for (let t = 0; t < triCount; t++) {
            a.fromBufferAttribute(pos, idxOf(t, 0)).applyMatrix4(m4);
            b.fromBufferAttribute(pos, idxOf(t, 1)).applyMatrix4(m4);
            c.fromBufferAttribute(pos, idxOf(t, 2)).applyMatrix4(m4);
            p.copy(a).add(b).add(c).divideScalar(3);
            const triR = Math.max(a.distanceTo(p), b.distanceTo(p), c.distanceTo(p));
            const d2 = p.distanceToSquared(reflCenter);
            if (d2 > (srcRadius + triR) ** 2) continue;
            e1.copy(b).sub(a); eB.copy(c).sub(a);
            const n = e1.clone().cross(eB).normalize();
            srcTris.push({ t, n });
            if (d2 < srcD2) { srcD2 = d2; srcAnchorN = n; }
        }
        if (!srcTris.length) continue;

        // Anchor-level guard (clone_paint parity, mirror-corrected): the
        // destination normal must agree with the REFLECTED source normal.
        let dstAnchorN = null, dstD2 = Infinity;
        for (let t = 0; t < triCount; t++) {
            a.fromBufferAttribute(pos, idxOf(t, 0)).applyMatrix4(m4);
            b.fromBufferAttribute(pos, idxOf(t, 1)).applyMatrix4(m4);
            c.fromBufferAttribute(pos, idxOf(t, 2)).applyMatrix4(m4);
            p.copy(a).add(b).add(c).divideScalar(3);
            const d2 = p.distanceToSquared(center);
            if (d2 < dstD2) {
                dstD2 = d2;
                e1.copy(b).sub(a); eB.copy(c).sub(a);
                dstAnchorN = e1.clone().cross(eB).normalize();
            }
        }
        if (srcAnchorN && dstAnchorN) {
            nTmp.copy(srcAnchorN).applyMatrix3(nrmMat).normalize();
            if (nTmp.dot(dstAnchorN) < Math.cos(Math.PI / 4)) {
                skipped.normalReject++;
                continue;
            }
        }

        const layer = ensureRepairableLayer(viewer, mesh, opts.texture_size);
        const foot = brushFootprint(mesh, layer, center, radius,
            opts.hardness !== undefined ? opts.hardness : 0.6, falloffFn);
        if (!foot || foot.size === 0) continue;

        // Work budget BEFORE the loop: the correspondence pass is
        // O(texels × source triangles) and a half-head brush silently runs
        // minutes past it (indistinguishable from a hang for agents).
        const work = foot.size * srcTris.length;
        if (work > CORRESPONDENCE_BUDGET) {
            throw new Error(
                `mirror_paint region too large: ${foot.size.toLocaleString()} texels × `
                + `${srcTris.length.toLocaleString()} source triangles ≈ `
                + `${Math.round(work / 1e6)}M correspondence tests (budget `
                + `${Math.round(CORRESPONDENCE_BUDGET / 1e6)}M). Use a smaller `
                + "radius/radius_rel (heal in passes) or a lower texture_size.");
        }

        const dim = layer.size;
        const snapshot = layer.ctx.getImageData(0, 0, dim, dim).data;

        // Reflected source normals + centroid/radius prefilter data, once per
        // candidate triangle (the per-texel loop rejects far triangles on the
        // centroid distance before paying closestPointToPoint).
        for (const st of srcTris) {
            st.rn = st.n.clone().applyMatrix3(nrmMat).normalize();
            const i0 = idxOf(st.t, 0), i1 = idxOf(st.t, 1), i2 = idxOf(st.t, 2);
            a.fromBufferAttribute(pos, i0).applyMatrix4(m4);
            b.fromBufferAttribute(pos, i1).applyMatrix4(m4);
            c.fromBufferAttribute(pos, i2).applyMatrix4(m4);
            p.copy(a).add(b).add(c).divideScalar(3);
            st.cx = p.x; st.cy = p.y; st.cz = p.z;
            st.r = Math.max(a.distanceTo(p), b.distanceTo(p), c.distanceTo(p));
        }

        let minX = dim, maxX = 0, minY = dim, maxY = 0;
        for (const key of foot.keys()) {
            const px = key % dim, py = (key - px) / dim;
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
        const w = maxX - minX + 1;
        const img = layer.ctx.getImageData(minX, minY, w, maxY - minY + 1);
        const data = img.data;

        // A texel is SELF-SOURCED when its mirror lands back inside the brush
        // itself (|P−P'| < radius): the heal reads from the very region being
        // healed — a visual no-op. (The earlier 0.1·radius threshold capped
        // the fraction at ~0.06 even dead-centered on the plane, so the
        // documented on-plane warning could mathematically never fire.)
        const selfR2 = radius * radius;
        for (const [key, rec] of foot) {
            p.set(rec.world[0], rec.world[1], rec.world[2]);
            q.copy(p);
            mapPoint(q);                       // q = mirrored world position
            if (rec.n) nDst.set(rec.n[0], rec.n[1], rec.n[2]);

            // Nearest source triangle whose reflected normal agrees with the
            // destination texel's normal (kills two-sheet mis-sourcing at
            // ears/eye-socket folds); nearest overall is NOT an acceptable
            // fallback — copying the wrong sheet is worse than skipping.
            let bestD = Infinity, bestUV = null;
            for (const st of srcTris) {
                if (rec.n && st.rn.dot(nDst) < 0.2) continue;
                // Centroid prefilter: the triangle cannot beat bestD when even
                // its nearest conceivable point (centroid − bounding radius)
                // is farther than the current best.
                const dcx = q.x - st.cx, dcy = q.y - st.cy, dcz = q.z - st.cz;
                const dc = Math.sqrt(dcx * dcx + dcy * dcy + dcz * dcz) - st.r;
                if (dc > 0 && dc * dc > bestD) continue;
                const i0 = idxOf(st.t, 0), i1 = idxOf(st.t, 1), i2 = idxOf(st.t, 2);
                a.fromBufferAttribute(pos, i0).applyMatrix4(m4);
                b.fromBufferAttribute(pos, i1).applyMatrix4(m4);
                c.fromBufferAttribute(pos, i2).applyMatrix4(m4);
                triangle.set(a, b, c);
                triangle.closestPointToPoint(q, closest);
                const d = closest.distanceToSquared(q);
                if (d < bestD) {
                    bestD = d;
                    triangle.getBarycoord(closest, bary);
                    bestUV = [
                        uvAttr.getX(i0) * bary.x + uvAttr.getX(i1) * bary.y + uvAttr.getX(i2) * bary.z,
                        uvAttr.getY(i0) * bary.x + uvAttr.getY(i1) * bary.y + uvAttr.getY(i2) * bary.z,
                    ];
                }
            }
            if (!bestUV || bestD > (radius * aniso) ** 2) {
                skipped.noSource++;
                continue;
            }

            // Bilinear sample from the snapshot (mirroring reverses orientation,
            // so nearest-neighbor aliases worse than it does for translation
            // cloning). Taps clamped to canvas bounds.
            const sx = bestUV[0] * dim - 0.5;
            const sy = (layer.flipY ? (1 - bestUV[1]) : bestUV[1]) * dim - 0.5;
            const x0 = Math.max(0, Math.min(dim - 1, Math.floor(sx)));
            const y0 = Math.max(0, Math.min(dim - 1, Math.floor(sy)));
            const x1 = Math.min(dim - 1, x0 + 1), y1 = Math.min(dim - 1, y0 + 1);
            const fx = Math.max(0, Math.min(1, sx - x0)), fy = Math.max(0, Math.min(1, sy - y0));
            let r = 0, g = 0, b2 = 0;
            for (const [xx, yy, wgt] of [
                [x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)],
                [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]]) {
                const o = (yy * dim + xx) * 4;
                r += snapshot[o] * wgt; g += snapshot[o + 1] * wgt; b2 += snapshot[o + 2] * wgt;
            }

            const px = key % dim, py = (key - px) / dim;
            const o = ((py - minY) * w + (px - minX)) * 4;
            const alpha = rec.alpha * strength;
            data[o] = Math.round(data[o] * (1 - alpha) + r * alpha);
            data[o + 1] = Math.round(data[o + 1] * (1 - alpha) + g * alpha);
            data[o + 2] = Math.round(data[o + 2] * (1 - alpha) + b2 * alpha);
            data[o + 3] = 255;
            healed++;
            alphaSum += alpha;
            if (p.distanceToSquared(q) < selfR2) selfSource++;
        }
        // Single-slot brush undo: stash the pre-write rect (undo_paint).
        stashPaintPatch("mirror_paint", layer, minX, minY, img.width, img.height);
        layer.ctx.putImageData(img, minX, minY);
        layer.texture.needsUpdate = true;
    }

    if (healed === 0) {
        // Loud failure with the best explanation we can compute — EXCLUDING
        // the mesh the brush itself sits on (naming the object's only mesh as
        // its own "cross-mesh counterpart" sent an agent to clone_paint,
        // which refuses mirrored donors: a dead-end detour, gauntlet finding).
        let brushMesh = null;
        for (const mesh of meshes) {
            mesh.geometry.computeBoundingBox();
            const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
            if (box.distanceToPoint(center) < radius) { brushMesh = mesh; break; }
        }
        for (const mesh of meshes) {
            if (mesh === brushMesh || !mesh.geometry.getAttribute("uv")) continue;
            mesh.geometry.computeBoundingBox();
            const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
            if (box.distanceToPoint(reflCenter) < radius) {
                crossMeshHint = mesh.name || "(unnamed mesh)";
                break;
            }
        }
        const nothingTouched = skipped.noSource === 0 && skipped.normalReject === 0;
        const cross = crossMeshHint
            ? ` The mirror counterpart appears to live on mesh '${crossMeshHint}' — `
              + "mirror_paint heals within ONE mesh's texture (cross-mesh donors are "
              + "not supported); use clone_paint or paint directly."
            : (nothingTouched
                ? " The brush rasterized ZERO texels — the radius is likely smaller "
                  + "than one texel at this texture size; raise radius/radius_rel."
                : "");
        throw new Error(
            "mirror_paint healed nothing — the reflected region found no matching "
            + `source surface (skipped: ${skipped.noSource} no-source, `
            + `${skipped.normalReject} normal-rejected).${cross}`
            + wrongObjectHint(viewer, opts.center));
    }

    entry.modified = true;
    viewer.invalidate();
    const out = {
        healed,
        meanAlpha: Math.round((alphaSum / healed) * 1000) / 1000,
        skipped,
        selfSourceFraction: Math.round((selfSource / healed) * 1000) / 1000,
        plane: { axis: plane.axis, originLocal: [r4(plane.origin.x), r4(plane.origin.y), r4(plane.origin.z)] },
    };
    if (plane.score) out.score = plane.score;
    if (plane.autoDetected) out.autoDetected = true;
    const notes = [];
    if (plane.overrideNote) notes.push(plane.overrideNote);
    if (out.selfSourceFraction > 0.4) {
        notes.push("A large share of the brush straddles the symmetry plane — "
            + "those texels sample from inside the brush itself (self-copy, "
            + "little visible change). Verify with a render.");
    } else if (out.meanAlpha < 0.25) {
        notes.push("Low meanAlpha — the heal may be nearly invisible; raise strength.");
    }
    if (notes.length) out.note = notes.join(" ");
    return out;
}

/** Local Householder reflection as a Matrix4 (about plane.normal through plane.origin). */
function reflectionMatrix4(plane) {
    const n = plane.normal, o = plane.origin;
    const m = new THREE.Matrix4();
    // Linear part: I − 2nnᵀ; translation: 2(o·n)n.
    const d = 2 * (o.x * n.x + o.y * n.y + o.z * n.z);
    m.set(
        1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, d * n.x,
        -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, d * n.y,
        -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, d * n.z,
        0, 0, 0, 1);
    return m;
}

/** Release the cached symmetry BVH (call from entry disposal). */
export function releaseSymmetryCache(entry) {
    if (entry && entry._symBVH) {
        if (entry._symBVH.geometry) entry._symBVH.geometry.dispose();
        entry._symBVH = null;
    }
}
