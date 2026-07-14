/**
 * Morph targets via sculpt-pose capture (backlog 049) — the talking face.
 *
 * Rigid articulation cannot make a fused head talk (a jaw plane-cut is a
 * hollow slice); blend shapes are the correct mechanism, and the sculpting
 * stack already produces poses. The loop:
 *
 *     begin_morph            → snapshot the BASE pose (accessor-decoded)
 *     sculpt … capture_morph {name:"jaw_open"}   → sparse delta, base restored
 *     sculpt … capture_morph {name:"smile"}      → …
 *     set_morph {name, weight} / set_keyframe {morphs:{smile:0.8}}
 *     export_glb → glTF morph targets + weight animation
 *
 * Design rules (from the 049 adversarial review, verified against three r170):
 * - The morph BASE is its own explicit snapshot (entry.morphBase) — NOT the
 *   reset snapshot (the artist may sculpt a base shape first) and NOT the UI
 *   undo slot (overwritten every gesture).
 * - Deltas are computed per CANONICAL WELD and written to every duplicate
 *   (an epsilon-straddling per-vertex diff can tear a seam).
 * - Sparse masters (typed arrays) on the entry; dense THREE.morphAttributes
 *   (relative) materialized per capture. After ANY content change the
 *   geometry must be DISPOSED: r170's texture-based morph path rebuilds its
 *   DataArrayTexture only when the morph COUNT changes — in-place content
 *   edits render stale data forever.
 * - Transform bakes move positions but three never transforms morphAttributes
 *   (BufferGeometry.applyMatrix4 skips them): bakes must transform the sparse
 *   deltas by the LINEAR part (deltas are position differences — the full
 *   affine cancels) and the base by the full matrix.
 * - reset DROPS morphs/base/weights loudly: deltas captured against a
 *   sculpted base applied to the restored ORIGINAL are a shape nobody
 *   authored. Geometry-replacing ops (simplify/split/fix drops) likewise.
 * - Sculpt/bake-class position writes are refused while any influence is
 *   nonzero (the brush raycasts the DISPLAYED morphed surface but writes the
 *   BASE); paint is texture-space and stays allowed.
 */

import * as THREE from "three";

export const MAX_MORPHS_PER_OBJECT = 8;
// Session-wide sparse budget: dense GPU cost ≈ 28 B/vertex/morph — 2M delta
// verts ≈ tens of MB dense-equivalent, ample for one hero object.
export const MORPH_DELTA_BUDGET = 2 * 1024 * 1024;
let deltaVertsAllocated = 0;

// PER-FRAME GPU cost guard (049 field bug B1): three's texture-based morph
// path makes the vertex shader read EVERY target every frame — 8 full-head
// morphs on a 99k-vertex mesh wedged a SwiftShader session beyond recovery
// (each render slower than the command timeout; no rejection, no way out).
// The budget is vertex×morph products per object, sized to the renderer:
// software rasterizers get a ceiling field-measured as responsive; hardware
// gets an order of magnitude more.
const MORPH_GPU_BUDGET_SOFTWARE = 512 * 1024;
const MORPH_GPU_BUDGET_HARDWARE = 8 * 1024 * 1024;
let _softwareRenderer = null;

