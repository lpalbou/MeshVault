/**
 * ScenePanel — the app-side UI for scene composition (backlog 042).
 *
 * Owns: the objects panel (select / show-hide / opacity / remove / reset
 * placement), the TransformControls gizmo (translate/rotate/scale on the
 * SELECTED object's placement wrapper), viewport click-to-select, and the
 * scene save flow. Composition state itself lives in the viewer's object
 * registry — this module is presentation + input only.
 *
 * App-only module: it ships in the app bundle, never in the standalone/agent
 * bundle (agents drive the same registry through the control API instead).
 */

import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";

export class ScenePanel {
    /**
     * @param {import("./viewer_3d.js").Viewer3D} viewer
     * @param {object} deps
     * @param {(msg:string, type?:string)=>void} deps.showToast
     * @param {()=>Promise<void>} deps.onSaveScene - app-owned save flow
     */
    constructor(viewer, deps) {
        this._viewer = viewer;
        this._toast = deps.showToast;
        this._onSaveScene = deps.onSaveScene;

        this._panel = document.getElementById("scene-panel");
        this._list = document.getElementById("scene-objects-list");
        this._toggleBtn = document.getElementById("scene-toggle");
        this._gizmoMode = "translate";

        if (!this._panel || !this._toggleBtn) return; // markup missing — feature off

        this._toggleBtn.addEventListener("click", () => {
            const visible = this._panel.style.display !== "none";
            this._panel.style.display = visible ? "none" : "block";
            this._toggleBtn.classList.toggle("active", !visible);
        });

        document.getElementById("scene-frame-all")?.addEventListener("click", () => {
            this._viewer.frameAll();
        });
        document.getElementById("scene-save")?.addEventListener("click", () => {
            this._onSaveScene();
        });
        for (const mode of ["translate", "rotate", "scale"]) {
            document.getElementById(`gizmo-${mode}`)?.addEventListener("click", () => {
                this.setGizmoMode(mode);
            });
        }

        // Registry changes drive the list (and panel auto-show on composition).
        viewer._container.addEventListener("objectschange", (e) => {
            this._render(e.detail);
        });

        this._initGizmo();
        this._initClickSelect();
    }

    // ------------------------------------------------------------------
    // Gizmo (three.js TransformControls on the wrapper = placement only)
    // ------------------------------------------------------------------

    _initGizmo() {
        const v = this._viewer;
        this._gizmo = new TransformControls(v._camera, v._renderer.domElement);
        this._gizmo.setMode(this._gizmoMode);
        const helper = this._gizmo.getHelper();
        helper.name = "__gizmo__";
        v._scene.add(helper);

        // The gizmo must never appear in screenshots/captures.
        v._captureHidden = v._captureHidden || [];
        v._captureHidden.push(helper);

        // Orbit and gizmo share the pointer: disable orbit while dragging.
        this._gizmo.addEventListener("dragging-changed", (e) => {
            v._controls.enabled = !e.value;
            if (!e.value) {
                // Drag finished: re-size lights/shadows/grid to the new layout.
                v._updateSceneRig(v._visibleUnionBox());
                this._refreshTransforms();
            }
        });
        // Demand-driven rendering: gizmo interaction must repaint every frame.
        this._gizmo.addEventListener("change", () => v.invalidate());

        // Keyboard mode switch (t/r/s) while an object is attached.
        window.addEventListener("keydown", (e) => {
            if (!this._gizmo.object) return;
            const tag = document.activeElement && document.activeElement.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            const key = e.key.toLowerCase();
            if (key === "t") this.setGizmoMode("translate");
            else if (key === "r") this.setGizmoMode("rotate");
            else if (key === "s") this.setGizmoMode("scale");
        });
    }

    setGizmoMode(mode) {
        this._gizmoMode = mode;
        this._gizmo.setMode(mode);
        for (const m of ["translate", "rotate", "scale"]) {
            document.getElementById(`gizmo-${m}`)?.classList.toggle("active", m === mode);
        }
    }

    /** Attach the gizmo to an object's placement wrapper (never the model). */
    _attachGizmo(entry) {
        if (!entry) {
            this._gizmo.detach();
            return;
        }
        this._gizmo.attach(entry.wrapper);
        // Screen-constant handle size: usable on a 1 cm part next to a 10 m one.
        this._gizmo.setSize(0.9);
    }

