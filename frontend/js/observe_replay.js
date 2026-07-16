/**
 * Recording-replay acceleration for the observation seat.
 *
 * Two complementary caches make scrubbing fast (the "much too slow" verdict
 * was measured as: every checkpoint-routed seek re-fetched ~MBs of blobs and
 * re-ran the whole GLB restore pipeline, and REPEAT scrubs paid it all
 * again):
 *
 * - CheckpointCache: manifest JSON + blob object-URLs, fetched once per
 *   session and reused by every subsequent restore. Invalidated on leave.
 *
 * - SnapshotStore: client-side state snapshots — full geometry buffers
 *   (every attribute + index), paint-canvas copies, placements — taken at
 *   positions the replay has already visited. Restoring one is a local
 *   memory write — no fetch, no GLB parse, no command re-execution.
 *
 * Snapshot honesty model (verify, don't trust — the same stance as the
 * checkpoint fingerprint): a snapshot restores only when it can PROVE the
 * write reproduces state(P) exactly:
 *
 * 1. BLOCKING SCAN: commands whose effects are INVISIBLE to structural
 *    verification (timeline keys, morph weights, display/lighting, scale/
 *    texture reallocation, …) bound snapshot reuse. A snapshot at P is a
 *    candidate from playhead Q only when no blocking command sits between
 *    them — everything that DID run between is either fully captured
 *    (geometry, texels, placements) or verified structurally below.
 *    Unknown commands are blocking by default (whitelist stance).
 * 2. STRUCTURE: the object roster must match (extra live objects that the
 *    snapshot's position predates are removed through the public command
 *    API; missing objects refuse — a snapshot cannot conjure scene graph),
 *    parent edges must match, per-entry mesh/geometry lists must align.
 *    Geometry is restored WHOLE (attributes + index), so topology changes
 *    between P and Q are handled, not refused.
 * 3. WRITE VERIFICATION: a FNV-1a positions hash stored at capture must
 *    reproduce after the write, or the restore reports failure and the
 *    caller falls back to checkpoint/re-execution. The e2e suite
 *    additionally proves snapshot-restored state hashes identical to
 *    re-executed state at the same position.
 *
 * Deliberately structural (ids/counts/order), NOT JS-object references:
 * checkpoint restores and from-zero rebuilds replace every geometry object,
 * and alternating scrubs across those rebuilds are exactly the pattern that
 * must stay fast.
 */

// Engine layer creation (budget accounting, shared-material cloning, base
// seeding): snapshot restores recreate missing paint layers through these
// exact paths — a checkpoint restore bakes paint into plain textures, so
// scrubbing back re-materializes the canvas layers.
import { ensurePaintLayer, ensureChannelLayer,
         paintBudgetInfo } from "./viewer/sculpt.js";

// Commands fully captured by a snapshot restore (geometry buffers, paint
// texels, placements, visibility/opacity/active-object) or verifiable by
// its structural checks (roster, parents, counts). Everything NOT listed
// here is BLOCKING: its effect lives in state a snapshot neither writes nor
// verifies (timeline, morphs, display, lighting, tracked scale, …).
const SNAPSHOT_SAFE = new Set([
    // pure covered writes
    "sculpt", "sculpt_stroke", "sculpt_sweep", "deform_region",
    "paint", "paint_stroke", "fill_paint", "paint_pattern",
    "blur_paint", "clone_paint", "mirror_paint", "project_paint",
    "bake_ao", "bake_normals",
    "set_object_transform", "place_object", "set_pivot",
    "set_object_visible", "set_object_opacity", "set_active_object",
    // structure-verified (roster / parents / counts catch every effect)
    "refine_region", "simplify_region", "regularize_region",
    "add_primitive", "add_model", "remove_object",
    "split_object", "merge_objects", "set_parent", "fix_mesh",
]);

const MAX_SNAPSHOTS = 8;
const MAX_SNAPSHOT_BYTES = 192 * 1024 * 1024;   // hard memory bound

function commandBlocking(cmd) {
    if (!cmd || !cmd.action) return true;
    if (cmd.action === "batch") {
        const subs = (cmd.params || {}).commands || [];
        return subs.some((s) => !s || !SNAPSHOT_SAFE.has(s.action));
    }
    return !SNAPSHOT_SAFE.has(cmd.action);
}

