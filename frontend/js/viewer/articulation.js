/**
 * Part detection + object splitting — the articulation path (backlog 046).
 *
 * Honesty first (adversarial + measured findings): image-to-3D outputs are
 * usually ONE fused component, so detection's strategy order is (1) existing
 * mesh/node partition, (2) material groups, (3) welded connected components —
 * and plane cuts through split_object are the PRIMARY articulation path for
 * fused meshes, with the cut-centroid returned as the suggested pivot.
 */

import * as THREE from "three";
import { clonePaintLayer, ensureFreshNormals } from "./sculpt.js";
import { capGeometry } from "./capping.js";
import { meshIssueCounts } from "./repair.js";
import { dropMorphs } from "./morphs.js";

const DETECT_TRIANGLE_BUDGET = 300000;
const MAX_PARTS = 24;
const MIN_COMPONENT_TRIS = 20;

function requireActive(viewer) {
    const entry = viewer._activeEntry();
    if (!entry) throw new Error("No object loaded. load / add_model / add_primitive first.");
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

const r3 = (v) => Math.round(v * 1000) / 1000;
const vec3 = (v) => [r3(v.x), r3(v.y), r3(v.z)];

/** World AABB of a set of triangles of one mesh. */
function triangleBox(mesh, tris) {
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex();
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const t of tris) {
        for (let k = 0; k < 3; k++) {
            v.fromBufferAttribute(pos, idxOf(t, k)).applyMatrix4(mesh.matrixWorld);
            box.expandByPoint(v);
        }
    }
    return box;
}

/** Welded connected components of one mesh → arrays of triangle indices. */
function connectedComponents(mesh) {
    const geometry = mesh.geometry;
    const pos = geometry.getAttribute("position");
    const index = geometry.getIndex();
    const triCount = triCountOf(geometry);
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);

    // Weld by quantized position (relative tolerance — the sculpt policy).
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

    // Union-find over triangles via shared welds.
    const parent = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) parent[i] = i;
    const find = (x) => {
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
    for (let t = 0; t < triCount; t++) {
        const a = canonical[idxOf(t, 0)];
        union(a, canonical[idxOf(t, 1)]);
        union(a, canonical[idxOf(t, 2)]);
    }
    const byRoot = new Map();
    for (let t = 0; t < triCount; t++) {
        const root = find(canonical[idxOf(t, 0)]);
        let list = byRoot.get(root);
        if (!list) { list = []; byRoot.set(root, list); }
        list.push(t);
    }
    return [...byRoot.values()];
}

/**
 * detect_parts — candidate articulation parts of the ACTIVE object.
 * Strategy order: mesh partition → material groups → welded components.
 * Partial detection is NORMAL on generated meshes — the note says so.
 */