    // ------------------------------------------------------------------
    // Click-to-select in the viewport
    // ------------------------------------------------------------------

    _initClickSelect() {
        const v = this._viewer;
        const canvas = v._renderer.domElement;
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();
        let downPos = null;
        let downTime = 0;

        canvas.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            downPos = { x: e.clientX, y: e.clientY };
            downTime = performance.now();
        });

        canvas.addEventListener("mouseup", (e) => {
            if (e.button !== 0 || !downPos) return;
            const wasDrag = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6
                || performance.now() - downTime > 350;
            downPos = null;
            if (wasDrag) return;
            // Selection only matters in composed scenes; measurement owns clicks
            // in measure mode; the gizmo handles its own pointer interactions.
            if (v._objects.length < 2 || v._measureMode || this._gizmo.dragging) return;

            const rect = canvas.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(mouse, v._camera);
            const hits = raycaster.intersectObjects(v._visibleMeshes(), false);
            if (hits.length === 0) return;
            const entry = v._entryForNode(hits[0].object);
            if (entry && entry.id !== v._activeObjectId) {
                v.setActiveObject(entry.id);
                this._toast(`Selected: ${entry.name}`, "info");
            }
        });
    }

    // ------------------------------------------------------------------
    // Panel rendering
    // ------------------------------------------------------------------

    _render(detail) {
        if (!this._list) return;
        const objects = detail.objects || [];

        // Composition started: surface the panel so the user discovers it.
        if (objects.length > 1 && this._panel.style.display === "none") {
            this._panel.style.display = "block";
            this._toggleBtn.classList.add("active");
        }
        if (objects.length === 0) {
            this._panel.style.display = "none";
            this._toggleBtn.classList.remove("active");
        }

        const count = document.getElementById("scene-objects-count");
        if (count) count.textContent = objects.length ? `${objects.length}` : "";

        this._list.innerHTML = "";
        for (const obj of objects) {
            this._list.appendChild(this._buildRow(obj));
        }

        // Keep the gizmo on the active entry (or detached when scene is empty).
        const active = this._viewer._activeEntry();
        this._attachGizmo(objects.length > 1 ? active : null);
    }

    _buildRow(obj) {
        const v = this._viewer;
        const row = document.createElement("div");
        row.className = "scene-object-row" + (obj.active ? " active" : "");

        // Name (selects on click). textContent — object names come from files
        // and manifests and must never be interpolated as HTML.
        const name = document.createElement("span");
        name.className = "scene-object-name";
        name.textContent = obj.name;
        name.title = obj.name;
        name.addEventListener("click", () => v.setActiveObject(obj.id));
        row.appendChild(name);

        // Visibility eye
        const eye = document.createElement("button");
        eye.className = "scene-object-btn";
        eye.textContent = obj.visible ? "👁" : "–";
        eye.title = obj.visible ? "Hide" : "Show";
        eye.addEventListener("click", () => {
            v.setObjectVisible(obj.id, !obj.visible);
            this._render({ objects: v.listObjects() });
        });
        row.appendChild(eye);

        // Opacity slider
        const opacity = document.createElement("input");
        opacity.type = "range";
        opacity.min = "0.1"; opacity.max = "1"; opacity.step = "0.05";
        opacity.value = String(obj.opacity);
        opacity.className = "scene-object-opacity";
        opacity.title = "Opacity";
        opacity.addEventListener("input", () => {
            v.setObjectOpacity(obj.id, parseFloat(opacity.value));
        });
        row.appendChild(opacity);

        // Reset placement
        const reset = document.createElement("button");
        reset.className = "scene-object-btn";
        reset.textContent = "⟲";
        reset.title = "Reset placement (position/rotation/scale)";
        reset.addEventListener("click", () => {
            v.resetObjectTransform(obj.id);
            this._toast(`Placement reset: ${obj.name}`, "info");
        });
        row.appendChild(reset);

        // Remove
        const remove = document.createElement("button");
        remove.className = "scene-object-btn";
        remove.textContent = "✕";
        remove.title = "Remove from scene";
        remove.addEventListener("click", () => {
            v.removeObject(obj.id);
        });
        row.appendChild(remove);

        return row;
    }

    _refreshTransforms() {
        // Cheap: re-render rows so any transform-dependent display stays honest.
        this._render({ objects: this._viewer.listObjects() });
    }
}