/**
 * Prefix counts of BLOCKING commands: blockedBefore[i] = how many blocking
 * commands sit in log[0..i). A snapshot at P is reusable from playhead Q
 * iff the count is identical at both — nothing invisible ran between.
 * Length is log.length + 1.
 */
export function computeBlockingPrefix(log) {
    const pre = new Array(log.length + 1);
    let n = 0;
    pre[0] = 0;
    for (let i = 0; i < log.length; i++) {
        const e = log[i];
        if (e.kind === "command" && commandBlocking(e.command)) n++;
        pre[i + 1] = n;
    }
    return pre;
}

/** FNV-1a 32-bit over every geometry position of every object (id order,
 *  traversal order). The cheap state fingerprint used to verify snapshot
 *  restores and to prove replay-path equivalence in e2e. Plain Float32
 *  storage hashes through a bulk u32 view (the accessor loop measured as a
 *  real per-capture cost on 300k-vertex meshes); other storages decode per
 *  component into IDENTICAL float bits, so both paths agree. */
export function hashScenePositions(viewer) {
    let h = 0x811c9dc5;
    const mixWord = (v) => {
        h ^= v & 0xff; h = Math.imul(h, 0x01000193);
        h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
        h ^= (v >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
        h ^= (v >>> 24) & 0xff; h = Math.imul(h, 0x01000193);
    };
    const f32 = new Float32Array(1);
    const u32 = new Uint32Array(f32.buffer);
    const objs = (viewer._objects || []).slice().sort((a, b) => a.id - b.id);
    for (const e of objs) {
        mixWord(e.id >>> 0);
        for (const g of collectGeometries(e.model)) {
            const pos = g.getAttribute("position");
            if (!pos) continue;
            mixWord(pos.count >>> 0);
            if (!pos.isInterleavedBufferAttribute && pos.itemSize === 3
                && pos.array instanceof Float32Array) {
                const words = new Uint32Array(
                    pos.array.buffer, pos.array.byteOffset, pos.count * 3);
                for (let i = 0; i < words.length; i++) mixWord(words[i]);
            } else {
                for (let i = 0; i < pos.count; i++) {
                    f32[0] = pos.getX(i); mixWord(u32[0]);
                    f32[0] = pos.getY(i); mixWord(u32[0]);
                    f32[0] = pos.getZ(i); mixWord(u32[0]);
                }
            }
        }
    }
    return (h >>> 0).toString(16);
}

/** Meshes of a model in traversal order — the index is the snapshot's
 *  mesh identity across scene rebuilds (deterministic for a fixed model
 *  structure, which the geometry checks verify separately). */
function collectMeshes(model) {
    const out = [];
    model.traverse((c) => { if (c.isMesh) out.push(c); });
    return out;
}

/** Paint layers of one mesh as {kind, layer} — albedo + channel layers.
 *  Kind names are the recreate keys (see recreateLayer). */
function meshLayers(mesh) {
    const stash = mesh._mvOriginalMaterial || mesh.material;
    const material = Array.isArray(stash) ? stash[0] : stash;
    const out = [];
    if (!material || !material.userData) return out;
    if (material.userData._mvPaint) {
        out.push({ kind: "albedo", layer: material.userData._mvPaint });
    }
    const chans = material.userData._mvChannels;
    if (chans) {
        for (const key of Object.keys(chans).sort()) {
            if (chans[key] && chans[key].canvas) {
                out.push({ kind: key, layer: chans[key] });
            }
        }
    }
    return out;
}

/** All paint canvases of a model with mesh identity (traversal index). */
function collectCanvases(model) {
    const out = [];
    const meshes = collectMeshes(model);
    for (let mi = 0; mi < meshes.length; mi++) {
        for (const { kind, layer } of meshLayers(meshes[mi])) {
            out.push({ meshIdx: mi, kind, layer });
        }
    }
    return out;
}

/** Unique geometries of a model in traversal order (multi-mesh geometry
 *  sharing dedups — capture and restore see the same list). */
function collectGeometries(model) {
    const out = [];
    const seen = new Set();
    model.traverse((c) => {
        if (!c.isMesh || !c.geometry || seen.has(c.geometry)) return;
        seen.add(c.geometry);
        out.push(c.geometry);
    });
    return out;
}

/**
 * Full geometry capture: every attribute + index + groups.
 *
 * Non-interleaved attributes copy EXACT typed arrays (constructor +
 * normalized flag preserved — skinIndex Uint16, normalized quantized
 * normals, … must round-trip byte-identically). Interleaved attributes
 * decode through the accessor into plain Float32 (the standard de-interleave;
 * integer interleaved attributes do not occur in this engine's assets —
 * refuse rather than corrupt if one ever shows up).
 */
function captureGeometry(g) {
    const rec = { attributes: {}, index: null, groups: null,
                  drawRange: null, bytes: 0, unsupported: false };
    for (const name of Object.keys(g.attributes)) {
        const attr = g.attributes[name];
        let a;
        if (!attr.isInterleavedBufferAttribute) {
            a = { itemSize: attr.itemSize, count: attr.count,
                  normalized: !!attr.normalized,
                  array: new attr.array.constructor(attr.array) };
        } else if (attr.array instanceof Float32Array
                   || attr.data && attr.data.array instanceof Float32Array) {
            const n = attr.count, k = attr.itemSize;
            const out = new Float32Array(n * k);
            for (let i = 0; i < n; i++) {
                out[i * k] = attr.getX(i);
                if (k > 1) out[i * k + 1] = attr.getY(i);
                if (k > 2) out[i * k + 2] = attr.getZ(i);
                if (k > 3) out[i * k + 3] = attr.getW(i);
            }
            a = { itemSize: k, count: n, normalized: false, array: out };
        } else {
            rec.unsupported = true;   // integer interleaved — refuse later
            continue;
        }
        rec.attributes[name] = a;
        rec.bytes += a.array.byteLength;
    }
    if (g.index) {
        rec.index = { array: new g.index.array.constructor(g.index.array) };
        rec.bytes += rec.index.array.byteLength;
    }
    if (g.groups && g.groups.length) {
        rec.groups = g.groups.map((gr) => ({ ...gr }));
    }
    if (g.drawRange && (g.drawRange.start !== 0
                        || g.drawRange.count !== Infinity)) {
        rec.drawRange = { ...g.drawRange };
    }
    // Morph-target geometry cannot be restored across a vertex-count change
    // (targets are not captured) — flag it; restore refuses that combination.
    rec.hasMorphs = !!(g.morphAttributes
                       && Object.keys(g.morphAttributes).length);
    rec.vertexCount = g.getAttribute("position")
        ? g.getAttribute("position").count : 0;
    return rec;
}

/** Write a captured geometry back. Same-layout attributes update arrays in
 *  place (cheapest GPU path); anything else rebuilds the attribute.
 *
 *  Cache retention is EXACT, not heuristic: the weld map (`_mvSculpt`)
 *  survives only when the restored INDEX is byte-identical to the live one
 *  (same topology era ⇒ weld classes are invariant along the deterministic
 *  replay lineage — sculpt moves welded copies together). Anything else
 *  drops it — a stale weld map silently corrupts later replayed strokes.
 *  Blanket dropping was measured as ~1 s weld rebuilds per post-restore
 *  sculpt on a 300k-tri mesh (it tripled repeat-scrub times). The BVH is
 *  geometryRev-keyed and needs no forced drop on the identical-index path.
 */
function restoreGeometry(THREE_NS, g, rec) {
    if (rec.unsupported) return false;
    const pos = g.getAttribute("position");
    const sameCount = pos && pos.count === rec.vertexCount;
    if (!sameCount) {
        if (rec.hasMorphs || (g.morphAttributes
                              && Object.keys(g.morphAttributes).length)) {
            return false;   // cannot reconcile morph targets across counts
        }
        g.dispose();   // free GL buffers of the topology being replaced
    }
    for (const name of Object.keys(g.attributes)) {
        if (!(name in rec.attributes)) g.deleteAttribute(name);
    }
    for (const name of Object.keys(rec.attributes)) {
        const a = rec.attributes[name];
        const live = g.getAttribute(name);
        if (live && !live.isInterleavedBufferAttribute
            && live.itemSize === a.itemSize
            && live.array.length === a.array.length
            && live.array.constructor === a.array.constructor
            && !!live.normalized === a.normalized) {
            live.array.set(a.array);
            live.needsUpdate = true;
        } else {
            const attr = new THREE_NS.BufferAttribute(
                a.array.slice(), a.itemSize, a.normalized);
            g.setAttribute(name, attr);
        }
    }
    let indexIdentical = false;
    if (rec.index) {
        const liveIdx = g.index;
        if (liveIdx && liveIdx.array.length === rec.index.array.length
            && liveIdx.array.constructor === rec.index.array.constructor) {
            // Early-out elementwise compare (~ms on identical arrays): the
            // proof that topology caches may survive this restore.
            const a = liveIdx.array, b = rec.index.array;
            indexIdentical = true;
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) { indexIdentical = false; break; }
            }
            if (!indexIdentical) {
                a.set(b);
                liveIdx.needsUpdate = true;
            }
        } else {
            g.setIndex(new THREE_NS.BufferAttribute(rec.index.array.slice(), 1));
        }
    } else if (g.index) {
        g.setIndex(null);
    } else {
        indexIdentical = true;   // both non-indexed: same triangle soup order
    }
    g.clearGroups();
    if (rec.groups) {
        for (const gr of rec.groups) {
            g.addGroup(gr.start, gr.count, gr.materialIndex || 0);
        }
    }
    if (rec.drawRange) g.setDrawRange(rec.drawRange.start, rec.drawRange.count);
    else g.setDrawRange(0, Infinity);
    if (g.userData) {
        delete g.userData._mvNormalsDirty;   // normals restored exactly above
        delete g.userData._mvUvIslands;      // rare consumer, cheap rebuild
        if (!(sameCount && indexIdentical)) {
            delete g.userData._mvSculpt;
            delete g.userData._mvBVHRev;
        }
    }
    if (!(sameCount && indexIdentical) && g.boundsTree) g.boundsTree = null;
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return true;
}

