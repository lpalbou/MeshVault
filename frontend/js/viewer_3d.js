/**
 * 3D Viewer Component
 *
 * High-quality Three.js-based 3D model viewer with:
 * - PBR-quality lighting (hemisphere + multiple directional lights)
 * - Soft shadows with shadow mapping
 * - SSAO postprocessing for ambient occlusion
 * - Tone mapping for better dynamic range
 * - Anti-aliasing (MSAA)
 * - OrbitControls for interactive viewing
 * - Auto-framing to fit models to view
 * - Ground plane with shadow reception
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { USDZLoader } from "three/addons/loaders/USDZLoader.js";
import { TGALoader } from "three/addons/loaders/TGALoader.js";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { deinterleaveGeometry } from "three/addons/utils/BufferGeometryUtils.js";
import { SimplifyModifier } from "three/addons/modifiers/SimplifyModifier.js";
import { VertexNormalsHelper } from "three/addons/helpers/VertexNormalsHelper.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { paintedMeshNames, releasePaintBudget } from "./viewer/sculpt.js";

/**
 * Turn a loader failure into a readable message. Loaders (and the Draco/Basis worker
 * bridges) reject with Error objects, strings, or plain objects — a bare template
 * literal on the latter yields "[object Object]".
 */
function describeLoadError(err) {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    if (err.message) return err.message;
    if (err.error && err.error.message) return err.error.message;
    try { return JSON.stringify(err); } catch { return String(err); }
}

export class Viewer3D {
    /**
     * @param {HTMLElement} container - The container element for the 3D canvas
     * @param {Function} onInfoUpdate - Callback to update viewer info (vertices, faces)
     */
    constructor(container, onInfoUpdate, options = {}) {
        this._container = container;
        this._onInfoUpdate = onInfoUpdate || (() => {});
        this._animationId = null;

        // --- Object registry (scene composition, backlog 042) ---
        // The viewer holds N objects, each wrapped in a placement Group:
        //   scene → entry.wrapper (placement transform ONLY) → entry.model (asset)
        // Single-object commands operate on the ACTIVE entry via the _currentModel
        // getter below, which keeps the ~90 pre-registry references (and the
        // describe/stats/sampling/heatmap helper modules) working unchanged.
        // INVARIANT: a non-empty registry always has a valid active entry.
        this._objects = [];
        this._activeObjectId = null;
        this._nextObjectId = 1;
        // Scene generation: bumped ONLY by clear-all (replace load / unload).
        // In-flight ADD loads capture it and discard themselves if the scene was
        // replaced while they were parsing; adds never invalidate other adds
        // (a single monotonic load id cannot express add-vs-replace semantics).
        this._sceneGeneration = 0;

        this._clock = new THREE.Clock();

        // Backend decoupling: how the viewer turns a resource reference (a texture/MTL
        // path referenced by a model) into a fetchable URL. The full MeshVault app injects
        // a resolver that points at its /api/asset/related endpoint; a standalone/embedded
        // viewer can inject its own (or rely on the default below, which returns the ref
        // as-is so relative URLs resolve against the host page). This is the single seam
        // that makes the rendering core usable without a server.
        this._resolveResource =
            options.resolveResource ||
            ((ref) => `/api/asset/related?path=${encodeURIComponent(ref)}`);

        // Base URL under which the vendored decoder assets (Draco/Basis) are served.
        // Full app: "/static/" (StaticFiles → frontend/). Standalone/Pages: "" so
        // "vendor/..." resolves relative to the host page. Locally bundled = no CDN.
        this._assetBaseUrl = options.assetBaseUrl != null ? options.assetBaseUrl : "/static/";

        // Lightweight state tracking so the control API (and AI agents) can query a
        // JSON snapshot without reaching into internals. Stats/name mirror the
        // ACTIVE entry (refreshed on load/add/activate).
        this._background = "#0d0d1a";
        this._lastModelName = null;
        this._lastStats = { vertices: 0, faces: 0, width: 0, height: 0, depth: 0 };

        // Track every DOM listener we attach to the container/canvas so destroy() can
        // remove them. Anonymous listeners on the embedder's element would otherwise
        // leak the whole scene graph and keep firing after teardown.
        this._trackedListeners = [];

        // Load guard: prevents race conditions when clicking assets rapidly
        this._loadId = 0;

        // Navigation mode: 'orbit' (default) or 'fpv' (drone)
        this._navMode = "orbit";
        this._keysPressed = new Set();
        this._moveSpeed = 1.0; // Adapted per model size
        this._yawSpeed = 1.5;  // Radians per second for A/D yaw
        // FPV mouse look state
        this._fpvMouseDown = false;
        this._fpvYaw = 0;
        this._fpvPitch = 0;
        // Stored initial view for spacebar reset
        this._initialCameraPos = new THREE.Vector3();
        this._initialTarget = new THREE.Vector3();

        this._initScene();
        this._initLights();
        this._initGround();
        this._initRenderer();
        this._initEnvironment();
        this._initControls();
        this._initPivotPick();
        this._initMeasurement();
        this._initKeyboardNav();
        this._initFPVMouseLook();
        this._initPostProcessing();
        this._startRenderLoop();

        // Handle resize
        this._resizeObserver = new ResizeObserver(() => this._onResize());
        this._resizeObserver.observe(this._container);
    }

    // ==========================================================
    // Object registry — scene composition core (backlog 042)
    // ==========================================================

    /**
     * The ACTIVE object's model — a derived view over the registry.
     *
     * This getter is the backward-compatibility seam: every pre-registry
     * single-object code path (and the describe_scene/mesh_stats/sample_points/
     * heatmap helpers) reads `viewer._currentModel` and now transparently
     * operates on the active entry. There is deliberately NO setter — the
     * registry is the single source of truth and all mutations go through
     * loadModel/addModel/removeObject/_clearAllObjects.
     */
    get _currentModel() {
        const entry = this._activeEntry();
        return entry ? entry.model : null;
    }

    /** Active entry's uniform scale (compat view for getState/legacy readers). */
    get _modelScale() {
        const entry = this._activeEntry();
        return entry ? entry.modelScale : 1;
    }

    /** Active entry's modified flag (compat view; bake/mesh ops set it per entry). */
    get _modelModified() {
        const entry = this._activeEntry();
        return entry ? entry.modified : false;
    }

    set _modelModified(value) {
        const entry = this._activeEntry();
        if (entry) {
            entry.modified = !!value;
            // Every writer of this compat setter is a GEOMETRY operation
            // (bakes/rotate/simplify/recompute) — track it as sculpted/baked so
            // introspection can distinguish geometry edits from paint-only
            // changes (`modified` stays the union: "anything unexported").
            if (value) entry.sculpted = true;
        }
    }

    _activeEntry() {
        if (this._activeObjectId == null) return null;
        return this._objects.find((e) => e.id === this._activeObjectId) || null;
    }

    _entryById(id) {
        return this._objects.find((e) => e.id === id) || null;
    }

    _visibleEntries() {
        return this._objects.filter((e) => e.visible);
    }

    /** Union world-space box of all VISIBLE objects (null when empty/none visible). */
    _visibleUnionBox() {
        let union = null;
        for (const entry of this._visibleEntries()) {
            entry.wrapper.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(entry.wrapper);
            if (box.isEmpty()) continue;
            union = union ? union.union(box) : box;
        }
        return union;
    }

    /** All meshes of all visible objects (raycast targets: pivot pick, measure, select). */
    _visibleMeshes() {
        const meshes = [];
        for (const entry of this._visibleEntries()) {
            entry.model.traverse((child) => {
                if (child.isMesh) meshes.push(child);
            });
        }
        return meshes;
    }

    /** The registry entry owning a mesh/object node, or null. */
    _entryForNode(node) {
        for (const entry of this._objects) {
            let found = false;
            entry.model.traverse((child) => { if (child === node) found = true; });
            if (found) return entry;
        }
        return null;
    }

    /**
     * Load a 3D model from a URL.
     *
     * @param {string} url - URL to the 3D file
     * @param {string} extension - File extension (.obj, .fbx)
     * @param {object} options - Additional loading options
     * @param {string[]} options.relatedFiles - Related file paths
     * @param {string} options.sourcePath - Absolute source file path for resolving
     *                                     relative resource references
     * @returns {Promise<{vertices: number, faces: number}>}
     */
    async loadModel(url, extension, options = {}) {
        // Increment load ID to guard against replace-vs-replace races
        // (user clicking multiple assets rapidly): the NEWEST replace wins.
        const thisLoadId = ++this._loadId;

        const object = await this._parseModel(url, extension, options);

        // If another REPLACE load started while we were parsing, discard this result.
        if (thisLoadId !== this._loadId) {
            this._disposeObject(object);
            return { vertices: 0, faces: 0 };
        }

        // Success — REPLACE semantics: clear every object, reset viewer state.
        this._clearAllObjects();
        this._resetViewerState();

        const entry = this._insertEntry(object, url, extension, options);

        // Auto-frame the (single) new object.
        this._frameModel(object);

        return entry.stats;
    }

    /**
     * Co-load a model into the CURRENT scene (composition — does not clear).
     * The new object becomes active. Returns stats + the new objectId.
     *
     * Concurrency: captures the scene generation; if a replace/unload happens
     * while parsing, the add discards itself (never resurrects a cleared scene).
     * Concurrent adds never invalidate each other.
     */
    async addModel(url, extension, options = {}) {
        const generation = this._sceneGeneration;

        const object = await this._parseModel(url, extension, options);

        if (generation !== this._sceneGeneration) {
            this._disposeObject(object);
            return { vertices: 0, faces: 0, discarded: true };
        }

        const entry = this._insertEntry(object, url, extension, options);
        if (options.transform) {
            this.setObjectTransform(entry.id, options.transform);
        }

        // Show the composed result (union framing) so the addition is visible
        // regardless of where the previous camera pointed.
        if (options.frame !== false) this.frameAll();
        else this._updateSceneRig(this._visibleUnionBox());

        return { ...entry.stats, objectId: entry.id };
    }

    /**
     * Add a procedural primitive as a scene object (backlog 045 — the sculpting
     * starting stock). Primitives are first-class objects: they persist in
     * manifests via their {kind:"primitive"} source and rebuild without files.
     * Default segment densities are chosen for SCULPTABILITY — a 12-triangle box
     * cannot deform.
     */
    addPrimitive(kind, options = {}) {
        const { geometry, params } = this._buildPrimitiveGeometry(kind, options.params || {});
        const color = options.color !== undefined ? options.color : "#9aa4b0";
        const material = new THREE.MeshStandardMaterial({
            color, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide,
        });
        // The agent chose this color deliberately — the dark-color preview clamp
        // must not repaint it (see _fixDarkColor).
        material.userData._mvKeepColor = true;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = kind;
        const group = new THREE.Group();
        group.name = `${kind}_primitive`;
        group.add(mesh);

        const entry = this._insertEntry(group, "", `.${kind}`, {
            name: options.name || kind,
            source: { kind: "primitive", primitive: kind, params, color },
        });
        if (options.transform) this.setObjectTransform(entry.id, options.transform);
        if (options.frame !== false) this.frameAll();
        else this._updateSceneRig(this._visibleUnionBox());
        return { ...entry.stats, objectId: entry.id, kind, params };
    }

    /** Allowed params per primitive kind — unknown keys are REJECTED (a typo like
     *  `radiu` must not silently produce a default shape with ok:true). */
    static PRIMITIVE_PARAMS = {
        box: ["width", "height", "depth", "segments"],
        sphere: ["radius", "widthSegments", "heightSegments"],
        cylinder: ["radius", "radiusTop", "radiusBottom", "height",
                   "radialSegments", "heightSegments"],
        cone: ["radius", "height", "radialSegments", "heightSegments"],
        torus: ["radius", "tube", "radialSegments", "tubularSegments"],
        plane: ["width", "height", "widthSegments", "heightSegments"],
        capsule: ["radius", "length", "capSegments", "radialSegments"],
    };

    _buildPrimitiveGeometry(kind, p) {
        const allowed = Viewer3D.PRIMITIVE_PARAMS[kind];
        if (!allowed) {
            throw new Error(
                `Unknown primitive '${kind}'. Use box|sphere|cylinder|cone|torus|plane|capsule.`);
        }
        const unknown = Object.keys(p).filter((k) => !allowed.includes(k));
        if (unknown.length > 0) {
            throw new Error(
                `Unknown param(s) for ${kind}: ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`);
        }
        // Segment caps (≤256) bound the constructible vertex count; the post-check
        // below is the belt-and-braces total cap.
        const seg = (v, def) => Math.max(1, Math.min(256, Math.round(v !== undefined ? v : def)));
        const num = (v, def) => (typeof v === "number" && v > 0 ? v : def);
        let geometry, params;
        // Segment defaults are tuned for SCULPTABILITY: a brush of ~0.1× the
        // primitive size should cover dozens of vertices, not a handful.
        switch (kind) {
            case "box": {
                params = { width: num(p.width, 1), height: num(p.height, 1),
                           depth: num(p.depth, 1), segments: seg(p.segments, 24) };
                geometry = new THREE.BoxGeometry(
                    params.width, params.height, params.depth,
                    params.segments, params.segments, params.segments);
                // 3×2 face atlas — default BoxGeometry maps ALL SIX faces onto the
                // full [0,1]² square, so painting one face paints all six.
                this._atlasGroupUVs(geometry, [
                    [0, 0.5, 1 / 3, 0.5], [1 / 3, 0.5, 1 / 3, 0.5], [2 / 3, 0.5, 1 / 3, 0.5],
                    [0, 0, 1 / 3, 0.5], [1 / 3, 0, 1 / 3, 0.5], [2 / 3, 0, 1 / 3, 0.5],
                ]);
                break;
            }
            case "sphere": {
                params = { radius: num(p.radius, 0.5),
                           widthSegments: seg(p.widthSegments, 64),
                           heightSegments: seg(p.heightSegments, 48) };
                geometry = new THREE.SphereGeometry(
                    params.radius, params.widthSegments, params.heightSegments);
                break;
            }
            case "cylinder": {
                params = { radiusTop: num(p.radiusTop, num(p.radius, 0.5)),
                           radiusBottom: num(p.radiusBottom, num(p.radius, 0.5)),
                           height: num(p.height, 1),
                           radialSegments: seg(p.radialSegments, 64),
                           heightSegments: seg(p.heightSegments, 32) };
                geometry = new THREE.CylinderGeometry(
                    params.radiusTop, params.radiusBottom, params.height,
                    params.radialSegments, params.heightSegments);
                // Side band on top, cap islands below (caps overlap the side band
                // in stock UVs). Caps are triangle FANS — fine to paint, poor to
                // sculpt (no interior vertices); documented in the command help.
                this._atlasGroupUVs(geometry, [
                    [0, 0.5, 1, 0.5], [0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5],
                ]);
                break;
            }
            case "cone": {
                params = { radius: num(p.radius, 0.5), height: num(p.height, 1),
                           radialSegments: seg(p.radialSegments, 64),
                           heightSegments: seg(p.heightSegments, 32) };
                geometry = new THREE.ConeGeometry(
                    params.radius, params.height,
                    params.radialSegments, params.heightSegments);
                this._atlasGroupUVs(geometry, [
                    [0, 0.5, 1, 0.5], [0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5],
                ]);
                break;
            }
            case "torus": {
                params = { radius: num(p.radius, 0.5), tube: num(p.tube, 0.2),
                           radialSegments: seg(p.radialSegments, 48),
                           tubularSegments: seg(p.tubularSegments, 96) };
                geometry = new THREE.TorusGeometry(
                    params.radius, params.tube,
                    params.radialSegments, params.tubularSegments);
                break;
            }
            case "plane": {
                params = { width: num(p.width, 1), height: num(p.height, 1),
                           widthSegments: seg(p.widthSegments, 48),
                           heightSegments: seg(p.heightSegments, 48) };
                geometry = new THREE.PlaneGeometry(
                    params.width, params.height,
                    params.widthSegments, params.heightSegments);
                break;
            }
            case "capsule": {
                params = { radius: num(p.radius, 0.3), length: num(p.length, 0.6),
                           capSegments: seg(p.capSegments, 24),
                           radialSegments: seg(p.radialSegments, 64) };
                geometry = new THREE.CapsuleGeometry(
                    params.radius, params.length,
                    params.capSegments, params.radialSegments);
                break;
            }
        }
        const count = geometry.getAttribute("position").count;
        if (count > 250000) {
            geometry.dispose();
            throw new Error(
                `Primitive too dense (${count.toLocaleString()} vertices > 250k). Lower the segment counts.`);
        }
        return { geometry, params };
    }

    /** Remap each geometry GROUP's UVs into its own atlas rect
     *  [uOffset, vOffset, uScale, vScale] so paint on one face/cap never bleeds
     *  onto another. Vertices are not shared across groups in three's builders. */
    _atlasGroupUVs(geometry, rects) {
        const uv = geometry.getAttribute("uv");
        const index = geometry.getIndex();
        if (!uv || !geometry.groups || geometry.groups.length === 0) return;
        const seen = new Set();
        geometry.groups.forEach((group, gi) => {
            const rect = rects[Math.min(gi, rects.length - 1)];
            for (let i = group.start; i < group.start + group.count; i++) {
                const vi = index ? index.getX(i) : i;
                if (seen.has(vi)) continue;
                seen.add(vi);
                uv.setXY(vi,
                         rect[0] + uv.getX(vi) * rect[2],
                         rect[1] + uv.getY(vi) * rect[3]);
            }
        });
        // Single-material primitives: collapse the per-face material groups so the
        // whole geometry renders as one range.
        geometry.clearGroups();
    }

    /** Fetch + parse a model WITHOUT touching the scene (shared by load/add). */
    async _parseModel(url, extension, options = {}) {
        const ext = extension.toLowerCase();

        // Record the model URL's directory so relative resource references (MTL,
        // textures, .gltf buffers) can be resolved against the MODEL's location —
        // what the platform loaders do natively — instead of the host page. Set
        // before the loaders run because _loadOBJ resolves its MTL during the load.
        // Known limit: concurrent ADDS of multi-file (non-self-contained) assets can
        // cross-resolve textures — callers serialize loads (the MCP lock, UI clicks).
        this._modelBaseUrl = this._computeModelBaseUrl(url);

        try {
            if (ext === ".obj") {
                return await this._loadOBJ(url, options);
            } else if (ext === ".fbx") {
                return await this._loadFBX(url, options);
            } else if (ext === ".gltf" || ext === ".glb") {
                return await this._loadGLTF(url, options);
            } else if (ext === ".stl") {
                return await this._loadSTL(url);
            } else if (ext === ".ply") {
                return await this._loadPLY(url);
            } else if (ext === ".dae") {
                return await this._loadCollada(url);
            } else if (ext === ".3mf") {
                return await this._load3MF(url);
            } else if (ext === ".usdz") {
                return await this._loadUSDZ(url);
            }
            throw new Error(`Unsupported format: ${ext}`);
        } catch (loadErr) {
            console.error(`Failed to load ${ext} model:`, loadErr);
            throw loadErr;
        }
    }

    /**
     * Register a parsed model as a scene object: wrap it in a placement Group,
     * make it active, and run the full per-object setup (materials, animations,
     * snapshots, persistent display settings, texture janitor, stats).
     */
    _insertEntry(object, url, extension, options = {}) {
        // Apply high-quality materials and settings
        this._enhanceModel(object);

        const id = this._nextObjectId++;
        const wrapper = new THREE.Group();
        wrapper.name = `mv_object_${id}`;
        wrapper.add(object);
        this._scene.add(wrapper);

        const nameSource = options.name || options.sourcePath || url || "";
        const name =
            String(nameSource).split(/[/\\]/).pop().split("?")[0] || `object_${id}`;

        // Persistent source identity for scene manifests. Callers pass a structured
        // descriptor; a bare sourcePath means a plain file; anything else (drag-drop
        // object URLs, unresolvable inputs) is VOLATILE and excluded from manifests.
        const source = options.source
            || (options.sourcePath ? { kind: "file", path: options.sourcePath }
                                   : { kind: "volatile" });

        let skinned = false;
        object.traverse((child) => { if (child.isSkinnedMesh) skinned = true; });

        const entry = {
            id,
            name,
            wrapper,
            model: object,
            source,
            visible: true,
            opacity: 1,
            modelScale: 1,
            modified: false,
            skinned,
            originalState: null,
            animation: null,
            stats: null,
        };
        this._objects.push(entry);
        this._activeObjectId = id;

        // Texture loads OUTLIVE the mesh load (loaders resolve when geometry
        // parses; MTL/FBX textures keep streaming in). Once they settle, clear
        // slots that DEFINITIVELY failed (404/decode error) so those materials
        // fall back to their base color instead of an unbound sampler. The
        // closure captures only the entry ID — capturing the model would pin its
        // full geometry/texture memory for 8 s even after removal/unload.
        const janitorId = entry.id;
        setTimeout(() => {
            const live = this._objects.find((e) => e.id === janitorId);
            if (live) this._sanitizeObjectTextures(live.model);
        }, 8000);

        // Wire up any animation clips and notify the UI (play/pause/scrub controls).
        this._setupAnimationsForEntry(entry);

        // The Reset snapshot is taken LAZILY (_ensureResetSnapshot) at the first
        // geometry-mutating operation — an unmodified model never pays the ~35-40%
        // geometry-RAM duplicate just for the possibility of Reset.

        // Re-apply persistent scene settings (wireframe/normals/render mode) so an
        // object arriving into a styled scene matches it.
        this._applySceneSettings();

        // Re-assert the current IBL state for the new object.
        this._applyEnvironment();

        // Compute stats + name for state queries (control API / AI agents).
        entry.stats = this._computeStats(object);
        this._lastStats = entry.stats;
        this._lastModelName = name;
        this._onInfoUpdate(entry.stats);

        // Notify embedders/UI (the app's objects panel listens for this).
        this._container.dispatchEvent(new CustomEvent("objectschange", {
            detail: { objects: this.listObjects(), activeId: this._activeObjectId },
        }));

        return entry;
    }

    /**
     * Dispose ONE registry entry: restore original materials first (render-mode
     * overrides / heatmaps stash them on _mvOriginalMaterial — disposing the
     * override alone would leak the originals' GPU textures), then dispose the
     * model and remove its wrapper. Per-entry snapshots/animations are dropped
     * so removed objects never pin geometry copies in memory.
     */
    _disposeEntry(entry) {
        // Return painted-texel budget BEFORE materials are disposed (the layer
        // records live on material.userData).
        releasePaintBudget(entry.model);
        entry.model.traverse((child) => {
            if (child.isMesh && child._mvOriginalMaterial) {
                const override = child.material;
                child.material = child._mvOriginalMaterial;
                delete child._mvOriginalMaterial;
                if (override && override !== child.material) {
                    (Array.isArray(override) ? override : [override])
                        .forEach((m) => m && m.dispose && m.dispose());
                }
            }
        });
        this._scene.remove(entry.wrapper);
        this._disposeObject(entry.model);
        entry.originalState = null;
        entry.animation = null;
    }

    /** Remove every object and reset scene-wide display state (replace/unload). */
    _clearAllObjects() {
        for (const entry of this._objects) {
            this._disposeEntry(entry);
        }
        this._objects = [];
        this._activeObjectId = null;
        // Invalidate in-flight ADD loads: the scene they were adding into is gone.
        this._sceneGeneration++;

        this._clearNormalsHelpers();
        // Drop any measurement overlay from the previous scene.
        if (this._measureGroup) this._clearMeasurement();
        // Reset clipping + render-mode trackers so a new scene starts clean (textured).
        if (this._renderer) {
            this._renderer.clippingPlanes = [];
            this._renderer.localClippingEnabled = false;
        }
        this._clip = null;
        this._renderMode = "textured";
        this._wireframeEnabled = false;
    }

    /** Backward-compat alias (a handful of internal callers say "clear model"). */
    _clearModel() {
        this._clearAllObjects();
    }

    // ---- registry public surface (control API + app UI) ----------------------

    /** Summaries of every object (id, name, active, visibility, opacity, source). */
    listObjects() {
        return this._objects.map((e) => {
            const painted = paintedMeshNames(e.model);
            return {
                id: e.id,
                name: e.name,
                active: e.id === this._activeObjectId,
                visible: e.visible,
                opacity: e.opacity,
                skinned: e.skinned,
                source: e.source,
                vertices: e.stats ? e.stats.vertices : 0,
                faces: e.stats ? e.stats.faces : 0,
                // Delta flags: which objects carry unexported work, introspectable
                // without a screenshot. painted = paint layers; sculpted =
                // geometry edits (sculpt/bakes); modified = the union (export-dirty).
                painted: painted.length > 0 || undefined,
                sculpted: e.sculpted || undefined,
                modified: e.modified || undefined,
                transform: this._transformOf(e),
            };
        });
    }