export function detectParts(viewer) {
    const entry = requireActive(viewer);
    const meshes = meshesOf(entry);
    entry.model.updateMatrixWorld(true);

    const totalTris = meshes.reduce((sum, m) => sum + triCountOf(m.geometry), 0);
    if (totalTris > DETECT_TRIANGLE_BUDGET) {
        return {
            parts: [], partitionId: entry.geometryRev, skipped: true,
            note: `Object exceeds the ${DETECT_TRIANGLE_BUDGET.toLocaleString()}-triangle `
                + "detection budget — simplify first (simplify / simplify_region).",
        };
    }

    const parts = [];
    let kind;
    if (meshes.length > 1) {
        // (1) The asset's own mesh partition — free and usually semantic.
        kind = "mesh";
        meshes.forEach((mesh, mi) => {
            const tris = [...Array(triCountOf(mesh.geometry)).keys()];
            const box = triangleBox(mesh, tris);
            parts.push({
                partId: parts.length, kind, meshIndex: mi,
                name: mesh.name || undefined,
                triangles: tris.length,
                center: vec3(box.getCenter(new THREE.Vector3())),
                size: vec3(box.getSize(new THREE.Vector3())),
                suggestedPivot: vec3(box.getCenter(new THREE.Vector3())),
                _tris: tris,
            });
        });
    } else if (meshes.length === 1 && meshes[0].geometry.groups
               && meshes[0].geometry.groups.length > 1) {
        // (2) Material groups — one geometry, N materials is often semantic.
        kind = "group";
        const mesh = meshes[0];
        const index = mesh.geometry.getIndex();
        meshes[0].geometry.groups.forEach((g, gi) => {
            const count = g.count === Infinity
                ? (index ? index.count : mesh.geometry.getAttribute("position").count) - g.start
                : g.count;
            const tris = [];
            for (let i = g.start / 3; i < (g.start + count) / 3; i++) tris.push(i);
            if (!tris.length) return;
            const box = triangleBox(mesh, tris);
            parts.push({
                partId: parts.length, kind, meshIndex: 0, groupIndex: gi,
                triangles: tris.length,
                center: vec3(box.getCenter(new THREE.Vector3())),
                size: vec3(box.getSize(new THREE.Vector3())),
                suggestedPivot: vec3(box.getCenter(new THREE.Vector3())),
                _tris: tris,
            });
        });
    } else if (meshes.length === 1) {
        // (3) Welded connected components — the within-mesh fallback.
        kind = "component";
        const comps = connectedComponents(meshes[0])
            .filter((tris) => tris.length >= MIN_COMPONENT_TRIS)
            .sort((a, b) => b.length - a.length);
        comps.forEach((tris) => {
            const box = triangleBox(meshes[0], tris);
            parts.push({
                partId: parts.length, kind, meshIndex: 0,
                triangles: tris.length,
                center: vec3(box.getCenter(new THREE.Vector3())),
                size: vec3(box.getSize(new THREE.Vector3())),
                suggestedPivot: vec3(box.getCenter(new THREE.Vector3())),
                _tris: tris,
            });
        });
    }

    // Cache the partition for split_object (indices reference THIS revision).
    entry._partition = { rev: entry.geometryRev, parts, meshes };
    const omitted = Math.max(0, parts.length - MAX_PARTS);
    const publicParts = parts.slice(0, MAX_PARTS).map(({ _tris, ...p }) => p);

    let note;
    if (parts.length <= 1) {
        note = "Single fused component — image-to-3D outputs usually are. "
            + "Articulation requires split_object with a plane cut "
            + "({axis, at} or {plane}), which is a REAL geometry cut.";
    } else {
        note = "Partial detection is NORMAL on generated meshes (most parts fuse "
            + "during generation) — verify candidates with focus + screenshot "
            + "before splitting.";
    }
    return { parts: publicParts, omitted: omitted || undefined,
             partitionId: entry.geometryRev, note };
}

/**
 * Texel sampler over a mesh's drawable base texture (cap anchor color picking
 * — 051 field fix B3). Returns (u, v) -> [r, g, b] | null, or null when the
 * texture is unreadable (KTX2/GPU-only) or absent.
 */
function rimColorSampler(mesh) {
    const stash = mesh._mvOriginalMaterial || mesh.material;
    const mat = Array.isArray(stash) ? stash[0] : stash;
    const map = mat && mat.map;
    const img = map && map.image;
    const drawable = img && ((typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement)
        || (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement)
        || (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap));
    if (!drawable) return null;
    // A small readback canvas is plenty for a median-of-rim decision.
    const W = Math.min(img.width || 256, 512);
    const H = Math.min(img.height || 256, 512);
    let data;
    try {
        const cv = document.createElement("canvas");
        cv.width = W; cv.height = H;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0, W, H);
        data = ctx.getImageData(0, 0, W, H).data;
    } catch {
        return null;   // tainted canvas etc. — anchor falls back to first vertex
    }
    const flipY = map.flipY !== false;
    return (uu, vv) => {
        const x = Math.max(0, Math.min(W - 1, Math.round(uu * W)));
        const y = Math.max(0, Math.min(H - 1, Math.round((flipY ? 1 - vv : vv) * H)));
        const o = (y * W + x) * 4;
        return [data[o], data[o + 1], data[o + 2]];
    };
}

/** Build a sub-geometry from a triangle subset (fresh attributes, no userData).
 *  Returns {geometry, remap} — remap (orig index -> new index) lets callers
 *  carry vertex references (rim edges) into the new indexing. */