/**
 * Bounded store of client-side state snapshots for one recording session.
 * Owned by the seat; cleared on leave.
 */
export class SnapshotStore {
    /** @param THREE_NS the three namespace (BufferAttribute constructor). */
    constructor(THREE_NS) {
        this._THREE = THREE_NS;
        this._snaps = [];        // ascending by pos
        this._bytes = 0;
        this.captureMsEma = 0;   // planner cost estimates (self-calibrating)
        this.restoreMsEma = 60;
    }

    clear() {
        this._snaps = [];
        this._bytes = 0;
    }

    positions() { return this._snaps.map((s) => s.pos); }

    has(pos) { return this._snaps.some((s) => s.pos === pos); }

    /** Best candidate at or before `pos` with no BLOCKING command between
     *  the snapshot and the playhead (blockedBefore prefix from
     *  computeBlockingPrefix; restore() re-verifies structure on top). */
    bestAtOrBefore(pos, playhead, blockedBefore) {
        let best = null;
        for (const s of this._snaps) {
            if (s.pos > pos) continue;
            const lo = Math.min(s.pos, playhead);
            const hi = Math.max(s.pos, playhead);
            if (blockedBefore[hi] !== blockedBefore[lo]) continue;
            if (!best || s.pos > best.pos) best = s;
        }
        return best;
    }

