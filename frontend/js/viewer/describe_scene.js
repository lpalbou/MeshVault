/**
 * describe_scene — a compact, structured TEXT snapshot of the loaded model for AI agents
 * (backlog 029, folding in the QA checks of 031).
 *
 * Design: "snapshot over screenshot" (as proven by Playwright-MCP). A text-only agent gets
 * everything it needs to reason — inventory, size, hierarchy, materials, detected issues,
 * current view — WITHOUT vision. The report is token-bounded: lists are capped with
 * explicit "…and N more" markers, and expensive geometry checks are skipped (and said to
 * be skipped) above a triangle budget so the command stays fast on huge scenes.
 *
 * All checks are heuristics on the raw buffers and are worded accordingly: watertightness
 * is evaluated on position-welded edges (raw index edges would false-positive every UV
 * seam), flipped normals use a centroid orientation test that is only meaningful for
 * mostly-closed shapes.
 */

import * as THREE from "three";

/** Triangle budget above which per-triangle checks are skipped (kept fast + bounded). */
const CHECK_TRIANGLE_BUDGET = 300_000;

export function describeScene(viewer, opts = {}) {
    const maxItems = Math.max(1, Math.min(50, opts.maxItems || 8));
    const state = viewer.getState();
    if (!state.model.loaded) {
        return { loaded: false, summary: "No model is loaded." };
    }

    const model = viewer._currentModel;
    const meshes = collectMeshes(model);
    const materials = collectMaterials(meshes);
    const hierarchy = collectHierarchy(model, maxItems * 3);

    // LIVE numbers, computed here from the current buffers/bounds — never cached loader
    // stats, which go stale after simplify/rotate and would contradict the mesh list.
    const totalTriangles = meshes.reduce((s, m) => s + m.triangles, 0);
    const totalVertices = meshes.reduce((s, m) => s + m.vertices, 0);
    const bounds = viewer.getBounds();
    const dimensions = bounds
        ? { width: r3(bounds.size[0]), height: r3(bounds.size[1]), depth: r3(bounds.size[2]) }
        : state.model.dimensions;
    const format = extOf(state.model.name);

    const issues = opts.checks === false ? [] : runChecks(meshes, materials, dimensions);
    const report = {
        loaded: true,
        summary: "",  // filled last, from the assembled facts
        model: {
            name: state.model.name,
            format,
            // Sum of position-attribute counts (same basis as meshes.items[].vertices).
            // Seam-duplicated vertices count once per duplicate.
            vertices: totalVertices,
            triangles: totalTriangles,
            meshCount: meshes.length,
            materialCount: materials.length,
            textureCount: countTextures(materials),
            animated: state.animation.hasAnimations,
            animationClips: state.animation.clips,
            dimensions,
            bounds,
            sizeHint: sizeHint(dimensions, format),
            userScale: state.model.scale,
            modified: state.model.modified,
        },
        hierarchy,
        meshes: topMeshes(meshes, maxItems),
        materials: materialSummaries(materials, maxItems),
        issues,
        view: {
            camera: {
                position: state.camera.position, target: state.camera.target,
                fov: state.camera.fov, mode: state.camera.mode,
            },
            renderMode: state.display.renderMode,
            environment: state.display.environment,
            clip: state.display.clip,
            grid: state.display.grid,
        },
    };

    // Optional: candidate "front" angles (costs a few offscreen renders → opt-in).
    if (opts.views) {
        try {
            const ranked = viewer.scoreViews({ size: 96 });
            report.suggestedViews = ranked.slice(0, 3).map((r) => ({
                azimuth: r.azimuth, elevation: r.elevation, score: Math.round(r.score * 1000) / 1000,
            }));
        } catch { /* scoring is best-effort; the report stands without it */ }
    }

    report.summary = buildSummary(report);
    return report;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const r3 = (v) => Math.round(v * 1000) / 1000;

function extOf(name) {
    const m = /\.[a-z0-9]+$/i.exec(name || "");
    return m ? m[0].toLowerCase() : null;
}

function collectMeshes(model) {
    const out = [];
    model.updateMatrixWorld(true);
    let id = 0;
    model.traverse((child) => {
        if (!child.isMesh || !child.geometry) return;
        const geo = child.geometry;
        const pos = geo.getAttribute("position");
        const index = geo.getIndex();
        const vertices = pos ? pos.count : 0;
        const triangles = Math.floor(index ? index.count / 3 : vertices / 3);
        // World-space placement of the part, so an agent can locate it spatially and
        // `focus` it. Same traversal-order id as the focus command. Skinned meshes
        // report the bind pose (three's cached bounds ignore the animated pose).
        let center = null, size = null;
        if (!geo.boundingBox) geo.computeBoundingBox();
        if (geo.boundingBox && !geo.boundingBox.isEmpty()) {
            const wb = geo.boundingBox.clone().applyMatrix4(child.matrixWorld);
            const c = wb.getCenter(new THREE.Vector3());
            const s = wb.getSize(new THREE.Vector3());
            center = [r3(c.x), r3(c.y), r3(c.z)];
            size = [r3(s.x), r3(s.y), r3(s.z)];
        }
        // Describe the ASSET, not the current display override: render modes (solid/
        // normals) swap child.material and stash the real one on _mvOriginalMaterial.
        const raw = child._mvOriginalMaterial || child.material;
        const mats = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
        out.push({
            id: id++,
            center,
            size,
            name: child.name || "(unnamed)",
            mesh: child,
            geometry: geo,
            vertices,
            triangles,
            indexed: !!index,
            hasNormals: !!geo.getAttribute("normal"),
            hasUVs: !!geo.getAttribute("uv"),
            hasVertexColors: !!geo.getAttribute("color"),
            skinned: !!child.isSkinnedMesh,
            materials: mats,
        });
    });
    return out;
}

const MAP_SLOTS = [
    "map", "normalMap", "roughnessMap", "metalnessMap", "aoMap",
    "emissiveMap", "bumpMap", "displacementMap", "alphaMap",
];

function collectMaterials(meshes) {
    const seen = new Map();
    for (const m of meshes) {
        for (const mat of m.materials) {
            if (seen.has(mat)) { seen.get(mat).meshes.push(m.name); continue; }
            const maps = MAP_SLOTS.filter((slot) => mat[slot] && mat[slot].isTexture);
            // Texture facts per slot: resolution + color space. `image` may be an
            // ImageBitmap/HTMLImage/compressed-data descriptor — all expose width/height.
            const textures = {};
            for (const slot of maps) {
                const tex = mat[slot];
                const img = tex.image || {};
                textures[slot] = {
                    width: img.width || null,
                    height: img.height || null,
                    // three uses "" (NoColorSpace) for linear data textures — say
                    // "linear" instead of leaving agents to guess what null means.
                    colorSpace: tex.colorSpace || "linear",
                };
            }
            // The viewer clamps extreme PBR values for preview (_fixDarkColor). Report
            // the AUTHORED values too, so a material audit sees the asset, not the clamp.
            const authored = mat.userData && mat.userData._mvAuthored ? mat.userData._mvAuthored : null;
            const displayed = {
                metalness: numOrNull(mat.metalness),
                roughness: numOrNull(mat.roughness),
            };
            const modifiedByViewer = !!(authored && (
                (authored.metalness !== null && authored.metalness !== displayed.metalness) ||
                (authored.roughness !== null && authored.roughness !== displayed.roughness) ||
                (authored.color && mat.color && authored.color !== `#${mat.color.getHexString()}`)
            ));
            seen.set(mat, {
                material: mat,
                name: mat.name || "(unnamed)",
                type: mat.type,
                color: mat.color ? `#${mat.color.getHexString()}` : null,
                metalness: displayed.metalness,
                roughness: displayed.roughness,
                authored,
                modifiedByViewer,
                maps,
                textures,
                transparent: !!mat.transparent,
                doubleSided: mat.side === THREE.DoubleSide,
                meshes: [m.name],
            });
        }
    }
    return [...seen.values()];
}

function numOrNull(v) {
    return typeof v === "number" ? Math.round(v * 100) / 100 : null;
}

function countTextures(materials) {
    const set = new Set();
    for (const m of materials) {
        for (const slot of m.maps) {
            const tex = m.material[slot];
            if (tex) set.add(tex.uuid);
        }
    }
    return set.size;
}

/**
 * Flat, depth-annotated outline of the object tree — capped, mesh/group/bone aware.
 * Anonymous single-child pass-through groups are pure noise for agents and are NOT
 * counted as truncated; `truncated` only counts meaningful nodes dropped by the
 * cap/depth limits (i.e. nodes a larger maxItems could reveal).
 */
function collectHierarchy(model, cap) {
    const nodes = [];
    let total = 0;
    let truncated = 0;
    const walk = (obj, depth) => {
        const kind = obj.isMesh ? "mesh" : obj.isBone ? "bone"
            : obj.isLight ? "light" : obj.isCamera ? "camera" : "group";
        const anonymous = !obj.name && kind === "group" && obj.children.length === 1;
        if (!anonymous) {
            total += 1;
            if (nodes.length < cap && depth <= 4) {
                nodes.push({ name: obj.name || "(unnamed)", kind, depth });
            } else {
                truncated += 1;
            }
        }
        for (const c of obj.children) walk(c, depth + 1);
    };
    walk(model, 0);
    return { nodes, totalNodes: total, truncated };
}

function topMeshes(meshes, maxItems) {
    const sorted = [...meshes].sort((a, b) => b.triangles - a.triangles);
    const items = sorted.slice(0, maxItems).map((m) => ({
        id: m.id,          // stable traversal-order id — pass to `focus { id }`
        name: m.name,
        triangles: m.triangles,
        vertices: m.vertices,
        center: m.center,  // world-space part placement
        size: m.size,
        materials: m.materials.map((x) => x.name || "(unnamed)"),
        hasUVs: m.hasUVs,
        hasVertexColors: m.hasVertexColors || undefined,
        skinned: m.skinned || undefined,
    }));
    return { items, omitted: Math.max(0, meshes.length - items.length) };
}

function materialSummaries(materials, maxItems) {
    const items = materials.slice(0, maxItems).map((m) => ({
        name: m.name, type: m.type, color: m.color,
        metalness: m.metalness, roughness: m.roughness,
        // Present only when the viewer changed something: the asset's original values.
        authored: m.modifiedByViewer ? m.authored : undefined,
        modifiedByViewer: m.modifiedByViewer || undefined,
        maps: m.maps,
        textures: Object.keys(m.textures).length ? m.textures : undefined,
        transparent: m.transparent, doubleSided: m.doubleSided,
    }));
    return { items, omitted: Math.max(0, materials.length - items.length) };
}

/**
 * Non-authoritative real-world plausibility hint from the bounding-box size.
 * glTF DEFINES its unit as meters, so for .glb/.gltf the hint speaks with confidence;
 * other formats have no spec-defined unit and the hint stays hedged.
 */
function sizeHint(dim, format) {
    const maxDim = Math.max(dim.width, dim.height, dim.depth);
    if (!maxDim || !Number.isFinite(maxDim)) return "size unknown";
    const s = maxDim.toPrecision(3);
    const isGltf = format === ".glb" || format === ".gltf";
    if (isGltf) {
        // Spec says meters — still flag implausible extremes (mis-exported assets exist).
        if (maxDim < 0.01) return `${s} m (glTF units are meters) — under 1 cm; possibly a mis-scaled export`;
        if (maxDim > 1000) return `${s} m (glTF units are meters) — over 1 km; possibly a mis-scaled export`;
        return `${s} m (glTF units are meters)`;
    }
    if (maxDim < 0.01) return `${s} units — tiny; if meters, likely wrong units (millimeter-authored?)`;
    if (maxDim <= 5) return `${s} units — human/object scale if meters`;
    if (maxDim <= 100) return `${s} units — room/building scale if meters, or object scale if centimeters`;
    if (maxDim <= 5000) return `${s} units — likely centimeters or millimeters (common for CAD/print)`;
    return `${s} units — very large; likely millimeters or an unscaled export`;
}

// ---------------------------------------------------------------------------
// QA checks (031): heuristics on the raw buffers, budget-bounded
// ---------------------------------------------------------------------------

function runChecks(meshes, materials, dimensions) {
    const issues = [];
    const add = (severity, code, message, meshNames) => {
        issues.push({ severity, code, message, ...(meshNames && meshNames.length ? { meshes: meshNames.slice(0, 6) } : {}) });
    };

    const totalTris = meshes.reduce((s, m) => s + m.triangles, 0);
    const overBudget = totalTris > CHECK_TRIANGLE_BUDGET;

    // Cheap structural checks — always run.
    const noNormals = meshes.filter((m) => !m.hasNormals).map((m) => m.name);
    if (noNormals.length) add("warning", "missing_normals", "Meshes without vertex normals (will shade flat/black until recomputed — see recompute_normals).", noNormals);

    const texturedMats = new Set(materials.filter((m) => m.maps.length > 0).map((m) => m.material));
    const noUVsButTextured = meshes
        .filter((m) => !m.hasUVs && m.materials.some((mat) => texturedMats.has(mat)))
        .map((m) => m.name);
    if (noUVsButTextured.length) add("error", "missing_uvs", "Meshes whose material has texture maps but which have no UV coordinates — textures cannot display on them.", noUVsButTextured);

    const empty = meshes.filter((m) => m.vertices === 0).map((m) => m.name);
    if (empty.length) add("warning", "empty_meshes", "Meshes with zero vertices.", empty);

    const unindexed = meshes.filter((m) => !m.indexed).map((m) => m.name);
    if (unindexed.length === meshes.length && meshes.length > 0) {
        add("info", "unindexed_geometry", "All geometry is unindexed (soup of triangles) — normal for STL and some exports; vertex-welding operations may be slower.");
    }

    // Scale sanity.
    const maxDim = Math.max(dimensions.width, dimensions.height, dimensions.depth);
    if (maxDim > 0 && maxDim < 0.001) add("warning", "scale_tiny", `Model is only ${maxDim.toPrecision(2)} units across — probably wrong units.`);
    if (maxDim > 100000) add("warning", "scale_huge", `Model is ${maxDim.toPrecision(3)} units across — probably wrong units.`);

    // Per-triangle checks — budget-bounded.
    if (overBudget) {
        add("info", "checks_skipped", `Per-triangle checks (degenerate faces, watertightness, normal orientation) skipped: ${totalTris.toLocaleString()} triangles exceeds the ${CHECK_TRIANGLE_BUDGET.toLocaleString()} budget.`);
        return issues;
    }

    const degenerate = [];
    const notWatertight = [];
    const nonManifold = [];
    const maybeFlipped = [];
    const nanMeshes = [];

    for (const m of meshes) {
        if (m.vertices === 0) continue;
        const r = analyzeGeometry(m.geometry);
        if (r.hasNaN) nanMeshes.push(m.name);
        if (r.degenerate > 0) degenerate.push(`${m.name} (${r.degenerate})`);
        if (r.boundaryEdges > 0) notWatertight.push(`${m.name} (${r.boundaryEdges} open edges)`);
        if (r.nonManifoldEdges > 0) nonManifold.push(`${m.name} (${r.nonManifoldEdges})`);
        // Signed volume of the winding: negative for a closed mesh means faces point
        // inward. Robust for any closed shape (a centroid test fails on tori etc.).
        if (r.boundaryEdges === 0 && r.signedVolume < 0) maybeFlipped.push(m.name);
    }

    if (nanMeshes.length) add("error", "nan_positions", "Meshes containing NaN vertex positions (corrupt geometry).", nanMeshes);
    if (degenerate.length) add("warning", "degenerate_faces", "Meshes with zero-area (sliver/collapsed) triangles (count in parentheses).", degenerate);
    if (notWatertight.length) add("info", "not_watertight", "Meshes with open (boundary) edges — not watertight; relevant for 3D printing, harmless for display. Edges are counted on position-welded vertices, so UV seams do not trigger this.", notWatertight);
    if (nonManifold.length) add("info", "non_manifold_edges", "Meshes with edges shared by more than two faces (non-manifold).", nonManifold);
    if (maybeFlipped.length) add("warning", "normals_maybe_flipped", "Closed meshes whose signed volume is negative — face windings point inward, normals are likely flipped (verify visually or recompute_normals).", maybeFlipped);

    return issues;
}

/**
 * One pass over the triangles of a geometry: degenerate count, edge topology on
 * position-welded vertices, signed volume (winding orientation), NaN detection.
 *
 * Written allocation-light on purpose: scalar math in the triangle loop (no Vector3
 * per vertex/face) and numeric Map keys for edges (no string churn) — this runs on the
 * main thread and must stay cheap up to the 300k-triangle budget.
 */
function analyzeGeometry(geo) {
    const pos = geo.getAttribute("position");
    const index = geo.getIndex();
    const triCount = Math.floor((index ? index.count : pos.count) / 3);

    // Weld by position: map each vertex index → canonical id for its (quantized) position.
    // Raw indices would report every UV/normal seam as a boundary edge (false positives).
    const bb = geo.boundingBox || (geo.computeBoundingBox(), geo.boundingBox);
    const scale = Math.max(1e-30, bb.max.distanceTo(bb.min));
    const q = 1e-6 * scale;
    const canon = new Map();
    const canonOf = new Int32Array(pos.count);
    let hasNaN = false;
    let nextId = 0;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) { hasNaN = true; canonOf[i] = -1; continue; }
        const key = `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
        let id = canon.get(key);
        if (id === undefined) { id = nextId++; canon.set(key, id); }
        canonOf[i] = id;
    }

    const edgeCount = new Map();  // numeric key u*nVerts+v (u<v, canonical ids) → face count
    const nVerts = Math.max(1, nextId);
    let degenerate = 0;
    let vol6 = 0;  // 6 × signed volume, accumulated per face tetrahedron

    const vi = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    for (let t = 0; t < triCount; t++) {
        const i0 = vi(t, 0), i1 = vi(t, 1), i2 = vi(t, 2);
        const c0 = canonOf[i0], c1 = canonOf[i1], c2 = canonOf[i2];
        if (c0 < 0 || c1 < 0 || c2 < 0) continue;  // NaN vertex — reported separately

        const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
        const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
        const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);
        const abx = bx - ax, aby = by - ay, abz = bz - az;
        const acx = cx - ax, acy = cy - ay, acz = cz - az;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        const area2 = nx * nx + ny * ny + nz * nz;
        // Degenerate = true sliver, judged on the RAW positions: |cross|² relative to the
        // edge lengths (sin²θ < 1e-12). NOT on welded ids — quantization can merge the
        // corners of a genuinely tiny-but-valid triangle (false positive), while a truly
        // collapsed corner has zero area and the sliver test catches it anyway.
        const lenSq = (abx * abx + aby * aby + abz * abz) * (acx * acx + acy * acy + acz * acz);
        if (area2 < 1e-12 * lenSq) { degenerate += 1; continue; }

        // Edge topology on welded ids; skip self-edges from quantization-merged corners.
        if (c0 !== c1) { const k = c0 < c1 ? c0 * nVerts + c1 : c1 * nVerts + c0; edgeCount.set(k, (edgeCount.get(k) || 0) + 1); }
        if (c1 !== c2) { const k = c1 < c2 ? c1 * nVerts + c2 : c2 * nVerts + c1; edgeCount.set(k, (edgeCount.get(k) || 0) + 1); }
        if (c2 !== c0) { const k = c2 < c0 ? c2 * nVerts + c0 : c0 * nVerts + c2; edgeCount.set(k, (edgeCount.get(k) || 0) + 1); }

        // Signed volume contribution: a · (b × c). Sum is positive when windings face
        // outward (right-handed), negative when the surface is inside-out.
        vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }

    let boundaryEdges = 0, nonManifoldEdges = 0;
    for (const count of edgeCount.values()) {
        if (count === 1) boundaryEdges += 1;
        else if (count > 2) nonManifoldEdges += 1;
    }

    return {
        hasNaN,
        degenerate,
        boundaryEdges,
        nonManifoldEdges,
        signedVolume: vol6 / 6,
    };
}

// ---------------------------------------------------------------------------
// Natural-language summary — assembled from the report so it can never disagree with it
// ---------------------------------------------------------------------------

function buildSummary(r) {
    const m = r.model;
    const d = m.dimensions;
    const parts = [];
    parts.push(
        `"${m.name}": ${m.meshCount} mesh${m.meshCount === 1 ? "" : "es"}, ` +
        `${m.materialCount} material${m.materialCount === 1 ? "" : "s"}` +
        `${m.textureCount ? ` (${m.textureCount} texture${m.textureCount === 1 ? "" : "s"})` : " (untextured)"}, ` +
        `${m.triangles.toLocaleString()} triangles, ` +
        `${d.width}\u00d7${d.height}\u00d7${d.depth} units (${m.sizeHint}).`
    );
    parts.push(m.animated ? `Animated (${m.animationClips.length} clip${m.animationClips.length === 1 ? "" : "s"}).` : "Not animated.");
    const errors = r.issues.filter((i) => i.severity === "error");
    const warnings = r.issues.filter((i) => i.severity === "warning");
    const infos = r.issues.filter((i) => i.severity === "info");
    if (errors.length || warnings.length) {
        parts.push(`Issues: ${[...errors, ...warnings].map((i) => i.code).join(", ")}` +
            `${infos.length ? ` (+${infos.length} informational: ${infos.map((i) => i.code).join(", ")})` : ""}.`);
    } else if (infos.length) {
        parts.push(`No blocking geometry issues (${infos.length} informational: ${infos.map((i) => i.code).join(", ")}).`);
    } else {
        parts.push("No geometry issues detected.");
    }
    parts.push(`Current view: ${r.view.renderMode} render mode, camera at [${r.view.camera.position.join(", ")}].`);
    return parts.join(" ");
}