function isSoftwareRenderer(viewer) {
    if (_softwareRenderer !== null) return _softwareRenderer;
    try {
        const gl = viewer._renderer && viewer._renderer.getContext();
        const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
        const name = String(gl ? gl.getParameter(
            ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : "");
        _softwareRenderer = /swiftshader|llvmpipe|softpipe|software/i.test(name);
    } catch {
        _softwareRenderer = false;
    }
    return _softwareRenderer;
}

const r3 = (v) => Math.round(v * 1000) / 1000;

function requireActive(viewer) {
    const entry = viewer._activeEntry();
    if (!entry) throw new Error("No model loaded. load / add_model / add_primitive first.");
    if (entry.skinned) {
        throw new Error("Morph capture on skinned (rigged) models is not supported "
            + "— they already carry their own deformation system.");
    }
    return entry;
}

/** Unique geometries of an entry (glTF instancing shares them). */
function uniqueGeometries(entry) {
    const seen = new Set();
    const out = [];
    entry.model.traverse((c) => {
        if (!c.isMesh || !c.geometry || seen.has(c.geometry)) return;
        seen.add(c.geometry);
        out.push(c.geometry);
    });
    return out;
}

/** All meshes referencing a geometry (influences live on the MESH). */
function meshesUsing(entry, geometry) {
    const out = [];
    entry.model.traverse((c) => {
        if (c.isMesh && c.geometry === geometry) out.push(c);
    });
    return out;
}

/**
 * Morph names that arrived WITH the asset (glTF import) rather than through
 * capture_morph. They have dense morphAttributes and mesh dictionaries but no
 * sparse masters — drive-only: weights and keyframes work, capture/delete
 * don't (049 field bug B2: reloaded exports were dead ends).
 */
export function importedMorphNames(entry) {
    const names = new Set();
    entry.model.traverse((c) => {
        if (!c.isMesh || !c.morphTargetDictionary) return;
        for (const n of Object.keys(c.morphTargetDictionary)) {
            if (!entry.morphs || !entry.morphs.has(n)) names.add(n);
        }
    });
    return names;
}

/** Accessor-decoded position snapshot of one geometry. */
function decodePositions(geometry) {
    const pos = geometry.getAttribute("position");
    const arr = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
        arr[i * 3] = pos.getX(i);
        arr[i * 3 + 1] = pos.getY(i);
        arr[i * 3 + 2] = pos.getZ(i);
    }
    return arr;
}

/** Weld map (same quantization rule as the sculpt cache). */
function weldMembers(geometry) {
    const pos = geometry.getAttribute("position");
    geometry.computeBoundingBox();
    const diag = geometry.boundingBox
        ? geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1 : 1;
    const quant = diag * 1e-6;
    const byKey = new Map();
    const members = new Map();   // canonical -> [indices]
    for (let i = 0; i < pos.count; i++) {
        const k = `${Math.round(pos.getX(i) / quant)}_${Math.round(pos.getY(i) / quant)}_${Math.round(pos.getZ(i) / quant)}`;
        let c = byKey.get(k);
        if (c === undefined) { c = i; byKey.set(k, c); }
        let list = members.get(c);
        if (!list) { list = []; members.set(c, list); }
        list.push(i);
    }
    return { members, diag };
}

/**
 * begin_morph — snapshot the ACTIVE object's current pose as the morph base.
 */
export function beginMorph(viewer) {
    const entry = requireActive(viewer);
    if (entry.morphs && entry.morphs.size) {
        throw new Error(
            "This object already has captured morphs — a new base would mix "
            + "bases (blending morphs captured against different bases is "
            + "garbage). delete_morph first, or keep capturing against the "
            + "existing base.");
    }
    const imported = importedMorphNames(entry);
    if (imported.size) {
        throw new Error(
            `This asset carries ${imported.size} IMPORTED morph target(s) `
            + `(${[...imported].join(", ")}) — capturing new morphs would `
            + "rebuild morphAttributes and DISCARD them. Drive the imported "
            + "morphs with set_morph / set_keyframe {morphs}; author fresh "
            + "morphs on a morph-free asset.");
    }
    const geoms = new Map();
    let vertices = 0;
    for (const g of uniqueGeometries(entry)) {
        const positions = decodePositions(g);
        geoms.set(g, positions);
        vertices += positions.length / 3;
    }
    if (!vertices) throw new Error("Active object has no vertices.");
    entry.morphBase = { geoms };
    return {
        base: "captured", vertices, geometries: geoms.size,
        note: "Sculpt the pose, then capture_morph {name} — the base pose is "
            + "restored after each capture. Morphs export via export_glb; they "
            + "do NOT persist in .mvscene manifests.",
    };
}

/**
 * capture_morph — diff current positions vs the base into a named sparse
 * morph, then restore the base (the sculpt → capture → sculpt-next loop).
 */