    /**
     * Capture the full restorable state at log position `pos`: geometry
     * buffers (all attributes + index), paint canvases, placements,
     * identity counters. Tens of ms — callers keep it off hot paths.
     */
    capture(viewer, pos) {
        if (this.has(pos)) return null;
        const t0 = performance.now();
        const objs = (viewer._objects || []).slice().sort((a, b) => a.id - b.id);
        const snap = {
            pos, bytes: 0,
            roster: objs.map((e) => e.id),
            nextObjectId: viewer._nextObjectId,
            activeObjectId: viewer._activeObjectId,
            entries: [], hash: null,
        };
        for (const e of objs) {
            const ent = {
                id: e.id,
                geoms: [], canvases: [],
                p: e.logical.p.toArray(), q: e.logical.q.toArray(),
                s: e.logical.s.toArray(), pivot: e.pivot.toArray(),
                visible: e.visible, opacity: e.opacity,
                parentId: e.parentId != null ? e.parentId : null,
                geometryRev: e.geometryRev || 0,
                modelScale: e.modelScale || 1,
            };
            for (const g of collectGeometries(e.model)) {
                // Bulk replay defers normal recomputes — settle BEFORE
                // copying, or the snapshot would freeze stale normals that
                // a checkpoint/re-execution path would have recomputed.
                if (g.userData && g.userData._mvNormalsDirty) {
                    g.computeVertexNormals();
                    delete g.userData._mvNormalsDirty;
                }
                const rec = captureGeometry(g);
                ent.geoms.push(rec);
                snap.bytes += rec.bytes;
            }
            for (const { meshIdx, kind, layer } of collectCanvases(e.model)) {
                const src = layer.canvas;
                const copy = document.createElement("canvas");
                copy.width = src.width;
                copy.height = src.height;
                copy.getContext("2d").drawImage(src, 0, 0);
                ent.canvases.push({ meshIdx, kind, copy,
                                    w: src.width, h: src.height,
                                    flipY: layer.flipY });
                snap.bytes += src.width * src.height * 4;
            }
            snap.entries.push(ent);
        }
        snap.hash = hashScenePositions(viewer);
        this._insert(snap);
        const ms = performance.now() - t0;
        this.captureMsEma = this.captureMsEma
            ? 0.5 * this.captureMsEma + 0.5 * ms : ms;
        return snap;
    }