    /** Make an object active (single-object commands target it). */
    setActiveObject(id) {
        const entry = this._entryById(id);
        if (!entry) throw new Error(`No object with id ${id}. Use list_objects.`);
        this._activeObjectId = id;
        this._lastStats = entry.stats || this._lastStats;
        this._lastModelName = entry.name;
        // Refresh the animation UI for the newly active object (frozen clips of
        // other objects stay where they are; see _setupAnimationsForEntry).
        this._dispatchAnimationsEvent(entry);
        this._container.dispatchEvent(new CustomEvent("objectschange", {
            detail: { objects: this.listObjects(), activeId: this._activeObjectId },
        }));
        return true;
    }

    /**
     * Remove ONE object. If it was active, the most recently added remaining
     * object becomes active (invariant: non-empty registry ⇒ active entry).
     */
    removeObject(id) {
        const entry = this._entryById(id);
        if (!entry) throw new Error(`No object with id ${id}. Use list_objects.`);
        this._disposeEntry(entry);
        this._objects = this._objects.filter((e) => e.id !== id);

        if (this._activeObjectId === id) {
            const next = this._objects[this._objects.length - 1] || null;
            this._activeObjectId = next ? next.id : null;
            if (next) {
                this._lastStats = next.stats || this._lastStats;
                this._lastModelName = next.name;
                this._dispatchAnimationsEvent(next);
            } else {
                this._lastStats = { vertices: 0, faces: 0, width: 0, height: 0, depth: 0 };
                this._lastModelName = null;
                this._dispatchAnimationsEvent(null);
            }
        }
        this._updateSceneRig(this._visibleUnionBox());
        this._container.dispatchEvent(new CustomEvent("objectschange", {
            detail: { objects: this.listObjects(), activeId: this._activeObjectId },
        }));
        return true;
    }

    setObjectVisible(id, visible) {
        const entry = this._entryById(id);
        if (!entry) throw new Error(`No object with id ${id}. Use list_objects.`);
        entry.visible = !!visible;
        entry.wrapper.visible = entry.visible;
        this._updateSceneRig(this._visibleUnionBox());
        return true;
    }

    /**
     * Per-object opacity (1 = opaque). Declarative: stored on the entry and
     * re-applied after every material swap (render modes, heatmap), so it
     * survives mode changes. Exports ignore it (viewer state, not asset data).
     */
    setObjectOpacity(id, opacity) {
        const entry = this._entryById(id);
        if (!entry) throw new Error(`No object with id ${id}. Use list_objects.`);
        entry.opacity = Math.max(0, Math.min(1, opacity));
        this._applyEntryOpacity(entry);
        return true;
    }