export function captureMorph(viewer, opts = {}) {
    const entry = requireActive(viewer);
    const name = String(opts.name || "").trim();
    if (!/^[\w\-]{1,32}$/.test(name)) {
        throw new Error("capture_morph requires name (1-32 chars, letters/digits/_/-).");
    }
    if (!entry.morphBase) {
        throw new Error("No morph base — begin_morph first (it snapshots the "
            + "pose your morphs deform FROM), then sculpt and capture.");
    }
    if (!entry.morphs) entry.morphs = new Map();
    const replacing = entry.morphs.has(name);
    if (!replacing && entry.morphs.size >= MAX_MORPHS_PER_OBJECT) {
        throw new Error(`Morph cap: ${MAX_MORPHS_PER_OBJECT} per object — `
            + "delete_morph one first.");
    }
    // GPU render-cost guard (field bug B1): the morph texture is read for
    // EVERY target on EVERY vertex each frame, independent of weights.
    {
        const morphsAfter = entry.morphs.size + (replacing ? 0 : 1);
        let vertexTotal = 0;
        for (const g of entry.morphBase.geoms.keys()) {
            const pos = g.getAttribute("position");
            if (pos) vertexTotal += pos.count;
        }
        const budget = isSoftwareRenderer(viewer)
            ? MORPH_GPU_BUDGET_SOFTWARE : MORPH_GPU_BUDGET_HARDWARE;
        const cost = vertexTotal * morphsAfter;
        if (cost > budget) {
            throw new Error(`Morph GPU budget: ${morphsAfter} morphs × `
                + `${vertexTotal} vertices = ${cost} vertex-morphs exceeds `
                + `${budget} (every target is shaded every frame — past this `
                + "the viewer stops responding on this renderer). Options: "
                + "delete_morph unused poses, or simplify the mesh BEFORE "
                + "begin_morph (fewer vertices raises the morph headroom).");
        }
    }

    const geoms = new Map();
    let deltaVerts = 0;
    let maxDelta = 0;
    for (const [g, base] of entry.morphBase.geoms) {
        const pos = g.getAttribute("position");
        if (!pos || pos.count * 3 !== base.length) {
            throw new Error("Geometry changed since begin_morph (simplify/split?) "
                + "— begin_morph again on the current geometry.");
        }
        const { members, diag } = weldMembers(g);
        const eps = diag * 1e-6;
        const idx = [];
        const del = [];
        // Per CANONICAL weld: average current members (sculpt keeps them
        // identical; averaging absorbs decode rounding), one delta, written
        // to every member — seams can never tear.
        for (const [, list] of members) {
            let cx = 0, cy = 0, cz = 0, bx = 0, by = 0, bz = 0;
            for (const i of list) {
                cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i);
                bx += base[i * 3]; by += base[i * 3 + 1]; bz += base[i * 3 + 2];
            }
            const n = list.length;
            const dx = (cx - bx) / n, dy = (cy - by) / n, dz = (cz - bz) / n;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len <= eps) continue;
            if (len > maxDelta) maxDelta = len;
            for (const i of list) {
                idx.push(i);
                del.push(dx, dy, dz);
            }
        }
        if (idx.length) {
            geoms.set(g, { indices: new Uint32Array(idx),
                           deltas: new Float32Array(del) });
            deltaVerts += idx.length;
        }
    }
    if (!deltaVerts) {
        throw new Error("capture_morph found NO vertices differing from the "
            + "base — sculpt the pose first (the diff is base → current).");
    }
    const previous = replacing
        ? [...entry.morphs.get(name).geoms.values()]
            .reduce((s, g) => s + g.indices.length, 0)
        : 0;
    if (deltaVertsAllocated - previous + deltaVerts > MORPH_DELTA_BUDGET) {
        throw new Error(`Morph budget exceeded (${deltaVertsAllocated - previous
            + deltaVerts} of ${MORPH_DELTA_BUDGET} delta-verts) — delete_morph `
            + "unused morphs, capture smaller poses, or simplify first.");
    }
    deltaVertsAllocated += deltaVerts - previous;
    entry.morphs.set(name, { geoms });
    if (!entry.morphWeights) entry.morphWeights = new Map();
    if (!entry.morphWeights.has(name)) entry.morphWeights.set(name, 0);

    // Restore the base pose (positions only; normals recomputed to match).
    for (const [g, base] of entry.morphBase.geoms) {
        const pos = g.getAttribute("position");
        for (let i = 0; i < pos.count; i++) {
            pos.setXYZ(i, base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
        }
        pos.needsUpdate = true;
        g.computeVertexNormals();
        g.computeBoundingBox();
        g.computeBoundingSphere();
    }
    rebuildMorphAttributes(viewer, entry);
    viewer.invalidate();
    return {
        name,
        replaced: replacing || undefined,
        deltaVertices: deltaVerts,
        maxDelta: r3(maxDelta),
        morphs: [...entry.morphs.keys()],
        budget: { used: deltaVertsAllocated, cap: MORPH_DELTA_BUDGET },
        note: "Base pose restored — sculpt the next pose, or set_morph "
            + `{name:"${name}", weight:0..1} to blend this one in.`,
    };
}