    _insert(snap) {
        this._snaps.push(snap);
        this._snaps.sort((a, b) => a.pos - b.pos);
        this._bytes += snap.bytes;
        // Even-coverage eviction (the hub's thinning rule): drop the interior
        // snapshot with the smallest predecessor gap; endpoints survive
        // longest (position ~0 and the newest/highest are the anchors).
        while (this._snaps.length > MAX_SNAPSHOTS
               || this._bytes > MAX_SNAPSHOT_BYTES) {
            if (this._snaps.length <= 1) break;
            let victim = -1, minGap = Infinity;
            for (let i = 1; i < this._snaps.length - 1; i++) {
                const gap = this._snaps[i].pos - this._snaps[i - 1].pos;
                if (gap < minGap) { minGap = gap; victim = i; }
            }
            if (victim < 0) victim = 0;   // 2 snaps over byte budget: drop older
            const [dropped] = this._snaps.splice(victim, 1);
            this._bytes -= dropped.bytes;
        }
    }

    drop(snap) {
        const i = this._snaps.indexOf(snap);
        if (i >= 0) {
            this._snaps.splice(i, 1);
            this._bytes -= snap.bytes;
        }
    }

    /** Recreate a paint layer through the engine's own creation paths so
     *  budget accounting and material handling stay exact. The bake_normals
     *  "normal" canvas has no ensure* path — refuse it (fallback routes
     *  reconstruct that era exactly). */
    _recreateLayer(viewer, mesh, rec) {
        try {
            if (rec.kind === "albedo") {
                return ensurePaintLayer(viewer, mesh, rec.w);
            }
            if (!["rm", "emissive", "height"].includes(rec.kind)) return null;
            const stash = mesh._mvOriginalMaterial || mesh.material;
            const material = Array.isArray(stash) ? stash[0] : stash;
            const albedo = material && material.userData
                && material.userData._mvPaint;
            if (!albedo) return null;   // verified earlier — belt and braces
            return ensureChannelLayer(viewer, mesh, rec.kind, albedo);
        } catch {
            return null;   // e.g. texel budget exceeded — fall back honestly
        }
    }

