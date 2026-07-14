/**
 * Mesh fusion (backlog: "primitives are the first draft, never the result").
 *
 * merge_objects fuses SEVERAL scene objects into ONE object with ONE welded
 * geometry, so sculpting brushes work ACROSS what used to be separate
 * primitives (each geometry kept its own weld map before — displacing a
 * boundary tore cracks between parts; a fused hull has no boundaries).
 *
 * Two modes:
 * - "union" (default): true CSG union via three-bvh-csg — overlapping volumes
 *   fuse where they intersect, interior shells disappear, the result is a
 *   single manifold surface you can sculpt/dig/refine anywhere. Requires
 *   closed sources (open rims make CSG classification garbage — refused with
 *   a teaching error naming the open counts; use mode:"concat" for shells).
 * - "concat": geometric concatenation + coincident-vertex weld. No volume
 *   classification — interior walls survive — but it never refuses, and
 *   welding lets brushes move shared boundary vertices together.
 *
 * blend > 0 (world units) rounds the union SEAMS into fillets: seam vertices
 * (on the intersection curves — within tolerance of ≥2 source surfaces) and
 * their neighborhood get deterministic Laplacian relaxation with smooth
 * falloff. This is the "local fusion" of the field request: assemble → fuse
 * → blend the joints → sculpt as one skin.
 *
 * Contract notes (disclosed in results):
 * - The merged object lives at IDENTITY placement (world coords baked).
 * - Paint layers and authored textures of the sources are DROPPED (the fused
 *   surface is meant to be textured after fusion); UVs are re-atlassed into
 *   per-source grid cells so later painting never cross-talks.
 * - Sources are removed (their ids die); the merged object is a NEW id.
 * - Manifests cannot rebuild a merge (source: volatile) — export_glb persists.
 */

import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { Brush, Evaluator, ADDITION } from "three-bvh-csg";
import { meshIssueCounts } from "./repair.js";

const MAX_MERGED_TRIANGLES = 400000;
const SEAM_EPS_SCALE = 1e-4;     // seam tolerance = eps × union bbox diagonal

/** Bake one entry's meshes (world space) into a single normalized geometry. */
function bakedSourceGeometry(entry) {
    const parts = [];
    entry.model.updateMatrixWorld(true);
    entry.model.traverse((child) => {
        if (!child.isMesh || !child.geometry) return;
        let g = child.geometry.clone();
        // Normalize to plain, non-indexed, position+normal+uv only — CSG and
        // mergeGeometries both need consistent attribute sets, and extras
        // (tangents, colors, morphs) do not survive fusion meaningfully.
        for (const name of Object.keys(g.attributes)) {
            if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
        }
        if (!g.getAttribute("normal")) g.computeVertexNormals();
        if (!g.getAttribute("uv")) {
            // Constant UV keeps attribute sets merge-compatible; the cell
            // re-atlas below still gives the source its own paint island.
            const n = g.getAttribute("position").count;
            g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
        }
        g = g.toNonIndexed ? g.toNonIndexed() : g;
        g.applyMatrix4(child.matrixWorld);
        parts.push(g);
    });
    if (parts.length === 0) return null;
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    parts.forEach((p) => { if (p !== merged) p.dispose(); });
    return merged;
}

/** Re-atlas each source's UVs into its own grid cell (no paint cross-talk). */
function atlasIntoCell(geometry, cellIndex, cells) {
    const grid = Math.ceil(Math.sqrt(cells));
    const cw = 1 / grid;
    const cx = (cellIndex % grid) * cw;
    const cy = Math.floor(cellIndex / grid) * cw;
    const uv = geometry.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) {
        // Clamp into [0,1] first: tiled UVs would leak into neighbor cells.
        const u = Math.min(1, Math.max(0, uv.getX(i)));
        const v = Math.min(1, Math.max(0, uv.getY(i)));
        uv.setXY(i, cx + u * cw, cy + v * cw);
    }
    uv.needsUpdate = true;
}

/**
 * Deterministic seam blend: Laplacian relaxation of the neighborhood of the
 * CSG intersection curves, with smooth falloff by distance to the seam.
 */
