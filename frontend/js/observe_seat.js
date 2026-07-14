/**
 * ObserveSeat — watch a performer session (an MCP agent, live) inside the app.
 *
 * Mechanism: COMMAND REPLICATION. The performer publishes every executed
 * mutating command to the backend observe hub; this seat replays the log —
 * strictly in order, from seq 0 — through the app's own ViewerControlAPI (the
 * same deterministic engine), so the observer natively renders the same scene
 * and keeps free-look 3D presence. Tool telemetry (the vividness): each brush
 * command paints a GHOST — a surface-oriented ring + soft falloff disc at
 * every stamp point, fading over ~400 ms, with a tool label — so you SEE the
 * agent's brush move across the mesh.
 *
 * Honesty machinery (the design review's highest-risk item is SILENT replica
 * divergence — every failure mode must surface, never drift quietly):
 * - server seq must be contiguous; any gap → hard stop + "desynced" banner;
 * - session `lossy` flag (performer lost a publish) → warning banner;
 * - periodic performer fingerprints compared against local counts → banner;
 * - `unjoinable` (log ring overwritten) and `ended` arrive as explicit states.
 *
 * Seat rules (review B5/M4): while observing, the seat is HARD READ-ONLY
 * (edit/timeline/scene inputs off, gizmo detached), the agent-bridge
 * `open_asset` push is ignored (it would REPLACE the replica scene and break
 * object-id alignment), and reverse-bridge state reporting is paused (an
 * observing tab would otherwise overwrite "what the human is looking at" with
 * a mirror of the agent's own work — an echo chamber for get_app_state).
 * Replayed commands are never re-published (`_replaying` flag) and never
 * enter local undo history. Camera: performer camera arrives as sampled
 * TELEMETRY (not commands); Follow is ON by default and disengages the moment
 * the user grabs the view (free-look), re-engageable from the panel.
 */

import * as THREE from "three";

// Field-test polish: 450 ms made a fast stroke "a blink"; labels were
// borderline legible at 0.14× model scale.
const GHOST_FADE_MS = 750;
const FOLLOW_LERP = 0.35;

export class ObserveSeat {
    /**
     * @param {import("./viewer_3d.js").Viewer3D} viewer
     * @param {import("./viewer/control_api.js").ViewerControlAPI} api
     * @param {object} deps {toast, setUiLocked(bool), onObservingChange(bool),
     *                       pauseBridge(bool)}
     */
    constructor(viewer, api, deps) {
        this._viewer = viewer;
        this._api = api;
        this._toast = deps.toast || (() => {});
        this._setUiLocked = deps.setUiLocked || (() => {});
        this._pauseBridge = deps.pauseBridge || (() => {});
        this._onObservingChange = deps.onObservingChange || (() => {});
        // Tool readout lives in the OBSERVE PANEL, not floating in the scene
        // (user feedback: "it shouldn't be a text next to the circle").
        this._onToolChange = deps.onToolChange || (() => {});
        // Replay-bar callback: (pos, total, playing, isRecording) — app.js
        // renders the bottom scrubber from this.
        this._onPlayback = deps.onPlayback || (() => {});

        this.observing = false;
        this.follow = true;
        // "instant" fast-forwards catch-up/recordings (no ghosts, rendering
        // suspended); "paced" replays as a ~40 cmd/s time-lapse with ghosts.
        this.replaySpeed = "instant";
        this._es = null;
        this._expectedSeq = 0;
        this._queue = Promise.resolve();
        this._ghosts = [];
        this._ghostGroup = null;
        this._banner = null;
        this._session = null;
        this._caughtUp = false;
        this._recording = false;
        this._totalAtHello = 0;
        this._replayedCount = 0;
        this._lastCam = null;      // latest performer camera (kept even with
                                   // follow off, so re-engaging can SNAP)
        this._raycaster = new THREE.Raycaster();
        this._replayErrors = 0;
        // Recording playback (the bottom replay bar): the full log buffers
        // client-side, then play/pause/scrub run LOCALLY — deterministic
        // replay makes any seek position reconstructible (backward = rebuild
        // from zero under fast-forward).
        this._log = [];
        this._pos = 0;             // entries applied so far (playhead)
        this._playTimer = null;
        this._seekBusy = false;
        // The PERSISTENT tool cursor: one ring+disc that is always on the mesh
        // while the performer holds a brush — its radius IS the current area
        // of influence; it glides between stamp points instead of blinking.
        this._cursor = null;
        this._cursorAnim = null;
    }