/** set_morph — blend a morph in (0..1): captured OR imported (drive-only). */
export function setMorph(viewer, opts = {}) {
    const entry = requireActive(viewer);
    const name = String(opts.name || "");
    const captured = !!(entry.morphs && entry.morphs.has(name));
    const imported = !captured && importedMorphNames(entry).has(name);
    if (!captured && !imported) {
        const haveC = entry.morphs ? [...entry.morphs.keys()] : [];
        const haveI = [...importedMorphNames(entry)];
        const have = [...haveC, ...haveI];
        throw new Error(`No morph '${name}' on this object`
            + (have.length ? ` — available: ${have.join(", ")}.`
                           : " — begin_morph, sculpt, capture_morph first."));
    }
    const weight = Math.max(0, Math.min(1, Number(opts.weight)));
    if (!Number.isFinite(weight)) throw new Error("set_morph requires weight (0..1).");
    applyMorphWeight(viewer, entry, name, weight);
    if (!entry.morphWeights) entry.morphWeights = new Map();
    entry.morphWeights.set(name, weight);
    viewer.invalidate();
    const out = { name, weight: r3(weight),
                  weights: Object.fromEntries(
                      [...entry.morphWeights].map(([k, v]) => [k, r3(v)])) };
    if (imported) {
        out.source = "imported";
        out.note = "This morph arrived WITH the asset (glTF targets) — weights "
            + "and keyframes work; capture_morph/delete_morph apply only to "
            + "session-captured morphs.";
    }
    return out;
}

/** Direct influence write (also used by timeline sampling — no allocation). */
export function applyMorphWeight(viewer, entry, name, weight) {
    if (entry.morphs && entry.morphs.has(name)) {
        for (const g of entry.morphs.get(name).geoms.keys()) {
            for (const mesh of meshesUsing(entry, g)) {
                const di = mesh.morphTargetDictionary
                    ? mesh.morphTargetDictionary[name] : undefined;
                if (di !== undefined && mesh.morphTargetInfluences) {
                    mesh.morphTargetInfluences[di] = weight;
                }
            }
        }
        return;
    }
    // Imported (asset-authored) morphs: drive by mesh dictionary (B2).
    entry.model.traverse((mesh) => {
        if (!mesh.isMesh || !mesh.morphTargetDictionary) return;
        const di = mesh.morphTargetDictionary[name];
        if (di !== undefined && mesh.morphTargetInfluences) {
            mesh.morphTargetInfluences[di] = weight;
        }
    });
}

/** delete_morph — remove one (or all) CAPTURED morphs; release budget. */
export function deleteMorph(viewer, opts = {}) {
    const entry = requireActive(viewer);
    if (!entry.morphs || !entry.morphs.size) {
        const imported = importedMorphNames(entry);
        throw new Error("No captured morphs on this object."
            + (imported.size
                ? ` ${imported.size} IMPORTED morph(s) ride the asset `
                  + `(${[...imported].join(", ")}) — they are drive-only `
                  + "(set_morph weights); deletion would rewrite the asset."
                : ""));
    }
    const names = opts.name ? [String(opts.name)] : [...entry.morphs.keys()];
    let removed = 0;
    for (const name of names) {
        const m = entry.morphs.get(name);
        if (!m && importedMorphNames(entry).has(name)) {
            throw new Error(`Morph '${name}' is IMPORTED (asset-authored) — `
                + "drive-only: set_morph {weight} works, deletion would "
                + "rewrite the asset. delete_morph applies to captured morphs: "
                + `${[...entry.morphs.keys()].join(", ") || "(none)"}.`);
        }
        if (!m) throw new Error(`No morph '${name}' — have: ${[...entry.morphs.keys()].join(", ")}.`);
        deltaVertsAllocated -= [...m.geoms.values()]
            .reduce((s, g) => s + g.indices.length, 0);
        entry.morphs.delete(name);
        if (entry.morphWeights) entry.morphWeights.delete(name);
        removed++;
    }
    deltaVertsAllocated = Math.max(0, deltaVertsAllocated);
    rebuildMorphAttributes(viewer, entry);
    // Drop this object's morph timeline channels for deleted names.
    const tl = viewer._timeline;
    if (tl && tl.tracks.has(entry.id)) {
        const channels = tl.tracks.get(entry.id);
        for (const name of names) delete channels[`morph:${name}`];
    }
    viewer.invalidate();
    return { removed, remaining: [...entry.morphs.keys()] };
}