    /**
     * Restore a snapshot onto the live scene. All structural verification
     * runs BEFORE any write; extra live objects (the snapshot's position
     * predates their creation) are removed through the public command API;
     * the post-write positions hash must reproduce the captured one.
     * Returns true on success. Failure leaves the caller to fall back
     * (checkpoint / re-execution) — and drops the snapshot only when its
     * own content proved bad (hash mismatch), not when the scene merely
     * isn't compatible right now.
     */
    async restore(viewer, api, snap) {
        const t0 = performance.now();
        this.lastRefusal = null;   // field diagnostics: why a restore refused
        // "verify" refusals leave the scene UNTOUCHED (callers may try any
        // fallback); "write" refusals mean the scene must be REBUILT before
        // trusting it (only the post-write hash check can land here).
        this.lastRefusalPhase = null;
        let phase = "verify";
        const refuse = (why) => {
            this.lastRefusal = why;
            this.lastRefusalPhase = phase;
            return false;
        };
        const liveById = new Map((viewer._objects || []).map((e) => [e.id, e]));
        let missingTexels = 0;
        // ---- verification pass (no writes) -----------------------------
        for (const id of snap.roster) {
            if (!liveById.has(id)) return refuse(`object ${id} missing`);
        }
        const snapIds = new Set(snap.roster);
        const extras = (viewer._objects || []).filter((e) => !snapIds.has(e.id));
        for (let i = 0; i < snap.roster.length; i++) {
            const e = liveById.get(snap.roster[i]);
            const ent = snap.entries[i];
            // Parent edges must already match once extras are gone — a
            // common object parented to an extra cannot be re-rooted
            // faithfully (the snapshot never saw that edge).
            const liveParent = e.parentId != null ? e.parentId : null;
            if (liveParent !== ent.parentId
                && !(liveParent != null && !snapIds.has(liveParent)
                     && ent.parentId === null)) {
                return refuse(`parent mismatch on ${e.id}`);
            }
            if ((e.modelScale || 1) !== ent.modelScale) {
                return refuse(`modelScale mismatch on ${e.id}`);
            }
            const geoms = collectGeometries(e.model);
            if (geoms.length !== ent.geoms.length) {
                return refuse(`geometry count ${geoms.length} vs ${ent.geoms.length} on ${e.id}`);
            }
            for (let k = 0; k < geoms.length; k++) {
                const rec = ent.geoms[k];
                const live = geoms[k];
                const count = live.getAttribute("position")
                    ? live.getAttribute("position").count : 0;
                if (count !== rec.vertexCount
                    && (rec.hasMorphs
                        || (live.morphAttributes
                            && Object.keys(live.morphAttributes).length))) {
                    // count change × morph targets: cannot reconcile
                    return refuse(`morphed geometry count change on ${e.id}`);
                }
            }
            for (const rec of ent.geoms) {
                if (rec.unsupported) {
                    return refuse(`unsupported attribute storage on ${e.id}`);
                }
            }
            // Canvas layers: live layers must be a SUBSET of the snapshot's
            // (missing ones are recreated through the engine paths below —
            // the post-checkpoint-restore norm, where paint came back baked
            // into plain textures). A live layer the snapshot lacks cannot
            // be un-created faithfully here — refuse to the fallback routes.
            const live = collectCanvases(e.model);
            const meshes = collectMeshes(e.model);
            const slot = (c) => `${c.meshIdx}:${c.kind}`;
            const liveSlots = new Set(live.map(slot));
            const wanted = new Map(ent.canvases.map((c) => [slot(c), c]));
            for (const l of live) {
                const w = wanted.get(slot(l));
                if (!w) return refuse(`extra live layer ${slot(l)} on ${e.id}`);
                if (l.layer.canvas.width !== w.w
                    || l.layer.canvas.height !== w.h) {
                    return refuse(`layer size mismatch ${slot(l)} on ${e.id}`);
                }
            }
            for (const c of ent.canvases) {
                if (!meshes[c.meshIdx]) {
                    return refuse(`mesh ${c.meshIdx} missing on ${e.id}`);
                }
                if (c.kind !== "albedo" && !wanted.has(`${c.meshIdx}:albedo`)) {
                    return refuse(`channel ${slot(c)} without albedo on ${e.id}`);
                }
                if (liveSlots.has(slot(c))) continue;
                // Will be RECREATED below: kind must have an engine path and
                // the texel budget must have headroom (pre-verified so the
                // write pass cannot fail mid-flight).
                if (!["albedo", "rm", "emissive", "height"].includes(c.kind)) {
                    return refuse(`no recreate path for ${slot(c)} on ${e.id}`);
                }
                missingTexels += c.w * c.h;
            }
        }
        if (missingTexels > 0) {
            const budget = paintBudgetInfo();
            if (budget.texelsUsed + missingTexels > budget.texelsBudget) {
                return refuse("texel budget too tight to recreate layers");
            }
        }
        // ---- write pass (scene mutates from here) ------------------------
        phase = "write";
        for (const e of extras) {
            const r = await api.execute({ action: "remove_object",
                                          params: { id: e.id } });
            if (!r.ok) return refuse(`remove_object ${e.id}: ${r.error}`);
        }
        if ((viewer._objects || []).length !== snap.roster.length) {
            return refuse("roster still mismatched after extras removal");
        }
        const objs = (viewer._objects || []).slice().sort((a, b) => a.id - b.id);
        for (let i = 0; i < objs.length; i++) {
            const e = objs[i], ent = snap.entries[i];
            if (e.id !== ent.id) return refuse(`roster order (${e.id} vs ${ent.id})`);
            const geoms = collectGeometries(e.model);
            for (let k = 0; k < geoms.length; k++) {
                if (!restoreGeometry(this._THREE, geoms[k], ent.geoms[k])) {
                    return refuse(`geometry write refused on ${e.id}[${k}]`);
                }
            }
            const meshes = collectMeshes(e.model);
            for (const c of ent.canvases) {
                const mesh = meshes[c.meshIdx];
                let layer = meshLayers(mesh).find((l) => l.kind === c.kind);
                if (!layer) {
                    // Recreate through the ENGINE paths (texel budget,
                    // shared-material cloning, base seeding) — then force
                    // the captured orientation before writing texels.
                    layer = { kind: c.kind,
                              layer: this._recreateLayer(viewer, mesh, c) };
                    if (!layer.layer) return refuse(`layer recreate failed `
                        + `${c.meshIdx}:${c.kind} on ${e.id}`);
                }
                const L = layer.layer;
                if (L.flipY !== c.flipY) {
                    L.flipY = c.flipY;
                    if (L.texture) L.texture.flipY = c.flipY;
                }
                const ctx = L.ctx || L.canvas.getContext("2d");
                const prev = ctx.globalCompositeOperation;
                ctx.globalCompositeOperation = "copy";   // replaces alpha too
                ctx.drawImage(c.copy, 0, 0);
                ctx.globalCompositeOperation = prev;
                if (L.texture) L.texture.needsUpdate = true;
            }
            e.logical.p.set(ent.p[0], ent.p[1], ent.p[2]);
            e.logical.q.set(ent.q[0], ent.q[1], ent.q[2], ent.q[3]);
            e.logical.s.set(ent.s[0], ent.s[1], ent.s[2]);
            e.pivot.set(ent.pivot[0], ent.pivot[1], ent.pivot[2]);
            viewer._composeWrapper(e);
            e.visible = ent.visible;
            e.wrapper.visible = ent.visible;
            if (e.opacity !== ent.opacity) {
                e.opacity = ent.opacity;
                if (viewer._applyEntryOpacity) viewer._applyEntryOpacity(e);
            }
            e.geometryRev = ent.geometryRev;
            e._statsDirty = true;
            e.modified = true;
        }
        viewer._nextObjectId = snap.nextObjectId;
        viewer._activeObjectId = snap.activeObjectId;
        viewer.invalidate();
        // ---- verify the write (hash must reproduce the capture) ---------
        if (hashScenePositions(viewer) !== snap.hash) {
            this.drop(snap);   // its own content failed — never trust again
            return refuse("post-write hash mismatch (snapshot dropped)");
        }
        const ms = performance.now() - t0;
        this.restoreMsEma = 0.5 * this.restoreMsEma + 0.5 * ms;
        return true;
    }
}