function blendSeams(geometry, sourceGeoms, blendRadius, diag) {
    const pos = geometry.getAttribute("position");
    const eps = diag * SEAM_EPS_SCALE + 1e-9;

    // Seam vertices: within eps of at least TWO source surfaces. Source
    // proximity via each source's own BVH (three-mesh-bvh closestPoint).
    const bvhs = sourceGeoms.map((g) => {
        const gi = g.index ? g : mergeVertices(g.clone(), 1e-10);
        if (!gi.boundsTree) gi.computeBoundsTree({ indirect: false });
        return gi;
    });
    const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
    const p = new THREE.Vector3();
    const seams = [];
    for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i);
        let near = 0;
        for (const g of bvhs) {
            // Bounded query returns null when nothing lies within the cap —
            // never read the (stale) target in that case.
            const hit = g.boundsTree.closestPointToPoint(p, target, 0, eps * 2);
            if (hit && hit.point.distanceTo(p) <= eps) near++;
            if (near >= 2) break;
        }
        if (near >= 2) seams.push(i);
    }
    if (seams.length === 0) return { seamVerts: 0, blended: 0 };

    // Weld map (positions coincide across CSG triangle splits): canonical
    // position key -> member indices; neighbors via triangle edges.
    const quant = Math.max(diag * 1e-7, 1e-12);
    const canon = new Map();
    const keyOf = (i) => {
        const x = Math.round(pos.getX(i) / quant);
        const y = Math.round(pos.getY(i) / quant);
        const z = Math.round(pos.getZ(i) / quant);
        return `${x},${y},${z}`;
    };
    const canonical = new Array(pos.count);
    const members = new Map();
    for (let i = 0; i < pos.count; i++) {
        const k = keyOf(i);
        let c = canon.get(k);
        if (c === undefined) { c = i; canon.set(k, c); members.set(c, []); }
        canonical[i] = c;
        members.get(c).push(i);
    }
    const neighbors = new Map();
    const link = (a, b) => {
        let s = neighbors.get(a);
        if (!s) { s = new Set(); neighbors.set(a, s); }
        s.add(b);
    };
    const triCount = Math.floor(pos.count / 3);
    for (let t = 0; t < triCount; t++) {
        const a = canonical[t * 3], b = canonical[t * 3 + 1], c = canonical[t * 3 + 2];
        if (a !== b) { link(a, b); link(b, a); }
        if (b !== c) { link(b, c); link(c, b); }
        if (c !== a) { link(c, a); link(a, c); }
    }

    // Blend region: canonical verts within blendRadius of any seam vertex
    // (seam subsampled for the distance field — exactness is not needed for
    // a fillet, determinism is: fixed order, fixed math).
    const seamPts = [];
    const step = Math.max(1, Math.floor(seams.length / 400));
    for (let s = 0; s < seams.length; s += step) {
        const i = seams[s];
        seamPts.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
    }
    const r2 = blendRadius * blendRadius;
    const weights = new Map();          // canonical -> falloff weight
    for (const c of members.keys()) {
        const x = pos.getX(c), y = pos.getY(c), z = pos.getZ(c);
        let best = Infinity;
        for (const sp of seamPts) {
            const dx = x - sp[0], dy = y - sp[1], dz = z - sp[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < best) best = d2;
        }
        if (best <= r2) {
            const t = Math.sqrt(best) / blendRadius;
            weights.set(c, (1 - t * t) * (1 - t * t));   // smooth falloff
        }
    }

    // 3 Laplacian passes over the weighted region (plain — a fillet WANTS
    // volume rounding at the crease; weights fade it into untouched skin).
    let blended = 0;
    const next = new Map();
    for (let pass = 0; pass < 3; pass++) {
        next.clear();
        for (const [c, w] of weights) {
            const ns = neighbors.get(c);
            if (!ns || ns.size < 2) continue;
            let ax = 0, ay = 0, az = 0;
            for (const n of ns) { ax += pos.getX(n); ay += pos.getY(n); az += pos.getZ(n); }
            const inv = 1 / ns.size;
            const k = 0.55 * w;
            next.set(c, [
                pos.getX(c) * (1 - k) + ax * inv * k,
                pos.getY(c) * (1 - k) + ay * inv * k,
                pos.getZ(c) * (1 - k) + az * inv * k,
            ]);
        }
        for (const [c, v] of next) {
            for (const m of members.get(c)) pos.setXYZ(m, v[0], v[1], v[2]);
            if (pass === 0) blended++;
        }
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    bvhs.forEach((g) => { if (g.boundsTree) g.disposeBoundsTree(); g.dispose(); });
    return { seamVerts: seams.length, blended };
}