/**
 * Materialize dense THREE morphAttributes from the sparse masters (in capture
 * order), reset dictionaries/influences, re-apply stored weights, and DISPOSE
 * the geometry so r170's morph texture rebuilds (in-place content changes
 * otherwise render stale data — the texture is keyed on morph COUNT only).
 */
export function rebuildMorphAttributes(viewer, entry) {
    const geometries = uniqueGeometries(entry);
    for (const g of geometries) {
        const attrs = [];
        if (entry.morphs) {
            for (const [name, morph] of entry.morphs) {
                const sparse = morph.geoms.get(g);
                const pos = g.getAttribute("position");
                const arr = new Float32Array(pos.count * 3);
                if (sparse) {
                    for (let k = 0; k < sparse.indices.length; k++) {
                        const i = sparse.indices[k];
                        arr[i * 3] = sparse.deltas[k * 3];
                        arr[i * 3 + 1] = sparse.deltas[k * 3 + 1];
                        arr[i * 3 + 2] = sparse.deltas[k * 3 + 2];
                    }
                }
                const attr = new THREE.BufferAttribute(arr, 3);
                attr.name = name;
                attrs.push(attr);
            }
        }
        if (attrs.length) {
            g.morphAttributes.position = attrs;
            g.morphTargetsRelative = true;
        } else {
            delete g.morphAttributes.position;
        }
        // Morphed bounds: r170 expands bounding volumes by morph target boxes
        // — without this the raycaster culls the morphed region.
        g.computeBoundingBox();
        g.computeBoundingSphere();
        g.dispose();   // evict stale GPU buffers + morph texture; re-uploads next frame
        for (const mesh of meshesUsing(entry, g)) {
            mesh.updateMorphTargets();   // dictionary + zeroed influences
            if (!attrs.length) {
                // updateMorphTargets is a no-op on morph-free geometry — it
                // would leave a STALE dictionary behind (ghost names that
                // importedMorphNames would then resurrect).
                mesh.morphTargetDictionary = undefined;
                mesh.morphTargetInfluences = undefined;
            }
        }
    }
    // Re-apply stored weights (updateMorphTargets zeroes influences).
    if (entry.morphWeights) {
        for (const [name, w] of entry.morphWeights) {
            applyMorphWeight(viewer, entry, name, w);
        }
    }
}

/** True when any influence on the entry is nonzero (sculpt/bake guard) —
 *  checks MESH influences, not just our weight ledger: imported morphs and
 *  paused clips mid-pose also displace the displayed surface. */
export function hasActiveMorphInfluence(entry) {
    if (!entry) return false;
    if (entry.morphWeights) {
        for (const w of entry.morphWeights.values()) if (w > 0) return true;
    }
    let active = false;
    entry.model.traverse((c) => {
        if (active || !c.isMesh || !c.morphTargetInfluences) return;
        for (const w of c.morphTargetInfluences) {
            if (w > 0) { active = true; return; }
        }
    });
    return active;
}

/**
 * Transform hook for vertex BAKES (center/ground/rotate/orient/scale):
 * three's applyMatrix4 never touches morphAttributes — the base transforms by
 * the full affine matrix, deltas by its linear part.
 */