/**
 * Per-session cache of checkpoint manifests + blob object-URLs. The URLs
 * stay alive for the whole seat session (restores reuse them freely);
 * clear() revokes everything on leave.
 */
export class CheckpointCache {
    constructor() {
        this._entries = new Map();   // seq → {manifest, urls} | Promise
        this._gen = 0;               // clear() fences in-flight fetches
        this.fetches = 0;            // diagnostics (e2e asserts reuse)
        this.hits = 0;
    }

    clear() {
        this._gen++;                 // orphan in-flight fetches (see get())
        for (const v of this._entries.values()) {
            if (v && v.urls) {
                for (const id of Object.keys(v.urls)) URL.revokeObjectURL(v.urls[id]);
            }
        }
        this._entries.clear();
    }

    invalidate(seq) {
        const v = this._entries.get(seq);
        if (v && v.urls) {
            for (const id of Object.keys(v.urls)) URL.revokeObjectURL(v.urls[id]);
        }
        this._entries.delete(seq);
    }

    /**
     * Manifest + blob URLs for checkpoint `seq` of `session`. Concurrent
     * callers share one in-flight fetch (warm() + a seek racing is the
     * normal case, not an error).
     */
    async get(session, seq) {
        const cached = this._entries.get(seq);
        if (cached) {
            if (typeof cached.then === "function") return cached;
            this.hits++;
            return cached;
        }
        const gen = this._gen;
        const p = (async () => {
            this.fetches++;
            const base = `/api/observe/checkpoint?session=${encodeURIComponent(session)}`;
            const mr = await fetch(`${base}&seq=${seq}`);
            if (!mr.ok) throw new Error(`manifest HTTP ${mr.status}`);
            const manifest = await mr.json();
            const objs = (manifest.objects || []).slice().sort((a, b) => a.id - b.id);
            const urls = {};
            await Promise.all(objs.filter((o) => !o.empty).map(async (o) => {
                const br = await fetch(`${base}&seq=${seq}&object=${o.id}`);
                if (!br.ok) throw new Error(`blob ${o.id} HTTP ${br.status}`);
                urls[o.id] = URL.createObjectURL(await br.blob());
            }));
            const entry = { manifest, urls };
            if (gen !== this._gen) {
                // clear() ran while fetching (leave/re-join): revoke rather
                // than leak URLs that no cache entry owns anymore.
                for (const id of Object.keys(urls)) URL.revokeObjectURL(urls[id]);
                throw new Error("checkpoint cache cleared during fetch");
            }
            this._entries.set(seq, entry);
            return entry;
        })();
        this._entries.set(seq, p);
        p.catch(() => { if (gen === this._gen) this._entries.delete(seq); });
        return p;
    }