/**
 * Stitch CSG T-junctions. three-bvh-csg clips each brush against the other
 * INDEPENDENTLY, so along the intersection curve side A is subdivided at A's
 * edge crossings and side B at B's — mutual T-junctions by construction
 * (~1k open edges on a two-sphere union). For every open edge that has seam
 * vertices lying ON it, the owning triangle is fanned so both sides share
 * every seam point. Deterministic: fixed iteration order, parametric sort
 * with canonical-id tie-break. Non-indexed in, non-indexed out.
 */
function stitchTJunctions(geometry, maxPasses = 4) {
    for (let pass = 0; pass < maxPasses; pass++) {
        const pos = geometry.getAttribute("position");
        const uv = geometry.getAttribute("uv");
        const nor = geometry.getAttribute("normal");
        const box = new THREE.Box3().setFromBufferAttribute(pos);
        const diag = box.getSize(new THREE.Vector3()).length() || 1;
        const quant = diag * 1e-6;
        const tol = diag * 2e-5;

        // Canonical position welding.
        const byKey = new Map();
        const canonical = new Int32Array(pos.count);
        for (let i = 0; i < pos.count; i++) {
            const k = `${Math.round(pos.getX(i) / quant)}_`
                + `${Math.round(pos.getY(i) / quant)}_`
                + `${Math.round(pos.getZ(i) / quant)}`;
            const seen = byKey.get(k);
            canonical[i] = seen !== undefined ? seen : (byKey.set(k, i), i);
        }
        // Canonical edge use counts.
        const triCount = Math.floor(pos.count / 3);
        const edgeCount = new Map();
        const ekey = (a, b) => (a < b ? a * 16777216 + b : b * 16777216 + a);
        for (let t = 0; t < triCount; t++) {
            for (let k = 0; k < 3; k++) {
                const a = canonical[t * 3 + k], b = canonical[t * 3 + (k + 1) % 3];
                if (a === b) continue;
                const key = ekey(a, b);
                edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
            }
        }
        // Seam vertices: canonical endpoints of open (count-1) edges.
        const seamVerts = new Set();
        for (const [key, count] of edgeCount) {
            if (count !== 1) continue;
            seamVerts.add(Math.floor(key / 16777216));
            seamVerts.add(key % 16777216);
        }
        if (seamVerts.size === 0) return;
        const seamList = [...seamVerts].sort((a, b) => a - b);

        // For every triangle's open edges, find seam vertices ON the edge.
        const va = new THREE.Vector3(), vb = new THREE.Vector3();
        const vw = new THREE.Vector3(), ab = new THREE.Vector3(), aw = new THREE.Vector3();
        const outP = [], outU = [], outN = [];
        const pushVert = (x, y, z, u, v, nx, ny, nz) => {
            outP.push(x, y, z); outU.push(u, v); outN.push(nx, ny, nz);
        };
        const copyVert = (i) => pushVert(
            pos.getX(i), pos.getY(i), pos.getZ(i),
            uv.getX(i), uv.getY(i),
            nor.getX(i), nor.getY(i), nor.getZ(i));
        let inserted = 0;

        for (let t = 0; t < triCount; t++) {
            const corners = [t * 3, t * 3 + 1, t * 3 + 2];
            // Collect insertions per edge k: list of {t, canon}.
            const perEdge = [null, null, null];
            for (let k = 0; k < 3; k++) {
                const ia = corners[k], ib = corners[(k + 1) % 3];
                const ca = canonical[ia], cb = canonical[ib];
                if (ca === cb) continue;
                if (edgeCount.get(ekey(ca, cb)) !== 1) continue;   // interior edge
                va.fromBufferAttribute(pos, ia);
                vb.fromBufferAttribute(pos, ib);
                ab.subVectors(vb, va);
                const len2 = ab.lengthSq();
                if (len2 < quant * quant) continue;
                let hits = null;
                for (const w of seamList) {
                    if (w === ca || w === cb) continue;
                    vw.fromBufferAttribute(pos, w);
                    aw.subVectors(vw, va);
                    const tt = aw.dot(ab) / len2;
                    if (tt <= 1e-6 || tt >= 1 - 1e-6) continue;
                    // Perpendicular distance to the segment.
                    const px = va.x + ab.x * tt - vw.x;
                    const py = va.y + ab.y * tt - vw.y;
                    const pz = va.z + ab.z * tt - vw.z;
                    if (px * px + py * py + pz * pz > tol * tol) continue;
                    (hits = hits || []).push({ t: tt, c: w });
                }
                if (hits) {
                    hits.sort((x, y) => x.t - y.t || x.c - y.c);
                    perEdge[k] = hits;
                }
            }
            if (!perEdge[0] && !perEdge[1] && !perEdge[2]) {
                copyVert(corners[0]); copyVert(corners[1]); copyVert(corners[2]);
                continue;
            }
            // Build the triangle's boundary loop with insertions, then fan
            // from the first corner (ear-safe for the convex-ish slivers CSG
            // produces along seams; conformality is what matters here).
            const loop = [];   // [{p, u, n}]
            for (let k = 0; k < 3; k++) {
                const ia = corners[k], ib = corners[(k + 1) % 3];
                loop.push({
                    p: [pos.getX(ia), pos.getY(ia), pos.getZ(ia)],
                    u: [uv.getX(ia), uv.getY(ia)],
                    n: [nor.getX(ia), nor.getY(ia), nor.getZ(ia)],
                });
                for (const h of (perEdge[k] || [])) {
                    const w = h.c, tt = h.t;
                    inserted++;
                    // Position = the seam vertex's CANONICAL position (exact
                    // weld); uv/normal interpolated along THIS side's edge.
                    const nx = nor.getX(ia) * (1 - tt) + nor.getX(ib) * tt;
                    const ny = nor.getY(ia) * (1 - tt) + nor.getY(ib) * tt;
                    const nz = nor.getZ(ia) * (1 - tt) + nor.getZ(ib) * tt;
                    const nl = Math.hypot(nx, ny, nz) || 1;
                    loop.push({
                        p: [pos.getX(w), pos.getY(w), pos.getZ(w)],
                        u: [uv.getX(ia) * (1 - tt) + uv.getX(ib) * tt,
                            uv.getY(ia) * (1 - tt) + uv.getY(ib) * tt],
                        n: [nx / nl, ny / nl, nz / nl],
                    });
                }
            }
            for (let i = 1; i + 1 < loop.length; i++) {
                const A = loop[0], B = loop[i], C = loop[i + 1];
                pushVert(...A.p, ...A.u, ...A.n);
                pushVert(...B.p, ...B.u, ...B.n);
                pushVert(...C.p, ...C.u, ...C.n);
            }
        }

        if (inserted === 0) return;
        geometry.setAttribute("position",
            new THREE.BufferAttribute(new Float32Array(outP), 3));
        geometry.setAttribute("uv",
            new THREE.BufferAttribute(new Float32Array(outU), 2));
        geometry.setAttribute("normal",
            new THREE.BufferAttribute(new Float32Array(outN), 3));
    }
}