    // ------------------------------------------------------------------
    // Session discovery
    // ------------------------------------------------------------------

    async sessions() {
        const r = await fetch("/api/observe/sessions");
        if (!r.ok) throw new Error(`observe sessions: HTTP ${r.status}`);
        return (await r.json()).sessions || [];
    }

    // ------------------------------------------------------------------
    // Join / leave
    // ------------------------------------------------------------------

    async join(sessionId) {
        if (this.observing) this.leave(false);

        // VALIDATE BEFORE DESTROYING ANYTHING (field bug F2-1: an unconditional
        // unload on a stale/unknown session id wiped the user's scene, and the
        // unhandled `unknown_session` meta left the seat locked forever). The
        // scene is only cleared once the stream says `hello` (joinable).
        try {
            const sessions = await this.sessions();
            const s = sessions.find((x) => x.id === sessionId);
            if (!s) {
                this._toast("That session no longer exists — refresh the list.", "error");
                return;
            }
            if (!s.joinable && !s.replayable) {
                this._toast("Cannot join: the session outgrew its log — "
                    + "replay-from-zero is impossible.", "error");
                return;
            }
        } catch (err) {
            this._toast(`Observe hub unreachable: ${err.message}`, "error");
            return;
        }

        this.observing = true;
        this._session = sessionId;
        this._expectedSeq = 0;
        this._caughtUp = false;
        this._helloSeen = false;
        this._recording = false;
        this._totalAtHello = 0;
        this._replayedCount = 0;
        this._replayErrors = 0;
        this._log = [];
        this._pos = 0;
        this._lastCam = null;
        this._setUiLocked(true);
        this._pauseBridge(true);
        this._onObservingChange(true);

        this._es = new EventSource(
            `/api/observe/stream?session=${encodeURIComponent(sessionId)}`);
        this._es.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            this._handle(msg);
        };
        this._es.onerror = () => {
            if (this.observing) this._showBanner("Stream interrupted — retrying…", "warn");
        };
        this._toast("Observation seat: joining session…", "info");
    }

    leave(keepScene = true) {
        if (this._es) { this._es.close(); this._es = null; }
        this.observing = false;
        this._session = null;
        this.playbackPause();
        this._log = [];
        this._pos = 0;
        this._recording = false;
        this._onPlayback(0, 0, false, false);   // hide the replay bar
        this._viewer.endBulkReplay();   // never leave rendering suspended
        this._clearGhosts();
        this._hideBanner();
        this._setUiLocked(false);
        this._pauseBridge(false);
        this._onObservingChange(false);
        if (keepScene) {
            this._toast("Left the observation seat — this scene is YOUR COPY of "
                + "the observed session (reload your own asset to discard).", "info");
        }
    }

    // ------------------------------------------------------------------
    // Stream handling
    // ------------------------------------------------------------------

    _handle(msg) {
        if (msg.type === "hello") {
            // The stream confirmed the session is joinable — ONLY NOW does the
            // replica clear the scene (join() pre-validates, but the session
            // can end between the list snapshot and the click; F2-2).
            this._helloSeen = true;
            this._recording = !!msg.recording;
            const s = msg.session || {};
            this._totalAtHello = s.commands || 0;
            // Fast-forward LIVE catch-up: suspend rendering — per-command
            // frames re-upload painted canvas textures every time, which is
            // what made 1000+-command replays crawl. Recordings instead
            // BUFFER fully and play through the replay bar.
            if (!this._recording
                && this.replaySpeed === "instant" && this._totalAtHello > 20) {
                this._viewer.beginBulkReplay();
                this._showBanner(
                    `Replaying ${this._totalAtHello} commands (fast-forward)…`, "info");
            }
            this._queue = this._api.execute({ action: "unload" }).then(() => {});
            if (s.lossy) this._showBanner(
                "Performer reported LOST publishes — the replica may diverge.", "warn");
            return;
        }
        if (msg.type === "caught_up") {
            if (this._recording) return;   // recordings finish on `ended`
            // All engine work up to here is already queued; finish it, then
            // resume rendering and paint the accumulated state at once.
            this._queue = this._queue.then(() => {
                this._viewer.endBulkReplay();
                this._caughtUp = true;
                this._hideBanner();
                this._toast("Caught up — watching live.", "info");
            });
            return;
        }
        if (msg.type === "meta") {
            if (msg.event === "ended" || msg.event === "performer_lost") {
                const text = msg.event === "ended"
                    ? "Session ended — final state shown."
                    : "Recording ends here (the performer stopped publishing "
                      + "without ending its session).";
                if (this._recording) {
                    // The log is fully buffered — hand control to the replay
                    // bar: instant = jump to the end; paced = play from zero.
                    this._caughtUp = true;
                    this._hideBanner();
                    if (this.replaySpeed === "paced") {
                        this.playbackPlay();
                    } else {
                        this.playbackSeek(this._log.length);
                    }
                    this._toast(`Recording loaded (${this._log.length} events) — `
                        + "scrub or replay it from the bar below.", "info");
                } else {
                    // Queue behind the live replay so the banner doesn't beat
                    // the work.
                    this._queue = this._queue.then(() => {
                        this._viewer.endBulkReplay();
                        this._showBanner(text, "info");
                    });
                }
                if (this._es) { this._es.close(); this._es = null; }
            } else if (msg.event === "desynced") {
                this._showBanner("DESYNCED: the observer fell behind and the log "
                    + "was overwritten. Leave and re-join.", "error");
                if (this._es) { this._es.close(); this._es = null; }
            } else if (msg.event === "unjoinable" || msg.event === "unknown_session") {
                // The scene was NOT touched yet (unload waits for hello) — the
                // user's work survives a refused join. Leave silently unlocks;
                // the toast must OUTLIVE it (leave(false) hides banners; F2-2's
                // "silence + data loss" was exactly this ordering).
                this.leave(false);
                this._toast(`Cannot join: ${msg.reason || "session not found "
                    + "(it may have ended — refresh the list)"}`, "error");
            }
            return;
        }
        if (msg.type !== "entry") return;
        if (!this._helloSeen) return;   // never mutate before the hello handshake

        // Contiguity: a gap means a divergent replica — stop honestly.
        if (msg.seq !== this._expectedSeq) {
            this._showBanner(`DESYNCED at seq ${msg.seq} (expected ${this._expectedSeq}) `
                + "— leave and re-join.", "error");
            if (this._es) { this._es.close(); this._es = null; }
            return;
        }
        this._expectedSeq++;
        if (msg.lossy) {
            this._showBanner("Performer lost publishes — replica may diverge.", "warn");
        }

        // Recordings buffer; the replay bar drives application.
        if (this._recording) {
            if (msg.kind === "command" || msg.kind === "camera") {
                this._log.push(msg);
                this._onPlayback(this._pos, this._log.length, false, true);
            }
            return;
        }

        if (msg.kind === "command") {
            const cmd = msg.command || {};
            this._queue = this._queue.then(() => this._replay(cmd));
        } else if (msg.kind === "camera") {
            // Keep the latest performer camera even while follow is OFF so
            // re-checking the box snaps to the agent's CURRENT view instead
            // of waiting for its next move (telemetry is deduped — a static
            // camera never resends, which read as "Follow has no effect").
            this._lastCam = msg.camera || this._lastCam;
            if (this.follow && msg.camera && !this._viewer._bulkReplay) {
                this._applyCamera(msg.camera);
            }
        } else if (msg.kind === "fingerprint") {
            this._queue = this._queue.then(() => this._checkFingerprint(msg.fingerprint));
        }
        // lifecycle pings need no action (aliveness is server-side)
    }

    // ------------------------------------------------------------------
    // Recording playback (the bottom replay bar)
    // ------------------------------------------------------------------

    /** Apply one buffered entry. fast=true skips ghosts (scrub/fast-forward). */
    async _applyLogEntry(entry, fast) {
        if (entry.kind === "camera") {
            this._lastCam = entry.camera || this._lastCam;
            if (this.follow && entry.camera && !fast) this._applyCamera(entry.camera);
            return;
        }
        if (entry.kind !== "command") return;
        const cmd = entry.command || {};
        await this._replayCore(cmd);
        if (!fast) this._ghostFor(cmd.action, cmd.params || {});
    }

    playbackPlay() {
        if (!this._recording || this._playTimer || this._seekBusy) return;
        if (this._pos >= this._log.length) {
            // Play from the start when the playhead sits at the end.
            this.playbackSeek(0).then(() => this.playbackPlay());
            return;
        }
        const step = async () => {
            if (!this.observing || this._pos >= this._log.length) {
                this.playbackPause();
                return;
            }
            const entry = this._log[this._pos++];
            await this._applyLogEntry(entry, false);
            this._onPlayback(this._pos, this._log.length, true, true);
        };
        this._playTimer = setInterval(() => {
            this._queue = this._queue.then(step);
        }, 30);
        this._onPlayback(this._pos, this._log.length, true, true);
    }

    playbackPause() {
        if (this._playTimer) { clearInterval(this._playTimer); this._playTimer = null; }
        this._onPlayback(this._pos, this._log.length, false, true);
    }

    /** Seek the playhead. Forward = apply the delta fast; backward = rebuild
     *  from zero (deterministic replay makes every position reconstructible). */
    async playbackSeek(target) {
        if (!this._recording || this._seekBusy) return;
        target = Math.max(0, Math.min(this._log.length, Math.round(target)));
        if (target === this._pos) return;
        this.playbackPause();
        this._seekBusy = true;
        this._onPlayback(this._pos, this._log.length, false, true);
        try {
            this._viewer.beginBulkReplay();
            if (target < this._pos) {
                await this._api.execute({ action: "unload" });
                this._pos = 0;
            }
            let applied = 0;
            while (this._pos < target) {
                await this._applyLogEntry(this._log[this._pos++], true);
                // Yield + advance the scrub thumb periodically: a long
                // rebuild must LOOK like progress, not a frozen tab.
                if (++applied % 20 === 0) {
                    this._onPlayback(this._pos, this._log.length, false, true);
                    await new Promise((res) => setTimeout(res, 0));
                }
            }
        } finally {
            this._viewer.endBulkReplay();
            this._seekBusy = false;
        }
        // Land on the performer's camera at this point when following.
        if (this.follow && this._lastCam) this._applyCamera(this._lastCam);
        this._onPlayback(this._pos, this._log.length, false, true);
    }

    /** Turn camera-follow on/off (panel checkbox). Engaging SNAPS to the
     *  performer's latest known camera immediately. */
    setFollow(on) {
        this.follow = !!on;
        if (this.follow && this._lastCam) this._applyCamera(this._lastCam);
    }

    async _replay(cmd) {
        if (!this.observing) return;
        const fastForward = !this._caughtUp && this._viewer._bulkReplay;
        await this._replayCore(cmd);
        this._replayedCount++;
        if (fastForward) {
            // No ghosts, no per-command frames — just a progress pulse. The
            // yield is what makes it VISIBLE: queued replays chain as
            // microtasks and never give the browser a frame, so without it
            // the banner text updates but never paints and the seat reads as
            // frozen for the whole catch-up (the "extremely slow" report was
            // partly THIS — invisible progress).
            if (this._replayedCount % 10 === 0) {
                this._showBanner(`Replaying ${this._replayedCount}`
                    + `/${this._totalAtHello || "?"} commands (fast-forward)…`, "info");
                await new Promise((res) => setTimeout(res, 0));
            }
            return;
        }
        if (!this._caughtUp && this.replaySpeed === "paced") {
            // Time-lapse: fast enough to not bore, slow enough to SEE.
            await new Promise((res) => setTimeout(res, 25));
        }
        this._ghostFor(cmd.action, cmd.params || {});
    }

    /** Execute one replicated command (source rewrite + camera envelope +
     *  divergence accounting) — shared by live replay and recording playback. */
    async _replayCore(cmd) {
        if (!this.observing) return;
        let { action, params } = cmd;
        params = params ? { ...params } : {};

        // B1: model sources replay by IDENTITY, not by the performer's
        // localhost URL (LocalModelServer is cross-origin to this page and
        // sends no CORS headers; it also dies with the MCP process).
        if ((action === "load" || action === "add_model") && params.source) {
            const src = params.source;
            if (src.kind === "file" && src.path) {
                params.url = "/api/asset/file?path=" + encodeURIComponent(src.path);
            } else if (src.kind === "url" && src.url) {
                params.url = src.url;
            }
        }

        // Camera-dependent mutations replay under the performer's camera
        // envelope, then the observer's view is restored (free-look holds).
        const env = cmd.env || {};
        let savedCam = null;
        if (env.camera) {
            savedCam = this._viewer.getState().camera;
            await this._api.execute({ action: "set_camera", params: {
                position: env.camera.position, target: env.camera.target,
                fov: env.camera.fov } });
        }

        this._viewer._observeReplaying = true;
        let r;
        try {
            r = await this._api.execute({ action, params });
        } finally {
            this._viewer._observeReplaying = false;
        }
        if (savedCam) {
            await this._api.execute({ action: "set_camera", params: {
                position: savedCam.position, target: savedCam.target,
                fov: savedCam.fov } });
        }
        if (r && !r.ok) {
            this._replayErrors++;
            // Replay errors are divergence — surface after a small tolerance
            // (a performer's own failed command publishes nothing, so any
            // error HERE means the replica disagrees with the performer).
            if (this._replayErrors >= 1) {
                this._showBanner(`Replay error on '${action}': ${String(r.error).slice(0, 120)} `
                    + "— the replica may have diverged.", "warn");
            }
        }
        // Tool-suitability cue: replayed sculpt results carry the engine's
        // quality signals (meshQuality trigger, under-sampling note). The
        // ring color reflects them: white = clean, amber = the engine
        // advised (too coarse / degrading facets), so a watcher SEES when
        // the performer's tool params don't suit the surface.
        this._lastSuitability = null;
        if (r && r.ok && r.result && (action === "sculpt" || action === "sculpt_stroke")) {
            const res = r.result;
            const advisory = (res.note && /coarser than the brush/.test(res.note))
                || (res.meshQuality && res.meshQuality.needsRemesh);
            this._lastSuitability = advisory ? "advisory" : "clean";
        }
    }

    _applyCamera(cam) {
        const v = this._viewer;
        if (!cam.position || !v._camera) return;
        v._camera.position.set(...cam.position);
        if (cam.target && v._controls) v._controls.target.set(...cam.target);
        if (cam.fov && Math.abs(v._camera.fov - cam.fov) > 0.01) {
            v._camera.fov = cam.fov;
            v._camera.updateProjectionMatrix();
        }
        if (v._controls) v._controls.update();
        v.invalidate();
    }

    async _checkFingerprint(fp) {
        if (!fp || !this._caughtUp) return;
        try {
            // Stats defer during bulk replay — settle EXACTLY before comparing
            // (a stale count here would raise a false DIVERGED banner).
            if (this._viewer.settleDeferredStats) this._viewer.settleDeferredStats();
            const objs = this._viewer._objects || [];
            let vertices = 0, triangles = 0;
            for (const e of objs) {
                if (e.stats) { vertices += e.stats.vertices || 0; triangles += e.stats.faces || 0; }
            }
            const mismatch =
                (fp.objectCount !== undefined && fp.objectCount !== objs.length)
                || (fp.triangles !== undefined && Math.abs(fp.triangles - triangles) > 0);
            if (mismatch) {
                this._showBanner(
                    `DIVERGED: performer has ${fp.objectCount} object(s) / `
                    + `${fp.triangles} tris; replica has ${objs.length} / ${triangles}. `
                    + "Leave and re-join.", "error");
            }
        } catch { /* fingerprint check is best-effort */ }
    }

    // ------------------------------------------------------------------
    // Ghost overlay — the vividness
    // ------------------------------------------------------------------

    _ghostFor(action, params) {
        const BRUSHES = {
            sculpt: params && params.tool === "dig" ? "#ff7847" : "#4aa3ff",
            sculpt_stroke: params && params.tool === "dig" ? "#ff7847" : "#4aa3ff",
            paint: null, paint_stroke: null,           // null = use params.color
            blur_paint: "#b58cff", clone_paint: "#7fe08f", mirror_paint: "#ffd166",
        };
        if (action in BRUSHES) {
            const points = params.points
                || (params.center ? [params.center] : [])
                || [];
            const pathPts = [];
            if (params.path && params.path.type === "line") {
                pathPts.push(params.path.from, params.path.to);
            } else if (params.path && params.path.type === "circle") {
                pathPts.push(params.path.center);
            }
            const all = [...points, ...pathPts].filter(
                (p) => Array.isArray(p) && p.length === 3);
            if (params.to) all.push(params.to);
            if (!all.length) return;
            const radius = this._resolveRadius(params);
            const color = BRUSHES[action] || params.color || "#ff5d5d";
            // Panel readout (user feedback: tool + size belong in the PANEL,
            // never as text floating next to the ring).
            this._onToolChange(this._toolInfo(action, params, radius, color));
            // The persistent cursor GLIDES through the stamp points; faint
            // stamp discs remain as a short trail.
            this._glideCursor(all.slice(0, 32), radius, color);
            return;
        }
        // Non-brush mutations: a transient action chip (top-center, not tied
        // to the cursor).
        if (["split_object", "set_object_transform", "place_object", "set_parent",
             "set_pivot", "set_keyframe", "refine_region", "simplify_region",
             "regularize_region", "add_primitive", "capture_morph",
             "set_morph"].includes(action)) {
            this._chip(`agent: ${action}`);
            this._onToolChange({ tool: action.replace(/_/g, " "), detail: "", color: null });
        }
    }

    /** Structured tool readout for the observe panel. */
    _toolInfo(action, params, radius, color) {
        const r3 = (v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);
        let tool = action.replace(/_/g, " ");
        const bits = [`radius ${r3(radius)}`];
        if (action.startsWith("sculpt")) {
            tool = `sculpt · ${params.tool || "draw"}`;
            if (params.strength !== undefined) bits.push(`strength ${r3(params.strength)}`);
            if (params.angle_deg !== undefined) bits.push(`angle ${r3(params.angle_deg)}°`);
            if (params.flat_fraction !== undefined) bits.push(`plateau ${r3(params.flat_fraction)}`);
            if (params.falloff) bits.push(params.falloff);
            if (this._lastSuitability === "advisory") bits.push("⚠ unsuited (see ring)");
        } else if (action === "paint" || action === "paint_stroke") {
            tool = "paint";
            if (params.opacity !== undefined) bits.push(`opacity ${r3(params.opacity)}`);
            if (params.hardness !== undefined) bits.push(`hardness ${r3(params.hardness)}`);
        } else if (params.strength !== undefined) {
            bits.push(`strength ${r3(params.strength)}`);
        }
        return { tool, detail: bits.join(" · "),
                 color: (action === "paint" || action === "paint_stroke")
                     ? (params.color || color) : null };
    }

    /** Create (once) the persistent influence cursor. */
    _ensureCursor() {
        if (this._cursor) return this._cursor;
        const group = this._ensureGhostGroup();
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.92, 1, 48),
            new THREE.MeshBasicMaterial({ color: "#4aa3ff", transparent: true,
                                          opacity: 0.95, side: THREE.DoubleSide,
                                          depthTest: false }));
        const disc = new THREE.Mesh(
            new THREE.CircleGeometry(0.9, 48),
            new THREE.MeshBasicMaterial({ color: "#4aa3ff", transparent: true,
                                          opacity: 0.15,
                                          blending: THREE.AdditiveBlending,
                                          side: THREE.DoubleSide, depthTest: false }));
        const cursor = new THREE.Group();
        cursor.add(ring, disc);
        cursor.visible = false;
        cursor.renderOrder = 999;
        group.add(cursor);
        this._cursor = { group: cursor, ring, disc };
        return this._cursor;
    }

    /**
     * Glide the persistent cursor through the stroke's stamp points (the ring
     * IS the area of influence: scaled to the resolved brush radius), leaving
     * faint fading stamp discs as the trail.
     *
     * Suitability cue: when the replayed result carried a quality advisory
     * (brush coarser than the mesh, or the facet-degradation trigger fired),
     * the ring turns AMBER — a watcher sees immediately that the performer's
     * tool parameters don't suit the surface. Clean results keep the tool
     * color.
     */
    _glideCursor(points, radius, colorHex) {
        const cur = this._ensureCursor();
        const advisory = this._lastSuitability === "advisory";
        const color = new THREE.Color(advisory ? "#ffb020" : colorHex);
        cur.ring.material.color.copy(color);
        cur.disc.material.color.copy(color);
        cur.ring.material.opacity = advisory ? 1.0 : 0.95;
        cur.group.scale.setScalar(Math.max(1e-6, radius));
        cur.group.visible = true;
        if (this._cursorAnim) clearInterval(this._cursorAnim);
        let i = 0;
        const step = () => {
            if (!this.observing || i >= points.length) {
                clearInterval(this._cursorAnim);
                this._cursorAnim = null;
                return;
            }
            const p = new THREE.Vector3(...points[i]);
            const normal = this._surfaceNormal(p);
            cur.group.position.copy(p).addScaledVector(normal, radius * 0.03);
            cur.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
            // Faint trail stamp behind the cursor (no label).
            this._spawnGhost(points[i], radius, colorHex, null);
            this._viewer.invalidate();
            i++;
        };
        step();
        this._cursorAnim = setInterval(step, 45);
    }

    _resolveRadius(params) {
        if (params.radius > 0) return params.radius;
        if (params.radius_rel > 0) {
            const model = this._viewer._currentModel;
            if (model) {
                const box = new THREE.Box3().setFromObject(model);
                if (!box.isEmpty()) {
                    return params.radius_rel * box.getSize(new THREE.Vector3()).length() / 2;
                }
            }
        }
        return 0.05;
    }

    _ensureGhostGroup() {
        if (this._ghostGroup) return this._ghostGroup;
        const v = this._viewer;
        this._ghostGroup = new THREE.Group();
        this._ghostGroup.name = "mv_observe_ghosts";
        v._scene.add(this._ghostGroup);
        // Observer screenshots must stay clean (the gizmo precedent).
        v._captureHidden = v._captureHidden || [];
        v._captureHidden.push(this._ghostGroup);
        return this._ghostGroup;
    }

    /** Surface frame at the stamp point: normal from a raycast along the
     *  camera ray (works whenever the point is visible; camera-facing fallback). */
    _surfaceNormal(point) {
        const v = this._viewer;
        const model = v._currentModel;
        if (model && v._camera) {
            const origin = v._camera.position.clone();
            const dir = point.clone().sub(origin).normalize();
            this._raycaster.set(origin, dir);
            this._raycaster.far = origin.distanceTo(point) + 1;
            const meshes = [];
            model.traverse((c) => { if (c.isMesh) meshes.push(c); });
            const hits = this._raycaster.intersectObjects(meshes, false);
            if (hits.length && hits[0].face) {
                return hits[0].face.normal.clone()
                    .transformDirection(hits[0].object.matrixWorld);
            }
        }
        return v._camera ? v._camera.getWorldDirection(new THREE.Vector3()).negate()
                         : new THREE.Vector3(0, 1, 0);
    }

    _spawnGhost(pointArr, radius, colorHex, _label) {
        if (!this.observing) return;
        const v = this._viewer;
        const group = this._ensureGhostGroup();
        const point = new THREE.Vector3(...pointArr);
        const normal = this._surfaceNormal(point);
        const color = new THREE.Color(colorHex);

        // Trail stamps are FAINT by design — the persistent cursor is the
        // strong mark; the trail just shows where the stroke has been.
        const ghost = new THREE.Group();
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(radius * 0.92, radius, 48),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4,
                                          side: THREE.DoubleSide, depthTest: false }));
        const disc = new THREE.Mesh(
            new THREE.CircleGeometry(radius * 0.9, 48),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14,
                                          blending: THREE.AdditiveBlending,
                                          side: THREE.DoubleSide, depthTest: false }));
        ghost.add(ring, disc);
        ghost.position.copy(point).addScaledVector(normal, radius * 0.02);
        ghost.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        ghost.renderOrder = 998;
        group.add(ghost);

        const born = performance.now();
        const entry = { ghost, born };
        this._ghosts.push(entry);
        const fade = () => {
            const t = (performance.now() - born) / GHOST_FADE_MS;
            if (t >= 1 || !this.observing) {
                group.remove(ghost);
                ghost.traverse((o) => { if (o.material) o.material.dispose();
                                        if (o.geometry) o.geometry.dispose(); });
                this._ghosts = this._ghosts.filter((g) => g !== entry);
                v.invalidate();
                return;
            }
            ring.material.opacity = 0.4 * (1 - t);
            disc.material.opacity = 0.14 * (1 - t);
            v.invalidate();
            requestAnimationFrame(fade);
        };
        requestAnimationFrame(fade);
        v.invalidate();
    }

    _clearGhosts() {
        if (this._cursorAnim) { clearInterval(this._cursorAnim); this._cursorAnim = null; }
        this._cursor = null;
        this._onToolChange(null);
        if (!this._ghostGroup) return;
        const v = this._viewer;
        v._scene.remove(this._ghostGroup);
        v._captureHidden = (v._captureHidden || []).filter((o) => o !== this._ghostGroup);
        this._ghostGroup = null;
        this._ghosts = [];
        v.invalidate();
    }

    // ------------------------------------------------------------------
    // Banners / chips
    // ------------------------------------------------------------------

    _showBanner(text, kind) {
        let el = this._banner;
        if (!el) {
            el = document.createElement("div");
            el.id = "observe-banner";
            this._viewer._container.appendChild(el);
            this._banner = el;
        }
        el.textContent = text;
        el.className = `observe-banner ${kind || "info"}`;
        el.style.display = "block";
    }

    _hideBanner() {
        if (this._banner) this._banner.style.display = "none";
    }

    _chip(text) {
        const el = document.createElement("div");
        el.className = "observe-chip";
        el.textContent = text;
        this._viewer._container.appendChild(el);
        setTimeout(() => { el.classList.add("gone"); }, 900);
        setTimeout(() => { el.remove(); }, 1400);
    }
}
