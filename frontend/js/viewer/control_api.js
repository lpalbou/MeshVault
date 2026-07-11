/**
 * ViewerControlAPI — a single, self-describing command surface for driving the 3D
 * viewer programmatically. Designed for AI agents and embedders:
 *
 * - ONE entry point: `execute({action, params})` → `{ok, result?|error?}` (JSON in/out).
 * - DISCOVERABLE: `listCommands()` returns every action with its parameter schema, so an
 *   agent can enumerate capabilities without prior knowledge.
 * - OBSERVABLE: `getState()` returns a JSON snapshot; `execute({action:'screenshot'})`
 *   returns a PNG data URL so the agent can *see* the result of its actions.
 * - EVENTS: `on(event, cb)` for async signals (loaded, error, animations, measurement).
 *
 * The API is a thin, defensive wrapper over the Viewer3D engine — it validates inputs,
 * coerces types, and never lets an engine exception escape as anything other than a
 * structured `{ok:false, error}`. It adds no rendering logic of its own.
 */

import { describeScene } from "./describe_scene.js";
import { meshStatistics } from "./mesh_stats.js";
import { samplePoints } from "./sample_points.js";
import {
    clearPaint,
    fillPaint,
    paintStamp,
    paintStroke,
    pick,
    raycast,
    sculptStamp,
    sculptStroke,
} from "./sculpt.js";

export class ViewerControlAPI {
    /**
     * @param {import("../viewer_3d.js").Viewer3D} viewer
     * @param {object} [opts]
     * @param {(event:string, data:any)=>void} [opts.onEvent] - optional global event sink
     */
    constructor(viewer, opts = {}) {
        this._viewer = viewer;
        this._listeners = new Map();
        if (opts.onEvent) this.on("*", opts.onEvent);

        // Bridge engine DOM events → API events (loaded/animations/measurement).
        // Track them so destroy() can detach and not leak the viewer via the container.
        this._containerListeners = [];
        const el = viewer._container;
        if (el && el.addEventListener) {
            const bind = (type) => {
                const handler = (e) => this._emit(type, e.detail);
                el.addEventListener(type, handler);
                this._containerListeners.push({ type, handler });
            };
            bind("animations");
            bind("measurement");
            bind("navmodechange");
        }

        this._commands = this._buildRegistry();
    }

    // ---- public surface -----------------------------------------------------

    /** Enumerate every command with its parameter schema (for agent discovery). */
    listCommands() {
        return Object.entries(this._commands).map(([action, def]) => ({
            action,
            description: def.description,
            params: def.params || {},
        }));
    }

    /** JSON snapshot of the viewer (model, camera, display, animation). */
    getState() {
        return this._viewer.getState();
    }

    /** Per-mesh + per-material breakdown of the loaded model. */
    getSceneInfo() {
        return this._viewer.getSceneInfo();
    }

    /**
     * Execute one command. Always resolves to a structured result; never throws.
     * @param {{action:string, params?:object}} command
     * @returns {Promise<{ok:boolean, result?:any, error?:string}>}
     */
    async execute(command) {
        if (!command || typeof command.action !== "string") {
            return { ok: false, error: "command.action (string) is required" };
        }
        const def = this._commands[command.action];
        if (!def) {
            return {
                ok: false,
                error: `Unknown action '${command.action}'. Use listCommands() to discover valid actions.`,
            };
        }
        // Commands that act on a model must fail clearly when none is loaded, so an
        // agent can distinguish "did nothing because empty" from "succeeded".
        if (def.requiresModel && !this._viewer.getState().model.loaded) {
            return { ok: false, error: `'${command.action}' requires a loaded model. Call 'load' first.` };
        }

        const params = command.params || {};
        const validation = this._validate(def.params || {}, params);
        if (validation.error) return { ok: false, error: validation.error };

        try {
            const result = await def.handler(validation.values);
            this._emit("executed", { action: command.action, params });
            // Demand-driven rendering: any successful command may have changed what's
            // on screen — request a frame (no-op cost for pure reads; guarantees an
            // agent's next screenshot reflects THIS command).
            if (this._viewer.invalidate) this._viewer.invalidate();
            return { ok: true, result: result === undefined ? null : result };
        } catch (err) {
            const message = String(err && err.message ? err.message : err);
            this._emit("error", { action: command.action, error: message });
            return { ok: false, error: message };
        }
    }

    /** Detach all listeners this API put on the container (call from the host destroy). */
    destroy() {
        for (const { type, handler } of this._containerListeners || []) {
            this._viewer._container.removeEventListener(type, handler);
        }
        this._containerListeners = [];
        this._listeners.clear();
    }