export function mergeObjects(viewer, opts = {}) {
    const ids = Array.isArray(opts.ids) ? opts.ids.map(Number) : [];
    if (ids.length < 2) {
        throw new Error("merge_objects needs ids: [a, b, ...] — at least two "
            + "objects (list_objects shows the roster).");
    }
    if (new Set(ids).size !== ids.length) {
        throw new Error("merge_objects ids must be distinct.");
    }
    const entries = ids.map((id) => {
        const e = (viewer._objects || []).find((o) => o.id === id);
        if (!e) throw new Error(`No object with id ${id}. Use list_objects.`);
        return e;
    });
    for (const e of entries) {
        if (e.skinned) {
            throw new Error(`Object ${e.id} (${e.name}) is skinned — fusing `
                + "would sever its skeleton. Merge rigid objects only.");
        }
    }
    const mode = opts.mode || "union";
    if (!["union", "concat"].includes(mode)) {
        throw new Error("merge_objects mode must be 'union' or 'concat'.");
    }
    const blend = opts.blend !== undefined ? Number(opts.blend) : 0;
    if (!(blend >= 0)) throw new Error("blend must be ≥ 0 (world units).");

    // Bake each source to world space + its own UV atlas cell.
    const baked = [];
    for (let k = 0; k < entries.length; k++) {
        const g = bakedSourceGeometry(entries[k]);
        if (!g) throw new Error(`Object ${entries[k].id} has no mesh geometry.`);
        atlasIntoCell(g, k, entries.length);
        baked.push(g);
    }
    const totalTris = baked.reduce(
        (a, g) => a + Math.floor(g.getAttribute("position").count / 3), 0);
    if (totalTris > MAX_MERGED_TRIANGLES) {
        baked.forEach((g) => g.dispose());
        throw new Error(`Merge too large: ${totalTris.toLocaleString()} source `
            + `triangles (max ${MAX_MERGED_TRIANGLES.toLocaleString()}). `
            + "simplify_region the sources first.");
    }

    let outGeometry;
    let note = "";
    if (mode === "union") {
        // CSG needs closed inputs: verify BEFORE evaluating (open rims make
        // inside/outside classification garbage, silently). Trace leftovers
        // are tolerated — a previously fused object can carry a couple of
        // stitch residuals that cannot corrupt classification.
        for (let k = 0; k < baked.length; k++) {
            const issues = meshIssueCounts(baked[k]);
            const tris = Math.floor(baked[k].getAttribute("position").count / 3);
            const allowance = Math.max(8, Math.floor(tris * 0.002));
            if (issues.openEdges > allowance) {
                const id = entries[k].id;
                baked.forEach((g) => g.dispose());
                throw new Error(`Object ${id} has ${issues.openEdges} open `
                    + "edges — CSG union needs CLOSED surfaces (open shells "
                    + "classify as garbage). fix_mesh first, or use "
                    + "mode:'concat' (+ sculpt smooth over the joints).");
            }
            if (issues.openEdges > 0) {
                note += `Source ${entries[k].id} had ${issues.openEdges} open `
                    + "edge(s) (within tolerance). ";
            }
        }
        const evaluator = new Evaluator();
        evaluator.attributes = ["position", "normal", "uv"];
        evaluator.useGroups = false;
        let acc = new Brush(baked[0]);
        acc.updateMatrixWorld();
        for (let k = 1; k < baked.length; k++) {
            const b = new Brush(baked[k]);
            b.updateMatrixWorld();
            acc = evaluator.evaluate(acc, b, ADDITION);
        }
        outGeometry = acc.geometry;
        outGeometry = outGeometry.toNonIndexed ? outGeometry.toNonIndexed()
                                               : outGeometry;
        // Stitch the intersection curve BY POSITION: the two brushes clip
        // their seam vertices independently with float differences beyond the
        // engine's weld quantum, so the raw union reports ~1k open edges,
        // and a fused object could never be union-merged again (the
        // closed-source check would refuse it). three's mergeVertices hashes
        // ALL attributes (per-source UV cells purposely differ at the seam),
        // so snap POSITIONS ONLY: every vertex in a quantization cell takes
        // the cell's first-seen representative position — per-corner UVs and
        // normals stay untouched, and the engine's position-keyed weld map
        // then sees one canonical vertex per seam point.
        {
            const pos = outGeometry.getAttribute("position");
            const box = new THREE.Box3().setFromBufferAttribute(pos);
            const diag = box.getSize(new THREE.Vector3()).length() || 1;
            const quant = diag * 5e-6;   // 5× the issue-counter quantum: seam
                                         // splits land within it, real detail
                                         // (≥ target edges) never does.
            const rep = new Map();
            for (let i = 0; i < pos.count; i++) {
                const k = `${Math.round(pos.getX(i) / quant)}_`
                    + `${Math.round(pos.getY(i) / quant)}_`
                    + `${Math.round(pos.getZ(i) / quant)}`;
                const r = rep.get(k);
                if (r === undefined) {
                    rep.set(k, [pos.getX(i), pos.getY(i), pos.getZ(i)]);
                } else {
                    pos.setXYZ(i, r[0], r[1], r[2]);
                }
            }
            pos.needsUpdate = true;
        }
        // Then resolve the mutual T-junctions (each side subdivides the seam
        // at ITS OWN crossings) so the union measures closed.
        stitchTJunctions(outGeometry);
    } else {
        outGeometry = mergeGeometries(baked, false);
        note += "concat mode: interior walls between overlapping sources "
            + "remain (union removes them). ";
    }
    // Weld coincident vertices ACROSS sources so brushes never tear seams —
    // then back to non-indexed soup (the sculpt engine's canonical form),
    // which keeps the weld effect (coincident positions weld by position).
    baked.forEach((g) => { if (g !== outGeometry) g.dispose(); });

    // Seam fillets.
    let seamReport = { seamVerts: 0, blended: 0 };
    if (mode === "union" && blend > 0) {
        // Re-bake fresh source geometries for the seam distance test (the
        // originals were consumed/disposed above).
        const ref = entries.map((e) => bakedSourceGeometry(e));
        const box = new THREE.Box3().setFromBufferAttribute(
            outGeometry.getAttribute("position"));
        const diag = box.getSize(new THREE.Vector3()).length();
        seamReport = blendSeams(outGeometry, ref, blend, diag);
        ref.forEach((g) => g && g.dispose());
    }

    // Build the fused object; remove the sources.
    const material = new THREE.MeshStandardMaterial({
        color: "#9aa4b0", roughness: 0.7, metalness: 0.0,
        side: THREE.DoubleSide,
    });
    material.userData._mvKeepColor = true;
    const mesh = new THREE.Mesh(outGeometry, material);
    mesh.name = opts.name || "fused";
    const group = new THREE.Group();
    group.name = "merged_object";
    group.add(mesh);

    const hadPaint = entries.some((e) => {
        let painted = false;
        e.model.traverse((c) => {
            const stash = c._mvOriginalMaterial || c.material;
            const m = Array.isArray(stash) ? stash && stash[0] : stash;
            if (c.isMesh && m && m.userData && m.userData._mvPaint) painted = true;
        });
        return painted;
    });
    if (hadPaint) {
        note += "Source paint layers were DROPPED (fusion re-atlasses UVs) — "
            + "texture the fused surface fresh. ";
    }

    const sourceNames = entries.map((e) => `${e.id}:${e.name}`);
    for (const e of entries) viewer.removeObject(e.id);
    const entry = viewer._insertEntry(group, "", ".merged", {
        name: opts.name || `fused(${entries.map((e) => e.name).join("+")})`.slice(0, 64),
        source: { kind: "volatile" },
    });
    viewer.setActiveObject(entry.id);
    viewer.frameAll();

    const stats = entry.stats || {};
    return {
        objectId: entry.id,
        name: entry.name,
        mode,
        sources: sourceNames,
        triangles: stats.faces,
        vertices: stats.vertices,
        ...(mode === "union" && blend > 0 ? { seams: seamReport } : {}),
        note: (note + "Fused object is ONE welded surface — sculpt/dig/refine "
            + "work across the old part boundaries. Placement is baked "
            + "(identity transform); manifests cannot rebuild a merge — "
            + "export_glb to persist. Do NOT run fix_mesh {degenerate} on a "
            + "fused mesh: CSG seams carry legitimate sliver triangles, and "
            + "dropping them OPENS the seam (field: 2006 dropped, 51→570 open "
            + "edges).").trim(),
    };
}
