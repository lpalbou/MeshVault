/**
 * EditPanel — human sculpt/paint authoring over the agent command surface
 * (backlog 054).
 *
 * PARITY RULE: every MUTATION goes through the app's ViewerControlAPI
 * (`execute({action:"sculpt_stroke"|"paint_stroke"|...})`) — the exact
 * commands agents use, so the E2E suites remain the single behavioral truth.
 * READS (hover picking, stroke sampling) use a local THREE.Raycaster instead:
 * `execute()` invalidates the renderer per call, and a per-pointermove hover
 * pick through it would force continuous rendering (defeats the 0%-idle-CPU
 * demand rendering).
 *
 * Input arbitration (design review verdicts):
 * - `viewer._toolMode` ("none"|"sculpt"|"paint") is the shared flag every
 *   input consumer checks (precedent: `_measureMode`).
 * - OrbitControls stays ENABLED; on pointerdown we hit-test the ACTIVE
 *   object's meshes only and disable orbit AFTER a hit. Verified against the
 *   vendored source: rotation happens in pointermove (which re-checks
 *   `enabled` per event), so no camera motion leaks; a MISS never touches
 *   orbit — click empty space to navigate.
 * - Pointer capture goes on the CANVAS (capturing an overlay would starve
 *   OrbitControls' dynamically-bound pointerup and corrupt its tracking).
 * - Strokes buffer radius/2-thinned points and flush at ≥16 points or 100 ms
 *   (never per-frame: normals recompute per COMMAND, and 60 flushes/s on a
 *   120k-tri mesh is 30-90% of the frame budget).
 * - Per-gesture sculpt undo (one slot, Cmd/Ctrl+Z): without it, an accidental
 *   grab-the-model-to-orbit stroke would cost the whole session (`reset`
 *   reverts ALL geometry edits, not the last gesture).
 */

import * as THREE from "three";
import {
    paintBudgetInfo,
    prewarmSculptCaches,
    restorePositionsSnapshot,
    snapshotActivePositions,
} from "./viewer/sculpt.js";

const SCULPT_TOOLS = ["draw", "inflate", "smooth", "flatten", "pinch"];
// Displacement tools take strength in WORLD units (fraction-of-radius slider);
// blend tools take 0..1 directly. Interactive defaults are gentler than the
// agent defaults — stamps accumulate fast at UI stroke density.
const STRENGTH_DEFAULTS = { draw: 0.1, inflate: 0.1, smooth: 0.5, flatten: 0.5, pinch: 0.4 };
const DISPLACEMENT_TOOLS = new Set(["draw", "inflate"]);

const FLUSH_POINTS = 16;
const FLUSH_MS = 100;
const HOVER_THROTTLE_MS = 66;

export class EditPanel {
    /**
     * @param viewer  Viewer3D
     * @param api     ViewerControlAPI (mutations only)
     * @param deps    {showToast, getGizmo, setMeasure} — app-owned hooks
     */
    constructor(viewer, api, deps) {
        this._viewer = viewer;
        this._api = api;
        this._toast = deps.showToast;
        this._getGizmo = deps.getGizmo || (() => null);
        this._setMeasure = deps.setMeasure || (() => {});

        viewer._toolMode = "none";

        this._panel = document.getElementById("edit-panel");
        this._toggleBtn = document.getElementById("edit-toggle");
        if (!this._panel || !this._toggleBtn) return;   // markup missing — feature off

        this._tool = "draw";
        this._strength = { ...STRENGTH_DEFAULTS };
        this._radiusRel = 0.12;
        this._paint = { color: "#ff3b30", opacity: 0.9, hardness: 0.6, tier: 1024 };

        // Stroke state
        this._stroke = null;          // {pointerId, buffer, firstAt, lastPoint, spacing, errors:Set}
        this._flushChain = Promise.resolve();
        this._undoSnap = null;

        this._raycaster = new THREE.Raycaster();
        this._ndc = new THREE.Vector2();
        this._lastHover = 0;

        this._initDom();
        this._initPointer();
        this._initKeys();

        // Scene replacement (SSE agent push, load, remove) can happen
        // MID-STROKE: end the gesture and re-run the pre-flight.
        viewer._container.addEventListener("objectschange", () => {
            this._endStroke(true);
            if (viewer._toolMode !== "none") this._preflight();
        });
        viewer._container.addEventListener("navmodechange", (e) => {
            if (e.detail && e.detail.mode === "fpv") this.exitToolMode();
        });
    }