    /** Subscribe to an event ('loaded','error','animations','measurement','executed','*'). */
    on(event, cb) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(cb);
        return () => this._listeners.get(event)?.delete(cb);
    }

    _emit(event, data) {
        for (const cb of this._listeners.get(event) || []) {
            try { cb(data, event); } catch { /* listener errors are their own problem */ }
        }
        for (const cb of this._listeners.get("*") || []) {
            try { cb(data, event); } catch { /* ignore */ }
        }
    }

    // ---- input validation ---------------------------------------------------

    /**
     * Validate + coerce params against a schema. Schema entry:
     *   { type: 'number'|'string'|'boolean'|'array', required?, default?, enum?, min?, max? }
     */
    _validate(schema, params) {
        const values = {};
        // Reject unknown params rather than silently ignoring them — otherwise an agent
        // that mistypes a param (or assumes a capability) gets a misleading ok:true.
        for (const key of Object.keys(params)) {
            if (!(key in schema)) {
                const valid = Object.keys(schema);
                return { error: `Unknown param '${key}'. Valid params: ${valid.length ? valid.join(", ") : "(none)"}` };
            }
        }
        for (const [key, spec] of Object.entries(schema)) {
            let v = params[key];
            if (v === undefined || v === null) {
                if (spec.required) return { error: `Missing required param '${key}'` };
                if (spec.default !== undefined) v = spec.default;
                else { values[key] = undefined; continue; }
            }
            if (spec.type === "number") {
                const n = Number(v);
                if (Number.isNaN(n)) return { error: `Param '${key}' must be a number` };
                if (spec.min !== undefined && n < spec.min) return { error: `Param '${key}' must be >= ${spec.min}` };
                if (spec.max !== undefined && n > spec.max) return { error: `Param '${key}' must be <= ${spec.max}` };
                v = n;
            } else if (spec.type === "boolean") {
                // Accept real booleans and the common string/number forms, but reject
                // anything ambiguous instead of silently coercing it to false.
                if (typeof v === "boolean") { /* ok */ }
                else if (v === "true" || v === 1 || v === "1") v = true;
                else if (v === "false" || v === 0 || v === "0") v = false;
                else return { error: `Param '${key}' must be a boolean (got ${JSON.stringify(v)})` };
            } else if (spec.type === "array") {
                if (!Array.isArray(v)) return { error: `Param '${key}' must be an array` };
            } else if (spec.type === "object") {
                if (typeof v !== "object" || v === null || Array.isArray(v)) {
                    return { error: `Param '${key}' must be an object` };
                }
            } else if (spec.type === "string") {
                v = String(v);
            }
            if (spec.enum && !spec.enum.includes(v)) {
                return { error: `Param '${key}' must be one of: ${spec.enum.join(", ")}` };
            }
            values[key] = v;
        }
        return { values };
    }

    // ---- command registry ---------------------------------------------------

    _buildRegistry() {
        const v = this._viewer;
        return {
            // --- observation ---
            get_state: {
                description: "Return a JSON snapshot of the viewer (model, camera, display, animation).",
                handler: () => v.getState(),
            },
            get_scene_info: {
                description: "Return per-mesh and per-material details of the loaded model.",
                handler: () => v.getSceneInfo(),
            },
            describe_scene: {
                description: "One-call structured TEXT snapshot of the loaded model, designed so an agent can reason WITHOUT screenshots: natural-language summary, inventory (meshes/materials/textures/triangles — live counts, correct after transforms), size + bounds + real-world scale hint, capped hierarchy outline, largest meshes, material properties (of the asset, even while a render-mode override is active), detected geometry issues (missing normals/UVs, degenerate faces, watertightness, flipped normals via signed volume, scale sanity), and the current camera/render state. Options: maxItems caps list lengths (default 8); checks:false skips geometry QA; views:true adds the top-3 detail-ranked camera angles (renders ~24 offscreen views — seconds on software GL). Prefer this over screenshot for understanding WHAT is loaded; use screenshot only to verify aesthetics.",
                params: {
                    maxItems: { type: "number", min: 1, max: 50 },
                    checks: { type: "boolean", default: true },
                    views: { type: "boolean", default: false },
                },
                requiresModel: false,
                handler: (p) => describeScene(v, { maxItems: p.maxItems, checks: p.checks, views: p.views }),
            },
            get_bounds: {
                description: "Return the model's world-space bounding box {min,max,center,size} or null.",
                handler: () => v.getBounds(),
            },
            sample_points: {
                description: "Deterministic, area-weighted surface point samples in world space — the geometric fingerprint used for shape registration / model comparison. Returns { count, seed, surfaceArea, points:[[x,y,z],...] }. Same model + same seed = same points (reproducible comparisons). count 16..20000 (default 4096).",
                params: {
                    count: { type: "number", min: 16, max: 20000 },
                    seed: { type: "number" },
                },
                requiresModel: true,
                handler: (p) => samplePoints(v, { count: p.count, seed: p.seed }),
            },
            get_mesh_stats: {
                description: "Numeric surface-quality statistics — use to COMPARE iterations of the same asset or judge quality beyond connectivity QA (a topologically perfect mesh can still be visual garbage). Returns per-mesh + total: surface area, volume (null for open meshes — the signed-volume sum is origin-dependent when the surface is not closed), edge-length distribution (min/median/p95/max), sliver %, dihedral roughness (mean/p95 angle between adjacent faces — a RELATIVE indicator: compare across versions of the same asset; hard-edged models legitimately score high, e.g. a cube is 60° mean), open/non-manifold/degenerate counts, and issuePoints: representative world-space defect locations to pass to `focus {point}`. Multi-mesh totals carry approx:true on median/mean fields (triangle-weighted combinations; read per-mesh entries when precision matters). Budget: skipped (with skipped:true) above 300k triangles.",
                requiresModel: true,
                handler: () => meshStatistics(v),
            },
            score_views: {
                description: "Score candidate camera angles by how much visible surface DETAIL each shows (edge energy), and return them ranked. Use this to find a model's semantic 'front' when it is not axis-aligned (e.g. a face): the most detailed side ranks first. Returns [{azimuth, elevation, score, coverage}]. NOTE: presets front/back/left/right are WORLD-AXIS conventions, not the model's real front — this command discovers the real one.",
                params: {
                    azimuths: { type: "array" },
                    elevations: { type: "array" },
                    size: { type: "number", min: 32, max: 512 },
                    fill: { type: "number", min: 0.1, max: 1 },
                },
                requiresModel: true,
                handler: (p) => v.scoreViews({ azimuths: p.azimuths, elevations: p.elevations, size: p.size, fill: p.fill }),
            },
            find_best_view: {
                description: "Find the best 'hero'/front angle (highest visible geometric detail, lighting-independent) and move the camera there. Auto-uprights by default (corrects camera roll so a lying-down/mis-oriented model appears the right way up); pass upright:false to skip, apply:false to only compute. Returns {azimuth, elevation, score, coverage, ranked}.",
                params: {
                    apply: { type: "boolean", default: true },
                    upright: { type: "boolean", default: true },
                    fill: { type: "number", min: 0.1, max: 1 },
                    size: { type: "number", min: 32, max: 512 },
                },
                requiresModel: true,
                handler: (p) => v.findBestView({ apply: p.apply, upright: p.upright, fill: p.fill, size: p.size }),
            },
            auto_upright: {
                description: "Correct the camera roll for the CURRENT view so a mis-oriented (e.g. lying-down) subject appears upright, without modifying the model. Uses left-right symmetry of the framed subject.",
                requiresModel: true,
                handler: () => v.autoUpright(),
            },
            focus: {
                description: "Frame a PART of the model (or a world point): moves the camera to look at it, keeping the current view direction, and rescales clip planes/zoom limits so even tiny parts are visible. Target by `id` (the stable mesh id from describe_scene/get_scene_info — most reliable, since real-world mesh names are often meaningless), by `name` (mesh or group; exact > case-insensitive > substring; ambiguity returns candidates), or by `point` [x,y,z] (+ optional radius). The part may be occluded by surrounding geometry — combine with set_clip or set_render_mode wireframe to see through. reset_camera returns to the whole-model view. Note: orbit/set_view/frame re-frame the WHOLE model; re-focus afterwards if needed.",
                params: {
                    id: { type: "number", min: 0 },
                    name: { type: "string" },
                    point: { type: "array" },
                    radius: { type: "number", min: 0 },
                    fill: { type: "number", min: 0.1, max: 1 },
                },
                requiresModel: true,
                handler: (p) => v.focusOn({ id: p.id, name: p.name, point: p.point, radius: p.radius, fill: p.fill }),
            },
            list_commands: {
                description: "List all available commands and their parameters.",
                handler: () => this.listCommands(),
            },
            screenshot: {
                description: "Render the current view and return a PNG data URL. Options: width/height (explicit output resolution; one may be omitted and is derived from aspect), transparent (alpha background, for cutouts), fog (default false — scene fog is suppressed for cleaner hero shots), hideGround (hide the ground/shadow plane), ssao (default true — render through the SSAO/tone-mapping composer for hero quality).",
                params: {
                    width: { type: "number", min: 16, max: 8192 },
                    height: { type: "number", min: 16, max: 8192 },
                    transparent: { type: "boolean", default: false },
                    fog: { type: "boolean", default: false },
                    hideGround: { type: "boolean", default: false },
                    ssao: { type: "boolean", default: true },
                },
                handler: (p) => v.captureImage({
                    width: p.width, height: p.height,
                    transparent: p.transparent, fog: p.fog,
                    hideGround: p.hideGround, ssao: p.ssao,
                }),
            },
            capture_views: {
                description: "Capture several views in one call (e.g. hero shots). `views` is a list of presets (front/back/left/right/top/bottom/iso) and/or {azimuth,elevation} objects. Returns { <label>: <PNG data URL> }. Hides grid/axes and suppresses fog for a clean shot, restoring them after.",
                params: {
                    views: { type: "array", default: ["front", "left", "right", "back"] },
                    width: { type: "number", default: 1024, min: 16, max: 8192 },
                    height: { type: "number", default: 1024, min: 16, max: 8192 },
                    transparent: { type: "boolean", default: false },
                    fill: { type: "number", min: 0.1, max: 1 },
                    hideGround: { type: "boolean", default: false },
                },
                requiresModel: true,
                handler: (p) => {
                    const presets = ["front", "back", "left", "right", "top", "bottom", "iso"];
                    // Pre-validate all views so bad input costs nothing.
                    for (const view of p.views) {
                        const ok = (typeof view === "string" && presets.includes(view)) ||
                            (view && typeof view === "object" && typeof view.azimuth === "number");
                        if (!ok) throw new Error(`Invalid view '${JSON.stringify(view)}' (preset name or {azimuth,elevation})`);
                    }
                    const grid = v.getGridVisible();
                    const axes = v.getAxisVisible();
                    v.setGridVisible(false);
                    v.setAxisVisible(false);
                    const out = {};
                    try {
                        p.views.forEach((view, i) => {
                            let label;
                            if (typeof view === "string") {
                                v.setCameraView(view, { fill: p.fill });
                                label = view;
                            } else {
                                v.orbitTo(view.azimuth, view.elevation ?? 15, { fill: p.fill });
                                label = `az${view.azimuth}_el${view.elevation ?? 15}`;
                            }
                            out[label] = v.captureImage({
                                width: p.width, height: p.height,
                                transparent: p.transparent, hideGround: p.hideGround,
                            });
                        });
                    } finally {
                        v.setGridVisible(grid);
                        v.setAxisVisible(axes);
                    }
                    return out;
                },
            },
            turntable: {
                description: "Capture N views evenly spaced around the model (turntable). Returns { <label>: <PNG data URL> }.",
                params: {
                    frames: { type: "number", default: 8, min: 1, max: 64 },
                    elevation: { type: "number", default: 15 },
                    width: { type: "number", default: 512, min: 16, max: 8192 },
                    height: { type: "number", default: 512, min: 16, max: 8192 },
                    fill: { type: "number", min: 0.1, max: 1 },
                    transparent: { type: "boolean", default: false },
                    hideGround: { type: "boolean", default: false },
                },
                requiresModel: true,
                handler: (p) => {
                    const grid = v.getGridVisible();
                    const axes = v.getAxisVisible();
                    v.setGridVisible(false);
                    v.setAxisVisible(false);
                    const out = {};
                    try {
                        for (let i = 0; i < p.frames; i++) {
                            const az = Math.round((360 / p.frames) * i);
                            v.orbitTo(az, p.elevation, { fill: p.fill });
                            out[`az${az}`] = v.captureImage({
                                width: p.width, height: p.height,
                                transparent: p.transparent, hideGround: p.hideGround,
                            });
                        }
                    } finally {
                        v.setGridVisible(grid);
                        v.setAxisVisible(axes);
                    }
                    return out;
                },
            },

            // --- loading ---
            load: {
                description: "Load a 3D model from a URL — REPLACES the entire scene, including a composed multi-object scene (use add_model to compose without clearing). Extension is inferred if omitted. relatedFiles lists companion files (MTL, textures) for multi-file formats — entries may be relative to the model's URL directory (e.g. ['model.mtl', 'textures/diffuse.png']) or absolute refs the host's resolver understands.",
                params: {
                    url: { type: "string", required: true },
                    extension: { type: "string" },
                    name: { type: "string" },
                    relatedFiles: { type: "array" },
                    source: { type: "object" },
                },
                handler: async (p) => {
                    const ext = p.extension || "." + p.url.split(".").pop().split("?")[0].toLowerCase();
                    const stats = await v.loadModel(p.url, ext, {
                        name: p.name,
                        relatedFiles: p.relatedFiles || [],
                        source: p.source,
                    });
                    this._emit("loaded", { name: v.getState().model.name, stats });
                    return { stats, state: v.getState() };
                },
            },
            unload: {
                description: "Remove EVERY object and reset the viewer to an empty scene. To remove one object of a composed scene, use remove_object.",
                handler: () => v.unload(),
            },

            // --- scene composition (backlog 042) ---
            add_model: {
                description: "Co-load a model into the CURRENT scene without clearing it (composition). `load` REPLACES the whole scene; add_model ADDS. The new object becomes ACTIVE (single-object commands target it). Optional transform places it immediately: {position:[x,y,z], quaternion:[x,y,z,w] OR rotation:[x,y,z] Euler degrees, scale:[x,y,z] or uniform number}. frame:false keeps the current camera instead of framing the whole scene.",
                params: {
                    url: { type: "string", required: true },
                    extension: { type: "string" },
                    name: { type: "string" },
                    relatedFiles: { type: "array" },
                    source: { type: "object" },
                    transform: { type: "object" },
                    frame: { type: "boolean", default: true },
                },
                handler: async (p) => {
                    const ext = p.extension || "." + p.url.split(".").pop().split("?")[0].toLowerCase();
                    const result = await v.addModel(p.url, ext, {
                        name: p.name,
                        relatedFiles: p.relatedFiles || [],
                        source: p.source,
                        transform: p.transform,
                        frame: p.frame,
                    });
                    this._emit("object_added", { objectId: result.objectId, name: v.getState().model.name });
                    return { stats: result, objectId: result.objectId, scene: v.getState().scene };
                },
            },
            add_primitive: {
                description: "Add a procedural primitive to the scene as a new object (sculpting stock / scene building block). kind: box|sphere|cylinder|cone|torus|plane|capsule. params (all optional, sensible sculptable defaults; unknown keys rejected): box {width,height,depth,segments} · sphere {radius,widthSegments,heightSegments} · cylinder {radius|radiusTop+radiusBottom,height,radialSegments,heightSegments} · cone {radius,height,radialSegments,heightSegments} · torus {radius,tube,radialSegments,tubularSegments} · plane {width,height,widthSegments,heightSegments} · capsule {radius,length,capSegments,radialSegments}. Higher segments = finer sculpting (cap 256/axis, 250k vertices). Note: cylinder/cone CAPS are triangle fans — paintable but poor sculpting targets (no interior vertices); sculpt sides or use sphere/capsule. UVs are non-overlapping (paint-safe). color is CSS hex, honored exactly. transform places it immediately. The primitive becomes ACTIVE and persists in .mvscene manifests without any file.",
                params: {
                    kind: { type: "string", required: true, enum: ["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"] },
                    params: { type: "object" },
                    color: { type: "string" },
                    name: { type: "string" },
                    transform: { type: "object" },
                    frame: { type: "boolean", default: true },
                },
                handler: (p) => {
                    const result = v.addPrimitive(p.kind, {
                        params: p.params, color: p.color, name: p.name,
                        transform: p.transform, frame: p.frame,
                    });
                    this._emit("object_added", { objectId: result.objectId, name: p.name || p.kind });
                    return result;
                },
            },

            // --- sculpting & painting (backlog 045) ---
            sculpt: {
                description: "Apply ONE sculpting brush stamp to the ACTIVE object, in WORLD coordinates (get them from pick, get_bounds, or describe_scene mesh centers). tool: draw (displace along the surface's average normal, or `direction`), inflate (along each vertex's own normal), smooth (relax bumps), flatten (toward the local plane), pinch (pull toward center), grab (move by `direction`*strength). radius: world units — or radius_rel (0..1, fraction of the object's bounding-sphere radius; scale-free). strength: world-units displacement for draw/inflate/grab (default radius*0.25); 0..1 blend for smooth/flatten/pinch (default 0.5). falloff: smooth|linear|sharp. Returns {affected, maxDisplacement, newSize} — quantified feedback, steer WITHOUT a verification render each stamp. A missed brush is an ERROR (fix center/radius). Edits are seam-safe (welded) and instance-aware; `reset` restores the pre-sculpt geometry. Not supported on skinned models.",
                params: {
                    tool: { type: "string", default: "draw", enum: ["draw", "inflate", "smooth", "flatten", "pinch", "grab"] },
                    center: { type: "array", required: true },
                    radius: { type: "number", min: 0.000001 },
                    radius_rel: { type: "number", min: 0.000001, max: 1 },
                    strength: { type: "number" },
                    direction: { type: "array" },
                    falloff: { type: "string", enum: ["smooth", "linear", "sharp"] },
                },
                requiresModel: true,
                handler: (p) => sculptStamp(v, p),
            },
            sculpt_stroke: {
                description: "Apply the sculpt brush along a stroke in ONE call — far cheaper than N sculpt calls. Give the stroke as explicit `points` (≤64 world-space [x,y,z]; overlap at spacing ≈ radius/2 for a continuous ridge) OR as a parametric `path` with server-side auto-spacing (no external math, no scalloping): {type:'circle', center, axis?=[0,1,0], radius, start_deg?, sweep_deg?=360} for rings/bands/arcs, or {type:'line', from, to}. Same brush params as sculpt.",
                params: {
                    points: { type: "array" },
                    path: { type: "object" },
                    tool: { type: "string", default: "draw", enum: ["draw", "inflate", "smooth", "flatten", "pinch", "grab"] },
                    radius: { type: "number", min: 0.000001 },
                    radius_rel: { type: "number", min: 0.000001, max: 1 },
                    strength: { type: "number" },
                    direction: { type: "array" },
                    falloff: { type: "string", enum: ["smooth", "linear", "sharp"] },
                },
                requiresModel: true,
                handler: (p) => sculptStroke(v, p),
            },
            paint: {
                description: "Paint ONE brush stamp of color onto the ACTIVE object's texture (creates a real texture layer on first use; the model's existing texture becomes the base when possible). WORLD-space brush like sculpt; radius in world units or radius_rel (0..1 of bounding-sphere radius). color: CSS hex. opacity 0..1 = the MAX alpha of this call (painter semantics: overlapping stamps within one call never exceed it); hardness 0..1 = fraction of the radius at full opacity before falloff scales alpha to 0 at the rim. shape:'square' stamps a crisp axis-aligned quad in the surface's tangent plane (radius = half-side; use hardness 1 for exact edges) — checkers/panels/labels in ONE stamp. max_normal_angle (degrees): skip faces tilted more than this from the stamped face — stops paint wrapping around hard edges (e.g. 45 on a box top). Requires UV coordinates (primitives always have them; STL/PLY do not). Returns {painted, meanAlpha} — meanAlpha is the average applied alpha; < 0.05 means near-invisible paint (raise opacity/hardness) and is flagged in `note`. A missed brush is an ERROR. Paint & sculpt edits are NOT saved by save_scene — export_model (GLB) persists them. clear_paint undoes all paint.",
                params: {
                    center: { type: "array", required: true },
                    radius: { type: "number", min: 0.000001 },
                    radius_rel: { type: "number", min: 0.000001, max: 1 },
                    color: { type: "string", required: true },
                    opacity: { type: "number", min: 0, max: 1 },
                    hardness: { type: "number", min: 0, max: 1 },
                    falloff: { type: "string", enum: ["smooth", "linear", "sharp"] },
                    shape: { type: "string", enum: ["round", "square"] },
                    max_normal_angle: { type: "number", min: 1, max: 180 },
                    texture_size: { type: "number", min: 64, max: 2048 },
                },
                requiresModel: true,
                handler: (p) => paintStamp(v, p),
            },
            paint_stroke: {
                description: "Paint a stroke in ONE call. Give it as explicit `points` (≤64 world-space [x,y,z]; overlap at spacing ≈ radius/2) OR as a parametric `path` with server-side auto-spacing (smooth bands with zero external math): {type:'circle', center, axis?=[0,1,0], radius, start_deg?, sweep_deg?=360} for rings/bands/arcs (e.g. a hat band: circle around the crown's axis), or {type:'line', from, to}. Same params as paint (incl. shape/max_normal_angle).",
                params: {
                    points: { type: "array" },
                    path: { type: "object" },
                    radius: { type: "number", min: 0.000001 },
                    radius_rel: { type: "number", min: 0.000001, max: 1 },
                    color: { type: "string", required: true },
                    opacity: { type: "number", min: 0, max: 1 },
                    hardness: { type: "number", min: 0, max: 1 },
                    falloff: { type: "string", enum: ["smooth", "linear", "sharp"] },
                    shape: { type: "string", enum: ["round", "square"] },
                    max_normal_angle: { type: "number", min: 1, max: 180 },
                    texture_size: { type: "number", min: 64, max: 2048 },
                },
                requiresModel: true,
                handler: (p) => paintStroke(v, p),
            },
            fill_paint: {
                description: "Flood the ACTIVE object's whole paint layer with one color (a fresh base coat before detailing).",
                params: {
                    color: { type: "string", required: true },
                    texture_size: { type: "number", min: 64, max: 2048 },
                },
                requiresModel: true,
                handler: (p) => fillPaint(v, p),
            },
            clear_paint: {
                description: "Remove ALL paint layers from the ACTIVE object, restoring its pre-paint textures/colors (the paint analog of `reset`).",
                requiresModel: true,
                handler: () => clearPaint(v),
            },
            batch: {
                description: "Execute up to 32 commands sequentially in ONE round-trip (halves latency/tokens for sculpt-stroke sessions). commands: [{action, params}, ...]. Stops at the first failure unless continue_on_error. Returns {results:[{ok,...}], completed}. batch cannot nest.",
                params: {
                    commands: { type: "array", required: true },
                    continue_on_error: { type: "boolean", default: false },
                },
                handler: async (p) => {
                    if (p.commands.length === 0 || p.commands.length > 32) {
                        throw new Error("batch takes 1-32 commands");
                    }
                    const results = [];
                    for (const cmd of p.commands) {
                        if (cmd && cmd.action === "batch") {
                            results.push({ ok: false, error: "batch cannot nest" });
                            if (!p.continue_on_error) break;
                            continue;
                        }
                        const r = await this.execute(cmd);
                        results.push(r);
                        if (!r.ok && !p.continue_on_error) break;
                    }
                    return { results, completed: results.length };
                },
            },
            pick: {
                description: "Turn SCREENSHOT coordinates into a world-space surface point: raycast from the CURRENT camera through normalized image coords (x right 0..1, y DOWN 0..1 — top-left origin, exactly as you read pixels off a screenshot). ALWAYS pass the screenshot's width/height — screenshots can have a different aspect than the live canvas, and picking with the wrong aspect lands off-target near the edges. Returns {point, normal, objectId} to feed into sculpt/paint. Only valid while the camera is unchanged since that screenshot — re-pick after any camera move. The agent hand-eye loop: screenshot → spot the feature at (x,y) → pick → sculpt/paint at the returned point.",
                params: {
                    x: { type: "number", required: true, min: 0, max: 1 },
                    y: { type: "number", required: true, min: 0, max: 1 },
                    width: { type: "number", min: 1 },
                    height: { type: "number", min: 1 },
                },
                requiresModel: true,
                handler: (p) => pick(v, p.x, p.y, p.width, p.height),
            },
            raycast: {
                description: "Raycast from an explicit world-space origin along a direction; returns the first visible surface hit {point, normal, objectId, distance}. Camera-independent alternative to pick.",
                params: {
                    origin: { type: "array", required: true },
                    direction: { type: "array", required: true },
                },
                requiresModel: true,
                handler: (p) => raycast(v, p.origin, p.direction),
            },

            list_objects: {
                description: "List every object in the scene: id, name, active flag, visibility, opacity, per-object placement transform, source, plus delta flags — painted (has paint layers), sculpted (geometry edited by sculpt/bakes), modified (the union: any unexported work) — a precise audit trail without a screenshot. Object ids are the handles for all set_object_*/remove_object commands.",
                handler: () => ({ objects: v.listObjects(), activeObjectId: v._activeObjectId }),
            },
            set_active_object: {
                description: "Make an object ACTIVE: all single-object commands (describe_scene, get_mesh_stats, transforms, focus, animation) target the active object. The scene keeps rendering all visible objects. Returns just {activeObjectId} — use list_objects for the full roster.",
                params: { id: { type: "number", required: true } },
                requiresModel: true,
                handler: (p) => { v.setActiveObject(p.id); return { activeObjectId: p.id }; },
            },
            remove_object: {
                description: "Remove ONE object from the scene (disposes its GPU resources). If it was active, the most recently added remaining object becomes active.",
                params: { id: { type: "number", required: true } },
                requiresModel: true,
                handler: (p) => { v.removeObject(p.id); return { removed: p.id, scene: v.getState().scene }; },
            },
            set_object_visible: {
                description: "Show/hide one object (it stays in the scene and in manifests).",
                params: {
                    id: { type: "number", required: true },
                    visible: { type: "boolean", required: true },
                },
                requiresModel: true,
                handler: (p) => { v.setObjectVisible(p.id, p.visible); return true; },
            },
            set_object_opacity: {
                description: "Per-object opacity (0..1; 1 = opaque). Viewer display state only — ghosting for overlays/comparisons; exports keep the authored materials.",
                params: {
                    id: { type: "number", required: true },
                    opacity: { type: "number", required: true, min: 0, max: 1 },
                },
                requiresModel: true,
                handler: (p) => { v.setObjectOpacity(p.id, p.opacity); return true; },
            },
            set_object_transform: {
                description: "Place an object in the scene: set its wrapper transform (NEVER baked into vertices — placement lives in the scene/manifest, not the asset). position [x,y,z]; quaternion [x,y,z,w] OR rotation [x,y,z] Euler degrees; scale [x,y,z] or uniform number. Omitted parts are unchanged. Returns the resulting transform.",
                params: {
                    id: { type: "number", required: true },
                    position: { type: "array" },
                    quaternion: { type: "array" },
                    rotation: { type: "array" },
                    scale: { type: "number" },
                    scale_xyz: { type: "array" },
                },
                requiresModel: true,
                handler: (p) => v.setObjectTransform(p.id, {
                    position: p.position,
                    quaternion: p.quaternion,
                    rotation: p.rotation,
                    scale: p.scale_xyz !== undefined ? p.scale_xyz : p.scale,
                }),
            },
            get_object_transform: {
                description: "Read an object's placement transform {position, quaternion, scale}.",
                params: { id: { type: "number", required: true } },
                requiresModel: true,
                handler: (p) => v.getObjectTransform(p.id),
            },
            reset_object_transform: {
                description: "Reset an object's placement to identity (undo scene positioning; the asset's geometry is untouched).",
                params: { id: { type: "number", required: true } },
                requiresModel: true,
                handler: (p) => v.resetObjectTransform(p.id),
            },
            frame_all: {
                description: "Frame the WHOLE composed scene (union of all visible objects). Camera presets/orbit/frame target the ACTIVE object; use this before scene-wide screenshots.",
                requiresModel: true,
                handler: () => v.frameAll(),
            },
            get_scene_manifest: {
                description: "Serializable scene manifest (version 1): per-object source + placement transform + visibility/opacity, plus scene lighting/environment/background. Objects with volatile sources (drag-drops) are excluded and listed in skippedVolatile. Save it as a .mvscene file; rebuild with load + add_model or the app/MCP scene loaders.",
                requiresModel: true,
                handler: () => v.getSceneManifest(),
            },

            // --- camera ---
            get_camera: {
                description: "Return camera position, target, fov, mode, and available presets.",
                handler: () => v.getState().camera,
            },
            set_camera: {
                description: "Set the camera to an explicit position and look-at target (world coords), optionally with a field of view (degrees). Mirrors get_camera, so a pose can be captured in one session and reproduced in another.",
                params: {
                    position: { type: "array", required: true },
                    target: { type: "array" },
                    fov: { type: "number", min: 1, max: 179 },
                },
                requiresModel: false,
                handler: (p) => {
                    if (p.position.length !== 3) throw new Error("position must be [x,y,z]");
                    if (p.target && p.target.length !== 3) throw new Error("target must be [x,y,z]");
                    return v.setCamera(p.position, p.target, p.fov);
                },
            },
            set_view: {
                description: "Point the camera at a preset around the model. `fill` (0-1, higher = tighter framing) controls how much of the frame the model occupies. scope:'scene' frames the WHOLE visible scene instead of the active object (multi-object tableaus).",
                params: {
                    preset: { type: "string", required: true, enum: ["front", "back", "left", "right", "top", "bottom", "iso"] },
                    fill: { type: "number", min: 0.1, max: 1 },
                    scope: { type: "string", enum: ["object", "scene"] },
                },
                requiresModel: true,
                handler: (p) => v.setCameraView(p.preset, { fill: p.fill, scope: p.scope }),
            },
            orbit: {
                description: "Orbit the camera to spherical angles around the model and frame it. azimuth: degrees around Y (0 = front); elevation: degrees above horizon. scope:'scene' orbits/frames the WHOLE visible scene instead of the active object — use it to compose multi-object shots from any angle (frame_all only keeps the current direction).",
                params: {
                    azimuth: { type: "number", required: true },
                    elevation: { type: "number", default: 15 },
                    fill: { type: "number", min: 0.1, max: 1 },
                    scope: { type: "string", enum: ["object", "scene"] },
                },
                requiresModel: true,
                handler: (p) => v.orbitTo(p.azimuth, p.elevation, { fill: p.fill, scope: p.scope }),
            },
            frame: {
                description: "Frame the model. Keeps the current view direction by default (keep_direction:false for an iso fit). `fill` (0-1) sets tightness.",
                params: {
                    fill: { type: "number", min: 0.1, max: 1 },
                    keep_direction: { type: "boolean", default: true },
                },
                requiresModel: true,
                handler: (p) => v.frameView({ fill: p.fill, keepDirection: p.keep_direction }),
            },
            get_lighting: {
                description: "Return the current studio lighting: key light azimuth/elevation (deg), key/fill/ambient intensities, and exposure.",
                handler: () => v.getLightSettings(),
            },
            set_lighting: {
                description: "Adjust the studio lighting (brightness). All params optional. azimuth/elevation in degrees; key_intensity/fill_intensity/ambient are light multipliers; exposure is the tone-mapping exposure (overall brightness). Also in getState().lighting.",
                params: {
                    azimuth: { type: "number", min: 0, max: 360 },
                    elevation: { type: "number", min: 0, max: 90 },
                    key_intensity: { type: "number", min: 0, max: 10 },
                    fill_intensity: { type: "number", min: 0, max: 10 },
                    ambient: { type: "number", min: 0, max: 10 },
                    exposure: { type: "number", min: 0.1, max: 8 },
                },
                handler: (p) => v.setLighting({
                    azimuth: p.azimuth, elevation: p.elevation,
                    key_intensity: p.key_intensity, fill_intensity: p.fill_intensity,
                    ambient: p.ambient, exposure: p.exposure,
                }),
            },
            reset_camera: {
                description: "Reset the camera to the initial framed view (orbit mode).",
                handler: () => { v.resetView(); return true; },
            },
            set_nav_mode: {
                description: "Set navigation mode: 'orbit' or 'fpv'.",
                params: { mode: { type: "string", required: true, enum: ["orbit", "fpv"] } },
                handler: (p) => { v.setNavMode(p.mode); return true; },
            },

            // --- display ---
            set_wireframe: {
                description: "Show/hide wireframe overlay.",
                params: { enabled: { type: "boolean", required: true } },
                handler: (p) => { v.setWireframe(p.enabled); return true; },
            },
            set_grid: {
                description: "Show/hide the floor grid.",
                params: { visible: { type: "boolean", required: true } },
                handler: (p) => { v.setGridVisible(p.visible); return true; },
            },
            set_axes: {
                description: "Show/hide the XYZ axes helper.",
                params: { visible: { type: "boolean", required: true } },
                handler: (p) => { v.setAxisVisible(p.visible); return true; },
            },
            set_normals: {
                description: "Show/hide vertex-normals visualization (little lines per vertex).",
                params: { visible: { type: "boolean", required: true } },
                handler: (p) => { v.setNormalsVisible(p.visible); return true; },
            },
            set_render_mode: {
                description: "How the model is drawn: 'textured' (mesh + texture, the lit PBR surface — default), 'solid' (the mesh only, uniform matte, no texture), or 'wireframe' (edges/topology only). Also accepts 'normals' (per-face normal colors) for geometry inspection. Aliases: 'shaded'=textured, 'clay'=solid.",
                params: { mode: { type: "string", required: true, enum: ["textured", "solid", "wireframe", "normals", "shaded", "clay"] } },
                requiresModel: true,
                handler: (p) => v.setRenderMode(p.mode),
            },
            set_clip: {
                description: "Cutting plane — hide part of the mesh on one side of a plane, e.g. to see only the front geometry and cut away what's behind, or make a cross-section. axis 'camera' cuts relative to the current view (near side kept); 'x'/'y'/'z' cut along model axes. position 0..1 across the model; flip keeps the other side. Set enabled:false to clear.",
                params: {
                    enabled: { type: "boolean", required: true },
                    axis: { type: "string", enum: ["x", "y", "z", "camera"], default: "camera" },
                    position: { type: "number", min: 0, max: 1, default: 0.5 },
                    flip: { type: "boolean", default: false },
                },
                requiresModel: true,
                handler: (p) => v.setClip({ enabled: p.enabled, axis: p.axis, position: p.position, flip: p.flip }),
            },
            set_fog: {
                description: "Enable/disable exponential scene fog and set its density (fog is off in hero captures by default).",
                params: {
                    enabled: { type: "boolean", required: true },
                    density: { type: "number", min: 0, max: 1 },
                },
                handler: (p) => v.setFog({ enabled: p.enabled, density: p.density }),
            },
            set_environment: {
                description: "Control image-based lighting (IBL): environment reflections on PBR materials. enabled on/off; intensity multiplier; asBackground shows the environment as the scene background. On by default for realistic metal/rough shading.",
                params: {
                    enabled: { type: "boolean" },
                    intensity: { type: "number", min: 0, max: 5 },
                    asBackground: { type: "boolean" },
                },
                handler: (p) => v.setEnvironment({ enabled: p.enabled, intensity: p.intensity, asBackground: p.asBackground }),
            },
            get_environment: {
                description: "Return the current IBL/environment settings { enabled, intensity, asBackground }.",
                handler: () => v.getEnvironment(),
            },
            set_background: {
                description: "Set the background color (CSS hex, e.g. #202030).",
                params: { color: { type: "string", required: true } },
                handler: (p) => { v.setBackground(p.color); return true; },
            },
            set_scale: {
                description: "Set the uniform model scale.",
                params: { scale: { type: "number", required: true, min: 0.001, max: 1000 } },
                requiresModel: true,
                handler: (p) => { v.setModelScale(p.scale); return true; },
            },

            // --- transforms ---
            center: { description: "Center the model's centroid at the origin.", requiresModel: true, handler: () => { v.recenterModel(); return true; } },
            ground: { description: "Drop the model so its lowest point sits on Y=0.", requiresModel: true, handler: () => { v.groundModel(); return true; } },
            auto_orient: { description: "Auto-orient the model via PCA (smallest axis → up).", requiresModel: true, handler: () => { v.autoOrientModel(); return true; } },
            rotate: {
                description: "Rotate the model by an angle (degrees) around an axis.",
                params: {
                    axis: { type: "string", required: true, enum: ["x", "y", "z"] },
                    degrees: { type: "number", required: true },
                },
                requiresModel: true,
                handler: (p) => { v.rotateModel(p.axis, p.degrees); return true; },
            },
            simplify: {
                description: "Simplify the mesh to a fraction of its vertices (0-1). Returns {before, after} vertex counts.",
                params: { ratio: { type: "number", required: true, min: 0.01, max: 1 } },
                requiresModel: true,
                handler: async (p) => { const r = await v.simplifyModel(p.ratio); return r; },
            },
            recompute_normals: { description: "Merge vertices and recompute smooth normals.", requiresModel: true, handler: () => { v.recomputeNormals(); return true; } },
            reset: { description: "Undo all transforms (restore original geometry).", requiresModel: true, handler: () => { v.resetModel(); return true; } },

            // --- animation ---
            play_animation: {
                description: "Play the animation clip at the given index.",
                params: { index: { type: "number", default: 0, min: 0 } },
                requiresModel: true,
                handler: (p) => {
                    if (!v.hasAnimations()) throw new Error("Model has no animation clips");
                    v.playAnimation(p.index); return true;
                },
            },
            pause_animation: { description: "Pause the active animation.", requiresModel: true, handler: () => { v.setAnimationPlaying(false); return true; } },
            set_animation_time: {
                description: "Seek the active animation to a time (seconds).",
                params: { seconds: { type: "number", required: true, min: 0 } },
                requiresModel: true,
                handler: (p) => {
                    if (!v.hasAnimations()) throw new Error("Model has no animation clips");
                    v.setAnimationTime(p.seconds); return true;
                },
            },
            set_animation_speed: {
                description: "Set animation playback speed multiplier.",
                params: { multiplier: { type: "number", required: true, min: 0 } },
                requiresModel: true,
                handler: (p) => { v.setAnimationSpeed(p.multiplier); return true; },
            },

            // --- measurement ---
            measure: {
                description: "Measure the distance between two world-space points; draws the line.",
                params: {
                    a: { type: "array", required: true },
                    b: { type: "array", required: true },
                },
                requiresModel: true,
                handler: (p) => {
                    if (p.a.length !== 3 || p.b.length !== 3) throw new Error("a and b must be [x,y,z]");
                    return { distance: v.measureBetween(p.a, p.b) };
                },
            },
            set_measure_mode: {
                description: "Enable/disable interactive click-to-measure mode. Disabling also clears any measurement overlay.",
                params: { enabled: { type: "boolean", required: true } },
                handler: (p) => {
                    // toggleMeasureMode flips; drive it to the requested state.
                    const cur = !!v._measureMode;
                    if (cur !== p.enabled) v.toggleMeasureMode();
                    // A programmatic `measure` draws without the mode being on — make
                    // disabling always remove the overlay (it polluted agent screenshots).
                    if (!p.enabled) v._clearMeasurement();
                    return v._measureMode;
                },
            },
            clear_measurement: {
                description: "Remove the measurement markers/line/label from the scene (e.g. before a clean screenshot).",
                handler: () => { v._clearMeasurement(); return true; },
            },

            // --- export ---
            export_obj: { description: "Export the model as OBJ text.", requiresModel: true, handler: () => v.exportAsOBJ() },
            export_glb: {
                description: "Export the model as a GLB (binary glTF); returns a base64 data URL.",
                requiresModel: true,
                handler: async () => {
                    const buf = await v.exportAsGLB();
                    if (!buf) return null;
                    const bytes = new Uint8Array(buf);
                    let bin = "";
                    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                    return "data:model/gltf-binary;base64," + btoa(bin);
                },
            },
        };
    }
}