    _applyEntryOpacity(entry) {
        const ghost = entry.opacity < 1;
        entry.model.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of mats) {
                if (ghost) {
                    if (m.userData._mvViewerOpacityBackup === undefined) {
                        m.userData._mvViewerOpacityBackup = {
                            opacity: m.opacity, transparent: m.transparent,
                            depthWrite: m.depthWrite,
                        };
                    }
                    m.opacity = entry.opacity;
                    m.transparent = true;
                    m.depthWrite = false;
                } else if (m.userData._mvViewerOpacityBackup !== undefined) {
                    const b = m.userData._mvViewerOpacityBackup;
                    m.opacity = b.opacity;
                    m.transparent = b.transparent;
                    m.depthWrite = b.depthWrite;
                    delete m.userData._mvViewerOpacityBackup;
                }
                m.needsUpdate = true;
            }
        });
    }

    /** Re-apply every entry's declarative opacity (call after material swaps). */
    _reapplyAllOpacities() {
        for (const entry of this._objects) {
            if (entry.opacity < 1) this._applyEntryOpacity(entry);
        }
    }

    /** Placement transform of an object's wrapper (TRS, world = scene space). */
    _transformOf(entry) {
        const w = entry.wrapper;
        const r3 = (v) => Math.round(v * 10000) / 10000;
        return {
            position: [r3(w.position.x), r3(w.position.y), r3(w.position.z)],
            quaternion: [r3(w.quaternion.x), r3(w.quaternion.y),
                         r3(w.quaternion.z), r3(w.quaternion.w)],
            scale: [r3(w.scale.x), r3(w.scale.y), r3(w.scale.z)],
        };
    }

    getObjectTransform(id) {
        const entry = this._entryById(id);
        if (!entry) throw new Error(`No object with id ${id}. Use list_objects.`);
        return this._transformOf(entry);
    }

    /**
     * Set an object's PLACEMENT (wrapper transform — never baked into vertices).
     * Accepts position [x,y,z], quaternion [x,y,z,w] OR rotation (Euler degrees
     * [x,y,z]), scale [x,y,z] or a uniform number. Omitted parts are unchanged.
     */
    setObjectTransform(id, { position, quaternion, rotation, scale } = {}) {
        const entry = this._entryById(id);
        if (!entry) throw new Error(`No object with id ${id}. Use list_objects.`);
        const w = entry.wrapper;
        if (position) w.position.set(position[0], position[1], position[2]);
        if (quaternion) {
            w.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
        } else if (rotation) {
            const d2r = Math.PI / 180;
            w.rotation.set(rotation[0] * d2r, rotation[1] * d2r, rotation[2] * d2r);
        }
        if (scale !== undefined) {
            if (typeof scale === "number") w.scale.setScalar(scale);
            else if (scale) w.scale.set(scale[0], scale[1], scale[2]);
        }
        w.updateMatrixWorld(true);
        // Placement moved — keep the light/shadow/grid rig honest without
        // yanking the user's camera.
        this._updateSceneRig(this._visibleUnionBox());
        return this._transformOf(entry);
    }

    /** Reset an object's placement to identity (the non-destructive "undo"). */
    resetObjectTransform(id) {
        return this.setObjectTransform(id, {
            position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
        });
    }

    /** Frame the union of all visible objects (the whole composed scene). */
    frameAll() {
        const box = this._visibleUnionBox();
        if (!box) return false;
        this._frameToBox(box);
        return true;
    }

    /**
     * Serializable scene manifest (version 1). Objects with volatile sources
     * (drag-drops, revoked object URLs) are EXCLUDED and reported so callers can
     * warn — persisting a reference that cannot be re-resolved would rot the file.
     */
    getSceneManifest() {
        const objects = [];
        const skipped = [];
        const unsavedPaint = [];
        const unsavedEdits = [];
        for (const e of this._objects) {
            // Manifests store SOURCES + placements, not deltas: paint layers
            // (CanvasTextures) and sculpt/bake vertex edits are NOT persisted —
            // load_scene rebuilds pristine sources. The warnings must surface AT
            // SAVE TIME or agents lose work silently; export GLB keeps both.
            if (paintedMeshNames(e.model).length > 0) unsavedPaint.push(e.name);
            if (e.modified) unsavedEdits.push(e.name);
            if (!e.source || e.source.kind === "volatile") {
                skipped.push(e.name);
                continue;
            }
            objects.push({
                source: e.source,
                name: e.name,
                transform: this._transformOf(e),
                visible: e.visible,
                opacity: e.opacity,
            });
        }
        return {
            version: 1,
            objects,
            skippedVolatile: skipped,
            unsavedPaint,
            unsavedEdits,
            lighting: this.getLightSettings(),
            environment: this.getEnvironment(),
            background: this._background,
        };
    }

    // ==========================================================
    // Animation playback (017) — single source of truth for clips
    // ==========================================================

    /**
     * Set up the animation state for a freshly registered entry and notify the UI.
     *
     * Animation state is PER ENTRY ({mixer, actions, clips, activeAction, playing})
     * so co-loaded objects keep independent playback. Only the ACTIVE entry's mixer
     * advances in the render loop — deactivated objects FREEZE mid-pose and resume
     * where they were when re-activated (no reset). The "animations" event carries
     * the active entry's clip list (empty list ⇒ hide controls).
     */
    _setupAnimationsForEntry(entry) {
        const clips = (entry.model && entry.model.animations) ? entry.model.animations : [];
        entry.animation = null;

        if (clips.length > 0) {
            const mixer = new THREE.AnimationMixer(entry.model);
            const actions = clips.map((c) => mixer.clipAction(c));
            entry.animation = {
                mixer, actions, clips, activeAction: null, playing: false,
            };
            this.playAnimation(0);
        }

        this._dispatchAnimationsEvent(entry);
    }

    /** Emit the animation UI event for an entry (or a null/empty entry). */
    _dispatchAnimationsEvent(entry) {
        const clips = entry && entry.animation ? entry.animation.clips : [];
        this._container.dispatchEvent(new CustomEvent("animations", {
            detail: {
                clips: clips.map((c, i) => ({
                    index: i,
                    name: c.name || `Clip ${i + 1}`,
                    duration: c.duration,
                })),
            },
        }));
    }

    /** The ACTIVE entry's animation state (or null). */
    get _activeAnimation() {
        const entry = this._activeEntry();
        return entry ? entry.animation : null;
    }

    /** True if the active object has at least one animation clip. */
    hasAnimations() {
        const anim = this._activeAnimation;
        return !!(anim && anim.clips.length > 0);
    }

    /** Play the clip at `index` on the ACTIVE object (stops its other clips). */
    playAnimation(index) {
        this.invalidate();
        const anim = this._activeAnimation;
        if (!anim || !anim.actions[index]) return;
        for (const a of anim.actions) a.stop();
        const action = anim.actions[index];
        action.reset();
        action.paused = false;
        action.play();
        anim.activeAction = action;
        anim.playing = true;
    }

    /** Pause or resume the active object's clip. Returns the new playing state. */
    toggleAnimationPlay() {
        this.invalidate();
        const anim = this._activeAnimation;
        if (!anim || !anim.activeAction) return false;
        anim.activeAction.paused = !anim.activeAction.paused;
        anim.playing = !anim.activeAction.paused;
        return anim.playing;
    }

    setAnimationPlaying(playing) {
        this.invalidate();
        const anim = this._activeAnimation;
        if (!anim || !anim.activeAction) return;
        anim.activeAction.paused = !playing;
        anim.playing = playing;
    }

    /** Playback speed multiplier for the active object's mixer (1 = normal). */
    setAnimationSpeed(multiplier) {
        const anim = this._activeAnimation;
        if (anim && anim.mixer) anim.mixer.timeScale = multiplier;
    }

    /** Current active clip duration in seconds (0 if none). */
    getAnimationDuration() {
        const anim = this._activeAnimation;
        if (!anim || !anim.activeAction) return 0;
        return anim.activeAction.getClip().duration;
    }

    /** Current playback time in seconds. */
    getAnimationTime() {
        const anim = this._activeAnimation;
        return anim && anim.activeAction ? anim.activeAction.time : 0;
    }

    /** Seek the active clip to `seconds` (pauses so the frame holds). */
    setAnimationTime(seconds) {
        this.invalidate();
        const anim = this._activeAnimation;
        if (!anim || !anim.activeAction || !anim.mixer) return;
        anim.activeAction.paused = true;
        anim.playing = false;
        anim.activeAction.time = Math.max(0, Math.min(seconds, this.getAnimationDuration()));
        // Force the mixer to apply the new time to the skeleton/nodes.
        anim.mixer.update(0);
    }

    /**
     * Reset all viewer state when loading a new model.
     * Ensures clean slate: camera, navigation mode, FPV angles, scale, keys.
     */
    _resetViewerState() {
        // Switch back to orbit mode if in FPV
        if (this._navMode === "fpv") {
            this._navMode = "orbit";
            this._controls.enabled = true;
            this._fpvMouseDown = false;
            this._container.dispatchEvent(new CustomEvent("navmodechange", {
                detail: { mode: "orbit" }
            }));
        }

        // Clear keyboard state
        this._keysPressed.clear();

        // Reset FPV angles
        this._fpvYaw = 0;
        this._fpvPitch = 0;

        // Reset control-API state trackers so getState() never reports stale values
        // (a name/stats after a failed load). Scale + modified flags are per-entry
        // now (derived getters) — fresh entries start clean by construction.
        this._lastModelName = null;
        this._lastStats = { vertices: 0, faces: 0, width: 0, height: 0, depth: 0 };

        // Reset camera to default position (will be overridden by _frameModel)
        this._camera.position.set(3, 2.5, 4);
        this._controls.target.set(0, 0.5, 0);
        this._controls.update();
    }

    /**
     * Re-apply persistent scene settings (wireframe, grid, axis, background)
     * to the newly loaded model. These settings survive across model loads.
     */
    _applySceneSettings() {
        // Wireframe: apply current state to every object's meshes
        if (this._wireframeEnabled) {
            this.setWireframe(true);
        }

        // Normals: recreate helpers for the current objects
        if (this._normalsVisible) {
            this.setNormalsVisible(true);
        }

        // Render-mode override (solid/normals): an object arriving into a styled
        // scene must match it, or a clay-mode scene shows one textured newcomer.
        if (this._renderMode && this._renderMode !== "textured") {
            this.setRenderMode(this._renderMode);
        }

        // Grid and axis visibility are already preserved on their scene objects.
        // Background is also already preserved on the scene.
    }

    /** Dispose of an object and its children recursively */
    _disposeObject(obj) {
        obj.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach((m) => this._disposeMaterial(m));
                } else {
                    this._disposeMaterial(child.material);
                }
            }
        });
    }

    _disposeMaterial(material) {
        for (const key of Object.keys(material)) {
            const value = material[key];
            if (value && typeof value === "object" && value.isTexture) {
                value.dispose();
            }
        }
        material.dispose();
    }

    /**
     * Fully tear down the viewer. Critical for embedders that create/destroy repeatedly:
     * a WebGL context is a scarce resource (browsers cap ~16), so we must remove the
     * canvas, force-lose the context, dispose GPU resources, and detach every listener
     * we put on the embedder's container — otherwise old contexts get reclaimed and can
     * corrupt other live viewers on the page.
     */
    destroy() {
        if (this._animationId) {
            cancelAnimationFrame(this._animationId);
            this._animationId = null;
        }
        this._keysPressed.clear();
        if (this._resizeObserver) this._resizeObserver.disconnect();

        // Detach tracked container listeners (canvas listeners die with the canvas below).
        for (const { target, type, handler, opts } of this._trackedListeners) {
            target.removeEventListener(type, handler, opts);
        }
        this._trackedListeners = [];
        // Restore the container attribute we mutated.
        if (!this._hadTabIndex) this._container.removeAttribute("tabindex");

        this._clearModel();

        if (this._controls && this._controls.dispose) this._controls.dispose();
        if (this._ssaoPass && this._ssaoPass.dispose) this._ssaoPass.dispose();
        if (this._composer && this._composer.dispose) this._composer.dispose();

        if (this._envRT && this._envRT.dispose) this._envRT.dispose();
        if (this._pmrem && this._pmrem.dispose) this._pmrem.dispose();
        if (this._dracoLoader && this._dracoLoader.dispose) this._dracoLoader.dispose();
        if (this._ktx2Loader && this._ktx2Loader.dispose) this._ktx2Loader.dispose();

        if (this._renderer) {
            this._renderer.dispose();
            // renderer.dispose() does NOT release the GL context — force it.
            if (this._renderer.forceContextLoss) this._renderer.forceContextLoss();
            const canvas = this._renderer.domElement;
            if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        }
    }

    // ==========================================
    // Scene Setup
    // ==========================================

    _initScene() {
        this._scene = new THREE.Scene();

        // Subtle dark gradient background
        this._scene.background = new THREE.Color(0x0d0d1a);

        // Fog for depth perception
        this._scene.fog = new THREE.FogExp2(0x0d0d1a, 0.008);

        // Camera
        this._camera = new THREE.PerspectiveCamera(
            45,
            this._getAspect(),
            0.01,
            1000
        );
        this._camera.position.set(3, 2.5, 4);
    }

    _initLights() {
        // Hemisphere light for natural ambient
        this._hemiLight = new THREE.HemisphereLight(0xc8d8f0, 0x3a3a5c, 0.6);
        this._hemiLight.position.set(0, 20, 0);
        this._scene.add(this._hemiLight);

        // Key light (main directional) with shadows
        this._keyLight = new THREE.DirectionalLight(0xfff5e6, 1.2);
        this._keyLight.position.set(5, 8, 6);
        this._keyLight.castShadow = true;
        this._keyLight.shadow.mapSize.width = 2048;
        this._keyLight.shadow.mapSize.height = 2048;
        this._keyLight.shadow.camera.near = 0.1;
        this._keyLight.shadow.camera.far = 50;
        this._keyLight.shadow.camera.left = -10;
        this._keyLight.shadow.camera.right = 10;
        this._keyLight.shadow.camera.top = 10;
        this._keyLight.shadow.camera.bottom = -10;
        this._keyLight.shadow.bias = -0.001;
        this._keyLight.shadow.normalBias = 0.02;
        this._scene.add(this._keyLight);

        // Fill light (softer, from opposite side)
        this._fillLight = new THREE.DirectionalLight(0xb0c4de, 0.5);
        this._fillLight.position.set(-4, 4, -3);
        this._scene.add(this._fillLight);

        // Rim light (back light for edge definition)
        this._rimLight = new THREE.DirectionalLight(0x8090c0, 0.4);
        this._rimLight.position.set(0, 3, -6);
        this._scene.add(this._rimLight);

        // Ambient light as base fill
        this._ambientLight = new THREE.AmbientLight(0x404060, 0.3);
        this._scene.add(this._ambientLight);

        // Key light orientation state (azimuth/elevation in radians)
        // Default: ~45° azimuth, ~60° elevation — matches initial position (5, 8, 6)
        this._keyLightAzimuth = Math.PI / 4;
        this._keyLightElevation = Math.PI / 3;
        this._keyLightRadius = 10; // Updated when model is loaded
        this._modelCenter = new THREE.Vector3(0, 0.5, 0);
    }

    _initGround() {
        // Ground plane to receive shadows
        const groundGeo = new THREE.PlaneGeometry(50, 50);
        const groundMat = new THREE.ShadowMaterial({
            opacity: 0.3,
            color: 0x000000,
        });
        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = 0;
        ground.receiveShadow = true;
        this._scene.add(ground);
        this._ground = ground;

        // Grid helper — created dynamically in _rebuildGrid(), scaled to model
        this._gridVisible = false;
        this._grid = null;
        this._currentBgHex = "#0d0d1a";

        // Axis helper (starts hidden, toggled via UI)
        this._axisVisible = false;
        this._axisGroup = new THREE.Group();
        this._axisGroup.visible = false;
        this._scene.add(this._axisGroup);
        this._buildAxisHelper(2);
    }

    /**
     * Rebuild the grid to match the current model size and background.
     *
     * SOTA practice: grid extends ~8x the model footprint with cell
     * size proportional to model dimensions. This ensures the grid
     * is always visible and provides meaningful spatial reference
     * regardless of model scale.
     */
    _rebuildGrid(modelMaxDim, groundY) {
        // Remove existing grid
        if (this._grid) {
            this._scene.remove(this._grid);
            this._grid.dispose();
            this._grid = null;
        }

        // Grid size: 8x the largest model dimension, minimum 10 units
        const gridSize = Math.max(modelMaxDim * 8, 10);

        // Divisions: aim for cells roughly 1/20th of model size
        // with a minimum of 20 and maximum of 200 divisions
        const cellSize = Math.max(modelMaxDim / 10, 0.01);
        const divisions = Math.min(200, Math.max(20, Math.round(gridSize / cellSize)));

        // Choose colors based on background luminance
        const bgColor = new THREE.Color(this._currentBgHex);
        const lum = bgColor.r * 0.299 + bgColor.g * 0.587 + bgColor.b * 0.114;
        const isDark = lum < 0.4;

        const mainColor = isDark ? 0x5577bb : 0x666688;
        const subColor = isDark ? 0x334466 : 0x9999aa;
        const opacity = isDark ? 0.5 : 0.4;

        const grid = new THREE.GridHelper(gridSize, divisions, mainColor, subColor);
        grid.position.y = groundY + 0.001;
        grid.position.x = this._modelCenter.x;
        grid.position.z = this._modelCenter.z;
        grid.material.opacity = opacity;
        grid.material.transparent = true;
        grid.visible = this._gridVisible;
        this._scene.add(grid);
        this._grid = grid;
    }

    /**
     * Build the axis helper with colored lines and text labels.
     * X = red, Y = green, Z = blue (standard convention).
     */
    _buildAxisHelper(size) {
        // Clear previous
        while (this._axisGroup.children.length > 0) {
            const c = this._axisGroup.children[0];
            if (c.geometry) c.geometry.dispose();
            if (c.material) c.material.dispose();
            this._axisGroup.remove(c);
        }

        const axes = [
            { dir: new THREE.Vector3(1, 0, 0), color: 0xff4444, label: "X" },
            { dir: new THREE.Vector3(0, 1, 0), color: 0x44dd44, label: "Y" },
            { dir: new THREE.Vector3(0, 0, 1), color: 0x4488ff, label: "Z" },
        ];

        for (const axis of axes) {
            // Line
            const points = [
                new THREE.Vector3(0, 0, 0),
                axis.dir.clone().multiplyScalar(size),
            ];
            const geo = new THREE.BufferGeometry().setFromPoints(points);
            const mat = new THREE.LineBasicMaterial({
                color: axis.color,
                linewidth: 2,
                depthTest: false,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 999;
            this._axisGroup.add(line);

            // Label sprite
            const sprite = this._makeTextSprite(
                axis.label, axis.color, size
            );
            sprite.position.copy(axis.dir.clone().multiplyScalar(size * 1.15));
            sprite.renderOrder = 1000;
            this._axisGroup.add(sprite);
        }
    }

    /**
     * Create a text sprite for axis labels.
     */
    _makeTextSprite(text, color, size) {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext("2d");
        ctx.font = "bold 48px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#" + new THREE.Color(color).getHexString();
        ctx.fillText(text, 32, 32);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const mat = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.setScalar(size * 0.3);
        return sprite;
    }

    _initRenderer() {
        this._renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true,  // enable transparent-background captures (normal view stays opaque)
            preserveDrawingBuffer: true,  // Required for screenshot (toDataURL)
            powerPreference: "high-performance",
        });
        this._renderer.setSize(
            this._container.clientWidth,
            this._container.clientHeight
        );
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this._renderer.shadowMap.enabled = true;
        this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        // Shadows re-render only when something changes (invalidate() flags
        // needsUpdate). A static scene was re-rendering its shadow map every
        // frame — pure waste for a viewer whose scenes are mostly still.
        this._renderer.shadowMap.autoUpdate = false;
        this._renderer.shadowMap.needsUpdate = true;
        this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this._renderer.toneMappingExposure = 1.2;
        this._renderer.outputColorSpace = THREE.SRGBColorSpace;

        this._container.appendChild(this._renderer.domElement);

        // Async resource arrivals (textures decoding after the mesh parsed) must
        // repaint, or agents screenshot untextured models and humans see stale
        // frames until they touch the camera.
        THREE.DefaultLoadingManager.onLoad = () => this.invalidate();
    }

    _initControls() {
        this._controls = new OrbitControls(
            this._camera,
            this._renderer.domElement
        );
        this._controls.enableDamping = true;
        this._controls.dampingFactor = 0.08;
        this._controls.enablePan = true;
        this._controls.enableZoom = true;
        this._controls.minDistance = 0.01;
        this._controls.maxDistance = 1000;
        this._controls.target.set(0, 0.5, 0);
        this._controls.update();
        // Demand-driven rendering: camera motion (user input AND damping settle
        // frames) requests repaints; when motion stops, the loop goes idle.
        this._controls.addEventListener("change", () => this.invalidate());
    }

    /**
     * Initialize right-click-to-set-pivot behavior.
     *
     * A quick right-click (without dragging) raycasts onto the model
     * surface and sets the orbit controls target to that point.
     * Right-drag still works as pan (handled by OrbitControls).
     * Spacebar reset restores the original pivot.
     */
    _initPivotPick() {
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();
        let rightDownPos = null;
        let rightDownTime = 0;
        const CLICK_THRESHOLD_PX = 5;   // Max pixel movement to count as click
        const CLICK_THRESHOLD_MS = 300; // Max hold time to count as click

        // Suppress browser context menu on the viewer
        this._renderer.domElement.addEventListener("contextmenu", (e) => {
            e.preventDefault();
        });

        this._renderer.domElement.addEventListener("mousedown", (e) => {
            if (e.button === 2) {
                rightDownPos = { x: e.clientX, y: e.clientY };
                rightDownTime = performance.now();
            }
        });

        this._renderer.domElement.addEventListener("mouseup", (e) => {
            if (e.button !== 2 || !rightDownPos) return;

            const dx = e.clientX - rightDownPos.x;
            const dy = e.clientY - rightDownPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const elapsed = performance.now() - rightDownTime;

            rightDownPos = null;

            // Only treat as a pivot-pick if it was a quick click, not a drag
            if (dist > CLICK_THRESHOLD_PX || elapsed > CLICK_THRESHOLD_MS) return;

            // No model loaded — nothing to raycast against
            if (!this._currentModel) return;

            // Compute normalized device coordinates from click position
            const rect = this._renderer.domElement.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            raycaster.setFromCamera(mouse, this._camera);

            // Collect meshes from EVERY visible object (pivot works scene-wide)
            const hits = raycaster.intersectObjects(this._visibleMeshes(), false);
            if (hits.length > 0) {
                const point = hits[0].point;
                this._controls.target.copy(point);
                this._controls.update();
            }
        });
    }

    // ==========================================================
    // Measurement (020) — point-to-point distance on the model surface
    // ==========================================================

    _initMeasurement() {
        this._measureMode = false;
        this._measurePoints = [];
        this._measureGroup = new THREE.Group();
        this._measureGroup.name = "__measure__";
        this._scene.add(this._measureGroup);

        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();
        const canvas = this._renderer.domElement;
        const CLICK_PX = 6;
        const CLICK_MS = 350;
        let downPos = null;
        let downTime = 0;

        canvas.addEventListener("mousedown", (e) => {
            if (e.button !== 0 || !this._measureMode) return;
            downPos = { x: e.clientX, y: e.clientY };
            downTime = performance.now();
        });

        canvas.addEventListener("mouseup", (e) => {
            if (e.button !== 0 || !this._measureMode || !downPos) return;
            const dx = e.clientX - downPos.x;
            const dy = e.clientY - downPos.y;
            const dist = Math.hypot(dx, dy);
            const elapsed = performance.now() - downTime;
            downPos = null;
            if (dist > CLICK_PX || elapsed > CLICK_MS) return; // was a drag/orbit
            if (!this._currentModel) return;

            const rect = canvas.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(mouse, this._camera);

            // Measure across EVERY visible object (world-space distances).
            const hits = raycaster.intersectObjects(this._visibleMeshes(), false);
            if (hits.length === 0) return;
            this._addMeasurePoint(hits[0].point.clone());
        });
    }

    /** Toggle measurement mode. Returns the new state. */
    toggleMeasureMode() {
        this._measureMode = !this._measureMode;
        if (!this._measureMode) this._clearMeasurement();
        return this._measureMode;
    }

    /**
     * Programmatic measurement between two world-space points (for the control API /
     * AI agents). Draws the markers + line + label and returns the distance.
     * @param {number[]} a - [x,y,z]
     * @param {number[]} b - [x,y,z]
     */
    measureBetween(a, b) {
        this._clearMeasurement();
        this._addMeasurePoint(new THREE.Vector3(a[0], a[1], a[2]));
        this._addMeasurePoint(new THREE.Vector3(b[0], b[1], b[2]));
        return this._measurePoints[0].distanceTo(this._measurePoints[1]);
    }

    _clearMeasurement() {
        this.invalidate();
        this._measurePoints = [];
        while (this._measureGroup.children.length) {
            const child = this._measureGroup.children.pop();
            child.geometry?.dispose();
            child.material?.map?.dispose();
            child.material?.dispose();
        }
    }

    _addMeasurePoint(point) {
        this.invalidate();
        // A third click starts a fresh measurement.
        if (this._measurePoints.length >= 2) this._clearMeasurement();
        this._measurePoints.push(point);

        // Marker sphere sized relative to the model for visibility at any scale.
        const r = this._measureMarkerRadius();
        const marker = new THREE.Mesh(
            new THREE.SphereGeometry(r, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false })
        );
        marker.position.copy(point);
        marker.renderOrder = 999;
        this._measureGroup.add(marker);

        if (this._measurePoints.length === 2) {
            this._drawMeasureLine(this._measurePoints[0], this._measurePoints[1]);
        }
    }

    _measureMarkerRadius() {
        // Sized from the visible-scene union so markers stay readable when
        // measuring between objects of very different sizes.
        const box = this._visibleUnionBox();
        if (!box) return 0.02;
        const size = box.getSize(new THREE.Vector3()).length();
        return Math.max(size * 0.008, 1e-4);
    }

    _drawMeasureLine(a, b) {
        const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
        const line = new THREE.Line(
            geom,
            new THREE.LineBasicMaterial({ color: 0xffcc33, depthTest: false })
        );
        line.renderOrder = 999;
        this._measureGroup.add(line);

        const distance = a.distanceTo(b);
        const label = this._makeMeasureLabel(distance);
        label.position.copy(a).add(b).multiplyScalar(0.5);
        this._measureGroup.add(label);

        this._container.dispatchEvent(new CustomEvent("measurement", {
            detail: { distance },
        }));
    }

    _makeMeasureLabel(distance) {
        const text = distance < 1 ? distance.toFixed(3) : distance.toFixed(2);
        const canvas = document.createElement("canvas");
        canvas.width = 256; canvas.height = 64;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "rgba(20,20,30,0.85)";
        ctx.fillRect(0, 0, 256, 64);
        ctx.fillStyle = "#ffcc33";
        ctx.font = "bold 28px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 128, 32);
        const tex = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: tex, depthTest: false })
        );
        const s = this._measureMarkerRadius() * 8;
        sprite.scale.set(s * 4, s, 1);
        sprite.renderOrder = 1000;
        return sprite;
    }

    /**
     * Initialize keyboard navigation.
     *
     * In Orbit mode: only Spacebar (reset view) is active.
     * In FPV mode: full drone controls:
     *   W/S = forward/backward (along camera's true look direction)
     *   A/D = yaw left/right (rotate the drone)
     *   ↑/↓ = pitch up/down
     *   ←/→ = yaw left/right
     *   E/Shift = altitude up, Q/Ctrl = altitude down
     *   Spacebar = reset view
     */
    /** Attach a listener to the embedder-owned container and track it for destroy(). */
    _onContainer(type, handler, opts) {
        this._container.addEventListener(type, handler, opts);
        this._trackedListeners.push({ target: this._container, type, handler, opts });
    }

    _initKeyboardNav() {
        // Make the container focusable so it captures keyboard events
        this._hadTabIndex = this._container.hasAttribute("tabindex");
        this._container.setAttribute("tabindex", "0");
        this._container.style.outline = "none";

        this._onContainer("keydown", (e) => {
            const key = e.key.toLowerCase();

            // Spacebar: reset view (both modes)
            if (e.code === "Space") {
                e.preventDefault();
                this._resetView();
                return;
            }

            // Only process nav keys in FPV mode
            if (this._navMode !== "fpv") return;

            const navKeys = [
                "w", "a", "s", "d", "q", "e",
                "arrowup", "arrowdown", "arrowleft", "arrowright",
                "shift", "control",
            ];
            if (navKeys.includes(key)) {
                e.preventDefault();
                this._keysPressed.add(key);
            }
        });

        this._onContainer("keyup", (e) => {
            this._keysPressed.delete(e.key.toLowerCase());
        });

        // Clear keys when focus is lost to prevent stuck movement
        this._onContainer("blur", () => {
            this._keysPressed.clear();
        });

        // Auto-focus the viewer when mouse enters, so keyboard works immediately
        this._onContainer("mouseenter", () => {
            this._container.focus();
        });
    }

    /**
     * Initialize FPV mouse look behavior.
     *
     * In FPV mode, left-click drag rotates the camera (yaw + pitch).
     * Mouse sensitivity is tuned for smooth control.
     */
    _initFPVMouseLook() {
        const canvas = this._renderer.domElement;
        const sensitivity = 0.003;

        canvas.addEventListener("mousedown", (e) => {
            if (this._navMode !== "fpv") return;
            if (e.button === 0) { // Left button
                this._fpvMouseDown = true;
                e.preventDefault();
            }
        });

        canvas.addEventListener("mousemove", (e) => {
            if (!this._fpvMouseDown || this._navMode !== "fpv") return;

            this._fpvYaw -= e.movementX * sensitivity;
            this._fpvPitch -= e.movementY * sensitivity;

            // Clamp pitch to avoid flipping (-85° to +85°)
            const limit = Math.PI * 0.47;
            this._fpvPitch = Math.max(-limit, Math.min(limit, this._fpvPitch));

            this._updateFPVCamera();
        });

        canvas.addEventListener("mouseup", (e) => {
            if (e.button === 0) this._fpvMouseDown = false;
        });

        canvas.addEventListener("mouseleave", () => {
            this._fpvMouseDown = false;
        });
    }

    /**
     * Update camera orientation from FPV yaw/pitch angles.
     */
    _updateFPVCamera() {
        // Build direction vector from yaw and pitch
        const dir = new THREE.Vector3(
            Math.sin(this._fpvYaw) * Math.cos(this._fpvPitch),
            Math.sin(this._fpvPitch),
            Math.cos(this._fpvYaw) * Math.cos(this._fpvPitch)
        );

        // Camera looks at a point 1 unit ahead in that direction
        const target = this._camera.position.clone().add(dir);
        this._camera.lookAt(target);
    }

    /**
     * Apply FPV drone movement each frame.
     *
     * W/Shift = move forward along camera's TRUE look direction
     * S/Ctrl  = move backward
     * A/D and ←/→ = yaw (rotate the drone left/right)
     * ↑/↓ = pitch (tilt the drone up/down)
     * E = altitude up, Q = altitude down
     */
    _applyFPVMovement(delta) {
        if (this._navMode !== "fpv") return;
        if (this._keysPressed.size === 0) return;

        const speed = this._moveSpeed * delta;
        const yawRate = this._yawSpeed * delta;
        const pitchRate = this._yawSpeed * 0.6 * delta;

        // Camera's true forward direction (where it's pointing, including pitch)
        const forward = new THREE.Vector3();
        this._camera.getWorldDirection(forward);

        // World up
        const up = new THREE.Vector3(0, 1, 0);

        const move = new THREE.Vector3();

        // Forward / backward along camera's true look direction
        // W and Shift = forward thrust, S and Ctrl = backward thrust
        if (this._keysPressed.has("w") || this._keysPressed.has("shift")) {
            move.add(forward.clone().multiplyScalar(speed));
        }
        if (this._keysPressed.has("s") || this._keysPressed.has("control")) {
            move.add(forward.clone().multiplyScalar(-speed));
        }

        // Yaw: A/D and arrow left/right ROTATE the drone
        if (this._keysPressed.has("a") || this._keysPressed.has("arrowleft")) {
            this._fpvYaw += yawRate;
        }
        if (this._keysPressed.has("d") || this._keysPressed.has("arrowright")) {
            this._fpvYaw -= yawRate;
        }

        // Pitch: arrow up/down tilt the drone
        if (this._keysPressed.has("arrowup")) {
            this._fpvPitch += pitchRate;
        }
        if (this._keysPressed.has("arrowdown")) {
            this._fpvPitch -= pitchRate;
        }

        // Clamp pitch
        const limit = Math.PI * 0.47;
        this._fpvPitch = Math.max(-limit, Math.min(limit, this._fpvPitch));

        // Altitude (E = up, Q = down)
        if (this._keysPressed.has("e")) {
            move.add(up.clone().multiplyScalar(speed));
        }
        if (this._keysPressed.has("q")) {
            move.add(up.clone().multiplyScalar(-speed));
        }

        // Apply translation
        if (move.lengthSq() > 0) {
            this._camera.position.add(move);
        }

        // Apply rotation
        this._updateFPVCamera();
    }

    // ==========================================
    // Mode Switching
    // ==========================================

    /**
     * Set the navigation mode.
     * @param {'orbit'|'fpv'} mode
     */
    setNavMode(mode) {
        this.invalidate();
        if (mode === this._navMode) return;

        this._keysPressed.clear();

        if (mode === "fpv") {
            // Switching to FPV: extract yaw/pitch from current camera orientation
            const dir = new THREE.Vector3();
            this._camera.getWorldDirection(dir);
            this._fpvYaw = Math.atan2(dir.x, dir.z);
            this._fpvPitch = Math.asin(
                Math.max(-1, Math.min(1, dir.y))
            );

            // Disable orbit controls
            this._controls.enabled = false;

        } else {
            // Switching to Orbit: re-enable orbit controls
            // Set orbit target to a point in front of the camera
            const dir = new THREE.Vector3();
            this._camera.getWorldDirection(dir);
            const dist = this._camera.position.distanceTo(this._modelCenter);
            this._controls.target.copy(
                this._camera.position.clone().add(dir.multiplyScalar(dist * 0.5))
            );
            this._controls.enabled = true;
            this._controls.update();
        }

        this._navMode = mode;
        this._fpvMouseDown = false;
    }

    /** Get the current navigation mode. */
    getNavMode() {
        return this._navMode;
    }

    /**
     * Reset the camera to the initial framed view (spacebar).
     * Also switches back to orbit mode.
     */
    _resetView() {
        this._restoreFocusClip();  // undo any part-focus near/far + distance clamps
        this._camera.position.copy(this._initialCameraPos);
        this._controls.target.copy(this._initialTarget);
        this._controls.enabled = true;
        this._controls.update();

        // Reset to orbit mode
        if (this._navMode === "fpv") {
            this._navMode = "orbit";
            this._fpvMouseDown = false;
            this._keysPressed.clear();
            // Notify the UI toggle (via custom event)
            this._container.dispatchEvent(new CustomEvent("navmodechange", {
                detail: { mode: "orbit" }
            }));
        }
    }

    // ==========================================================
    // Control-API surface (used by the standalone viewer + AI agents)
    // ==========================================================

    /** Public wrapper: re-frame the camera to fit the current model. */
    frameModel() {
        if (this._currentModel) this._frameModel(this._currentModel);
    }

    /** Public wrapper: reset the camera to the initial framed view (orbit). */
    resetView() {
        this._resetView();
    }

    /**
     * Set the camera to an explicit position and look-at target (world coords).
     * @param {number[]} position - [x,y,z]
     * @param {number[]} [target] - [x,y,z]; defaults to current target
     */
    setCamera(position, target, fov) {
        this.invalidate();
        if (this._navMode === "fpv") this.setNavMode("orbit");
        this._camera.position.set(position[0], position[1], position[2]);
        if (target) this._controls.target.set(target[0], target[1], target[2]);
        if (typeof fov === "number" && fov >= 1 && fov <= 179) {
            this._camera.fov = fov;
            this._camera.updateProjectionMatrix();
        }
        this._controls.update();
        return true;
    }

    /** Remove EVERY object and reset viewer state (empty scene afterwards). */
    unload() {
        this._clearAllObjects();
        this._lastModelName = null;
        this._lastStats = { vertices: 0, faces: 0, width: 0, height: 0, depth: 0 };
        this._dispatchAnimationsEvent(null);
        this._container.dispatchEvent(new CustomEvent("objectschange", {
            detail: { objects: [], activeId: null },
        }));
        return true;
    }

    // ==========================================================
    // Part-level exploration (focus) — frame a named/id'd part or a world point.
    // Reduced design from the adversarial review: keep the current view direction
    // (the only predictable policy), retarget the orbit controls, and — the load-
    // bearing part — rescale near/far and the orbit distance clamps, because a part
    // smaller than ~1/800 of the model otherwise vanishes behind the near plane.
    // Occlusion is explicitly out of scope (use set_clip / set_render_mode).
    // ==========================================================

    /**
     * Enumerate focusable parts: every mesh (stable traversal-order id, matching
     * describe_scene ids) and every NAMED group with mesh descendants.
     */
    listParts() {
        const meshes = [];
        const groups = [];
        if (!this._currentModel) return { meshes, groups };
        let id = 0;
        this._currentModel.updateMatrixWorld(true);
        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                meshes.push({ id: id++, name: child.name || "(unnamed)", object: child });
            } else if (!child.isMesh && child.name && child !== this._currentModel) {
                let hasMesh = false;
                child.traverse((d) => { if (d.isMesh) hasMesh = true; });
                if (hasMesh) groups.push({ name: child.name, object: child });
            }
        });
        return { meshes, groups };
    }

    /** World-space Box3 of an object (mesh: geometry bbox × matrixWorld; group: union). */
    _worldBoxOf(object) {
        const box = new THREE.Box3();
        object.traverse((child) => {
            if (!child.isMesh || !child.geometry) return;
            const geo = child.geometry;
            if (!geo.boundingBox) geo.computeBoundingBox();
            if (!geo.boundingBox || geo.boundingBox.isEmpty()) return;
            box.union(geo.boundingBox.clone().applyMatrix4(child.matrixWorld));
        });
        return box;
    }

    /**
     * Focus the camera on a part of the model or a world-space point.
     *
     * @param {object} opts
     * @param {number}   [opts.id]     - stable mesh id (from describe_scene / get_scene_info)
     * @param {string}   [opts.name]   - mesh or group name; exact > case-insensitive >
     *                                   substring. Ambiguity returns an error listing candidates.
     * @param {number[]} [opts.point]  - [x,y,z] world point to focus instead of a part
     * @param {number}   [opts.radius] - framing radius for point focus (default 5% of model)
     * @param {number}   [opts.fill]   - framing tightness (0.1..1)
     * @returns {object} { target, center, size, distance, camera } — or throws with candidates.
     */
    focusOn(opts = {}) {
        if (!this._currentModel) throw new Error("No model loaded");
        const { meshes, groups } = this.listParts();

        let object = null;
        let target = null;
        let box = null;

        if (opts.id !== undefined && opts.id !== null) {
            const hit = meshes.find((m) => m.id === opts.id);
            if (!hit) throw new Error(
                `No mesh with id ${opts.id}. Valid ids: 0..${meshes.length - 1} (see describe_scene).`);
            object = hit.object;
            target = { kind: "mesh", id: hit.id, name: hit.name };
        } else if (opts.name) {
            const all = [
                ...meshes.map((m) => ({ ...m, kind: "mesh" })),
                ...groups.map((g) => ({ ...g, kind: "group" })),
            ];
            const q = String(opts.name);
            const ql = q.toLowerCase();
            // Tiered matching: exact > case-insensitive > substring (case-insensitive).
            let matches = all.filter((p) => p.name === q);
            if (matches.length === 0) matches = all.filter((p) => p.name.toLowerCase() === ql);
            if (matches.length === 0) matches = all.filter((p) => p.name.toLowerCase().includes(ql));
            if (matches.length === 0) {
                const names = all.slice(0, 12).map((p) => p.kind === "mesh" ? `${p.name} (id ${p.id})` : `${p.name} (group)`);
                throw new Error(`No part matches "${q}". Parts: ${names.join(", ")}${all.length > 12 ? ", …" : ""}`);
            }
            if (matches.length > 1) {
                const names = matches.slice(0, 12).map((p) => p.kind === "mesh" ? `${p.name} (id ${p.id})` : `${p.name} (group)`);
                throw new Error(`Ambiguous name "${q}" — ${matches.length} matches: ${names.join(", ")}. Use a mesh id.`);
            }
            object = matches[0].object;
            target = { kind: matches[0].kind, id: matches[0].id, name: matches[0].name };
        } else if (Array.isArray(opts.point) && opts.point.length === 3) {
            const modelBox = new THREE.Box3().setFromObject(this._currentModel);
            const modelMax = modelBox.getSize(new THREE.Vector3());
            const r = opts.radius || Math.max(modelMax.x, modelMax.y, modelMax.z) * 0.05 || 0.1;
            const c = new THREE.Vector3(...opts.point);
            box = new THREE.Box3(
                c.clone().subScalar(r), c.clone().addScalar(r));
            target = { kind: "point", point: opts.point, radius: r };
        } else {
            throw new Error("focus requires one of: id (mesh id), name (mesh/group name), or point [x,y,z]");
        }

        if (!box) {
            box = this._worldBoxOf(object);
            if (box.isEmpty()) throw new Error(`Part "${target.name}" has no geometry to frame`);
        }
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 0.001;

        // Keep the current view direction — the only policy without pathological cases.
        if (this._navMode === "fpv") this.setNavMode("orbit");
        const dir = this._camera.position.clone().sub(this._controls.target);
        if (dir.lengthSq() < 1e-12) dir.set(1, 0.6, 1);
        dir.normalize();

        const distance = this._frameDistance(maxDim, opts.fill || 0.7);
        this._camera.position.copy(center).addScaledVector(dir, distance);
        this._controls.target.copy(center);

        // The substance: rescale clip planes + orbit clamps to the part, or a small part
        // is invisible (near-plane) and the orbit distance clamp blocks getting close.
        if (!this._preFocusClip) {
            this._preFocusClip = {
                near: this._camera.near, far: this._camera.far,
                minDistance: this._controls.minDistance,
                maxDistance: this._controls.maxDistance,
            };
        }
        const modelBox = new THREE.Box3().setFromObject(this._currentModel);
        const modelSpan = modelBox.getSize(new THREE.Vector3()).length() || distance * 10;
        this._camera.near = Math.max(distance * 0.001, 1e-7);
        this._camera.far = Math.max(distance * 10, modelSpan * 4);
        this._camera.updateProjectionMatrix();
        this._controls.minDistance = distance * 0.05;
        this._controls.maxDistance = Math.max(this._preFocusClip.maxDistance, modelSpan * 4);
        this._controls.update();
        this._refreshCameraClip && this._refreshCameraClip();

        const r3 = (v) => Math.round(v * 1000) / 1000;
        return {
            target,
            center: [r3(center.x), r3(center.y), r3(center.z)],
            size: [r3(size.x), r3(size.y), r3(size.z)],
            distance: r3(distance),
            camera: {
                position: [r3(this._camera.position.x), r3(this._camera.position.y), r3(this._camera.position.z)],
                target: [r3(center.x), r3(center.y), r3(center.z)],
            },
            note: "View direction kept. The part may be occluded by surrounding geometry — use set_clip or set_render_mode wireframe to see through. reset_camera restores the whole-model view.",
        };
    }

    /** Restore pre-focus clip planes / orbit clamps (called by reset & frame paths). */
    _restoreFocusClip() {
        if (!this._preFocusClip) return;
        this._camera.near = this._preFocusClip.near;
        this._camera.far = this._preFocusClip.far;
        this._camera.updateProjectionMatrix();
        this._controls.minDistance = this._preFocusClip.minDistance;
        this._controls.maxDistance = this._preFocusClip.maxDistance;
        this._preFocusClip = null;
    }

    /** Distance from the model center that frames it to a target fill fraction. */
    _frameDistance(maxDim, fill) {
        const fov = this._camera.fov * (Math.PI / 180);
        const base = maxDim / (2 * Math.tan(fov / 2));
        // fill in (0,1]: higher = tighter. Default 0.55 reproduces the classic 1.8× pad.
        const f = fill ? Math.max(0.1, Math.min(1, fill)) : 0.55;
        return base / f;
    }

    /** Place the camera along a unit direction, framed to fill the current model —
     *  or the whole visible scene with scope:"scene" (multi-object tableaus need
     *  angled shots without hand-computed set_camera positions). */
    _placeCamera(dir, fill, up, scope) {
        let box = null;
        if (scope === "scene") {
            box = this._visibleUnionBox();
        }
        if (!box || box.isEmpty()) {
            box = new THREE.Box3().setFromObject(this._currentModel);
        }
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const distance = this._frameDistance(maxDim, fill);
        if (this._navMode === "fpv") this.setNavMode("orbit");
        // Reset roll to world-up by default so presets/orbit are consistent; autoUpright
        // (or an explicit up) overrides it afterward.
        this._camera.up.copy(up ? up.clone().normalize() : new THREE.Vector3(0, 1, 0));
        this._camera.position.copy(center.clone().add(dir.clone().normalize().multiplyScalar(distance)));
        this._controls.target.copy(center);
        this._controls.update();
        return true;
    }

    /**
     * Auto-upright the CURRENT view by choosing the camera roll (up-vector) that makes
     * the framed subject look correctly oriented. This solves the "model was baked lying
     * down" case: score_views finds the right azimuth, but a lying-down face still
     * appears sideways — rotating the camera up-vector around the view axis fixes it
     * without mutating the model.
     *
     * Scoring per candidate roll: vertical bilateral symmetry (faces/heads/most subjects
     * are left-right symmetric about their up axis) with a top-heaviness tie-break to
     * reject the upside-down twin (visible detail sits in the upper half for real subjects).
     */
    autoUpright(opts = {}) {
        if (!this._currentModel) return false;
        const r = this._renderer, cam = this._camera;
        const size = opts.size || 96;
        const steps = opts.steps || 12; // roll candidates over 360°

        const viewDir = cam.position.clone().sub(this._controls.target).normalize();
        // A stable reference up perpendicular to the view direction.
        let ref = new THREE.Vector3(0, 1, 0);
        if (Math.abs(viewDir.dot(ref)) > 0.95) ref = new THREE.Vector3(0, 0, 1);
        ref.sub(viewDir.clone().multiplyScalar(ref.dot(viewDir))).normalize();

        // Snapshot state.
        const prevUp = cam.up.clone();
        const prevAspect = cam.aspect;
        const prevBg = this._scene.background, prevFog = this._scene.fog;
        const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
        const prevGrid = this.getGridVisible(), prevAxes = this.getAxisVisible();
        const prevGround = this._ground ? this._ground.visible : true;
        const prevClip = r.clippingPlanes;
        const scoreMat = new THREE.MeshNormalMaterial();
        const savedMats = [];
        const rt = new THREE.WebGLRenderTarget(size, size);
        const buf = new Uint8Array(size * size * 4);

        let bestUp = prevUp.clone(), bestScore = -Infinity;
        // Scoring must see ONLY the active object: co-loaded neighbors would
        // contaminate the symmetry/detail measurements.
        const hiddenWrappers = [];
        for (const e of this._objects) {
            if (e.id !== this._activeObjectId && e.wrapper.visible) {
                e.wrapper.visible = false;
                hiddenWrappers.push(e.wrapper);
            }
        }
        try {
            this._currentModel.traverse((c) => { if (c.isMesh) { savedMats.push([c, c.material]); c.material = scoreMat; } });
            this.setGridVisible(false); this.setAxisVisible(false);
            if (this._ground) this._ground.visible = false;
            r.clippingPlanes = [];
            this._scene.background = null; this._scene.fog = null;
            r.setClearColor(0x000000, 0);
            cam.aspect = 1; cam.updateProjectionMatrix();

            for (let i = 0; i < steps; i++) {
                const roll = (2 * Math.PI * i) / steps;
                const up = ref.clone().applyAxisAngle(viewDir, roll);
                cam.up.copy(up);
                cam.lookAt(this._controls.target);
                r.setRenderTarget(rt);
                r.render(this._scene, cam);
                r.readRenderTargetPixels(rt, 0, 0, size, size, buf);
                r.setRenderTarget(null);
                const s = this._uprightScore(buf, size);
                if (s > bestScore) { bestScore = s; bestUp = up.clone(); }
            }
        } finally {
            for (const [c, m] of savedMats) c.material = m;
            for (const w of hiddenWrappers) w.visible = true;
            scoreMat.dispose(); rt.dispose(); r.setRenderTarget(null);
            this._scene.background = prevBg; this._scene.fog = prevFog;
            r.setClearColor(prevClear, prevAlpha); r.clippingPlanes = prevClip;
            this.setGridVisible(prevGrid); this.setAxisVisible(prevAxes);
            if (this._ground) this._ground.visible = prevGround;
            cam.aspect = prevAspect; cam.updateProjectionMatrix();
        }

        // Apply the winning up-vector.
        cam.up.copy(bestUp);
        this._controls.update();
        return true;
    }

    /**
     * Upright score for a rendered thumbnail: left-right (vertical-axis) symmetry of the
     * coverage mask, plus a top-heaviness bonus so an upside-down subject scores lower.
     */
    _uprightScore(buf, size) {
        let match = 0, total = 0;
        let topCover = 0, botCover = 0;
        const covered = (x, y) => buf[(y * size + x) * 4 + 3] > 16 ? 1 : 0;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size / 2; x++) {
                const a = covered(x, y), b = covered(size - 1 - x, y);
                if (a || b) { total++; if (a === b) match++; }
            }
            for (let x = 0; x < size; x++) {
                if (covered(x, y)) { if (y < size / 2) topCover++; else botCover++; }
            }
        }
        const symmetry = total > 0 ? match / total : 0;
        const totalCover = topCover + botCover;
        // Real subjects (faces, busts, most props) carry a bit more mass/detail high up
        // (head above chin/neck). Small bonus breaks the upright-vs-upside-down tie.
        const topHeavy = totalCover > 0 ? topCover / totalCover : 0.5;
        return symmetry + 0.15 * topHeavy;
    }

    /**
     * Point the camera at a named preset around the current model.
     * @param {'front'|'back'|'left'|'right'|'top'|'bottom'|'iso'} preset
     * @param {object} [opts] - { fill } fraction (0..1, higher = tighter framing)
     */
    setCameraView(preset, opts = {}) {
        if (!this._currentModel) return false;
        const dirs = {
            front: [0, 0, 1], back: [0, 0, -1],
            left: [-1, 0, 0], right: [1, 0, 0],
            top: [0, 1, 0], bottom: [0, -1, 0],
            iso: [1, 0.6, 1],
        };
        const d = dirs[preset];
        if (!d) return false;
        return this._placeCamera(new THREE.Vector3(d[0], d[1], d[2]), opts.fill, null, opts.scope);
    }

    /**
     * Orbit the camera to spherical angles around the model center and frame it.
     * @param {number} azimuthDeg - rotation around Y (0 = +Z / "front")
     * @param {number} elevationDeg - angle above the horizon
     * @param {object} [opts] - { fill }
     */
    orbitTo(azimuthDeg, elevationDeg, opts = {}) {
        if (!this._currentModel) return false;
        const az = azimuthDeg * Math.PI / 180;
        const el = elevationDeg * Math.PI / 180;
        const dir = new THREE.Vector3(
            Math.cos(el) * Math.sin(az),
            Math.sin(el),
            Math.cos(el) * Math.cos(az),
        );
        return this._placeCamera(dir, opts.fill, null, opts.scope);
    }

    /**
     * Frame the model. By default keeps the CURRENT view direction (so "front then
     * frame" works); pass keepDirection:false for an iso fit. `fill` controls tightness.
     */
    frameView(opts = {}) {
        if (!this._currentModel) return false;
        let dir;
        if (opts.keepDirection === false) {
            dir = new THREE.Vector3(1, 0.6, 1);
        } else {
            dir = this._camera.position.clone().sub(this._controls.target);
            if (dir.lengthSq() < 1e-9) dir = new THREE.Vector3(1, 0.6, 1);
        }
        return this._placeCamera(dir, opts.fill);
    }

    // ==========================================================
    // "Which way is front?" — there is no universal geometric front for an arbitrary
    // mesh (it's semantic). The world-axis presets (front=+Z, etc.) are just a
    // convention and are wrong for mis-oriented models. So instead of guessing, we let
    // an agent MEASURE: render the model from many angles offscreen and score each by
    // how much visible detail it shows (edge/contrast energy). The most "interesting"
    // side — a face's features, a device's control panel — scores highest.
    // ==========================================================

    /**
     * Score candidate camera directions by visible detail and return them ranked.
     * @param {object} [opts]
     * @param {number[]} [opts.azimuths] - degrees around Y to sample (default every 30°)
     * @param {number[]} [opts.elevations] - degrees above horizon (default [0, 20])
     * @param {number} [opts.size] - offscreen render size (default 96)
     * @param {number} [opts.fill] - framing tightness for scoring (default 0.9)
     * @returns {{azimuth:number, elevation:number, score:number, coverage:number}[]}
     */
    scoreViews(opts = {}) {
        if (!this._currentModel) return [];
        const azimuths = opts.azimuths || [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
        const elevations = opts.elevations || [0, 20];
        const size = opts.size || 96;
        const fill = opts.fill || 0.9;

        const r = this._renderer, cam = this._camera;
        // Snapshot ALL state we touch, so a throw mid-loop can't leave the viewer broken.
        const prevPos = cam.position.clone();
        const prevTarget = this._controls.target.clone();
        const prevAspect = cam.aspect;
        const prevBg = this._scene.background;
        const prevFog = this._scene.fog;
        const prevClear = r.getClearColor(new THREE.Color());
        const prevAlpha = r.getClearAlpha();
        const prevGrid = this.getGridVisible();
        const prevAxes = this.getAxisVisible();
        const prevGround = this._ground ? this._ground.visible : true;
        const prevClipPlanes = r.clippingPlanes;

        const rt = new THREE.WebGLRenderTarget(size, size);
        const buf = new Uint8Array(size * size * 4);
        const results = [];

        // A model's semantic "front" is not captured by any single signal:
        //  - GEOMETRY detail (normal-material edges) finds a device's bezel/panel but is
        //    fooled by hair strands (a face's back scores high geometrically).
        //  - ALBEDO/texture detail (unlit basic-material edges) finds a face's eyes/mouth
        //    but ignores smooth painted panels.
        // Both are LIGHTING-INDEPENDENT (no directional light), fixing the earlier bias
        // where the "best" view just tracked the key light. We render both per candidate
        // and combine the normalized scores, so faces AND devices are handled.
        const normalMat = new THREE.MeshNormalMaterial();
        const savedMats = [];
        const albedoMats = [];
        this._currentModel.traverse((child) => {
            if (!child.isMesh) return;
            savedMats.push([child, child.material]);
            const m0 = Array.isArray(child.material) ? child.material[0] : child.material;
            albedoMats.push([child, new THREE.MeshBasicMaterial({
                map: m0 && m0.map ? m0.map : null,
                color: m0 && m0.color ? m0.color.clone() : new THREE.Color(0x999999),
                side: THREE.DoubleSide,
            })]);
        });
        // Scoring must see ONLY the active object — co-loaded neighbors would
        // contribute edge energy and corrupt the ranking (and best_view).
        const hiddenWrappers = [];
        for (const e of this._objects) {
            if (e.id !== this._activeObjectId && e.wrapper.visible) {
                e.wrapper.visible = false;
                hiddenWrappers.push(e.wrapper);
            }
        }
        const raw = [];
        try {
            this.setGridVisible(false);
            this.setAxisVisible(false);
            if (this._ground) this._ground.visible = false;
            r.clippingPlanes = [];
            this._scene.background = null;
            this._scene.fog = null;
            r.setClearColor(0x000000, 0);
            cam.aspect = 1;
            cam.updateProjectionMatrix();

            const renderScore = () => {
                r.setRenderTarget(rt);
                r.render(this._scene, cam);
                r.readRenderTargetPixels(rt, 0, 0, size, size, buf);
                r.setRenderTarget(null);
                return this._detailScore(buf, size);
            };

            for (const el of elevations) {
                for (const az of azimuths) {
                    this.orbitTo(az, el, { fill });
                    // Geometry pass
                    for (const [c] of savedMats) c.material = normalMat;
                    const g = renderScore();
                    // Albedo pass
                    for (const [c, m] of albedoMats) c.material = m;
                    const a = renderScore();
                    raw.push({ azimuth: az, elevation: el, eg: g.score, ea: a.score, coverage: g.coverage });
                }
            }

            // Normalize each channel across candidates, then blend, weighting by coverage
            // so a tiny sliver can't win on ratio alone.
            const maxEg = Math.max(1e-6, ...raw.map((x) => x.eg));
            const maxEa = Math.max(1e-6, ...raw.map((x) => x.ea));
            for (const x of raw) {
                const blended = (0.55 * (x.eg / maxEg) + 0.45 * (x.ea / maxEa)) * (0.6 + 0.4 * x.coverage);
                results.push({ azimuth: x.azimuth, elevation: x.elevation, score: blended, coverage: x.coverage });
            }
        } finally {
            for (const [child, mat] of savedMats) child.material = mat;
            for (const w of hiddenWrappers) w.visible = true;
            normalMat.dispose();
            for (const [, m] of albedoMats) m.dispose();
            rt.dispose();
            r.setRenderTarget(null);
            this._scene.background = prevBg;
            this._scene.fog = prevFog;
            r.setClearColor(prevClear, prevAlpha);
            r.clippingPlanes = prevClipPlanes;
            this.setGridVisible(prevGrid);
            this.setAxisVisible(prevAxes);
            if (this._ground) this._ground.visible = prevGround;
            cam.position.copy(prevPos);
            this._controls.target.copy(prevTarget);
            cam.aspect = prevAspect;
            cam.updateProjectionMatrix();
            this._controls.update();
        }

        const round = (v) => Math.round(v * 10000) / 10000;
        results.forEach((x) => { x.score = round(x.score); x.coverage = round(x.coverage); });
        results.sort((a, b) => b.score - a.score);
        return results;
    }

    /**
     * Detail score for a rendered thumbnail: mean Sobel edge energy over covered pixels,
     * lightly boosted by silhouette coverage. High = lots of visible features (a face's
     * eyes/nose, a device's panel); low = a smooth blank side (back of a head).
     */
    _detailScore(buf, size) {
        // Luminance + coverage mask.
        const lum = new Float32Array(size * size);
        let covered = 0;
        for (let i = 0; i < size * size; i++) {
            const a = buf[i * 4 + 3];
            if (a > 16) {
                lum[i] = 0.299 * buf[i * 4] + 0.587 * buf[i * 4 + 1] + 0.114 * buf[i * 4 + 2];
                covered++;
            } else {
                lum[i] = -1; // background marker
            }
        }
        if (covered === 0) return { score: 0, coverage: 0 };

        let edgeSum = 0, edgeCount = 0;
        const at = (x, y) => lum[y * size + x];
        for (let y = 1; y < size - 1; y++) {
            for (let x = 1; x < size - 1; x++) {
                if (at(x, y) < 0) continue; // only covered pixels
                // Skip if any neighbor is background (silhouette edge would dominate);
                // we want INTERNAL detail, not just the outline.
                let bg = false;
                for (let dy = -1; dy <= 1 && !bg; dy++)
                    for (let dx = -1; dx <= 1; dx++)
                        if (at(x + dx, y + dy) < 0) { bg = true; break; }
                if (bg) continue;
                const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
                    - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
                const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
                    - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
                edgeSum += Math.sqrt(gx * gx + gy * gy);
                edgeCount++;
            }
        }
        const meanEdge = edgeCount > 0 ? edgeSum / edgeCount : 0;
        const coverage = covered / (size * size);
        // Mean internal detail, gently scaled by coverage so a tiny sliver doesn't win.
        return { score: meanEdge * (0.5 + 0.5 * coverage), coverage };
    }

    /**
     * Find the best "hero"/front view by scoring, and optionally move the camera to it.
     * @param {object} [opts] - passthrough to scoreViews + { apply=true, fill }
     * @returns {{azimuth, elevation, score, coverage, ranked}}
     */
    findBestView(opts = {}) {
        const ranked = this.scoreViews(opts);
        if (ranked.length === 0) return null;
        const best = ranked[0];
        if (opts.apply !== false) {
            this.orbitTo(best.azimuth, best.elevation, { fill: opts.fill });
            // Auto-upright by default: correct the camera roll so a mis-oriented
            // (e.g. lying-down) model appears the right way up. Pass upright:false to skip.
            if (opts.upright !== false) this.autoUpright({ size: opts.size });
        }
        return { ...best, ranked: ranked.slice(0, 6) };
    }

    /** Set lighting for hero shots. All params optional; only provided ones apply. */
    setLighting(opts = {}) {
        if (opts.azimuth !== undefined) this.setKeyLightAzimuth(opts.azimuth);
        if (opts.elevation !== undefined) this.setKeyLightElevation(opts.elevation);
        if (opts.key_intensity !== undefined) this.setKeyLightIntensity(opts.key_intensity);
        if (opts.fill_intensity !== undefined) this.setFillLightIntensity(opts.fill_intensity);
        if (opts.ambient !== undefined) this.setAmbientIntensity(opts.ambient);
        if (opts.exposure !== undefined) this.setExposure(opts.exposure);
        return true;
    }

    // ==========================================================
    // Render mode (see the mesh, not just the lit surface) + clipping + fog
    // ==========================================================

    /**
     * Switch how the model is drawn:
     *  - 'shaded'    : original PBR materials (default)
     *  - 'wireframe' : wireframe overlay on the lit material (shows edges/topology)
     *  - 'normals'   : per-face normal colors (inspect surface orientation / mesh)
     *  - 'clay'      : uniform matte material (read pure form, ignore textures)
     * Original materials are preserved and restored when returning to 'shaded'.
     */
    setRenderMode(mode) {
        this.invalidate();
        if (this._objects.length === 0) return false;
        // Canonical modes + friendly aliases:
        //   textured (= mesh + texture, the lit PBR surface)   [aliases: shaded]
        //   solid    (= mesh only, uniform matte, no texture)  [aliases: clay]
        //   wireframe(= edges/topology only)
        //   normals  (= per-face normal colors; geometry inspection)
        const alias = {
            textured: "textured", shaded: "textured",
            solid: "solid", clay: "solid",
            wireframe: "wireframe", normals: "normals",
        };
        const m = alias[mode];
        if (!m) return false;

        // Render mode is a SCENE-WIDE display state: apply to every object so a
        // composed scene reads consistently (a clay review must not show one
        // textured object). Restore original materials first (idempotent).
        for (const entry of this._objects) {
            entry.model.traverse((child) => {
                if (child.isMesh && child._mvOriginalMaterial) {
                    if (child.material && child.material !== child._mvOriginalMaterial) {
                        (Array.isArray(child.material) ? child.material : [child.material])
                            .forEach((mat) => mat && mat.dispose && mat.dispose());
                    }
                    child.material = child._mvOriginalMaterial;
                    delete child._mvOriginalMaterial;
                }
            });
        }
        this.setWireframe(false);

        if (m === "textured" || m === "wireframe") {
            if (m === "wireframe") this.setWireframe(true);
            this._renderMode = m;
            this._applyEnvironment();
            // Per-object opacity is declarative and must survive the material swap.
            this._reapplyAllOpacities();
            return true;
        }

        // solid / normals: override the material (keep the original for restore).
        for (const entry of this._objects) {
            entry.model.traverse((child) => {
                if (!child.isMesh) return;
                child._mvOriginalMaterial = child.material;
                if (m === "normals") {
                    child.material = new THREE.MeshNormalMaterial({ flatShading: false });
                } else { // solid (matte clay)
                    child.material = new THREE.MeshStandardMaterial({
                        color: 0xcfd2d6, roughness: 0.85, metalness: 0.0,
                        side: THREE.DoubleSide,
                    });
                }
            });
        }
        this._renderMode = m;
        this._applyEnvironment();  // damp IBL in matte 'solid' mode so form stays readable
        this._reapplyAllOpacities();
        return true;
    }

    getRenderMode() {
        // Wireframe is also a persistent toggle that survives loads; report it faithfully
        // so the state snapshot never says "textured" while the mesh renders as wireframe.
        if ((this._renderMode || "textured") === "textured" && this._wireframeEnabled) {
            return "wireframe";
        }
        return this._renderMode || "textured";
    }

    /** Recompute a camera-relative clip plane; needed before synchronous offscreen renders
     *  (capture_views/scoreViews) where the rAF loop that normally refreshes it never runs. */
    _refreshCameraClip() {
        if (this._clip && this._clip.axis === "camera") {
            const plane = this._computeClipPlane();
            if (plane) this._renderer.clippingPlanes = [plane];
        }
    }

    /**
     * Cutting plane — hide the part of the mesh on one side of a plane, e.g. to see the
     * front of a model with the far/back geometry cut away, or a cross-section.
     * @param {object} opts
     * @param {boolean} opts.enabled
     * @param {'x'|'y'|'z'|'camera'} [opts.axis='camera'] - plane orientation
     * @param {number} [opts.position=0.5] - cut location, 0..1 across the model bbox
     *        (for 'camera', 0=near side .. 1=far side of the bbox along the view)
     * @param {boolean} [opts.flip=false] - keep the other side
     */
    setClip(opts = {}) {
        const r = this._renderer;
        if (!opts.enabled) {
            r.clippingPlanes = [];
            r.localClippingEnabled = false;
            this._clip = null;
            return true;
        }
        if (this._objects.length === 0) return false;

        const axis = opts.axis || "camera";
        const t = opts.position !== undefined ? Math.max(0, Math.min(1, opts.position)) : 0.5;
        const flip = !!opts.flip;

        this._clip = { axis, t, flip };
        r.localClippingEnabled = true;
        r.clippingPlanes = [this._computeClipPlane()];
        // Camera-relative planes must follow the camera; the render loop refreshes them.
        return true;
    }

    /** Build the current clipping plane (called on set and, for 'camera', each frame).
     *  Geometry derives from the VISIBLE-SCENE union: the renderer's clipping plane
     *  cuts every object, so `position: 0.5` must mean "middle of the scene", not
     *  "middle of whichever object happens to be active" (which would slice
     *  neighbors at unpredictable places). */
    _computeClipPlane() {
        if (!this._clip) return null;
        const box = this._visibleUnionBox();
        if (!box) return null;
        const { axis, t, flip } = this._clip;
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const sign = flip ? -1 : 1;

        let normal, point;
        if (axis === "camera") {
            // Normal points from the model toward the camera; keep the near side.
            normal = this._camera.position.clone().sub(center).normalize().multiplyScalar(sign);
            const radius = size.length() / 2;
            // t=0 → near side (keep almost everything), t=1 → far side (keep a thin slice).
            point = center.clone().add(normal.clone().multiplyScalar(radius * (1 - 2 * t)));
        } else {
            const axisVec = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis] || [0, 0, 1];
            normal = new THREE.Vector3(axisVec[0], axisVec[1], axisVec[2]).multiplyScalar(sign);
            const half = axis === "x" ? size.x / 2 : axis === "y" ? size.y / 2 : size.z / 2;
            const cc = axis === "x" ? center.x : axis === "y" ? center.y : center.z;
            const coord = cc - half + t * (half * 2);
            point = center.clone();
            if (axis === "x") point.x = coord; else if (axis === "y") point.y = coord; else point.z = coord;
        }
        const plane = new THREE.Plane();
        plane.setFromNormalAndCoplanarPoint(normal, point);
        return plane;
    }

    /** Enable/disable/adjust exponential scene fog. */
    setFog(opts = {}) {
        this.invalidate();
        if (opts.enabled === false) {
            this._scene.fog = null;
            return true;
        }
        if (!this._scene.fog) {
            this._scene.fog = new THREE.FogExp2(
                new THREE.Color(this._background), 0.008
            );
        }
        if (opts.density !== undefined) this._scene.fog.density = opts.density;
        this._scene.fog.color.copy(new THREE.Color(this._background));
        return true;
    }

    /**
     * World-space bounding box of the current model: {min, max, center, size} as
     * [x,y,z] arrays, or null if nothing is loaded. Agents need this to compute
     * framing/orbit radii without clipping.
     */
    getBounds() {
        if (!this._currentModel) return null;
        const box = new THREE.Box3().setFromObject(this._currentModel);
        if (box.isEmpty()) return null;
        const r = (v) => Math.round(v * 1000) / 1000;
        const min = box.min, max = box.max;
        const c = box.getCenter(new THREE.Vector3());
        const s = box.getSize(new THREE.Vector3());
        return {
            min: [r(min.x), r(min.y), r(min.z)],
            max: [r(max.x), r(max.y), r(max.z)],
            center: [r(c.x), r(c.y), r(c.z)],
            size: [r(s.x), r(s.y), r(s.z)],
        };
    }

    /**
     * JSON-serializable snapshot of the viewer. This is the primary observation
     * surface for AI agents: model stats, camera pose, display toggles, animation.
     */
    getState() {
        const round = (v) => Math.round(v * 1000) / 1000;
        const pos = this._camera.position;
        const tgt = this._controls.target;
        const activeAnim = this._activeAnimation;
        const unionBox = this._visibleUnionBox();
        return {
            // `model` describes the ACTIVE object (single-object commands target it).
            model: {
                loaded: !!this._currentModel,
                name: this._lastModelName,
                vertices: this._lastStats.vertices || 0,
                faces: this._lastStats.faces || 0,
                dimensions: {
                    width: round(this._lastStats.width || 0),
                    height: round(this._lastStats.height || 0),
                    depth: round(this._lastStats.depth || 0),
                },
                bounds: this.getBounds(),
                scale: this._modelScale,
                modified: !!this._modelModified,
            },
            // Scene composition: every loaded object + which one is active.
            scene: {
                objectCount: this._objects.length,
                activeObjectId: this._activeObjectId,
                objects: this.listObjects(),
                bounds: unionBox && !unionBox.isEmpty() ? {
                    min: [round(unionBox.min.x), round(unionBox.min.y), round(unionBox.min.z)],
                    max: [round(unionBox.max.x), round(unionBox.max.y), round(unionBox.max.z)],
                } : null,
            },
            camera: {
                mode: this._navMode,
                position: [round(pos.x), round(pos.y), round(pos.z)],
                target: [round(tgt.x), round(tgt.y), round(tgt.z)],
                fov: this._camera.fov,
                presets: ["front", "back", "left", "right", "top", "bottom", "iso"],
            },
            display: {
                wireframe: !!this._wireframeEnabled,
                grid: this.getGridVisible(),
                axes: this.getAxisVisible(),
                normals: !!this._normalsVisible,
                background: this._background,
                renderMode: this.getRenderMode(),
                clip: this._clip ? { axis: this._clip.axis, position: this._clip.t, flip: this._clip.flip } : null,
                fog: !!this._scene.fog,
                environment: this.getEnvironment(),
            },
            animation: {
                hasAnimations: this.hasAnimations(),
                clips: (activeAnim ? activeAnim.clips : []).map((c, i) => c.name || `Clip ${i + 1}`),
                playing: !!(activeAnim && activeAnim.playing),
                time: round(this.getAnimationTime()),
                duration: round(this.getAnimationDuration()),
            },
            lighting: this.getLightSettings(),
        };
    }

    /**
     * Detailed per-mesh + per-material breakdown of the loaded model.
     * Lets an agent reason about the object it is looking at.
     */
    getSceneInfo() {
        const meshes = [];
        const materials = [];
        if (this._currentModel) {
            this._currentModel.updateMatrixWorld(true);
            const round = (v) => Math.round(v * 1000) / 1000;
            let id = 0;
            this._currentModel.traverse((child) => {
                if (child.isMesh && child.geometry) {
                    const pos = child.geometry.getAttribute("position");
                    const vertices = pos ? pos.count : 0;
                    const index = child.geometry.getIndex();
                    const faces = index ? index.count / 3 : vertices / 3;
                    const matNames = (Array.isArray(child.material)
                        ? child.material : [child.material])
                        .filter(Boolean).map((m) => m.name || "(unnamed)");
                    // World placement + stable id (same as describe_scene / focus).
                    let center = null, size = null;
                    const geo = child.geometry;
                    if (!geo.boundingBox) geo.computeBoundingBox();
                    if (geo.boundingBox && !geo.boundingBox.isEmpty()) {
                        const wb = geo.boundingBox.clone().applyMatrix4(child.matrixWorld);
                        const c = wb.getCenter(new THREE.Vector3());
                        const s = wb.getSize(new THREE.Vector3());
                        center = [round(c.x), round(c.y), round(c.z)];
                        size = [round(s.x), round(s.y), round(s.z)];
                    }
                    meshes.push({
                        id: id++,
                        name: child.name || "(unnamed)",
                        vertices,
                        faces: Math.floor(faces),
                        center,
                        size,
                        materials: matNames,
                    });
                }
            });
        }
        try {
            for (const m of this.getMaterialsInfo()) {
                materials.push({
                    name: m.name, type: m.type,
                    color: m.color, roughness: m.roughness, metalness: m.metalness,
                });
            }
        } catch { /* getMaterialsInfo may vary; meshes are the primary signal */ }
        return { meshes, materials };
    }

    // ==========================================================
    // Image-based lighting (IBL) — environment map for realistic PBR reflections.
    // Generated procedurally from RoomEnvironment (no HDRI asset to ship), so metallic
    // / rough materials get real reflections instead of looking flat. The existing
    // key/fill/ambient rig stays as the baseline; IBL is layered on top.
    // ==========================================================
    _initEnvironment() {
        this._environmentIntensity = 1.0;
        this._environmentEnabled = true;
        try {
            this._pmrem = new THREE.PMREMGenerator(this._renderer);
            const room = new RoomEnvironment();
            this._envRT = this._pmrem.fromScene(room, 0.04);
            if (typeof room.dispose === "function") room.dispose();
            this._environmentTexture = this._envRT.texture;
            this._applyEnvironment();
        } catch (e) {
            console.warn("Environment (IBL) init failed:", e);
            this._environmentEnabled = false;
        }
    }

    /**
     * Apply the current IBL state to the scene. In three r170, image-based lighting from
     * `scene.environment` is scaled by `scene.environmentIntensity` (NOT per-material
     * envMapIntensity, which the renderer overrides for materials with no own envMap). So
     * we drive those two — see KnowledgeBase "IBL in three r170".
     */
    _applyEnvironment() {
        // In the matte "solid" inspection mode, suppress the env entirely: it is exactly
        // the pre-IBL clay look (analytic rig only), which is what form-reading needs.
        const solid = this.getRenderMode() === "solid";
        const on = this._environmentEnabled && !solid;
        this._scene.environment = on ? this._environmentTexture : null;
        if ("environmentIntensity" in this._scene) {
            this._scene.environmentIntensity = on ? this._environmentIntensity : 0;
        }
    }

    /**
     * Control image-based lighting.
     * @param {object} opts
     * @param {boolean} [opts.enabled]  - turn IBL on/off
     * @param {number}  [opts.intensity] - environment intensity multiplier
     * @param {boolean} [opts.asBackground] - show the environment as the background
     */
    setEnvironment(opts = {}) {
        this.invalidate();
        if (opts.enabled !== undefined) this._environmentEnabled = !!opts.enabled;
        if (opts.intensity !== undefined) this._environmentIntensity = opts.intensity;
        this._applyEnvironment();
        if (opts.asBackground !== undefined) {
            this._envAsBackground = !!opts.asBackground;
            this._scene.background = this._envAsBackground && this._environmentTexture
                ? this._environmentTexture
                : new THREE.Color(this._background);
        }
        // When IBL is turned off, don't leave the environment image as the background.
        if (opts.enabled !== undefined && !this._environmentEnabled && this._envAsBackground) {
            this._envAsBackground = false;
            this._scene.background = new THREE.Color(this._background);
        }
        return true;
    }

    getEnvironment() {
        return {
            enabled: !!this._environmentEnabled,
            intensity: this._environmentIntensity,
            asBackground: !!this._envAsBackground,
        };
    }

    _initPostProcessing() {
        this._composer = new EffectComposer(this._renderer);

        // Render pass
        const renderPass = new RenderPass(this._scene, this._camera);
        this._composer.addPass(renderPass);

        // SSAO pass for ambient occlusion
        const ssaoPass = new SSAOPass(
            this._scene,
            this._camera,
            this._container.clientWidth,
            this._container.clientHeight
        );
        ssaoPass.kernelRadius = 0.5;
        ssaoPass.minDistance = 0.001;
        ssaoPass.maxDistance = 0.1;
        ssaoPass.output = SSAOPass.OUTPUT.Default;
        this._composer.addPass(ssaoPass);
        this._ssaoPass = ssaoPass;

        // Output pass for correct color space
        const outputPass = new OutputPass();
        this._composer.addPass(outputPass);
    }

    // ==========================================
    // Model Loading
    // ==========================================

    /**
     * Directory of the model's own URL ("…/dir/" with trailing slash), or null when
     * the URL has no usable base (blob:/data: object URLs, bare filenames). Used by
     * the standalone default resolver to resolve relative resource refs the way the
     * platform would: against the model, not against the host page.
     */
    _computeModelBaseUrl(url) {
        if (!url || /^(blob:|data:)/i.test(url)) return null;
        const cut = url.lastIndexOf("/");
        return cut >= 0 ? url.slice(0, cut + 1) : null;
    }

    /** Current model's base URL (see _computeModelBaseUrl); null when not applicable. */
    getModelBaseUrl() {
        return this._modelBaseUrl || null;
    }

    _loadOBJ(url, options = {}) {
        return new Promise((resolve, reject) => {
            const manager = new THREE.LoadingManager();
            manager.onLoad = () => this.invalidate();  // repaint when textures land
            const relatedFiles = options.relatedFiles || [];

            // Check if there's a .mtl file among related files
            const mtlFile = relatedFiles.find((f) =>
                f.toLowerCase().endsWith(".mtl")
            );

            if (mtlFile) {
                // Load with material
                const mtlUrl = this._resolveResource(mtlFile);

                // We need to determine the base path for the MTL loader
                // to resolve texture paths relative to the MTL file
                const mtlLoader = new MTLLoader(manager);

                // Override the resource path to use our API
                mtlLoader.setResourcePath("");

                fetch(mtlUrl)
                    .then((res) => res.text())
                    .then((mtlText) => {
                        // Rewrite texture paths in the MTL to use our API
                        const mtlDir = mtlFile.substring(
                            0,
                            mtlFile.lastIndexOf("/") + 1
                        ) || mtlFile.substring(
                            0,
                            mtlFile.lastIndexOf("\\") + 1
                        );
                        const rewrittenMtl = this._rewriteMtlTexturePaths(
                            mtlText,
                            mtlDir
                        );

                        const materials = mtlLoader.parse(rewrittenMtl, "");
                        materials.preload();

                        const objLoader = new OBJLoader(manager);
                        objLoader.setMaterials(materials);
                        objLoader.load(
                            url,
                            (obj) => resolve(obj),
                            undefined,
                            (err) => {
                                // Fallback: load without materials
                                console.warn("MTL load failed, loading OBJ without materials:", err);
                                const fallbackLoader = new OBJLoader();
                                fallbackLoader.load(url, resolve, undefined, reject);
                            }
                        );
                    })
                    .catch(() => {
                        // Fallback: load without materials
                        const objLoader = new OBJLoader();
                        objLoader.load(url, resolve, undefined, reject);
                    });
            } else {
                // Load without material
                const objLoader = new OBJLoader(manager);
                objLoader.load(url, resolve, undefined, reject);
            }
        });
    }

    _loadFBX(url, options = {}) {
        return new Promise((resolve, reject) => {
            // Set up a loading manager that redirects texture requests
            // through our API. This is essential for archived assets where
            // textures are extracted to a temp directory.
            const manager = new THREE.LoadingManager();
            manager.onLoad = () => this.invalidate();  // repaint when textures land
            const relatedFiles = options.relatedFiles || [];
            const sourcePath = options.sourcePath || null;

            // Build filename -> absolute path map from extracted related files.
            const textureMap = {};
            for (const f of relatedFiles) {
                if (!this._isTextureFilePath(f)) continue;
                const filename = f.split("/").pop().split("\\").pop().toLowerCase();
                if (!(filename in textureMap)) {
                    textureMap[filename] = f;
                }
            }

            // Always install URL resolver for FBX resources.
            // This handles:
            // 1) Archive-related files (from relatedFiles map)
            // 2) Direct FBX files using relative texture paths next to sourcePath
            // 3) Absolute filesystem paths embedded in FBX
            manager.setURLModifier((resourceUrl) => {
                const resolvedPath = this._resolveFBXResourcePath(
                    resourceUrl,
                    sourcePath,
                    textureMap
                );
                if (resolvedPath) {
                    return this._resolveResource(resolvedPath);
                }
                return resourceUrl;
            });

            const loader = new FBXLoader(manager);
            loader.load(
                url,
                async (object) => {
                    try {
                        // Animation clips (object.animations) are wired up centrally
                        // in loadModel via _setupAnimations so the UI can control them.

                        // Fallback for FBX exports that omit texture links:
                        // if no maps are bound, auto-assign from related files
                        // by filename conventions (_d, _n, _ao, etc.).
                        if (relatedFiles.length > 0) {
                            await this._autoBindFBXTextures(object, relatedFiles);
                        }

                        resolve(object);
                    } catch (err) {
                        console.error("FBX post-load processing error:", err);
                        // Still resolve with the object even if animations fail
                        resolve(object);
                    }
                },
                undefined,
                (err) => {
                    console.error("FBX loader error:", err);
                    reject(new Error(
                        `FBX loading failed: ${describeLoadError(err) || 'Unknown error. The file may use an unsupported FBX version.'}`
                    ));
                }
            );
        });
    }

    /**
     * Resolve an FBX-referenced resource URL to an absolute filesystem path.
     * Returns null when the URL should not be rewritten.
     */
    _resolveFBXResourcePath(resourceUrl, sourcePath, textureMap) {
        if (!resourceUrl) return null;
        const trimmed = String(resourceUrl).trim();
        if (!trimmed) return null;

        // Ignore external/data URLs.
        if (/^(data:|blob:|https?:\/\/)/i.test(trimmed)) return null;

        // Already resolved through our API, or the main model URL itself.
        if (
            trimmed.startsWith("/api/asset/related?") ||
            trimmed.startsWith("/api/asset/file?")
        ) {
            return null;
        }

        let clean = trimmed.split("?")[0].split("#")[0];

        // Malformed FBX refs sometimes come as "/api/asset/<filename>".
        // Keep /api/asset/file and /api/asset/related untouched, but salvage
        // bare "/api/asset/<name>" by stripping the prefix and resolving it.
        if (clean.startsWith("/api/asset/")) {
            if (
                clean.startsWith("/api/asset/file") ||
                clean.startsWith("/api/asset/related")
            ) {
                return null;
            }
            clean = clean.slice("/api/asset/".length);
        } else if (clean.startsWith("/api/")) {
            return null;
        }
        const filename = clean.split("/").pop().split("\\").pop();
        if (filename) {
            const match = textureMap[filename.toLowerCase()];
            if (match) return this._normalizeFsPath(match);
        }

        // Absolute filesystem path embedded in FBX.
        if (/^[a-zA-Z]:[\\/]/.test(clean) || clean.startsWith("/")) {
            return this._normalizeFsPath(clean);
        }

        // Relative path from source FBX directory.
        if (sourcePath) {
            const sourceNorm = this._normalizeFsPath(sourcePath);
            const idx = sourceNorm.lastIndexOf("/");
            const baseDir = idx >= 0 ? sourceNorm.slice(0, idx) : "";
            if (baseDir) {
                return this._resolveRelativeFsPath(baseDir, clean);
            }
        }

        return null;
    }

    _normalizeFsPath(path) {
        const raw = String(path).replace(/\\/g, "/");
        const isUnixAbs = raw.startsWith("/");

        const out = [];
        const parts = raw.split("/");
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!part || part === ".") {
                if (i === 0 && isUnixAbs) out.push("");
                continue;
            }
            if (part === "..") {
                if (
                    out.length > 0 &&
                    out[out.length - 1] !== "" &&
                    out[out.length - 1] !== ".."
                ) {
                    out.pop();
                }
                continue;
            }
            out.push(part);
        }
        if (isUnixAbs && out[0] !== "") out.unshift("");
        return out.join("/");
    }

    _resolveRelativeFsPath(baseDir, relPath) {
        const rel = String(relPath).replace(/\\/g, "/");
        if (/^[a-zA-Z]:[\\/]/.test(relPath) || rel.startsWith("/")) {
            return this._normalizeFsPath(rel);
        }
        return this._normalizeFsPath(`${baseDir}/${rel}`);
    }

    /**
     * Auto-bind textures for FBX files when texture links are missing.
     *
     * Robust logic:
     * - Supports TGA (common in DCC exports)
     * - Scores texture candidates per material name (including numeric tokens)
     * - Assigns maps per material instead of one global texture for all
     * - Gracefully falls back when naming conventions are inconsistent
     */
    async _autoBindFBXTextures(object, relatedFiles) {
        const textureEntries = (relatedFiles || [])
            .filter((p) => this._isTextureFilePath(p))
            .map((p) => this._buildTextureEntry(p));
        if (textureEntries.length === 0) return 0;

        // Deduplicate material instances across meshes.
        const materials = [];
        const seen = new Set();
        object.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
                if (!mat || seen.has(mat)) continue;
                seen.add(mat);
                materials.push(mat);
            }
        });

        const textureCache = new Map();
        let needsUv2 = false;
        let applied = 0;

        for (const mat of materials) {
            const matName = mat.name || "";
            let changed = false;
            this._sanitizeMaterialTextureSlots(mat);

            const pick = (slot) => this._pickBestTextureEntry(textureEntries, matName, slot);

            const currentMapName = this._extractTextureFilename(mat.map);
            const mapLooksWrong = this._isLikelyNonColorTextureName(currentMapName);
            if (!this._isUsableTexture(mat.map) || mapLooksWrong) {
                const entry = pick("map");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.SRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    // Avoid replacing with the same likely-wrong file.
                    if (!(mapLooksWrong && currentMapName && entry?.fileLower === currentMapName)) {
                        mat.map = tex;
                        changed = true;
                    }
                }
            }

            if (!this._isUsableTexture(mat.normalMap)) {
                const entry = pick("normalMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.LinearSRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.normalMap = tex;
                    // DirectX normal maps have inverted green channel.
                    if (entry?.isDirectX) {
                        mat.normalScale = new THREE.Vector2(1, -1);
                    }
                    changed = true;
                }
            }

            if (!this._isUsableTexture(mat.aoMap)) {
                const entry = pick("aoMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.LinearSRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.aoMap = tex;
                    mat.aoMapIntensity = 1.0;
                    needsUv2 = true;
                    changed = true;
                }
            }

            if (mat.roughness !== undefined && !this._isUsableTexture(mat.roughnessMap)) {
                const entry = pick("roughnessMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.LinearSRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.roughnessMap = tex;
                    mat.roughness = Math.max(0.45, mat.roughness);
                    changed = true;
                }
            }

            if (mat.metalness !== undefined && !this._isUsableTexture(mat.metalnessMap)) {
                const entry = pick("metalnessMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.LinearSRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.metalnessMap = tex;
                    mat.metalness = Math.min(0.2, mat.metalness);
                    changed = true;
                }
            }

            if (!this._isUsableTexture(mat.bumpMap)) {
                const entry = pick("bumpMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.LinearSRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.bumpMap = tex;
                    mat.bumpScale = 0.05;
                    changed = true;
                }
            }

            if (!this._isUsableTexture(mat.emissiveMap)) {
                const entry = pick("emissiveMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.SRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.emissiveMap = tex;
                    if (mat.emissive && this._isVeryDark(mat.emissive)) {
                        mat.emissive.set(0xffffff);
                    }
                    if (mat.emissiveIntensity !== undefined) {
                        mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 1.0);
                    }
                    changed = true;
                }
            }

            if (changed) {
                mat.needsUpdate = true;
                applied += 1;
            }
        }

        // AO maps require uv2 in Three.js. Copy uv -> uv2 when missing.
        if (needsUv2) {
            object.traverse((child) => {
                if (!child.isMesh || !child.geometry) return;
                if (child.geometry.hasAttribute("uv") && !child.geometry.hasAttribute("uv2")) {
                    child.geometry.setAttribute("uv2", child.geometry.getAttribute("uv").clone());
                }
            });
        }

        return applied;
    }

    /**
     * Is this texture BROKEN (definitely unusable)?
     *
     * Textures load asynchronously: TextureLoader attaches `image` only when the
     * network fetch + decode complete, so a texture with NO image is normally
     * PENDING, not broken — treating it as broken is what silently stripped
     * textures from every model whose mesh parsed faster than its textures
     * decoded (always the case over loopback in the headless/MCP runtimes, a
     * race in the app for small models). Failure is only knowable two ways:
     * an ATTACHED image that completed with zero natural size (decode error),
     * or a still-missing image once the post-load settling window has passed
     * (`settled` — the 404 case, cleared by the load's janitor pass so the
     * material falls back to its base color like before).
     */
    _isBrokenTexture(tex, settled = false) {
        if (!tex || !tex.isTexture) return true;
        const img = tex.image || tex.source?.data || null;
        if (!img) return settled;
        if (img instanceof HTMLImageElement) {
            if (!img.complete) return settled;
            return !(img.naturalWidth > 0 && img.naturalHeight > 0);
        }
        if (
            typeof img.width === "number" &&
            typeof img.height === "number" &&
            (img.width === 0 || img.height === 0)
        ) {
            return true;
        }
        return false;
    }

    _isUsableTexture(tex, settled = false) {
        return !!(tex && tex.isTexture) && !this._isBrokenTexture(tex, settled);
    }

    _extractTextureFilename(tex) {
        if (!tex || !tex.isTexture) return "";
        const img = tex.image || tex.source?.data || null;
        const src = img?.currentSrc || img?.src || "";
        if (!src) return "";
        try {
            let raw = String(src);
            if (raw.includes("/api/asset/related?")) {
                const m = raw.match(/[?&]path=([^&]+)/);
                if (m && m[1]) {
                    raw = decodeURIComponent(m[1]);
                }
            }
            raw = raw.split("?")[0].split("#")[0];
            return raw.split("/").pop().split("\\").pop().toLowerCase();
        } catch {
            return "";
        }
    }

    _isLikelyNonColorTextureName(name) {
        if (!name) return false;
        const stem = String(name).toLowerCase().replace(/\.[^.]+$/, "");
        return /(^|[_\-\s])(normal|nrm|nor|rough|roughness|metal|metallic|ao|occlusion|height|disp|displacement|bump|spec|specular|gloss|glossiness|emissive|emission|mask|alpha|opacity|id|wire|g|s)([_\-\s]|$)/.test(stem);
    }

    _sanitizeMaterialTextureSlots(material, settled = false) {
        if (!material) return false;
        const textureSlots = [
            "map",
            "normalMap",
            "aoMap",
            "roughnessMap",
            "metalnessMap",
            "bumpMap",
            "emissiveMap",
            "alphaMap",
        ];
        let changed = false;
        for (const slot of textureSlots) {
            const tex = material[slot];
            if (tex && tex.isTexture && this._isBrokenTexture(tex, settled)) {
                material[slot] = null;
                changed = true;
            }
        }
        if (changed) {
            material.needsUpdate = true;
        }
        return changed;
    }

    /**
     * Janitor pass over a model's materials once its texture loads have settled:
     * clears slots whose textures definitively failed (404/decode error), so the
     * material falls back to its base color instead of sampling an unbound
     * texture (renders black). Pending textures are never touched — see
     * _isBrokenTexture for the pending-vs-broken distinction.
     */
    _sanitizeObjectTextures(object, settled = true) {
        if (!object) return;
        let changed = false;
        object.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of mats) {
                if (this._sanitizeMaterialTextureSlots(m, settled)) changed = true;
            }
        });
        if (changed) this.invalidate();
    }

    _isTextureFilePath(path) {
        const lower = path.toLowerCase();
        return (
            lower.endsWith(".png") ||
            lower.endsWith(".jpg") ||
            lower.endsWith(".jpeg") ||
            lower.endsWith(".tga") ||
            lower.endsWith(".bmp") ||
            lower.endsWith(".webp") ||
            lower.endsWith(".gif") ||
            lower.endsWith(".tif") ||
            lower.endsWith(".tiff")
        );
    }

    _buildTextureEntry(path) {
        const file = path.split("/").pop().split("\\").pop();
        const fileLower = file.toLowerCase();
        const stemLower = fileLower.replace(/\.[^.]+$/, "");
        return {
            path,
            fileLower,
            stemLower,
            slot: this._classifyTextureSlotFromPath(path),
            tokens: this._tokenizeName(stemLower),
            isDirectX: stemLower.includes("directx") || stemLower.includes("_dx"),
            isOpenGL: stemLower.includes("opengl") || stemLower.includes("_ogl"),
        };
    }

    _tokenizeName(name) {
        const raw = (name || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim()
            .split(/\s+/)
            .filter(Boolean);

        // Normalize numeric tokens so "01" and "1" match.
        return raw.map((tok) => (/^\d+$/.test(tok) ? String(parseInt(tok, 10)) : tok));
    }

    _scoreTextureEntry(materialName, entry, targetSlot) {
        const materialTokens = this._tokenizeName(materialName);
        const tokenSet = new Set(materialTokens);

        let score = 0;

        // Slot fitness
        if (entry.slot === targetSlot) {
            score += 60;
        } else if (targetSlot === "map" && entry.slot === "other") {
            score += 25;
        } else if (entry.slot === "other") {
            score += 5;
        } else {
            score -= 15;
        }

        // Token overlap between material and texture names
        let overlap = 0;
        for (const token of entry.tokens) {
            if (tokenSet.has(token)) {
                overlap += 1;
                score += /^\d+$/.test(token) ? 10 : 6;
            }
        }

        // Weak fallback by compact-string containment
        if (overlap === 0) {
            const matCompact = materialTokens.join("");
            const texCompact = entry.tokens.join("");
            if (matCompact && texCompact) {
                if (matCompact.includes(texCompact) || texCompact.includes(matCompact)) {
                    score += 8;
                }
            }
        } else {
            score += overlap * 2;
        }

        // Prefer OpenGL normals over DirectX normals in Three.js.
        if (targetSlot === "normalMap") {
            if (entry.isOpenGL) score += 8;
            if (entry.isDirectX) score -= 4;
        }

        // Avoid obviously wrong diffuse picks.
        if (targetSlot === "map") {
            if (/(diffuse|albedo|basecolor|base_color|color|col)/.test(entry.stemLower)) {
                score += 20;
            }
            if (this._isLikelyNonColorTextureName(entry.fileLower)) {
                score -= 35;
            }
        }

        return score;
    }

    _pickBestTextureEntry(entries, materialName, targetSlot) {
        if (!entries || entries.length === 0) return null;

        let best = null;
        let bestScore = -Infinity;
        for (const entry of entries) {
            const score = this._scoreTextureEntry(materialName, entry, targetSlot);
            if (score > bestScore) {
                bestScore = score;
                best = entry;
            }
        }

        // If scoring is weak, prefer deterministic slot fallback.
        if (bestScore < 15) {
            const slotCandidates = entries.filter((entry) => (
                entry.slot === targetSlot ||
                (targetSlot === "map" && entry.slot === "other")
            ));
            if (slotCandidates.length === 0) return null;
            if (targetSlot === "normalMap") {
                return (
                    slotCandidates.find((entry) => entry.isOpenGL) ||
                    slotCandidates.find((entry) => !entry.isDirectX) ||
                    slotCandidates[0]
                );
            }
            return slotCandidates[0];
        }

        return best;
    }

    async _loadTextureFromAbsPath(absPath, colorSpace, cache = null) {
        if (!absPath) return null;

        const cacheKey = `${absPath}|${colorSpace || "none"}`;
        if (cache && cache.has(cacheKey)) {
            return cache.get(cacheKey);
        }

        const promise = new Promise((resolve) => {
            const url = this._resolveResource(absPath);
            const lower = absPath.toLowerCase();
            const onLoad = (tex) => {
                if (!tex) return resolve(null);
                if (colorSpace) tex.colorSpace = colorSpace;
                tex.needsUpdate = true;
                resolve(tex);
            };
            const onError = () => resolve(null);

            if (lower.endsWith(".tga")) {
                const loader = new TGALoader();
                loader.load(url, onLoad, undefined, onError);
            } else {
                const loader = new THREE.TextureLoader();
                loader.load(url, onLoad, undefined, onError);
            }
        });

        if (cache) {
            cache.set(cacheKey, promise);
        }
        return promise;
    }

    /**
     * Classify a texture file into the most likely material slot.
     */
    _classifyTextureSlotFromPath(path) {
        const file = path.split("/").pop().split("\\").pop().toLowerCase();
        const stem = file.replace(/\.[^.]+$/, "");

        if (/(^|[_\-\s])(n|nor|nrm|normal|normalmap)([_\-\s]|$)/.test(stem)) {
            return "normalMap";
        }
        if (/(^|[_\-\s])(ao|occlusion|ambientocclusion)([_\-\s]|$)/.test(stem)) {
            return "aoMap";
        }
        if (/(^|[_\-\s])(emissive|emission|emit|glow)([_\-\s]|$)/.test(stem)) {
            return "emissiveMap";
        }
        if (/(^|[_\-\s])(rough|roughness|rgh|gloss|glossiness|spec|specular|g|s)([_\-\s]|$)/.test(stem)) {
            return "roughnessMap";
        }
        if (/(^|[_\-\s])(metal|metallic|mtl|met)([_\-\s]|$)/.test(stem)) {
            return "metalnessMap";
        }
        if (/(^|[_\-\s])(height|disp|displacement|bump)([_\-\s]|$)/.test(stem)) {
            return "bumpMap";
        }
        if (/(^|[_\-\s])(d|diff|diffuse|albedo|basecolor|base_color|color|col)([_\-\s]|$)/.test(stem)) {
            return "map";
        }

        // For unlabeled color textures (e.g. "Asteroids_01.jpg"), default to map.
        if (/\.(png|jpg|jpeg|tga|bmp|webp|gif|tif|tiff)$/.test(file)) {
            return "map";
        }

        return "other";
    }

    _loadSTL(url) {
        return new Promise((resolve, reject) => {
            const loader = new STLLoader();
            loader.load(
                url,
                (geometry) => {
                    // STLLoader returns a BufferGeometry, not a mesh
                    // Wrap it in a mesh with a default material
                    geometry.computeVertexNormals();
                    const material = new THREE.MeshStandardMaterial({
                        color: 0x808080,
                        roughness: 0.6,
                        metalness: 0.1,
                        side: THREE.DoubleSide,
                    });
                    // STL has no material concept — this is the VIEWER's default, and
                    // must never be reported as an "authored" value (see describe_scene).
                    material.userData._mvViewerDefault = true;
                    const mesh = new THREE.Mesh(geometry, material);
                    const group = new THREE.Group();
                    group.add(mesh);
                    resolve(group);
                },
                undefined,
                (err) => {
                    console.error("STL loader error:", err);
                    reject(new Error(
                        `STL loading failed: ${describeLoadError(err)}`
                    ));
                }
            );
        });
    }

    /**
     * A GLTFLoader with the compressed-glTF decoders attached: Draco (geometry),
     * KTX2/Basis (textures), and Meshopt. Many real-world GLBs ship compressed and
     * won't load without these. All decoder assets are vendored locally (no CDN), so
     * this works offline and in the standalone/Pages bundle.
     */
    _makeGLTFLoader() {
        const loader = new GLTFLoader();
        const base = this._assetBaseUrl;
        // Create the decoders ONCE and reuse them. DRACOLoader/KTX2Loader each spawn web
        // workers; making a new set per load (and never disposing the old) leaks workers.
        try {
            if (!this._dracoLoader) {
                this._dracoLoader = new DRACOLoader();
                this._dracoLoader.setDecoderPath(`${base}vendor/draco/gltf/`);
            }
            loader.setDRACOLoader(this._dracoLoader);
        } catch (e) { console.warn("Draco decoder unavailable:", e); }
        try {
            if (!this._ktx2Loader) {
                this._ktx2Loader = new KTX2Loader();
                this._ktx2Loader.setTranscoderPath(`${base}vendor/basis/`);
                this._ktx2Loader.detectSupport(this._renderer);
            }
            loader.setKTX2Loader(this._ktx2Loader);
        } catch (e) { console.warn("KTX2 transcoder unavailable:", e); }
        try {
            loader.setMeshoptDecoder(MeshoptDecoder);
        } catch (e) { console.warn("Meshopt decoder unavailable:", e); }
        return loader;
    }

    _loadGLTF(url) {
        return new Promise((resolve, reject) => {
            const loader = this._makeGLTFLoader();
            loader.load(
                url,
                (gltf) => {
                    try {
                        const object = gltf.scene;
                        // Expose clips on the object; loadModel wires the mixer/UI.
                        object.animations = gltf.animations || [];
                        resolve(object);
                    } catch (err) {
                        console.error("GLTF post-load error:", err);
                        resolve(gltf.scene);
                    }
                },
                undefined,
                (err) => {
                    console.error("GLTF loader error:", err);
                    reject(new Error(
                        `GLTF loading failed: ${describeLoadError(err)}`
                    ));
                }
            );
        });
    }

    /**
     * Wrap a raw BufferGeometry (from PLY) into a mesh + group, mirroring the STL
     * path. PLY often carries vertex colors; honor them when present so scans and
     * point-cloud-derived meshes look right instead of flat gray.
     */
    _loadPLY(url) {
        return new Promise((resolve, reject) => {
            const loader = new PLYLoader();
            loader.load(
                url,
                (geometry) => {
                    if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals();
                    const hasColor = geometry.hasAttribute("color");
                    const material = new THREE.MeshStandardMaterial({
                        color: hasColor ? 0xffffff : 0x808080,
                        vertexColors: hasColor,
                        roughness: 0.6,
                        metalness: 0.1,
                        side: THREE.DoubleSide,
                    });
                    // PLY carries no material — viewer default, not authored data.
                    material.userData._mvViewerDefault = true;
                    const group = new THREE.Group();
                    group.add(new THREE.Mesh(geometry, material));
                    resolve(group);
                },
                undefined,
                (err) => reject(new Error(
                    `PLY loading failed: ${describeLoadError(err)}`
                ))
            );
        });
    }

    /** Collada (.dae) returns a scene graph on `collada.scene`. */
    _loadCollada(url) {
        return new Promise((resolve, reject) => {
            const loader = new ColladaLoader();
            loader.load(
                url,
                (collada) => {
                    const object = collada.scene;
                    object.animations = collada.animations || object.animations || [];
                    resolve(object);
                },
                undefined,
                (err) => reject(new Error(
                    `Collada loading failed: ${describeLoadError(err)}`
                ))
            );
        });
    }

    /** 3MF returns a Group directly. */
    _load3MF(url) {
        return new Promise((resolve, reject) => {
            const loader = new ThreeMFLoader();
            loader.load(
                url,
                (object) => resolve(object),
                undefined,
                (err) => reject(new Error(
                    `3MF loading failed: ${describeLoadError(err)}`
                ))
            );
        });
    }

    /**
     * USDZ (.usdz) — read-only import. USDZLoader is synchronous-ish (returns a
     * group) but the underlying fetch is async, so we mirror the async pattern.
     */
    async _loadUSDZ(url) {
        const loader = new USDZLoader();
        // USDZLoader.loadAsync returns a THREE.Group.
        const group = await loader.loadAsync(url);
        return group;
    }

    /**
     * Rewrite texture file paths in an MTL file to use our API endpoint.
     */
    _rewriteMtlTexturePaths(mtlText, mtlDir) {
        // Match lines like: map_Kd texture.png
        const textureKeywords = [
            "map_Ka", "map_Kd", "map_Ks", "map_Ns", "map_d",
            "map_bump", "bump", "disp", "decal", "map_Pr",
            "map_Pm", "norm",
        ];

        const lines = mtlText.split("\n");
        const rewritten = lines.map((line) => {
            const trimmed = line.trim();
            for (const keyword of textureKeywords) {
                if (trimmed.startsWith(keyword + " ")) {
                    const texPath = trimmed.substring(keyword.length + 1).trim();
                    // Build full path
                    const fullPath = mtlDir + texPath;
                    const apiUrl = this._resolveResource(fullPath);
                    return `${keyword} ${apiUrl}`;
                }
            }
            return line;
        });

        return rewritten.join("\n");
    }

    // ==========================================
    // Model Enhancement
    // ==========================================

    /**
     * Enhance loaded model with better materials, shadows, etc.
     */
    _enhanceModel(object) {
        object.traverse((child) => {
            if (child.isMesh) {
                // Enable shadows
                child.castShadow = true;
                child.receiveShadow = true;

                // Ensure geometry has normals for proper lighting
                if (child.geometry && !child.geometry.attributes.normal) {
                    child.geometry.computeVertexNormals();
                }

                // Upgrade materials for better rendering
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material = child.material.map((m) =>
                            this._upgradeMaterial(m)
                        );
                    } else {
                        child.material = this._upgradeMaterial(child.material);
                    }
                }
            }
        });
    }

    /**
     * Record the AUTHORED material values before any viewer adjustment. The viewer
     * defensively clamps extreme PBR params for preview (see _fixDarkColor), which is
     * right for display but must never masquerade as asset data: describe_scene reports
     * these authored values alongside the displayed ones so material audits stay honest.
     */
    _stashAuthoredMaterial(material) {
        if (!material || material.userData._mvAuthored) return;
        // Viewer-created defaults (STL/PLY wrappers) have no authored values to report.
        if (material.userData._mvViewerDefault) return;
        material.userData._mvAuthored = {
            metalness: typeof material.metalness === "number" ? material.metalness : null,
            roughness: typeof material.roughness === "number" ? material.roughness : null,
            color: material.color ? `#${material.color.getHexString()}` : null,
            opacity: typeof material.opacity === "number" ? material.opacity : null,
            transparent: !!material.transparent,
        };
    }

    /**
     * Upgrade a basic material to MeshStandardMaterial for PBR rendering.
     * Preserves existing textures and colors.
     */
    _upgradeMaterial(material) {
        this._stashAuthoredMaterial(material);
        this._sanitizeMaterialTextureSlots(material);

        // Skip if already a standard/physical material
        if (
            material.isMeshStandardMaterial ||
            material.isMeshPhysicalMaterial
        ) {
            // Fix unreasonably dark colors that make the model invisible
            this._fixDarkColor(material);
            // NOTE: don't set envMapIntensity here — for scene-environment IBL the r170
            // renderer overrides it with scene.environmentIntensity (see KnowledgeBase).
            material.needsUpdate = true;
            return material;
        }

        // Create a new MeshStandardMaterial preserving existing properties
        let color = material.color
            ? material.color.clone()
            : new THREE.Color(0x808080);

        const params = {
            color: color,
            roughness: 0.6,
            metalness: 0.1,
            side: THREE.DoubleSide,
        };

        // Preserve textures if any
        if (this._isUsableTexture(material.map)) params.map = material.map;
        if (this._isUsableTexture(material.normalMap)) params.normalMap = material.normalMap;
        if (this._isUsableTexture(material.bumpMap)) params.bumpMap = material.bumpMap;
        if (this._isUsableTexture(material.alphaMap)) params.alphaMap = material.alphaMap;
        if (material.emissive) params.emissive = material.emissive.clone();
        if (this._isUsableTexture(material.emissiveMap)) {
            params.emissiveMap = material.emissiveMap;
            if (!params.emissive || this._isVeryDark(params.emissive)) {
                params.emissive = new THREE.Color(0xffffff);
            }
            params.emissiveIntensity = material.emissiveIntensity !== undefined
                ? Math.max(material.emissiveIntensity, 1.0)
                : 1.0;
        }
        if (material.transparent) params.transparent = true;
        if (material.opacity !== undefined) params.opacity = material.opacity;

        // If material has specular/emissive color but very dark diffuse,
        // use the specular or emissive as the base color instead
        if (material.specular && this._isVeryDark(color)) {
            if (!this._isVeryDark(material.specular)) {
                params.color = material.specular.clone();
            }
        }
        if (material.emissive && this._isVeryDark(color)) {
            if (!this._isVeryDark(material.emissive)) {
                params.color = material.emissive.clone();
            }
        }

        const upgraded = new THREE.MeshStandardMaterial(params);
        // Carry the authored snapshot onto the replacement material.
        upgraded.userData._mvAuthored = material.userData._mvAuthored;
        upgraded.name = material.name;

        // Fix dark color after creation
        this._fixDarkColor(upgraded);

        // Dispose old material
        material.dispose();

        return upgraded;
    }

    /**
     * Check if a color is unreasonably dark (nearly black).
     */
    _isVeryDark(color) {
        if (!color) return true;
        const lum = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
        return lum < 0.15;
    }

    /**
     * Fix materials that are too dark to see properly.
     *
     * Many FBX models from asset stores use very dark diffuse colors
     * because they were designed for engines with IBL/environment maps.
     * In our PBR setup without env maps, these appear nearly black.
     *
     * For untextured materials: enforce a minimum brightness.
     */
    _fixDarkColor(material) {
        let changed = false;
        this._sanitizeMaterialTextureSlots(material);

        // Deliberately-colored materials (agent-created primitives) are exempt from
        // the readability clamps — a requested black stays black.
        if (material.userData && material.userData._mvKeepColor) return false;

        // Some FBX exports set transparent=true with very low opacity even for
        // opaque meshes. In a preview viewer this makes assets nearly invisible.
        if (material.transparent && !material.alphaMap && material.opacity < 0.2) {
            material.transparent = false;
            material.opacity = 1.0;
            changed = true;
        }

        // In a no-IBL preview environment, very metallic materials can look
        // almost black. Clamp extreme values when no metalness/roughness maps
        // are provided.
        if (
            material.metalness !== undefined &&
            material.roughness !== undefined &&
            !material.envMap
        ) {
            const hasMetalnessMap = this._isUsableTexture(material.metalnessMap);
            const hasRoughnessMap = this._isUsableTexture(material.roughnessMap);
            const hasColorMap = this._isUsableTexture(material.map);

            // In preview mode without IBL, aggressively metallic materials can
            // collapse to near-black. Keep a conservative metallic response.
            if (!hasMetalnessMap && material.metalness > 0.5) {
                material.metalness = hasColorMap ? 0.25 : 0.12;
                changed = true;
            }

            // Also avoid ultra-smooth surfaces that look black/mirror-like under
            // missing or partial texture setups.
            if (!hasRoughnessMap && material.roughness < 0.45) {
                material.roughness = hasColorMap ? 0.5 : 0.6;
                changed = true;
            }
        }

        if (material.color) {
            const lum = material.color.r * 0.299 + material.color.g * 0.587 + material.color.b * 0.114;
            const hasColorMap = this._isUsableTexture(material.map);

            if (hasColorMap) {
                // Textured materials should usually use a neutral (white)
                // diffuse multiplier. Near-black multipliers crush textures.
                if (lum < 0.25) {
                    material.color.set(0xffffff);
                    changed = true;
                }
            } else {
                if (lum < 0.15) {
                    // Boost to a visible neutral gray
                    material.color.set(0x808080);
                    changed = true;
                } else if (lum < 0.35) {
                    // Slightly dark — brighten proportionally
                    const boost = 0.4 / lum;
                    material.color.r = Math.min(1, material.color.r * boost);
                    material.color.g = Math.min(1, material.color.g * boost);
                    material.color.b = Math.min(1, material.color.b * boost);
                    changed = true;
                }
            }
        }

        if (changed) {
            material.needsUpdate = true;
        }
    }

    // ==========================================
    // Camera & Framing
    // ==========================================

    /**
     * Auto-frame the camera to fit the model in view.
     */
    _frameModel(object) {
        const box = new THREE.Box3().setFromObject(object);
        this._frameToBox(box);
    }

    /**
     * Frame an arbitrary world-space box: size the scene rig to it and move the
     * camera to the classic 3/4 view. `frame_all` passes the visible-scene union;
     * single-object loads pass the object's own box (unchanged behavior).
     */
    _frameToBox(box) {
        this.invalidate();
        if (!box || box.isEmpty()) return;
        this._preFocusClip = null;  // whole-scene framing supersedes any part focus

        this._updateSceneRig(box);

        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);

        // Calculate optimal camera distance
        const fov = this._camera.fov * (Math.PI / 180);
        let distance = maxDim / (2 * Math.tan(fov / 2));
        distance *= 1.8; // Add some padding

        // Position camera
        const direction = new THREE.Vector3(1, 0.6, 1).normalize();
        this._camera.position.copy(
            center.clone().add(direction.multiplyScalar(distance))
        );

        // Update controls target
        this._controls.target.copy(center);
        this._controls.update();

        // Update camera near/far
        this._camera.near = distance * 0.001;
        this._camera.far = distance * 10;
        this._camera.updateProjectionMatrix();

        // Store initial view for spacebar reset
        this._initialCameraPos.copy(this._camera.position);
        this._initialTarget.copy(this._controls.target);
    }

    /**
     * Size the NON-CAMERA scene rig (lights, shadows, ground, grid, axes, fog,
     * nav speed) to a world-space box, without touching the user's camera.
     * Called by framing AND whenever composition changes (add/remove/transform/
     * visibility) so shadows/lights never go stale as objects move around
     * (a placed object outside the last-framed footprint would silently lose
     * its shadow otherwise).
     */
    _updateSceneRig(box) {
        this.invalidate();
        if (!box || box.isEmpty()) return;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;

        // Store scene center and light radius for light orientation controls
        this._modelCenter.copy(center);
        this._keyLightRadius = maxDim * 3;

        // Update axis helper scale + position to match the scene
        const axisSize = maxDim * 0.5;
        this._buildAxisHelper(axisSize);
        this._axisGroup.position.copy(center);
        this._axisGroup.position.y = box.min.y;

        // Position ground at the bottom of the scene
        const minY = box.min.y;
        this._ground.position.y = minY;

        // Rebuild grid scaled to the scene (extends well beyond footprint)
        this._rebuildGrid(maxDim, minY);

        // Update shadow camera to cover the whole scene
        const fov = this._camera.fov * (Math.PI / 180);
        const frameDistance = (maxDim / (2 * Math.tan(fov / 2))) * 1.8;
        const shadowPad = maxDim * 2;
        this._keyLight.shadow.camera.left = -shadowPad;
        this._keyLight.shadow.camera.right = shadowPad;
        this._keyLight.shadow.camera.top = shadowPad;
        this._keyLight.shadow.camera.bottom = -shadowPad;
        this._keyLight.shadow.camera.far = frameDistance * 4;
        this._keyLight.shadow.camera.updateProjectionMatrix();

        // Position the key light using azimuth/elevation
        this._updateKeyLightPosition();

        // Update fog density based on scene size (fog may be disabled via setFog)
        if (this._scene.fog) this._scene.fog.density = 0.5 / maxDim;

        // Set keyboard movement speed proportional to scene size
        // so navigation feels natural regardless of scale
        this._moveSpeed = maxDim * 1.5;
    }

    // ==========================================
    // Light Controls (public API)
    // ==========================================

    /**
     * Update the key light position from current azimuth/elevation.
     * Uses spherical coordinates orbiting around the model center.
     */
    _updateKeyLightPosition() {
        this.invalidate();
        const r = this._keyLightRadius;
        const az = this._keyLightAzimuth;
        const el = this._keyLightElevation;

        // Spherical to cartesian (Y-up)
        const x = this._modelCenter.x + r * Math.cos(el) * Math.cos(az);
        const y = this._modelCenter.y + r * Math.sin(el);
        const z = this._modelCenter.z + r * Math.cos(el) * Math.sin(az);

        this._keyLight.position.set(x, y, z);
        this._keyLight.target.position.copy(this._modelCenter);
        this._keyLight.target.updateMatrixWorld();
    }

    /**
     * Set the key light azimuth (horizontal angle in degrees, 0-360).
     * 0° = front-right, 90° = front-left, 180° = back-left, 270° = back-right.
     */
    setKeyLightAzimuth(degrees) {
        this._keyLightAzimuth = (degrees * Math.PI) / 180;
        this._updateKeyLightPosition();
    }

    /**
     * Set the key light elevation (vertical angle in degrees, 5-90).
     * 5° = nearly horizontal, 90° = directly overhead.
     */
    setKeyLightElevation(degrees) {
        this._keyLightElevation = (degrees * Math.PI) / 180;
        this._updateKeyLightPosition();
    }

    /** Set key light intensity (0-3). Default: 1.2. */
    setKeyLightIntensity(value) {
        this.invalidate();
        this._keyLight.intensity = value;
    }

    /** Set fill light intensity (0-2). Default: 0.5. */
    setFillLightIntensity(value) {
        this.invalidate();
        this._fillLight.intensity = value;
    }

    /** Set ambient light intensity (0-2). Default: 0.3. */
    setAmbientIntensity(value) {
        this.invalidate();
        this._ambientLight.intensity = value;
        this._hemiLight.intensity = value * 2; // Hemisphere scales proportionally
    }

    /** Set tone mapping exposure (0.3-4). Default: 1.2. */
    setExposure(value) {
        this.invalidate();
        this._renderer.toneMappingExposure = value;
    }

    /**
     * Set the model scale uniformly.
     * @param {number} scale - Scale factor (e.g., 0.25, 0.5, 1.0, 2.0)
     */
    setModelScale(scale) {
        this.invalidate();
        const entry = this._activeEntry();
        if (entry) {
            // Reset must be able to restore the pre-scale root transform.
            this._ensureResetSnapshot(entry);
            // Scale sits on the MODEL root (inside the wrapper): it is an asset
            // adjustment that bake ops fold into vertices — distinct from the
            // wrapper's placement scale (set_object_transform), which never bakes.
            entry.model.scale.setScalar(scale);
            entry.modelScale = scale;
        }
    }

    getModelScale() {
        return this._modelScale;
    }

    /**
     * Toggle wireframe rendering on all meshes.
     * @param {boolean} enabled - Whether to show wireframe
     */
    setWireframe(enabled) {
        this.invalidate();
        // Scene-wide display toggle: applies to every object.
        for (const entry of this._objects) {
            entry.model.traverse((child) => {
                if (child.isMesh && child.material) {
                    const mats = Array.isArray(child.material)
                        ? child.material
                        : [child.material];
                    mats.forEach((m) => { m.wireframe = enabled; });
                }
            });
        }
        this._wireframeEnabled = enabled;
    }

    /** Get wireframe state. */
    getWireframe() {
        return this._wireframeEnabled || false;
    }

    /**
     * Toggle vertex normals visualization.
     * Shows colored lines from each vertex in the direction of its normal.
     * Useful for debugging shading issues and verifying normal directions.
     *
     * @param {boolean} enabled
     */
    setNormalsVisible(enabled) {
        this.invalidate();
        // Remove existing helpers
        this._clearNormalsHelpers();

        if (enabled && this._objects.length > 0) {
            this._normalsHelpers = [];
            for (const entry of this._visibleEntries()) {
                // Normal line length proportional to EACH object's own size, so a
                // small object's normals stay readable next to a large neighbor.
                const box = new THREE.Box3().setFromObject(entry.wrapper);
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z) || 1;
                const normalLength = maxDim * 0.02;

                entry.model.traverse((child) => {
                    if (child.isMesh && child.geometry) {
                        const helper = new VertexNormalsHelper(child, normalLength, 0x44ddff);
                        this._scene.add(helper);
                        this._normalsHelpers.push(helper);
                    }
                });
            }
        }

        this._normalsVisible = enabled;
    }

    /** Get normals display state. */
    getNormalsVisible() {
        return this._normalsVisible || false;
    }

    /** Remove all normals helper objects from the scene. */
    _clearNormalsHelpers() {
        if (this._normalsHelpers) {
            for (const h of this._normalsHelpers) {
                this._scene.remove(h);
                h.dispose();
            }
            this._normalsHelpers = [];
        }
    }

    /**
     * Set the viewer background color.
     * Also updates fog and grid colors to match for visual consistency.
     * Grid adapts: light grid lines on dark backgrounds, dark on light.
     * @param {string} hex - CSS hex color (e.g. "#1a1a1a")
     */
    setBackground(hex) {
        this.invalidate();
        const color = new THREE.Color(hex);
        // Don't clobber an environment-as-background; just remember the color for later.
        if (!this._envAsBackground) this._scene.background = color;
        if (this._scene.fog) this._scene.fog.color.copy(color);  // fog may be disabled
        this._currentBgHex = hex;
        this._background = hex;

        // Adapt grid colors based on background luminance
        this._updateGridColors();
    }

    /**
     * Update grid colors to contrast with the background.
     * Rebuilds the grid with the current model dimensions and new colors.
     */
    _updateGridColors() {
        if (!this._grid) return;

        // Rebuild grid with the visible-scene bounds + new background colors
        const box = this._visibleUnionBox();
        if (!box) return;
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        this._rebuildGrid(maxDim, box.min.y);
    }

    /**
     * Toggle grid visibility.
     * @param {boolean} visible
     */
    setGridVisible(visible) {
        this.invalidate();
        this._gridVisible = visible;
        if (this._grid) this._grid.visible = visible;
    }

    /** Get grid visibility. */
    getGridVisible() {
        return this._gridVisible;
    }

    /**
     * Toggle axis helper visibility.
     * @param {boolean} visible
     */
    setAxisVisible(visible) {
        this.invalidate();
        this._axisVisible = visible;
        this._axisGroup.visible = visible;
    }

    // ==========================================
    // Model Transform (recenter, orient, reset, export)
    // ==========================================

    /** Whether the model has been modified (recentered, oriented, scaled). */
    get isModelModified() {
        return this._modelModified || false;
    }

    /**
     * Save a snapshot of all geometry positions + mesh transforms
     * so we can restore them on Reset.
     */
    /** Per-entry geometry snapshot (Reset support). See _insertEntry.
     *
     * Positions are snapshotted THROUGH THE ACCESSOR (getX/getY/getZ), never as a
     * raw array copy: quantized attributes (KHR_mesh_quantization Int16) would
     * snapshot raw integers and restore ±32767-range garbage into the dequantized
     * float buffer after any bake/sculpt; interleaved attributes would snapshot
     * the whole stride-packed buffer and silently fail the restore. Decoded
     * floats restore correctly into ANY later attribute layout via setXYZ. */
    /** Take the Reset snapshot if this entry doesn't have one yet. Called at
     *  every geometry-mutating entry point (bakes, scale, sculpt) — unmodified
     *  models never pay the snapshot's memory. */
    _ensureResetSnapshot(entry) {
        if (entry && !entry.originalState) this._saveOriginalGeometryForEntry(entry);
    }

    _saveOriginalGeometryForEntry(entry) {
        const items = [];
        entry.model.updateMatrixWorld(true);
        entry.model.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const posAttr = child.geometry.attributes.position;
                const positions = new Float32Array(posAttr.count * 3);
                for (let i = 0; i < posAttr.count; i++) {
                    positions[i * 3] = posAttr.getX(i);
                    positions[i * 3 + 1] = posAttr.getY(i);
                    positions[i * 3 + 2] = posAttr.getZ(i);
                }
                items.push({
                    mesh: child,
                    geometry: child.geometry,
                    count: posAttr.count,
                    positions,
                    position: child.position.clone(),
                    rotation: child.rotation.clone(),
                    scale: child.scale.clone(),
                });
            }
        });
        entry.originalState = {
            items,
            rootPos: entry.model.position.clone(),
            rootRot: entry.model.rotation.clone(),
            rootScale: entry.model.scale.clone(),
        };
    }

    /**
     * Reset the ACTIVE object's geometry to its last snapshot (undo transform
     * bakes: center/ground/rotate/orient/scale). Does NOT touch the camera or
     * the object's PLACEMENT (wrapper) — use reset_object_transform for that.
     *
     * The snapshot is RETAKEN after geometry-replacing ops (simplify, recompute
     * normals): restoring a positions array into a differently-sized geometry is
     * exactly the long-standing "offset is out of bounds" crash, so Reset honestly
     * undoes bakes since the last geometry-modifying operation instead.
     */
    resetModel() {
        this.invalidate();
        const entry = this._activeEntry();
        if (!entry || !entry.originalState) return;
        const snap = entry.originalState;

        const restoredGeometries = new Set();
        for (const saved of snap.items) {
            // Geometry object was replaced since the snapshot? (defensive — the
            // retake rule should prevent this, but never write into a mismatched
            // buffer.) Shared geometries (glTF instancing) restore once.
            if (saved.mesh.geometry !== saved.geometry) continue;
            const posAttr = saved.mesh.geometry.attributes.position;
            if (!posAttr || posAttr.count !== saved.count) continue;
            if (!restoredGeometries.has(saved.geometry)) {
                restoredGeometries.add(saved.geometry);
                // Write through the accessor: correct into plain, dequantized OR
                // interleaved layouts alike (see _saveOriginalGeometryForEntry).
                for (let i = 0; i < saved.count; i++) {
                    posAttr.setXYZ(i, saved.positions[i * 3],
                                   saved.positions[i * 3 + 1],
                                   saved.positions[i * 3 + 2]);
                }
                posAttr.needsUpdate = true;
                saved.mesh.geometry.computeVertexNormals();
                saved.mesh.geometry.computeBoundingBox();
                saved.mesh.geometry.computeBoundingSphere();
            }

            saved.mesh.position.copy(saved.position);
            saved.mesh.rotation.copy(saved.rotation);
            saved.mesh.scale.copy(saved.scale);
            saved.mesh.updateMatrix();
        }

        entry.model.position.copy(snap.rootPos);
        entry.model.rotation.copy(snap.rootRot);
        entry.model.scale.copy(snap.rootScale);
        // Keep the tracked scale value in sync with the restored root scale
        // (getModelScale/UI slider read it).
        entry.modelScale = snap.rootScale.x;

        entry.sculpted = false;
        // Paint layers survive reset (clear_paint is their undo) — the object is
        // still export-dirty if any remain.
        entry.modified = paintedMeshNames(entry.model).length > 0;
    }

    /**
     * Bake the active object's transforms into vertex positions, RELATIVE TO ITS
     * WRAPPER. After this, all transforms inside the model subtree are identity
     * and vertices are wrapper-local coordinates.
     *
     * The wrapper (scene placement, backlog 042) is deliberately excluded: baking
     * matrixWorld outright would fold the user's scene placement into the asset's
     * geometry — exports and manifests would then double-apply it.
     *
     * Refuses skinned models: zeroing bone-carrying nodes corrupts the bind pose
     * (documented pre-existing failure — now blocked instead of inherited).
     */
    _bakeWorldTransforms() {
        const entry = this._activeEntry();
        if (!entry) return;
        if (entry.skinned) {
            throw new Error(
                "Transform baking (center/ground/rotate/orient/simplify) is not "
                + "supported for skinned/animated models — it corrupts the bind pose. "
                + "Use set_object_transform to place the object instead.");
        }
        // First mutation of this entry? Snapshot NOW, before vertices change.
        this._ensureResetSnapshot(entry);

        const model = entry.model;
        entry.wrapper.updateMatrixWorld(true);
        const wrapperInv = new THREE.Matrix4().copy(entry.wrapper.matrixWorld).invert();
        const local = new THREE.Matrix4();

        model.traverse((child) => {
            if (child.isMesh && child.geometry) {
                // Quantized attributes (KHR_mesh_quantization: normalized Int16/Uint16
                // positions with the dequant scale in the node transform) MUST be
                // converted to plain Float32 before baking. applyMatrix4 would write
                // world-scale floats back into the integer array — overflow garbage
                // that destroys the model (verified live on a KTX2/quantized GLB).
                this._dequantizeVectorAttributes(child.geometry);
                local.multiplyMatrices(wrapperInv, child.matrixWorld);
                child.geometry.applyMatrix4(local);
                child.position.set(0, 0, 0);
                child.rotation.set(0, 0, 0);
                child.scale.set(1, 1, 1);
                child.updateMatrix();
            }
        });

        // Reset all intermediate groups and the model root (the wrapper is NOT part
        // of this traversal — placement survives).
        model.traverse((node) => {
            if (!node.isMesh) {
                node.position.set(0, 0, 0);
                node.rotation.set(0, 0, 0);
                node.scale.set(1, 1, 1);
                node.updateMatrix();
            }
        });
        model.updateMatrixWorld(true);
    }

    /**
     * Wrapper-LOCAL bounding box of the active object AFTER a bake (all subtree
     * transforms identity ⇒ geometry coordinates ARE wrapper-local). Box math for
     * bake ops must use this, never Box3.setFromObject (which is world space and
     * would fold the wrapper placement back into the offsets — under a rotated
     * wrapper, ground would shift along the wrong axes).
     */
    _localBakedBox() {
        const entry = this._activeEntry();
        const box = new THREE.Box3();
        if (!entry) return box;
        entry.model.traverse((child) => {
            if (!child.isMesh || !child.geometry) return;
            child.geometry.computeBoundingBox();
            if (child.geometry.boundingBox && !child.geometry.boundingBox.isEmpty()) {
                box.union(child.geometry.boundingBox);
            }
        });
        return box;
    }

    /**
     * Replace integer/normalized vector attributes (position/normal/tangent) with plain
     * Float32 copies, reading through the accessor so normalization is decoded. Required
     * before any in-place matrix bake; a no-op for already-float geometry.
     */
    _dequantizeVectorAttributes(geometry) {
        for (const name of ["position", "normal", "tangent"]) {
            const attr = geometry.getAttribute(name);
            if (!attr) continue;
            const needsConvert = attr.normalized || !(attr.array instanceof Float32Array);
            if (!needsConvert) continue;
            const itemSize = attr.itemSize;
            const out = new Float32Array(attr.count * itemSize);
            for (let i = 0; i < attr.count; i++) {
                out[i * itemSize] = attr.getX(i);
                if (itemSize > 1) out[i * itemSize + 1] = attr.getY(i);
                if (itemSize > 2) out[i * itemSize + 2] = attr.getZ(i);
                if (itemSize > 3) out[i * itemSize + 3] = attr.getW(i);
            }
            geometry.setAttribute(name, new THREE.BufferAttribute(out, itemSize));
        }
    }

    /**
     * Center the model so its bounding box center is at (0, 0, 0).
     * Does NOT touch the camera.
     */
    recenterModel() {
        if (!this._currentModel) return;

        // Bake transforms so we work with clean geometry (wrapper-local).
        this._bakeWorldTransforms();

        // Compute center in the object's LOCAL frame — centering normalizes the
        // asset at its own origin; scene placement (wrapper) is untouched.
        const box = this._localBakedBox();
        const center = box.getCenter(new THREE.Vector3());

        // Shift all vertices so center is at origin
        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                child.geometry.translate(-center.x, -center.y, -center.z);
                child.geometry.computeBoundingBox();
                child.geometry.computeBoundingSphere();
            }
        });

        this._modelModified = true;
    }

    /**
     * Auto-orient the model using PCA (Principal Component Analysis).
     *
     * Aligns the model so its "up" direction (smallest variance axis)
     * coincides with the Y axis. Does NOT touch the camera.
     */
    /**
     * Ground the model: center on X/Z and place it on the ground plane.
     * The lowest geometry point is at Y=0 (model sits on a surface).
     * Does NOT touch the camera.
     */
    groundModel() {
        if (!this._currentModel) return;

        this._bakeWorldTransforms();

        // LOCAL-frame normalization: the asset sits centered on its own local
        // origin with its lowest point at local y=0. With an identity wrapper
        // (the single-object case) this is exactly the old world-ground; with a
        // placed object it grounds AT ITS PLACEMENT (predictable, and keeps
        // geometry independent of scene composition).
        const box = this._localBakedBox();
        const center = box.getCenter(new THREE.Vector3());

        const offsetX = -center.x;
        const offsetZ = -center.z;
        const offsetY = -box.min.y; // Lift so lowest point touches local Y=0

        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                child.geometry.translate(offsetX, offsetY, offsetZ);
                child.geometry.computeBoundingBox();
                child.geometry.computeBoundingSphere();
            }
        });

        this._modelModified = true;
    }

    /**
     * Rotate the model by a given angle around an axis.
     * Bakes the rotation directly into the geometry vertices.
     * Does NOT touch the camera.
     *
     * @param {'x'|'y'|'z'} axis - The rotation axis
     * @param {number} angleDeg - Rotation angle in degrees (e.g., 90, -90)
     */
    /**
     * Recompute smooth vertex normals for all meshes.
     *
     * Steps:
     * 1. Delete existing normals (they prevent vertex merging at hard edges)
     * 2. Merge vertices at the same position (creates indexed geometry)
     * 3. Compute vertex normals by averaging face normals at shared vertices
     *
     * This turns faceted/flat shading into fully smooth shading.
     */
    recomputeNormals() {
        if (!this._currentModel) return;

        // If normals are displayed, turn them off first (will re-add after)
        const hadNormals = this._normalsVisible;
        if (hadNormals) this.setNormalsVisible(false);

        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const orig = child.geometry;
                try {
                    // Work on a CLONE, and only swap it in on success. Cloning also
                    // de-interleaves interleaved attributes (common in GLB), which
                    // mergeVertices cannot process — this both fixes the crash on such
                    // models and keeps the op atomic (a failure leaves the mesh intact
                    // instead of stripping its normals and rendering it black).
                    const geo = this._mergeableClone(orig);

                    // Remove per-face normals AND tangents. Both are per-face-derived
                    // attributes that differ across faceted duplicate vertices; if
                    // either remains, mergeVertices refuses to merge and smoothing
                    // fails. Tangents are recomputed/invalidated anyway. KEEP the UVs so
                    // the texture mapping survives (merge splits only at genuine seams).
                    geo.deleteAttribute("normal");
                    if (geo.hasAttribute("tangent")) geo.deleteAttribute("tangent");

                    const merged = BufferGeometryUtils.mergeVertices(geo, 0.0001);
                    merged.computeVertexNormals();
                    merged.computeBoundingBox();
                    merged.computeBoundingSphere();

                    child.geometry = merged;
                    orig.dispose();
                    if (geo !== merged) geo.dispose();
                } catch (err) {
                    console.warn("recomputeNormals: skipped a mesh (left unchanged):", err);
                }
            }
        });

        this._modelModified = true;

        // Re-enable normals display if it was on
        if (hadNormals) this.setNormalsVisible(true);

        // Geometry objects were REPLACED — the old snapshot must not be restored
        // into the new geometry (the "offset out of bounds" bug). Drop it; the
        // NEW geometry becomes the reset baseline, snapshotted lazily on the next
        // mutation ("reset = undo everything since the last geometry-replacing op").
        const entry = this._activeEntry();
        if (entry) {
            entry.originalState = null;
            entry.stats = this._computeStats(entry.model);
            this._lastStats = entry.stats;
            this._onInfoUpdate(entry.stats);
        }
    }

    /**
     * Return a geometry safe to feed to mergeVertices/SimplifyModifier: a clone with
     * plain (non-interleaved) attributes. BufferGeometry.clone() de-interleaves
     * InterleavedBufferAttributes, so this both avoids the interleaved-buffer crash and
     * protects the original from partial mutation.
     */
    _mergeableClone(geometry) {
        const clone = geometry.clone();
        // Belt-and-suspenders: if any attribute is still interleaved, de-interleave.
        for (const key in clone.attributes) {
            if (clone.attributes[key].isInterleavedBufferAttribute) {
                return deinterleaveGeometry(clone);
            }
        }
        return clone;
    }

    rotateModel(axis, angleDeg) {
        if (!this._currentModel) return;

        this._bakeWorldTransforms();

        const angleRad = (angleDeg * Math.PI) / 180;
        const rotMatrix = new THREE.Matrix4();

        if (axis === "x") rotMatrix.makeRotationX(angleRad);
        else if (axis === "y") rotMatrix.makeRotationY(angleRad);
        else if (axis === "z") rotMatrix.makeRotationZ(angleRad);

        // Rotate about the object's LOCAL center, in its LOCAL axes — the bake is
        // wrapper-relative, so vertices are local coordinates here. (World-space
        // box math would mis-place the pivot under a placed/rotated wrapper.)
        const box = this._localBakedBox();
        const center = box.getCenter(new THREE.Vector3());

        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const posAttr = child.geometry.attributes.position;
                if (!posAttr) return;

                for (let i = 0; i < posAttr.count; i++) {
                    const v = new THREE.Vector3().fromBufferAttribute(posAttr, i);
                    v.sub(center);
                    v.applyMatrix4(rotMatrix);
                    v.add(center);
                    posAttr.setXYZ(i, v.x, v.y, v.z);
                }
                posAttr.needsUpdate = true;
                child.geometry.computeVertexNormals();
                child.geometry.computeBoundingBox();
                child.geometry.computeBoundingSphere();
            }
        });

        this._modelModified = true;
    }

    autoOrientModel() {
        if (!this._currentModel) return;

        // Bake transforms first
        this._bakeWorldTransforms();

        // 1. Collect all vertex positions
        const positions = [];
        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const posAttr = child.geometry.attributes.position;
                if (!posAttr) return;
                for (let i = 0; i < posAttr.count; i++) {
                    positions.push(new THREE.Vector3().fromBufferAttribute(posAttr, i));
                }
            }
        });

        if (positions.length < 3) return;

        // 2. Compute centroid
        const centroid = new THREE.Vector3();
        for (const p of positions) centroid.add(p);
        centroid.divideScalar(positions.length);

        // 3. Compute covariance matrix
        let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
        for (const p of positions) {
            const dx = p.x - centroid.x;
            const dy = p.y - centroid.y;
            const dz = p.z - centroid.z;
            cxx += dx * dx; cxy += dx * dy; cxz += dx * dz;
            cyy += dy * dy; cyz += dy * dz; czz += dz * dz;
        }
        const n = positions.length;
        cxx /= n; cxy /= n; cxz /= n; cyy /= n; cyz /= n; czz /= n;

        // 4. Find eigenvectors
        const eigenvectors = this._computeEigenvectors3x3(
            cxx, cxy, cxz, cyy, cyz, czz
        );

        // 5. Sort: largest → X, medium → Z, smallest → Y (up)
        eigenvectors.sort((a, b) => b.value - a.value);

        const ex = eigenvectors[0].vector.normalize();
        const ey = eigenvectors[2].vector.normalize(); // smallest → up
        const ez = eigenvectors[1].vector.normalize();

        // Ensure right-handed + Y points up
        const cross = new THREE.Vector3().crossVectors(ex, ey);
        if (cross.dot(ez) < 0) ez.negate();
        if (ey.y < 0) { ey.negate(); ez.negate(); }

        // Rotation matrix
        const rotMatrix = new THREE.Matrix4().makeBasis(ex, ey, ez);
        const invRot = rotMatrix.clone().invert();

        // 6. Apply rotation to all vertices (centered at centroid)
        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const posAttr = child.geometry.attributes.position;
                if (!posAttr) return;

                for (let i = 0; i < posAttr.count; i++) {
                    const v = new THREE.Vector3().fromBufferAttribute(posAttr, i);
                    v.sub(centroid);
                    v.applyMatrix4(invRot);
                    v.add(centroid); // Keep position, only rotate
                    posAttr.setXYZ(i, v.x, v.y, v.z);
                }
                posAttr.needsUpdate = true;
                child.geometry.computeVertexNormals();
                child.geometry.computeBoundingBox();
                child.geometry.computeBoundingSphere();
            }
        });

        this._modelModified = true;
    }

    /**
     * Compute eigenvectors of a 3x3 symmetric matrix via power iteration + deflation.
     */
    _computeEigenvectors3x3(a00, a01, a02, a11, a12, a22) {
        const mat = [
            [a00, a01, a02],
            [a01, a11, a12],
            [a02, a12, a22],
        ];

        const results = [];

        for (let round = 0; round < 3; round++) {
            let v = [Math.random(), Math.random(), Math.random()];
            let eigenvalue = 0;

            for (let iter = 0; iter < 100; iter++) {
                const w = [
                    mat[0][0] * v[0] + mat[0][1] * v[1] + mat[0][2] * v[2],
                    mat[1][0] * v[0] + mat[1][1] * v[1] + mat[1][2] * v[2],
                    mat[2][0] * v[0] + mat[2][1] * v[1] + mat[2][2] * v[2],
                ];
                const len = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
                if (len < 1e-10) break;
                v = [w[0] / len, w[1] / len, w[2] / len];
                eigenvalue = len;
            }

            results.push({
                value: eigenvalue,
                vector: new THREE.Vector3(v[0], v[1], v[2]),
            });

            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    mat[i][j] -= eigenvalue * v[i] * v[j];
                }
            }
        }

        return results;
    }

    /**
     * Export the current model as OBJ text.
     * Bakes all transforms into the output.
     */
    /**
     * Extract all materials from the current model with mesh references.
     *
     * Returns an array of material descriptors:
     * {
     *   id: number,              // Unique index
     *   name: string,            // Material name or auto-generated
     *   material: THREE.Material, // Direct reference (for future editing)
     *   meshes: THREE.Mesh[],    // Meshes using this material
     *   color: string,           // Hex color (#rrggbb)
     *   roughness: number,
     *   metalness: number,
     *   opacity: number,
     *   transparent: boolean,
     *   wireframe: boolean,
     *   type: string,            // e.g. "MeshStandardMaterial"
     *   hasMap: boolean,         // Has diffuse texture
     *   hasNormalMap: boolean,
     * }
     *
     * The material references are live — editing them affects the scene
     * immediately (foundation for future material editor).
     */
    getMaterialsInfo() {
        if (!this._currentModel) return [];

        // Use a Map to deduplicate materials (same material instance on multiple meshes)
        const matMap = new Map();
        let autoId = 0;

        this._currentModel.traverse((child) => {
            if (!child.isMesh || !child.material) return;

            const mats = Array.isArray(child.material)
                ? child.material
                : [child.material];

            for (const mat of mats) {
                if (!matMap.has(mat)) {
                    matMap.set(mat, {
                        id: autoId++,
                        name: mat.name || `Material_${autoId}`,
                        material: mat, // Live reference for future editing
                        meshes: [],
                        color: mat.color ? "#" + mat.color.getHexString() : "#808080",
                        roughness: mat.roughness !== undefined ? mat.roughness : 0.5,
                        metalness: mat.metalness !== undefined ? mat.metalness : 0.0,
                        opacity: mat.opacity !== undefined ? mat.opacity : 1.0,
                        transparent: !!mat.transparent,
                        wireframe: !!mat.wireframe,
                        type: mat.type || "Unknown",
                        hasMap: !!mat.map,
                        hasNormalMap: !!mat.normalMap,
                    });
                }
                matMap.get(mat).meshes.push(child);
            }
        });

        return Array.from(matMap.values());
    }

    /**
     * Get the total unique vertex count of the current model.
     * Uses the stats computed by _computeStats (which deduplicates).
     */
    getTotalVertexCount() {
        if (!this._currentModel) return 0;
        const stats = this._computeStats(this._currentModel);
        return stats.vertices;
    }

    /**
     * Simplify model geometry — async, cancellable, processes one mesh at a time.
     *
     * @param {number} targetRatio - 0.0–1.0 ratio of vertices to keep
     * @param {AbortSignal} signal - AbortController signal to cancel
     * @returns {Promise<{before: number, after: number}>}
     */
    async simplifyModel(targetRatio, signal) {
        if (!this._currentModel) return { before: 0, after: 0 };

        const modifier = new SimplifyModifier();
        let totalBefore = 0;
        let totalAfter = 0;

        const hadNormals = this._normalsVisible;
        if (hadNormals) this.setNormalsVisible(false);

        // Bake world transforms first
        this._bakeWorldTransforms();

        // Collect meshes to process
        const meshes = [];
        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) meshes.push(child);
        });

        // Process one mesh at a time with yield to UI between each
        for (let i = 0; i < meshes.length; i++) {
            // Check for cancellation
            if (signal && signal.aborted) {
                return { before: totalBefore, after: totalAfter, cancelled: true };
            }

            const child = meshes[i];
            const origGeo = child.geometry;
            let geo;
            try {
                // Clone (de-interleaves GLB interleaved buffers) so mergeVertices works
                // and the original stays intact if anything fails. Drop per-face normals
                // AND tangents so faceted duplicates collapse; keep UVs (SimplifyModifier
                // r170 carries `uv` through decimation, so textures survive).
                geo = this._mergeableClone(origGeo);
                geo.deleteAttribute("normal");
                if (geo.hasAttribute("tangent")) geo.deleteAttribute("tangent");
                geo = BufferGeometryUtils.mergeVertices(geo, 0.0001);
            } catch (err) {
                console.warn(`Simplify: skipped mesh ${child.name} (unchanged):`, err);
                totalBefore += origGeo.attributes.position ? origGeo.attributes.position.count : 0;
                totalAfter += origGeo.attributes.position ? origGeo.attributes.position.count : 0;
                await new Promise((r) => setTimeout(r, 0));
                continue;
            }

            const vertCount = geo.attributes.position.count;
            totalBefore += vertCount;

            const targetCount = Math.max(4, Math.floor(vertCount * targetRatio));
            const removeCount = vertCount - targetCount;

            if (removeCount <= 0) {
                child.geometry.dispose();
                child.geometry = geo;
                child.geometry.computeVertexNormals();
                totalAfter += vertCount;
            } else {
                try {
                    const simplified = modifier.modify(geo, removeCount);
                    child.geometry.dispose();
                    child.geometry = simplified;
                    totalAfter += simplified.attributes.position.count;
                } catch (err) {
                    console.warn(`Simplification failed for mesh ${child.name}:`, err);
                    child.geometry.dispose();
                    child.geometry = geo;
                    totalAfter += vertCount;
                }

                child.geometry.computeVertexNormals();
                child.geometry.computeBoundingBox();
                child.geometry.computeBoundingSphere();
            }

            // Yield to UI after each mesh (allows cancel button to be clicked)
            await new Promise((r) => setTimeout(r, 10));
        }

        this._modelModified = true;
        if (hadNormals) this.setNormalsVisible(true);

        // Geometry objects were REPLACED — drop the stale snapshot; the new
        // geometry is the reset baseline (snapshotted lazily on next mutation).
        const entry = this._activeEntry();
        if (entry) {
            entry.originalState = null;
            entry.stats = this._computeStats(entry.model);
            this._lastStats = entry.stats;
            this._onInfoUpdate(entry.stats);
            return { before: totalBefore, after: totalAfter };
        }

        const stats = this._computeStats(this._currentModel);
        this._onInfoUpdate(stats);

        return { before: totalBefore, after: totalAfter };
    }

    /**
     * Apply textures from a scanned texture folder.
     *
     * Takes a map of lowercase filename → server path (from /api/scan_textures),
     * scans all materials for missing texture maps, and attempts to load
     * matching textures by filename (case-insensitive).
     *
     * @param {Object} textureMap - { "filename.png": "/abs/path/filename.png", ... }
     * @returns {number} Number of textures applied
     */
    async applyTextureFolder(textureMap) {
        if (!this._currentModel) return 0;

        let applied = 0;
        const textureCache = new Map();

        const loadTexture = async (path, prop) => {
            const colorSpace = (prop === "map" || prop === "emissiveMap")
                ? THREE.SRGBColorSpace
                : THREE.LinearSRGBColorSpace;
            return this._loadTextureFromAbsPath(path, colorSpace, textureCache);
        };

        // Scan all materials for missing maps
        const mapProps = ["map", "normalMap", "roughnessMap", "metalnessMap",
                          "aoMap", "emissiveMap", "bumpMap", "displacementMap",
                          "alphaMap", "envMap", "lightMap"];

        for (const matInfo of this.getMaterialsInfo()) {
            const mat = matInfo.material;
            let matChanged = false;

            // Check each texture slot
            for (const prop of mapProps) {
                // Skip if already has a texture loaded
                if (mat[prop]) continue;

                // Check if there's a reference we can try to resolve
                // For materials without explicit references, try common naming
                // conventions: {materialName}_diffuse, {materialName}_normal, etc.
                const conventions = this._getTextureConventions(matInfo.name, prop);

                for (const name of conventions) {
                    const match = textureMap[name.toLowerCase()];
                    if (match) {
                        const tex = await loadTexture(match, prop);
                        if (tex) {
                            mat[prop] = tex;
                            matChanged = true;
                            applied++;
                            break;
                        }
                    }
                }
            }

            // Also try to assign a diffuse map if nothing was found via conventions
            // by matching any texture with a similar name to the material
            if (!mat.map && !matChanged) {
                const matName = matInfo.name.toLowerCase().replace(/[_\s-]/g, "");
                for (const [filename, filepath] of Object.entries(textureMap)) {
                    const cleanFile = filename.replace(/[_\s-]/g, "").replace(/\.\w+$/, "");
                    if (cleanFile.includes(matName) || matName.includes(cleanFile)) {
                        const tex = await loadTexture(filepath, "map");
                        if (tex) {
                            mat.map = tex;
                            matChanged = true;
                            applied++;
                            break;
                        }
                    }
                }
            }

            if (matChanged) {
                mat.needsUpdate = true;
            }
        }

        return applied;
    }

    /**
     * Generate texture filename conventions for a material + channel.
     * Tries common naming patterns used by 3D tools.
     */
    _getTextureConventions(materialName, channel) {
        const name = materialName.replace(/\s+/g, "_");
        const channelNames = {
            map: ["diffuse", "basecolor", "base_color", "color", "albedo", "diff", "col"],
            normalMap: ["normal", "norm", "nrm", "bump"],
            roughnessMap: ["roughness", "rough", "rgh"],
            metalnessMap: ["metalness", "metallic", "metal", "met"],
            aoMap: ["ao", "ambient_occlusion", "occlusion", "occ"],
            emissiveMap: ["emissive", "emission", "emit", "glow"],
            bumpMap: ["bump", "height", "disp"],
            displacementMap: ["displacement", "disp", "height"],
            alphaMap: ["alpha", "opacity", "mask", "transparency"],
        };

        const suffixes = channelNames[channel] || [];
        const results = [];
        const exts = [".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tiff"];

        for (const suffix of suffixes) {
            for (const ext of exts) {
                results.push(`${name}_${suffix}${ext}`);
                results.push(`${suffix}${ext}`);
            }
        }

        return results;
    }

    /**
     * Capture the current 3D view as a PNG and trigger download.
     */
    /**
     * Render one frame and return the view as a PNG data URL (no download).
     * This is the capture primitive used by the control API / AI agents to "see".
     *
     * For a hero-quality shot it renders THROUGH the postprocessing composer (SSAO +
     * tone mapping), so the capture matches the on-screen image instead of a flatter
     * direct render. Options let a caller pick an explicit output resolution (decoupled
     * from the on-screen canvas) and a transparent background for compositing.
     *
     * @param {object} [opts]
     * @param {number} [opts.width]  - output width in px (defaults to canvas width)
     * @param {number} [opts.height] - output height in px (defaults to canvas height)
     * @param {boolean} [opts.transparent=false] - transparent background (disables SSAO)
     * @param {boolean} [opts.ssao=true] - render through the SSAO composer for depth
     */
    captureImage(opts = {}) {
        const r = this._renderer;
        const cam = this._camera;

        // --- snapshot everything we may touch, restore it all afterwards ---
        const prevSize = new THREE.Vector2();
        r.getSize(prevSize);
        const prevPixelRatio = r.getPixelRatio();
        const prevComposerPR = this._composer ? this._composer._pixelRatio : 1;
        const prevAspect = cam.aspect;
        const prevBg = this._scene.background;
        const prevFog = this._scene.fog;
        const prevClear = r.getClearColor(new THREE.Color());
        const prevClearAlpha = r.getClearAlpha();
        const prevGroundVisible = this._ground ? this._ground.visible : true;
        const prevSsao = this._ssaoPass
            ? { w: this._ssaoPass.width, h: this._ssaoPass.height } : null;

        // Derive a missing dimension from the current aspect so width-only / height-only
        // still work instead of being silently ignored.
        let width = opts.width, height = opts.height;
        if (width && !height) height = Math.round(width / prevAspect);
        if (height && !width) width = Math.round(height * prevAspect);
        const resize = !!(width && height);

        const transparent = !!opts.transparent;
        // Fog blends the model toward the background and washes out hero shots (badly on
        // light backgrounds). Suppress it unless the caller explicitly wants it.
        const suppressFog = opts.fog === false || transparent;
        const hideGround = !!opts.hideGround || transparent;
        // Transparent captures bypass the composer (SSAO/OutputPass don't preserve alpha);
        // opaque captures use the composer so they match on-screen quality.
        const useComposer = (opts.ssao !== false) && this._composer && !transparent;

        if (resize) {
            r.setPixelRatio(1);
            if (this._composer && this._composer.setPixelRatio) this._composer.setPixelRatio(1);
            r.setSize(width, height, false);
            if (this._composer) this._composer.setSize(width, height);
            if (this._ssaoPass) this._ssaoPass.setSize(width, height);
            cam.aspect = width / height;
            cam.updateProjectionMatrix();
        }
        if (suppressFog) this._scene.fog = null;
        if (hideGround && this._ground) this._ground.visible = false;
        if (transparent) {
            this._scene.background = null;
            r.setClearColor(0x000000, 0);
        }

        // UI helpers (e.g. the transform gizmo) registered by the app must never
        // appear in captures — hide them for this frame, restore after.
        const hiddenHelpers = (this._captureHidden || []).filter((o) => o.visible);
        hiddenHelpers.forEach((o) => { o.visible = false; });

        // A camera-relative clip plane is normally refreshed by the rAF loop, which does
        // not run during a synchronous capture — refresh it here so the cut matches THIS
        // camera (fixes stale clips in capture_views/turntable).
        this._refreshCameraClip();

        if (useComposer) this._composer.render();
        else r.render(this._scene, cam);

        const dataUrl = r.domElement.toDataURL("image/png");
        hiddenHelpers.forEach((o) => { o.visible = true; });

        // --- restore ---
        this._scene.background = prevBg;
        this._scene.fog = prevFog;
        r.setClearColor(prevClear, prevClearAlpha);
        if (this._ground) this._ground.visible = prevGroundVisible;
        if (resize) {
            r.setPixelRatio(prevPixelRatio);
            if (this._composer && this._composer.setPixelRatio) this._composer.setPixelRatio(prevComposerPR);
            r.setSize(prevSize.x, prevSize.y, false);
            if (this._composer) this._composer.setSize(prevSize.x, prevSize.y);
            if (this._ssaoPass && prevSsao) this._ssaoPass.setSize(prevSsao.w, prevSsao.h);
            cam.aspect = prevAspect;
            cam.updateProjectionMatrix();
        }
        // The canvas now holds the capture-sized frame; with the demand-driven
        // loop idle, nothing would repaint at the live size until the next input.
        this.invalidate();
        return dataUrl;
    }

    screenshot(opts = {}) {
        const dataUrl = this.captureImage(opts);
        const link = document.createElement("a");
        link.download = "meshvault_screenshot.png";
        link.href = dataUrl;
        link.click();
        return dataUrl;
    }

    exportAsOBJ() {
        // OBJ export stays ACTIVE-OBJECT only (multi-object OBJ needs global
        // vertex-index rebasing across parses — GLB is the composed-scene format).
        if (!this._currentModel) return null;
        this._currentModel.updateMatrixWorld(true);
        const exporter = new OBJExporter();
        return exporter.parse(this._currentModel);
    }

    /**
     * Export as GLB — self-contained binary glTF.
     *
     * Builds a new flat scene with fresh geometry and materials containing
     * only what glTF can represent. Never passes the live scene graph to the
     * exporter (FBX-loaded models carry state that breaks GLTFExporter).
     *
     * UV convention: glTF (0,0) = upper-left; Three.js = lower-left.
     * We flip V (v→1-v) and set textures to flipY=false so the exporter
     * writes pixel data without implicit flips.
     */
    async exportAsGLB() {
        if (this._objects.length === 0) return null;

        const exportScene = new THREE.Scene();
        exportScene.name = "MeshVault";

        // Export every VISIBLE object. matrixWorld includes each object's wrapper
        // placement, so a composed scene exports exactly as arranged — without
        // ever baking placements into the live geometry.
        for (const entry of this._visibleEntries()) {
            entry.wrapper.updateMatrixWorld(true);
            entry.model.traverse((child) => {
                this._appendExportMesh(exportScene, child);
            });
        }

        if (exportScene.children.length === 0) return null;

        const exporter = new GLTFExporter();
        return new Promise((resolve, reject) => {
            exporter.parse(
                exportScene,
                (result) => resolve(result),
                (error) => reject(error),
                { binary: true, maxTextureSize: 4096 }
            );
        });
    }

    /** Clone one mesh into the export scene with glTF-safe geometry + material. */
    _appendExportMesh(exportScene, child) {
        {
            if (!child.isMesh || !child.geometry) return;

            const srcGeo = child.geometry;
            const geo = new THREE.BufferGeometry();

            // position — clone without baking (preserves GPU-path fidelity)
            const srcPos = srcGeo.attributes.position;
            if (srcPos) geo.setAttribute("position", srcPos.clone());

            // normal
            const srcNorm = srcGeo.attributes.normal;
            if (srcNorm) geo.setAttribute("normal", srcNorm.clone());

            // uv — flip V for glTF upper-left origin
            const srcUV = srcGeo.attributes.uv;
            if (srcUV) {
                const uvArr = new Float32Array(srcUV.array);
                for (let i = 0; i < uvArr.length; i += 2) {
                    uvArr[i + 1] = 1.0 - uvArr[i + 1];
                }
                geo.setAttribute("uv", new THREE.BufferAttribute(uvArr, 2));
            }

            // tangent — negate w (handedness) because we flipped V
            const srcTan = srcGeo.attributes.tangent;
            if (srcTan && srcTan.itemSize === 4) {
                const tanArr = new Float32Array(srcTan.array);
                for (let i = 0; i < srcTan.count; i++) {
                    tanArr[i * 4 + 3] = -tanArr[i * 4 + 3];
                }
                geo.setAttribute("tangent", new THREE.BufferAttribute(tanArr, 4));
            }

            // index
            if (srcGeo.index) geo.setIndex(srcGeo.index.clone());

            // material — new MeshStandardMaterial with only glTF-safe props.
            // Read the ORIGINAL material, never a viewer override: a solid/normals
            // render mode stashes the original on _mvOriginalMaterial, and exporting
            // the live override would bake clay/normal-colors into the asset.
            const stash = child._mvOriginalMaterial || child.material;
            const srcMat = Array.isArray(stash) ? stash[0] : stash;

            const matParams = {
                roughness: srcMat.roughness !== undefined ? srcMat.roughness : 0.5,
                metalness: srcMat.metalness !== undefined ? srcMat.metalness : 0.0,
                side: THREE.DoubleSide,
            };

            if (srcMat.map) {
                matParams.color = 0xffffff;
                matParams.map = this._prepTextureForGLB(srcMat.map);
            } else if (srcMat.color) {
                matParams.color = srcMat.color.clone();
            }

            if (srcMat.normalMap) {
                matParams.normalMap = this._prepTextureForGLB(srcMat.normalMap);
            }
            if (srcMat.emissiveMap) {
                matParams.emissiveMap = this._prepTextureForGLB(srcMat.emissiveMap);
                matParams.emissive = new THREE.Color(0xffffff);
            }
            if (srcMat.aoMap) {
                matParams.aoMap = this._prepTextureForGLB(srcMat.aoMap);
                if (srcUV) {
                    const uv2Arr = new Float32Array(srcUV.array);
                    for (let i = 0; i < uv2Arr.length; i += 2) {
                        uv2Arr[i + 1] = 1.0 - uv2Arr[i + 1];
                    }
                    geo.setAttribute("uv2", new THREE.BufferAttribute(uv2Arr, 2));
                }
            }
            // Opacity: export the AUTHORED value, never viewer state. Per-object
            // ghosting (setObjectOpacity) mutates live materials but records a
            // backup — a ghosted object must not export as a transparent asset.
            const backup = srcMat.userData && srcMat.userData._mvViewerOpacityBackup;
            const authoredOpacity = backup ? backup.opacity : srcMat.opacity;
            const authoredTransparent = backup ? backup.transparent : srcMat.transparent;
            if (authoredOpacity !== undefined && authoredOpacity < 1 && authoredTransparent) {
                matParams.opacity = authoredOpacity;
                matParams.transparent = true;
            }

            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial(matParams));
            mesh.name = child.name || "mesh";
            mesh.matrixAutoUpdate = false;
            mesh.matrix.copy(child.matrixWorld);
            exportScene.add(mesh);
        }
    }

    /**
     * Prepare a texture for GLB export.
     * Converts to canvas for PNG serialisation, sets flipY=false for glTF convention.
     */
    _prepTextureForGLB(tex) {
        if (!tex || !tex.image) return tex;

        const t = tex.clone();
        t.flipY = false;
        t.needsUpdate = true;

        const img = t.image;

        if (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement) {
            return t;
        }

        // DataTexture (TGALoader etc.) — convert to canvas
        if (img.data && img.width) {
            const w = img.width;
            const h = img.height;
            const channels = img.data.length / (w * h);
            const cv = document.createElement("canvas");
            cv.width = w;
            cv.height = h;
            const ctx = cv.getContext("2d");

            const srcFlipY = !!tex.flipY;
            const rgba = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) {
                const srcRow = srcFlipY ? y : (h - 1 - y);
                for (let x = 0; x < w; x++) {
                    const si = (srcRow * w + x) * channels;
                    const di = (y * w + x) * 4;
                    rgba[di]     = img.data[si];
                    rgba[di + 1] = img.data[si + 1];
                    rgba[di + 2] = img.data[si + 2];
                    rgba[di + 3] = channels === 4 ? img.data[si + 3] : 255;
                }
            }
            ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
            t.image = cv;
            return t;
        }

        // ImageBitmap
        if (img instanceof ImageBitmap) {
            const cv = document.createElement("canvas");
            cv.width = img.width;
            cv.height = img.height;
            cv.getContext("2d").drawImage(img, 0, 0);
            t.image = cv;
            return t;
        }

        return t;
    }

    /** Get axis helper visibility. */
    getAxisVisible() {
        return this._axisVisible;
    }

    /** Get current light settings for UI synchronization. */
    getLightSettings() {
        return {
            keyAzimuth: Math.round((this._keyLightAzimuth * 180) / Math.PI),
            keyElevation: Math.round((this._keyLightElevation * 180) / Math.PI),
            keyIntensity: this._keyLight.intensity,
            fillIntensity: this._fillLight.intensity,
            ambientIntensity: this._ambientLight.intensity,
            exposure: this._renderer.toneMappingExposure,
        };
    }

    // ==========================================
    // Render Loop
    // ==========================================

    /**
     * DEMAND-DRIVEN rendering (resource priority: stay lightweight).
     *
     * The old loop rendered 60fps forever — in the headless MCP harness that
     * meant SwiftShader software-rendering an unchanged frame continuously
     * (measured: ~140% CPU while completely idle; an orphaned session burned
     * 19 CPU-hours overnight). Now a frame renders only when something asks
     * for one (invalidate()), an animation is playing, or FPV input is active;
     * after ~0.75s with nothing to do the rAF loop STOPS entirely and resumes
     * on the next invalidation. OrbitControls damping keeps itself alive via
     * its 'change' events; synchronous captures (screenshot/scoring) render
     * explicitly and are unaffected.
     */
    _startRenderLoop() {
        this._renderRequested = true;   // always draw the first frame
        this._idleFrames = 0;
        this._renderLoopActive = false;
        this._resumeRenderLoop();
    }

    /** Request a repaint (and shadow refresh); restarts the loop if stopped. */
    invalidate() {
        this._renderRequested = true;
        if (this._renderer && this._renderer.shadowMap) {
            this._renderer.shadowMap.needsUpdate = true;
        }
        this._resumeRenderLoop();
    }

    _resumeRenderLoop() {
        if (this._renderLoopActive) return;
        this._renderLoopActive = true;
        // Reset the clock so a resumed animation doesn't jump by the idle time.
        this._clock.getDelta();

        const animate = () => {
            if (!this._renderLoopActive) return;
            this._animationId = requestAnimationFrame(animate);

            const activeAnim = this._activeAnimation;
            const animating = !!(activeAnim && activeAnim.mixer && activeAnim.playing);
            const fpvActive = this._navMode === "fpv"
                && (this._keysPressed.size > 0 || this._fpvMouseDown);

            if (!this._renderRequested && !animating && !fpvActive) {
                // Nothing to draw. Idle briefly (damping/late events), then stop.
                if (++this._idleFrames > 45) {
                    this._renderLoopActive = false;
                    if (this._animationId) {
                        cancelAnimationFrame(this._animationId);
                        this._animationId = null;
                    }
                }
                return;
            }
            this._idleFrames = 0;
            this._renderRequested = false;

            const delta = this._clock.getDelta();

            // Apply FPV drone movement (only active in FPV mode)
            this._applyFPVMovement(delta);

            // Update orbit controls (damping, etc. — only when enabled). While
            // damping is in motion this fires 'change' → invalidate(), which keeps
            // the loop alive exactly until the motion settles.
            if (this._controls.enabled) {
                this._controls.update();
            }

            // Update animation mixers (FBX)
            // Advance ONLY the active object's animation: deactivated objects
            // freeze mid-pose in the composed scene and resume on re-activation.
            if (animating) {
                activeAnim.mixer.update(delta);
                // Animated geometry moves its shadows every frame.
                this._renderer.shadowMap.needsUpdate = true;
            }

            // A camera-relative cutting plane must track the moving camera each frame.
            if (this._clip && this._clip.axis === "camera") {
                const plane = this._computeClipPlane();
                if (plane) this._renderer.clippingPlanes = [plane];
            }

            // Render with postprocessing
            this._composer.render();
        };
        animate();
    }

    _onResize() {
        this.invalidate();
        const width = this._container.clientWidth;
        const height = this._container.clientHeight;

        if (width === 0 || height === 0) return;

        this._camera.aspect = width / height;
        this._camera.updateProjectionMatrix();

        this._renderer.setSize(width, height);
        this._composer.setSize(width, height);

        // Update SSAO pass resolution
        if (this._ssaoPass) {
            this._ssaoPass.setSize(width, height);
        }
    }

    // ==========================================
    // Utilities
    // ==========================================

    _getAspect() {
        return (
            this._container.clientWidth / this._container.clientHeight || 1
        );
    }

    /**
     * Compute model statistics (vertices, faces).
     */
    _computeStats(object) {
        let bufferVerts = 0;
        let faces = 0;
        // Dedup positions with nested NUMERIC maps (x -> y -> Set of z) — exact
        // for any coordinate range, and allocation-free per vertex. The previous
        // per-vertex template strings (~60 B + rope churn each) burned hundreds
        // of MB transiently on multi-million-vertex models.
        const byX = new Map();
        const quant = 1e5; // matches the previous 5-decimal rounding
        let uniqueVerts = 0;

        object.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const geo = child.geometry;
                const posAttr = geo.attributes.position;
                if (posAttr) {
                    bufferVerts += posAttr.count;

                    // Count unique vertex positions (rounded to avoid float noise).
                    for (let i = 0; i < posAttr.count; i++) {
                        const x = Math.round(posAttr.getX(i) * quant);
                        const y = Math.round(posAttr.getY(i) * quant);
                        const z = Math.round(posAttr.getZ(i) * quant);
                        let byY = byX.get(x);
                        if (!byY) { byY = new Map(); byX.set(x, byY); }
                        let zs = byY.get(y);
                        if (!zs) { zs = new Set(); byY.set(y, zs); }
                        if (!zs.has(z)) { zs.add(z); uniqueVerts++; }
                    }
                }
                if (geo.index) {
                    faces += geo.index.count / 3;
                } else if (posAttr) {
                    faces += posAttr.count / 3;
                }
            }
        });

        // Compute bounding box dimensions
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());

        return {
            vertices: Math.round(uniqueVerts),
            faces: Math.round(faces),
            bufferVertices: Math.round(bufferVerts),
            width: size.x,
            height: size.y,
            depth: size.z,
        };
    }
}