    // ------------------------------------------------------------------
    // Mode lifecycle
    // ------------------------------------------------------------------

    get mode() { return this._viewer._toolMode; }

    enterToolMode(mode) {
        const v = this._viewer;
        if (v._objects.length === 0) {
            this._toast("Load a model first", "info");
            return;
        }
        // Mutual exclusions: measure off, FPV back to orbit.
        this._setMeasure(false);
        if (v._navMode === "fpv") v.setNavMode("orbit");

        v._toolMode = mode;
        this._panel.style.display = "block";
        this._toggleBtn.classList.add("active");
        this._syncTabs();
        this._preflight();
        this._cursor().style.display = "none";

        if (mode === "paint") this._ensureTexturedRenderMode();
        if (mode === "sculpt") this._prewarmWeld();
    }

    exitToolMode() {
        this._endStroke(true);
        this._viewer._toolMode = "none";
        this._panel.style.display = "none";
        this._toggleBtn.classList.remove("active");
        this._cursor().style.display = "none";
    }

    _syncTabs() {
        const mode = this.mode;
        this._panel.querySelector("#edit-tab-sculpt")
            .classList.toggle("active", mode === "sculpt");
        this._panel.querySelector("#edit-tab-paint")
            .classList.toggle("active", mode === "paint");
        this._panel.querySelector("#edit-sculpt-body").style.display =
            mode === "sculpt" ? "block" : "none";
        this._panel.querySelector("#edit-paint-body").style.display =
            mode === "paint" ? "block" : "none";
    }

    /** Disable the tool for states the engine refuses; explain inline, not via throws. */
    _preflight() {
        const v = this._viewer;
        const entry = v._activeEntry();
        const banner = this._panel.querySelector("#edit-banner");
        const msgs = [];
        if (!entry) {
            msgs.push("No object loaded.");
        } else {
            if (entry.skinned) {
                msgs.push("Skinned (rigged) model — sculpt/paint would corrupt the "
                    + "bind pose. Placement and keyframes still work.");
            }
            if (v._timeline && v._timeline.playing) {
                msgs.push("Timeline is playing — pause it to edit (a brush on a "
                    + "moving object would bake a transient pose).");
            }
            if (this.mode === "paint") {
                let hasUV = false, ktx2 = false;
                entry.model.traverse((c) => {
                    if (!c.isMesh || !c.geometry) return;
                    if (c.geometry.getAttribute("uv")) hasUV = true;
                    const stash = c._mvOriginalMaterial || c.material;
                    const m = Array.isArray(stash) ? stash[0] : stash;
                    const img = m && m.map && m.map.image;
                    if (img && typeof HTMLImageElement !== "undefined"
                        && !(img instanceof HTMLImageElement)
                        && !(img instanceof HTMLCanvasElement)
                        && (typeof ImageBitmap === "undefined" || !(img instanceof ImageBitmap))
                        && !(m.userData && m.userData._mvPaint)) {
                        ktx2 = true;
                    }
                });
                if (!hasUV) {
                    msgs.push("This mesh has no UV coordinates (STL/PLY) — painting "
                        + "needs them. Sculpting still works.");
                }
                if (ktx2) {
                    msgs.push("Compressed texture (GPU-only): painting starts from a "
                        + "flat base color — the original texture can't be read back.");
                }
            }
        }
        banner.textContent = msgs.join(" ");
        banner.style.display = msgs.length ? "block" : "none";
        const blocked = !entry || entry.skinned;
        this._panel.querySelectorAll(".edit-tool-btn, .edit-slider").forEach((el) => {
            el.disabled = blocked;
        });
        this._updateBudgetLine();
    }