export function transformMorphsForBake(viewer, entry, geometry, matrix) {
    let touched = false;
    const L = new THREE.Matrix3().setFromMatrix4(matrix);
    const v = new THREE.Vector3();
    if (entry.morphBase && entry.morphBase.geoms.has(geometry)) {
        const base = entry.morphBase.geoms.get(geometry);
        for (let i = 0; i < base.length; i += 3) {
            v.set(base[i], base[i + 1], base[i + 2]).applyMatrix4(matrix);
            base[i] = v.x; base[i + 1] = v.y; base[i + 2] = v.z;
        }
        touched = true;
    }
    if (entry.morphs) {
        for (const morph of entry.morphs.values()) {
            const sparse = morph.geoms.get(geometry);
            if (!sparse) continue;
            for (let k = 0; k < sparse.deltas.length; k += 3) {
                v.set(sparse.deltas[k], sparse.deltas[k + 1], sparse.deltas[k + 2])
                    .applyMatrix3(L);
                sparse.deltas[k] = v.x;
                sparse.deltas[k + 1] = v.y;
                sparse.deltas[k + 2] = v.z;
            }
            touched = true;
        }
    }
    return touched;
}

/**
 * Drop ALL morph state on an entry (reset / geometry-replacing ops). Returns
 * a note for the caller's result, or null when there was nothing to drop.
 */
export function dropMorphs(viewer, entry, why) {
    const had = (entry.morphs && entry.morphs.size) || 0;
    const hadBase = !!entry.morphBase;
    if (!had && !hadBase) return null;
    if (entry.morphs) {
        for (const m of entry.morphs.values()) {
            deltaVertsAllocated -= [...m.geoms.values()]
                .reduce((s, g) => s + g.indices.length, 0);
        }
        deltaVertsAllocated = Math.max(0, deltaVertsAllocated);
    }
    entry.morphs = null;
    entry.morphBase = null;
    entry.morphWeights = null;
    for (const g of uniqueGeometries(entry)) {
        if (g.morphAttributes && g.morphAttributes.position) {
            delete g.morphAttributes.position;
            g.dispose();
        }
    }
    // Mesh-level dictionaries clear UNCONDITIONALLY (field bug F1-2): callers
    // that REPLACE geometry before dropping (refine_region, simplify_region)
    // leave morph-free geometries — the guard above never fires for them, and
    // the stale mesh.morphTargetDictionary made dropped morphs addressable as
    // phantoms: set_morph "succeeded" (claiming source:"imported"), rendered
    // nothing, and its nonzero weight then bricked every sculpt/refine guard.
    entry.model.traverse((mesh) => {
        if (!mesh.isMesh) return;
        const targets = mesh.geometry && mesh.geometry.morphAttributes
            && mesh.geometry.morphAttributes.position;
        if (!targets || !targets.length) {
            mesh.morphTargetDictionary = undefined;
            mesh.morphTargetInfluences = undefined;
        }
    });
    const tl = viewer._timeline;
    if (tl && tl.tracks.has(entry.id)) {
        const channels = tl.tracks.get(entry.id);
        for (const key of Object.keys(channels)) {
            if (key.startsWith("morph:")) delete channels[key];
        }
    }
    return had
        ? `${had} captured morph(s) were DROPPED by ${why} — their deltas `
          + "referenced the previous geometry/base. export_glb BEFORE "
          + `${why} to keep morphs.`
        : null;
}

/** Morph summary for list_objects / get_state — captured AND imported. */
export function morphSummary(entry) {
    const out = {};
    if (entry.morphs) {
        for (const name of entry.morphs.keys()) {
            out[name] = r3(entry.morphWeights ? (entry.morphWeights.get(name) || 0) : 0);
        }
    }
    for (const name of importedMorphNames(entry)) {
        let w = entry.morphWeights ? entry.morphWeights.get(name) : undefined;
        if (w === undefined) {
            // Read the live influence (clips drive these without our ledger).
            entry.model.traverse((c) => {
                if (w !== undefined || !c.isMesh || !c.morphTargetDictionary) return;
                const di = c.morphTargetDictionary[name];
                if (di !== undefined && c.morphTargetInfluences) {
                    w = c.morphTargetInfluences[di];
                }
            });
        }
        out[name] = r3(w || 0);
    }
    return Object.keys(out).length ? out : undefined;
}

/** Release the session budget held by an entry (object disposal). */
export function releaseMorphBudget(entry) {
    if (!entry || !entry.morphs) return;
    for (const m of entry.morphs.values()) {
        deltaVertsAllocated -= [...m.geoms.values()]
            .reduce((s, g) => s + g.indices.length, 0);
    }
    deltaVertsAllocated = Math.max(0, deltaVertsAllocated);
}