function extractSubGeometry(mesh, tris) {
    const src = mesh.geometry;
    // Bulk-replay normal deferral: attribute copies must see fresh values.
    ensureFreshNormals(src);
    const index = src.getIndex();
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const names = Object.keys(src.attributes);
    const remap = new Map();
    const newIndex = [];
    for (const t of tris) {
        for (let k = 0; k < 3; k++) {
            const vi = idxOf(t, k);
            let ni = remap.get(vi);
            if (ni === undefined) { ni = remap.size; remap.set(vi, ni); }
            newIndex.push(ni);
        }
    }
    const geo = new THREE.BufferGeometry();
    for (const name of names) {
        const attr = src.getAttribute(name);
        const size = attr.itemSize;
        const out = new Float32Array(remap.size * size);
        for (const [vi, ni] of remap) {
            for (let c = 0; c < size; c++) {
                out[ni * size + c] = attr.getComponent(vi, c);
            }
        }
        geo.setAttribute(name, new THREE.BufferAttribute(out, size));
    }
    geo.setIndex(newIndex);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return { geometry: geo, remap };
}

/**
 * Classify welded edges of a split into BECAME-OPEN rims (the 051 review's
 * correct rim definition — plane-distance tolerances cannot work under
 * whole-triangle classification, and pre-existing open boundaries must never
 * be treated as cut rims; they never qualify here by construction).
 *
 * Returns { cut, partRim, remRim } — cut = welded edges crossing the split
 * (the historical openEdgesAdded number); partRim/remRim = [[a,b]...] RAW
 * vertex-index pairs, each representative taken from a triangle on ITS side
 * (so the indices survive that side's extractSubGeometry remap).
 */
function classifyCutEdges(mesh, selected) {
    const geometry = mesh.geometry;
    const pos = geometry.getAttribute("position");
    const index = geometry.getIndex();
    const triCount = triCountOf(geometry);
    const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    geometry.computeBoundingBox();
    const diag = geometry.boundingBox
        ? geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1 : 1;
    const quant = diag * 1e-6;
    const canon = new Map();
    const canonOf = (vi) => {
        const k = `${Math.round(pos.getX(vi) / quant)}_${Math.round(pos.getY(vi) / quant)}_${Math.round(pos.getZ(vi) / quant)}`;
        let c = canon.get(k);
        if (c === undefined) { c = canon.size; canon.set(k, c); }
        return c;
    };
    const inSel = new Uint8Array(triCount);
    for (const t of selected) inSel[t] = 1;
    const edges = new Map();   // key -> {sel, out, repSel: [a,b]|null, repOut}
    for (let t = 0; t < triCount; t++) {
        const raw = [idxOf(t, 0), idxOf(t, 1), idxOf(t, 2)];
        const cs = raw.map(canonOf);
        for (let k = 0; k < 3; k++) {
            const a = Math.min(cs[k], cs[(k + 1) % 3]);
            const b = Math.max(cs[k], cs[(k + 1) % 3]);
            const key = a * 16777216 + b;
            let e = edges.get(key);
            if (!e) { e = { sel: 0, out: 0, repSel: null, repOut: null }; edges.set(key, e); }
            if (inSel[t]) {
                e.sel++;
                if (!e.repSel) e.repSel = [raw[k], raw[(k + 1) % 3]];
            } else {
                e.out++;
                if (!e.repOut) e.repOut = [raw[k], raw[(k + 1) % 3]];
            }
        }
    }
    let cut = 0;
    const partRim = [];
    const remRim = [];
    for (const e of edges.values()) {
        if (e.sel > 0 && e.out > 0) cut++;
        // Z2 boundary rule (051 field fix B1): a side's edge BECOMES boundary
        // when its use count is ODD, provided it was not boundary before
        // (total EVEN — pre-existing open edges have odd totals and must
        // never be treated as cut rims). The naive `sel === 1` special case
        // missed doubled-shell edges (sel:1/out:3 on the scanned chest lip),
        // leaving degree-1 dead ends no loop walk could ever close. Mod-2
        // boundaries are cycles, so every rim vertex has even degree and a
        // closed-loop decomposition always exists.
        if ((e.sel + e.out) % 2 === 0) {
            if (e.sel % 2 === 1 && e.out > 0) partRim.push(e.repSel);
            if (e.out % 2 === 1 && e.sel > 0) remRim.push(e.repOut);
        }
    }
    return { cut, partRim, remRim };
}