    _ensureTexturedRenderMode() {
        const state = this._viewer.getState();
        const mode = state.display && state.display.renderMode;
        if (mode && mode !== "textured") {
            this._exec("set_render_mode", { mode: "textured" }).then((r) => {
                if (r.ok) this._toast("Render mode switched to textured (paint is "
                    + "invisible under wireframe/solid overrides)", "info");
            });
        }
    }

    _prewarmWeld() {
        // First stamp on a 120k-tri mesh otherwise pays the weld-map build
        // mid-gesture (visible hitch). Engine-side warm-up: no command, no
        // modified/sculpted flag side effects.
        setTimeout(() => {
            try { prewarmSculptCaches(this._viewer); } catch { /* best-effort */ }
        }, 30);
    }

    // ------------------------------------------------------------------
    // DOM
    // ------------------------------------------------------------------

    _initDom() {
        this._toggleBtn.addEventListener("click", () => {
            if (this.mode === "none") this.enterToolMode("sculpt");
            else this.exitToolMode();
        });
        this._panel.querySelector("#edit-tab-sculpt").addEventListener("click", () => {
            if (this.mode !== "sculpt") { this._viewer._toolMode = "sculpt"; this._syncTabs(); this._preflight(); this._prewarmWeld(); }
        });
        this._panel.querySelector("#edit-tab-paint").addEventListener("click", () => {
            if (this.mode !== "paint") { this._viewer._toolMode = "paint"; this._syncTabs(); this._preflight(); this._ensureTexturedRenderMode(); }
        });
        this._panel.querySelector("#edit-close").addEventListener("click", () => this.exitToolMode());

        // Sculpt tools
        const toolsRow = this._panel.querySelector("#edit-tools");
        for (const tool of SCULPT_TOOLS) {
            const b = document.createElement("button");
            b.className = "btn btn-small edit-tool-btn" + (tool === this._tool ? " active" : "");
            b.textContent = tool;
            b.title = `${tool} brush`;
            b.addEventListener("click", () => {
                this._tool = tool;
                toolsRow.querySelectorAll(".edit-tool-btn")
                    .forEach((x) => x.classList.toggle("active", x.textContent === tool));
                this._panel.querySelector("#edit-strength").value =
                    String(this._strength[tool]);
                this._panel.querySelector("#edit-strength-val").textContent =
                    this._strength[tool].toFixed(2);
            });
            toolsRow.appendChild(b);
        }

        const bindSlider = (id, valId, get, set, fmt = (x) => x.toFixed(2)) => {
            const el = this._panel.querySelector(id);
            const val = this._panel.querySelector(valId);
            el.value = String(get());
            val.textContent = fmt(get());
            el.addEventListener("input", () => {
                set(parseFloat(el.value));
                val.textContent = fmt(get());
            });
        };
        bindSlider("#edit-radius", "#edit-radius-val",
            () => this._radiusRel, (x) => { this._radiusRel = x; });
        bindSlider("#edit-strength", "#edit-strength-val",
            () => this._strength[this._tool],
            (x) => { this._strength[this._tool] = x; });
        bindSlider("#edit-opacity", "#edit-opacity-val",
            () => this._paint.opacity, (x) => { this._paint.opacity = x; });
        bindSlider("#edit-hardness", "#edit-hardness-val",
            () => this._paint.hardness, (x) => { this._paint.hardness = x; });

        const color = this._panel.querySelector("#edit-color");
        color.value = this._paint.color;
        color.addEventListener("input", () => { this._paint.color = color.value; });

        const tier = this._panel.querySelector("#edit-tier");
        tier.value = String(this._paint.tier);
        tier.addEventListener("change", () => { this._paint.tier = parseInt(tier.value, 10); });

        this._invert = false;
        const invertBtn = this._panel.querySelector("#edit-invert");
        invertBtn.addEventListener("click", () => {
            this._invert = !this._invert;
            invertBtn.classList.toggle("active", this._invert);
        });

        this._panel.querySelector("#edit-undo").addEventListener("click", () => this._undo());
        this._panel.querySelector("#edit-undo-paint").addEventListener("click", () => this._undo());
        this._panel.querySelector("#edit-clear-paint").addEventListener("click", async () => {
            const r = await this._exec("clear_paint", {});
            this._toast(r.ok ? `Paint cleared (${r.result.clearedMeshes} mesh(es))`
                             : r.error, r.ok ? "info" : "error");
            this._updateBudgetLine();
        });
    }