    /** Fire-and-forget prefetch (e.g. the final checkpoint while a recording
     *  log buffers). Failures surface later through the normal get() path. */
    warm(session, seq) {
        this.get(session, seq).catch(() => {});
    }
}

/**
 * One-line human description of a replayed command — the replay-bar ticker
 * ("paint #a33226 r=0.12", "sculpt_sweep crease", …). Generic by design:
 * salient params are picked by KEY, not by per-action special cases.
 */
export function describeCommand(action, params) {
    const p = params || {};
    const bits = [action.replace(/_/g, " ")];
    if (p.tool) bits.push(p.tool);
    if (p.profile) bits.push(p.profile);
    if (p.kind) bits.push(p.kind);
    if (p.pattern) bits.push(p.pattern);
    if (p.color) bits.push(String(p.color));
    if (typeof p.radius === "number") bits.push(`r=${+p.radius.toFixed(3)}`);
    else if (typeof p.radius_rel === "number") bits.push(`r=${+p.radius_rel.toFixed(3)}×`);
    if (typeof p.strength === "number") bits.push(`s=${+p.strength.toFixed(2)}`);
    if (typeof p.detail_rel === "number") bits.push(`detail=${p.detail_rel}`);
    if (typeof p.opacity === "number" && action.includes("paint")) {
        bits.push(`op=${+p.opacity.toFixed(2)}`);
    }
    if (typeof p.time === "number") bits.push(`t=${p.time}`);
    if (p.id !== undefined) bits.push(`#${p.id}`);
    return bits.join(" ");
}