/**
 * split_object — extract parts of the ACTIVE object into NEW scene objects.
 * Selection: detect_parts partIds (+ partitionId handshake) OR a plane cut
 * ({axis, at} convenience / {plane: {point, normal}} general). Plane cuts are
 * whole-triangle classification; cut faces are hollow unless cap:true closes
 * them (backlog 051 — see viewer/capping.js).
 */
export function splitObject(viewer, opts = {}) {
    const entry = requireActive(viewer);
    if (entry.skinned) {
        throw new Error("Splitting skinned (rigged) models is not supported — the "
            + "skeleton cannot be safely torn apart.");
    }
    if (entry.animation && entry.animation.clips && entry.animation.clips.length) {
        throw new Error("This object carries loaded animation clips that bind to "
            + "its node tree — splitting would break them. Split a static copy "
            + "(export_glb without animation, reload) instead.");
    }
    if (viewer._timeline && viewer._timeline.tracks.has(entry.id)) {
        throw new Error("This object has timeline tracks — clear_timeline "
            + `{id: ${entry.id}} first (split changes what the track animates).`);
    }
    const meshes = meshesOf(entry);
    entry.model.updateMatrixWorld(true);

    // Instancing guard: splitting a shared geometry in place would edit every
    // instance (the sculpt-dedup trap, but destructive).
    const geometryUse = new Map();
    for (const e of viewer._objects) {
        e.model.traverse((c) => {
            if (c.isMesh && c.geometry) {
                geometryUse.set(c.geometry, (geometryUse.get(c.geometry) || 0) + 1);
            }
        });
    }
    for (const mesh of meshes) {
        if (geometryUse.get(mesh.geometry) > 1) {
            throw new Error("This object shares geometry with other meshes "
                + "(glTF instancing) — splitting would mutate every instance. "
                + "clone_object first, then split the clone.");
        }
    }

    // ---- selection -> per-mesh triangle sets --------------------------------
    const selections = new Map();   // mesh -> Set(tri)
    let suggestedPivot = null;
    let mode;
    let splitNormal = null;   // signed classification normal (plane cuts)

    if (opts.parts && opts.parts.length) {
        mode = "parts";
        const partition = entry._partition;
        if (!partition || partition.rev !== entry.geometryRev
            || opts.partitionId !== partition.rev) {
            throw new Error(
                "Stale or missing partition — geometry changed since detect_parts "
                + `(or partitionId mismatch). Re-run detect_parts and pass its `
                + `partitionId (current rev: ${entry.geometryRev}).`);
        }
        for (const pid of opts.parts) {
            const part = partition.parts[pid];
            if (!part) throw new Error(`No part ${pid}. detect_parts returned ${partition.parts.length} parts.`);
            const mesh = partition.meshes[part.meshIndex];
            let set = selections.get(mesh);
            if (!set) { set = new Set(); selections.set(mesh, set); }
            for (const t of part._tris) set.add(t);
        }
    } else if (opts.plane || opts.axis) {
        mode = "plane";
        let point, normal;
        if (opts.axis) {
            if (!["x", "y", "z"].includes(opts.axis)) {
                throw new Error("axis must be x|y|z (with `at` = world coordinate).");
            }
            if (typeof opts.at !== "number") {
                throw new Error("Plane cut by axis requires `at` (world coordinate).");
            }
            // side selects WHICH half is extracted — the +side-only convention
            // silently extracted a fuselage as "wing_left" (cycle-3 finding).
            const sign = opts.side === "-" ? -1 : 1;
            if (opts.side !== undefined && opts.side !== "+" && opts.side !== "-") {
                throw new Error("side must be '+' (extract the +axis half, default) or '-'.");
            }
            normal = new THREE.Vector3(
                (opts.axis === "x" ? 1 : 0) * sign,
                (opts.axis === "y" ? 1 : 0) * sign,
                (opts.axis === "z" ? 1 : 0) * sign);
            point = new THREE.Vector3(
                opts.axis === "x" ? opts.at : 0,
                opts.axis === "y" ? opts.at : 0,
                opts.axis === "z" ? opts.at : 0);
        } else {
            const pl = opts.plane;
            if (!Array.isArray(pl.point) || !Array.isArray(pl.normal)) {
                throw new Error("plane needs {point:[x,y,z], normal:[x,y,z]}.");
            }
            point = new THREE.Vector3(...pl.point);
            normal = new THREE.Vector3(...pl.normal).normalize();
            if (normal.lengthSq() < 1e-12) throw new Error("plane.normal must be non-zero.");
        }
        splitNormal = normal.clone();
        // Classify by triangle CENTROID side (whole triangles; no cutting).
        const v = new THREE.Vector3();
        const centroid = new THREE.Vector3();
        for (const mesh of meshes) {
            const pos = mesh.geometry.getAttribute("position");
            const index = mesh.geometry.getIndex();
            const triCount = triCountOf(mesh.geometry);
            const idxOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
            const set = new Set();
            for (let t = 0; t < triCount; t++) {
                centroid.set(0, 0, 0);
                for (let k = 0; k < 3; k++) {
                    centroid.add(v.fromBufferAttribute(pos, idxOf(t, k))
                        .applyMatrix4(mesh.matrixWorld));
                }
                centroid.divideScalar(3);
                if (centroid.clone().sub(point).dot(normal) > 0) set.add(t);
            }
            if (set.size) selections.set(mesh, set);
        }
        if (![...selections.values()].some((s) => s.size)) {
            throw new Error("The plane selects no triangles on the positive side — "
                + "check `at`/plane against get_bounds (nothing was split).");
        }
    } else {
        throw new Error("split_object needs `parts` (from detect_parts, with "
            + "partitionId) OR a plane cut: {axis:'x'|'y'|'z', at:<world coord>} "
            + "or {plane:{point,normal}}.");
    }

    // ---- build all geometries FIRST (atomicity) -----------------------------
    // Field-proven default (051): plane cuts cap unless the caller opts out;
    // parts-mode has no cut face, so its default is no-cap and only an
    // EXPLICIT cap:true earns the teaching error.
    const wantCap = opts.cap !== undefined ? !!opts.cap : mode === "plane";
    if (opts.cap === true && mode !== "plane") {
        throw new Error("cap:true applies to PLANE cuts only (parts-mode splits "
            + "separate existing components — there is no cut face to cap).");
    }
    const built = [];   // {mesh, extracted, remainder|null, capPart, capRem}
    let selectedTotal = 0;
    let openEdgesAdded = 0;
    const capReport = wantCap
        ? { part: { loops: 0, capTriangles: 0, skippedEdges: 0, fallbackFans: 0 },
            remaining: { loops: 0, capTriangles: 0, skippedEdges: 0, fallbackFans: 0 },
            uvModes: new Set() }
        : null;
    const pivotAccum = new THREE.Vector3();
    let pivotCount = 0;

    for (const mesh of meshes) {
        const set = selections.get(mesh);
        if (!set || set.size === 0) continue;
        const triCount = triCountOf(mesh.geometry);
        const selected = [...set];
        selectedTotal += selected.length;

        let rims = null;
        if (mode === "plane") {
            rims = classifyCutEdges(mesh, selected);
            openEdgesAdded += rims.cut;
        }

        const box = triangleBox(mesh, selected);
        pivotAccum.add(box.getCenter(new THREE.Vector3()));
        pivotCount++;

        const rest = [];
        for (let t = 0; t < triCount; t++) if (!set.has(t)) rest.push(t);
        const ext = extractSubGeometry(mesh, selected);
        const rem = rest.length ? extractSubGeometry(mesh, rest) : null;
        let extracted = ext.geometry;
        let remainder = rem ? rem.geometry : null;

        if (wantCap && rims) {
            // The signed classification normal, in MESH-LOCAL space (covector
            // transform — a world-space cap basis skews under node scale).
            const nLocal = splitNormal.clone().applyMatrix3(
                new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).transpose())
                .normalize();
            const sampleRimColor = rimColorSampler(mesh);
            // Extracted side sits on +n: its cap closes facing BACK toward the
            // plane (−n); the remainder's cap faces +n.
            const partEdges = rims.partRim
                .map(([a, b]) => [ext.remap.get(a), ext.remap.get(b)])
                .filter(([a, b]) => a !== undefined && b !== undefined);
            const r1 = capGeometry(extracted, partEdges, nLocal.clone().negate(),
                                   { sampleRimColor });
            extracted = r1.geometry;
            capReport.part.loops += r1.report.loops;
            capReport.part.capTriangles += r1.report.capTriangles;
            capReport.part.skippedEdges += r1.report.skippedEdges;
            capReport.part.fallbackFans += r1.report.fallbackFans;
            capReport.uvModes.add(r1.report.uvMode);
            if (remainder && rem) {
                const remEdges = rims.remRim
                    .map(([a, b]) => [rem.remap.get(a), rem.remap.get(b)])
                    .filter(([a, b]) => a !== undefined && b !== undefined);
                const r2 = capGeometry(remainder, remEdges, nLocal,
                                       { sampleRimColor });
                remainder = r2.geometry;
                capReport.remaining.loops += r2.report.loops;
                capReport.remaining.capTriangles += r2.report.capTriangles;
                capReport.remaining.skippedEdges += r2.report.skippedEdges;
                capReport.remaining.fallbackFans += r2.report.fallbackFans;
                capReport.uvModes.add(r2.report.uvMode);
            }
        }
        built.push({ mesh, extracted, remainder });
    }
    if (!built.length) throw new Error("Selection resolved to no triangles.");

    // Suggested hinge: for a plane cut, the selection centroid PROJECTED ONTO
    // the cut plane (the cross-section centroid — the correct hinge for a wing
    // root/elbow); for part selections, the parts' bbox centroid.
    if (pivotCount) {
        suggestedPivot = pivotAccum.divideScalar(pivotCount);
        if (mode === "plane") {
            // Projection onto the cut plane is sign-invariant; the axis point
            // must use the UNSIGNED coordinate (a negated normal would flip it).
            const normal = opts.axis
                ? new THREE.Vector3(opts.axis === "x" ? 1 : 0,
                                    opts.axis === "y" ? 1 : 0,
                                    opts.axis === "z" ? 1 : 0)
                : new THREE.Vector3(...opts.plane.normal).normalize();
            const point = opts.axis
                ? new THREE.Vector3(opts.axis === "x" ? opts.at : 0,
                                    opts.axis === "y" ? opts.at : 0,
                                    opts.axis === "z" ? opts.at : 0)
                : new THREE.Vector3(...opts.plane.point);
            const dist = suggestedPivot.clone().sub(point).dot(normal);
            suggestedPivot.addScaledVector(normal, -dist);
        }
    }

    // ---- commit --------------------------------------------------------------
    const newRoot = new THREE.Group();
    newRoot.name = opts.name || `${entry.name}_part`;
    for (const b of built) {
        const stash = b.mesh._mvOriginalMaterial || b.mesh.material;
        // Painted materials must NOT be shared across the split (clear_paint on
        // one object would strip the other): deep-clone with canvas copy.
        const material = clonePaintedMaterial(stash);
        const newMesh = new THREE.Mesh(b.extracted, material);
        newMesh.name = `${b.mesh.name || "mesh"}_part`;
        // World placement preserved: bake the mesh's world transform relative to
        // the SOURCE wrapper into the new mesh (the new object copies the source
        // wrapper transform).
        const rel = new THREE.Matrix4()
            .copy(entry.wrapper.matrixWorld).invert()
            .multiply(b.mesh.matrixWorld);
        newMesh.applyMatrix4(rel);
        newRoot.add(newMesh);
    }

    const newEntry = viewer._insertEntry(newRoot, "", "", {
        name: opts.name || `${entry.name}_part`,
        source: { kind: "volatile" },   // derived geometry has no file identity
    });
    newEntry.pivot.copy(entry.pivot);
    viewer.setObjectTransform(newEntry.id, viewer._transformOf(entry));
    // keep_active: re-activate the SOURCE after the split — split→split→pivot
    // sequences (the standard articulation workflow) otherwise need a manual
    // set_active_object between every cut (cycle-3 finding).
    if (opts.keep_active && viewer._entryById(entry.id)) {
        viewer.setActiveObject(entry.id);
    }

    // Source keeps the remainder (or disappears if fully consumed).
    let remaining = null;
    let sourceRemoved = false;
    for (const b of built) {
        if (b.remainder) {
            b.mesh.geometry.dispose();
            b.mesh.geometry = b.remainder;
        } else {
            b.mesh.removeFromParent();
            b.mesh.geometry.dispose();
        }
    }
    const leftMeshes = meshesOf(entry);
    if (leftMeshes.length === 0) {
        viewer.removeObject(entry.id);
        sourceRemoved = true;
    } else {
        entry.originalState = null;    // geometry replaced — snapshot baseline moves
        dropMorphs(viewer, entry, "split_object");
        entry.geometryRev++;
        entry._partition = null;
        entry.modified = true;
        entry.sculpted = true;
        entry.stats = viewer._computeStats(entry.model);
        remaining = {
            objectId: entry.id,
            triangles: leftMeshes.reduce((s, m) => s + triCountOf(m.geometry), 0),
        };
    }

    viewer._updateSceneRig(viewer._visibleUnionBox());
    viewer.invalidate();
    viewer._container.dispatchEvent(new CustomEvent("objectschange", {
        detail: { objects: viewer.listObjects(), activeId: viewer._activeObjectId },
    }));

    const created = [{
        objectId: newEntry.id,
        name: newEntry.name,
        triangles: selectedTotal,
        suggestedPivot: suggestedPivot ? vec3(suggestedPivot) : null,
        bounds: viewer._placementSummary(newEntry).bounds,
    }];
    if (wantCap) created[0].capTriangles = capReport.part.capTriangles;
    const result = { created, remaining, mode };
    if (mode === "plane") {
        result.openEdgesAdded = openEdgesAdded;
        if (wantCap) {
            // Closure is RECOUNTED with the shared welded semantics, never
            // assumed (ear-clip/fan both close by construction, but "one
            // metric, one meaning" demands the reported value be measured).
            const partOpen = meshesOf(newEntry).reduce(
                (s, m) => s + meshIssueCounts(m.geometry).openEdges, 0);
            capReport.part.openEdges = partOpen;
            if (!sourceRemoved) {
                capReport.remaining.openEdges = meshesOf(entry).reduce(
                    (s, m) => s + meshIssueCounts(m.geometry).openEdges, 0);
            }
            // Measured per-mesh modes, not an assumption (a UV-less mesh in a
            // multi-mesh cut must not report "rim-sample").
            const modes = [...capReport.uvModes];
            capReport.uvMode = modes.length > 1 ? "mixed" : (modes[0] || "none");
            delete capReport.uvModes;
            result.capped = capReport;
            const skippedTotal = capReport.part.skippedEdges
                + capReport.remaining.skippedEdges;
            result.note = "Cut faces were CAPPED (flat rim-sampled color; "
                + "openEdges above are the measured post-cap counts"
                + (skippedTotal > 0
                    ? ` — ${skippedTotal} rim edge(s) could NOT be walked into `
                      + "cap loops (complex junctions) and remain open"
                    : " — nonzero means the source had pre-existing open "
                      + "boundaries, which capping deliberately never seals")
                + "). suggestedPivot = the cut region centroid — set_pivot "
                + "there, then rotate. Old describe_scene mesh ids are void; "
                + "reset restores the SPLIT state, not the pre-split mesh.";
        } else {
            result.note = "Cut faces are HOLLOW (pass cap:true to close them "
                + "with flat rim-sampled caps). Keep articulation sweeps small "
                + "(≲30°) or orient cuts away from the camera. suggestedPivot "
                + "= the cut region centroid — set_pivot there, then rotate. "
                + "Old describe_scene mesh ids are void; reset now restores "
                + "the SPLIT state, not the pre-split mesh.";
        }
    } else {
        result.note = "Old detect_parts partIds and describe_scene mesh ids are "
            + "void after a split. reset restores the SPLIT state.";
    }
    return result;
}

/** Clone a material for a split part; deep-copies paint layers (canvas pixels)
 *  and charges the budget — via the sculpt module's clonePaintLayer. */
function clonePaintedMaterial(stash) {
    const cloneOne = (m) => {
        const c = m.clone();
        c.userData = { ...m.userData };
        clonePaintLayer(c);
        return c;
    };
    return Array.isArray(stash) ? stash.map(cloneOne) : cloneOne(stash);
}