    _cursor() {
        if (!this._cursorEl) {
            this._cursorEl = document.createElement("div");
            this._cursorEl.id = "edit-brush-cursor";
            this._cursorEl.style.display = "none";
            this._viewer._container.appendChild(this._cursorEl);
        }
        return this._cursorEl;
    }

    _updateBudgetLine() {
        const line = this._panel.querySelector("#edit-budget");
        try {
            const b = paintBudgetInfo();
            const frac = b.usedFraction !== undefined ? b.usedFraction
                : (b.texelsUsed / Math.max(1, b.texelsBudget));
            line.textContent = `paint memory: ${(frac * 100).toFixed(0)}%`;
            line.classList.toggle("warn", frac >= 0.75);
        } catch { line.textContent = ""; }
    }

    // ------------------------------------------------------------------
    // Pointer input
    // ------------------------------------------------------------------

    _initPointer() {
        const canvas = this._viewer._renderer.domElement;

        canvas.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;                       // right/middle = nav
            if (this.mode === "none") return;
            const gizmo = this._getGizmo();
            // `axis` is set on HOVER, so this guard works before the gizmo's
            // own pointerdown; never fight the gizmo for the pointer.
            if (gizmo && (gizmo.dragging || gizmo.axis)) return;
            const v = this._viewer;
            if (v._timeline && v._timeline.playing) {
                this._toast("Timeline is playing — pause to edit", "info");
                return;
            }
            const entry = v._activeEntry();
            if (!entry || entry.skinned) return;

            const hit = this._raycastActive(e);
            if (!hit) return;                                  // miss → orbit proceeds

            // Freeze orbit for the gesture (rotation happens in pointermove,
            // which re-checks `enabled` per event — nothing leaks).
            v._controls.enabled = false;
            canvas.setPointerCapture(e.pointerId);

            const worldRadius = this._worldRadius();
            this._undoSnap = this.mode === "sculpt" ? snapshotActivePositions(v) : this._undoSnap;
            this._stroke = {
                pointerId: e.pointerId,
                buffer: [[hit.point.x, hit.point.y, hit.point.z]],
                firstAt: performance.now(),
                lastPoint: hit.point.clone(),
                spacing: worldRadius / 2,
                errors: new Set(),
                notes: new Set(),
                // Alt at gesture start inverts displacement brushes (dent).
                invert: e.altKey || this._invert,
                // One undo/opacity unit per GESTURE: the engine groups all
                // flush slices under this token (undo_group).
                gid: `ui-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
                stats: { count: 0, meanAlpha: 0, affected: 0, maxDisplacement: 0 },
            };
        });

        canvas.addEventListener("pointermove", (e) => {
            if (this.mode === "none") return;
            if (this._stroke) {
                const hit = this._raycastActive(e);
                if (hit) {
                    this._updateCursor(e, hit);
                    if (hit.point.distanceTo(this._stroke.lastPoint) >= this._stroke.spacing) {
                        this._stroke.buffer.push([hit.point.x, hit.point.y, hit.point.z]);
                        this._stroke.lastPoint = hit.point.clone();
                    }
                    if (this._stroke.buffer.length >= FLUSH_POINTS
                        || performance.now() - this._stroke.firstAt >= FLUSH_MS) {
                        this._flush(false);
                    }
                } else {
                    this._cursor().style.display = "none";
                }
                return;
            }
            // Hover ring (throttled; local raycast — never through execute()).
            const now = performance.now();
            if (now - this._lastHover < HOVER_THROTTLE_MS) return;
            this._lastHover = now;
            const hit = this._raycastActive(e);
            if (hit) this._updateCursor(e, hit);
            else this._cursor().style.display = "none";
        });

        const end = (e) => {
            if (this._stroke && (!e || e.pointerId === this._stroke.pointerId)) {
                this._endStroke(false);
            }
        };
        canvas.addEventListener("pointerup", end);
        canvas.addEventListener("pointercancel", end);
        canvas.addEventListener("lostpointercapture", end);
        window.addEventListener("blur", () => this._endStroke(false));
        canvas.addEventListener("pointerleave", () => {
            if (!this._stroke) this._cursor().style.display = "none";
        });
        // The panel floats OVER the canvas: entering it must hide the ring
        // (a stale circle otherwise lingers at the last hover position).
        this._panel.addEventListener("pointerenter", () => {
            if (!this._stroke) this._cursor().style.display = "none";
        });
    }

    /** Local raycast against the ACTIVE object's meshes only (M7): strokes on
     *  other objects fall through to orbit instead of teaching-error spam. */
    _raycastActive(e) {
        const v = this._viewer;
        const entry = v._activeEntry();
        if (!entry || !entry.visible) return null;
        const canvas = v._renderer.domElement;
        const rect = canvas.getBoundingClientRect();
        this._ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._ndc, v._camera);
        const meshes = [];
        entry.model.traverse((c) => { if (c.isMesh && c.visible) meshes.push(c); });
        const hits = this._raycaster.intersectObjects(meshes, false);
        return hits.length ? hits[0] : null;
    }

    _worldRadius() {
        const entry = this._viewer._activeEntry();
        if (!entry) return 0.1;
        const box = new THREE.Box3().setFromObject(entry.wrapper);
        const sphereR = box.getSize(new THREE.Vector3()).length() / 2;
        return Math.max(1e-6, this._radiusRel * sphereR);
    }

    _updateCursor(e, hit) {
        const v = this._viewer;
        const rect = v._renderer.domElement.getBoundingClientRect();
        const dist = hit.distance;
        const fovRad = (v._camera.fov * Math.PI) / 180;
        const px = this._worldRadius() * (rect.height / 2) / (dist * Math.tan(fovRad / 2));
        const c = this._cursor();
        const size = Math.max(4, Math.min(600, px * 2));
        c.style.width = `${size}px`;
        c.style.height = `${size}px`;
        c.style.left = `${e.clientX - rect.left}px`;
        c.style.top = `${e.clientY - rect.top}px`;
        c.style.display = "block";
        c.classList.toggle("paint", this.mode === "paint");
    }

    // ------------------------------------------------------------------
    // Stroke flushing (through the AGENT command surface)
    // ------------------------------------------------------------------

    _exec(action, params) {
        return this._api.execute({ action, params });
    }

    _flush(final) {
        const stroke = this._stroke;
        if (!stroke || stroke.buffer.length === 0) return;
        const points = stroke.buffer.splice(0, 64);
        stroke.firstAt = performance.now();
        const mode = this.mode;

        let action, params;
        if (mode === "sculpt") {
            let strength = DISPLACEMENT_TOOLS.has(this._tool)
                ? this._strength[this._tool] * this._worldRadius()
                : this._strength[this._tool];
            // Invert (dent): displacement brushes accept negative strength —
            // carving was otherwise impossible from the UI (gauntlet gap).
            if (stroke.invert && DISPLACEMENT_TOOLS.has(this._tool)) {
                strength = -strength;
            }
            action = points.length === 1 ? "sculpt" : "sculpt_stroke";
            params = {
                tool: this._tool,
                radius_rel: this._radiusRel,
                strength,
                ...(points.length === 1 ? { center: points[0] } : { points }),
            };
        } else {
            action = points.length === 1 ? "paint" : "paint_stroke";
            params = {
                radius_rel: this._radiusRel,
                color: this._paint.color,
                opacity: this._paint.opacity,
                hardness: this._paint.hardness,
                texture_size: this._paint.tier,
                undo_group: stroke.gid,
                ...(points.length === 1 ? { center: points[0] } : { points }),
            };
        }

        // Serialize flushes: one in-flight command; further points keep
        // buffering meanwhile.
        this._flushChain = this._flushChain.then(async () => {
            const r = await this._exec(action, params);
            if (!r.ok) {
                // Teaching errors deduped per gesture — no toast spam.
                if (!stroke.errors.has(r.error)) {
                    stroke.errors.add(r.error);
                    this._toast(r.error, "error");
                }
                return;
            }
            const res = r.result || {};
            const s = stroke.stats;
            // Engine notes (budget warnings, tier mismatches, visibility
            // advisories) surface at gesture end — collect, don't drop.
            if (res.note) stroke.notes.add(res.note);
            if (mode === "sculpt") {
                s.affected += res.affected || 0;
                s.maxDisplacement = Math.max(s.maxDisplacement, res.maxDisplacement || 0);
                this._panel.querySelector("#edit-sculpt-status").textContent =
                    `affected ${s.affected} · max Δ ${s.maxDisplacement.toFixed(4)}`;
            } else {
                s.count += res.painted || 0;
                if (res.meanAlpha !== undefined && res.meanAlpha > 0) {
                    s.meanAlpha = res.meanAlpha;
                }
                this._panel.querySelector("#edit-paint-status").textContent =
                    `painted ${s.count} texels · alpha ${s.meanAlpha}`;
            }
        });
    }

    /** Gesture-end feedback — runs for EVERY gesture (the earlier version only
     *  ran when unflushed points remained at pointer-up, so the flush timer
     *  usually starved it: no advisory, stale budget line — gauntlet bug). */
    _afterGesture(stroke) {
        if (this.mode === "paint") {
            if (stroke.stats.count > 0 && stroke.stats.meanAlpha < 0.05) {
                this._toast("Paint nearly invisible — raise opacity/hardness", "info");
            }
            this._updateBudgetLine();
        }
        const note = stroke.notes.values().next().value;
        if (note) this._toast(note, "info");
    }

    _endStroke(cancel) {
        const stroke = this._stroke;
        if (!stroke) return;
        this._stroke = null;
        const canvas = this._viewer._renderer.domElement;
        try { canvas.releasePointerCapture(stroke.pointerId); } catch { /* released */ }
        this._viewer._controls.enabled = true;
        if (!cancel && stroke.buffer.length) {
            this._stroke = stroke;      // let _flush read the remainder
            this._stroke.buffer = stroke.buffer;
            this._flush(true);
            this._stroke = null;
        }
        if (!cancel) {
            // After the LAST flush lands (chain-ordered), close the gesture.
            this._flushChain = this._flushChain.then(() => this._afterGesture(stroke));
        }
    }

    async _undo() {
        if (this.mode === "paint") {
            // Engine-side single-slot brush undo (the same command agents use).
            const r = await this._exec("undo_paint", {});
            this._toast(r.ok
                ? `Last stroke undone (${r.result.restoredPatches} patch(es))`
                : r.error, r.ok ? "info" : "error");
            return;
        }
        if (this.mode !== "sculpt") return;
        if (!this._undoSnap) {
            this._toast("Nothing to undo (one gesture is remembered)", "info");
            return;
        }
        const ok = restorePositionsSnapshot(this._viewer, this._undoSnap);
        this._toast(ok ? "Last sculpt gesture undone"
                       : "Undo unavailable (geometry changed since)", "info");
        this._undoSnap = null;
    }

    _initKeys() {
        window.addEventListener("keydown", (e) => {
            const tag = document.activeElement && document.activeElement.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            if (e.key === "Escape" && this.mode !== "none") {
                this.exitToolMode();
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z"
                       && this.mode !== "none") {
                e.preventDefault();
                this._undo();
            }
        });
    }
}
