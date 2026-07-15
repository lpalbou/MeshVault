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

import { clearPaintUndo } from "./viewer/sculpt.js";

// Field-test polish: 450 ms made a fast stroke "a blink"; labels were
// borderline legible at 0.14× model scale.
const GHOST_FADE_MS = 750;
const FOLLOW_LERP = 0.35;

// Fast-forward scheduler TIME BUDGET (perf gauntlet: the old scheduler
// yielded every N commands, which is meaningless when one command takes
// seconds and N cheap ones fit in a frame — measured 8.5 s main-thread
// blocks on a 233-command catch-up). Process commands until the budget is
// spent, then yield a real frame: progress paints, input (Cancel/Leave)
// runs, and Firefox's "page is slowing down" detector stays quiet.
const REPLAY_BUDGET_MS = 80;

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
        // Run generation: bumped on every join/leave. Long replay loops and
        // queued replay continuations capture it and bail when it moved —
        // leave() must interrupt a running catch-up PROMPTLY (the old loop
        // kept reading an emptied log and threw), and a leave→re-join must
        // never let session A's stale queue leak commands into session B.
        this._runId = 0;
        // Time-budget scheduler bookkeeping (see REPLAY_BUDGET_MS).
        this._lastYieldAt = 0;
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
        // CHECKPOINTS (the x-wing freeze fix): performer-captured state
        // snapshots let the seat RESTORE at seq S instead of re-executing
        // the whole build (a recorded ~20-minute simplify re-runs for ~20
        // minutes in the observer's tab — re-execution cannot be made fast).
        // List comes from /api/observe/sessions at join; live markers from
        // the stream keep it fresh.
        this._checkpoints = [];
        this._joinCheckpoint = null;   // chosen for live join (stream from=seq+1)
        this._restoredFrom = null;     // seq of the checkpoint the replica stands on
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
        let sessionInfo = null;
        try {
            const sessions = await this.sessions();
            const s = sessions.find((x) => x.id === sessionId);
            if (!s) {
                this._toast("That session no longer exists — refresh the list.", "error");
                return;
            }
            const hasCheckpoint = (s.checkpoints || []).some(
                (c) => c.seq + 1 >= (s.first_seq || 0));
            if (!s.joinable && !s.replayable && !hasCheckpoint) {
                this._toast("Cannot join: the session outgrew its log — "
                    + "replay-from-zero is impossible.", "error");
                return;
            }
            sessionInfo = s;
        } catch (err) {
            this._toast(`Observe hub unreachable: ${err.message}`, "error");
            return;
        }

        this.observing = true;
        this._runId++;
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
        this._restoredFrom = null;
        // Checkpoint plan: LIVE sessions restore the newest usable snapshot
        // and stream only the tail (from = seq+1); recordings buffer the
        // whole entry log (cheap — no execution) and use checkpoints for
        // SEEKS instead. `alive` is the recording discriminator available
        // before hello.
        this._checkpoints = (sessionInfo.checkpoints || [])
            .filter((c) => c.seq + 1 >= (sessionInfo.first_seq || 0))
            .sort((a, b) => a.seq - b.seq);
        this._joinCheckpoint = null;
        let fromSeq = 0;
        if (sessionInfo.alive && this._checkpoints.length
            && this.replaySpeed === "instant") {
            this._joinCheckpoint = this._checkpoints[this._checkpoints.length - 1];
            fromSeq = this._joinCheckpoint.seq + 1;
        }
        // The single-slot brush undo must not straddle the seat boundary:
        // a pre-join stash points at layers the replica unload disposes, and
        // "undo" restoring ancient texels into a replica is a trust bug.
        clearPaintUndo();
        this._setUiLocked(true);
        this._pauseBridge(true);
        this._onObservingChange(true);

        this._es = new EventSource(
            `/api/observe/stream?session=${encodeURIComponent(sessionId)}`
            + (fromSeq > 0 ? `&from=${fromSeq}` : ""));
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
        // Abort any in-flight catch-up/seek loop and orphan the queued replay
        // continuations of THIS session (they check the run id after every
        // await) — the seat must come back the moment the user clicks Leave.
        this._runId++;
        this._session = null;
        this.playbackPause();
        this._log = [];
        this._pos = 0;
        this._recording = false;
        this._checkpoints = [];
        this._joinCheckpoint = null;
        this._restoredFrom = null;
        this._onPlayback(0, 0, false, false);   // hide the replay bar
        this._viewer.endBulkReplay();   // never leave rendering suspended
        // Replay may have overwritten (or, under bulk suppression, skipped)
        // the brush-undo stash — either way it no longer describes anything
        // the USER did. Their own next paint re-arms undo normally.
        clearPaintUndo();
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
            // A checkpoint join assumed a LIVE session; if it ended between
            // the list snapshot and the hello, the stream is now a recording
            // whose scrubber needs the WHOLE entry log — reopen from zero
            // (buffering is cheap; checkpoints still accelerate the seeks).
            if (this._recording && this._joinCheckpoint) {
                this._joinCheckpoint = null;
                this._expectedSeq = 0;
                if (this._es) { this._es.close(); }
                this._es = new EventSource(
                    `/api/observe/stream?session=${encodeURIComponent(this._session)}`);
                this._es.onmessage = (e) => {
                    let m;
                    try { m = JSON.parse(e.data); } catch { return; }
                    this._handle(m);
                };
                this._helloSeen = false;
                return;
            }
            // Fast-forward LIVE catch-up: suspend rendering — per-command
            // frames re-upload painted canvas textures every time, which is
            // what made 1000+-command replays crawl. Recordings instead
            // BUFFER fully and play through the replay bar.
            if (!this._recording
                && this.replaySpeed === "instant" && this._totalAtHello > 20) {
                this._viewer.beginBulkReplay();
                this._lastYieldAt = performance.now();
                this._showProgress(0, this._totalAtHello);
            }
            if (this._joinCheckpoint) {
                // RESTORE instead of re-executing history: the stream begins
                // at seq+1, so the entry contiguity check must too.
                const ck = this._joinCheckpoint;
                this._expectedSeq = ck.seq + 1;
                const run = this._runId;
                this._viewer.beginBulkReplay();
                this._queue = this._restoreFromCheckpoint(ck, run).catch((err) => {
                    if (run !== this._runId) return;
                    // Fallback: replay from zero when the ring still has it.
                    this._showBanner(`Checkpoint restore failed (${String(err.message).slice(0, 90)}) `
                        + "— replaying from the start instead.", "warn");
                    this._joinCheckpoint = null;
                    this._expectedSeq = 0;
                    if (this._es) this._es.close();
                    this._es = new EventSource(
                        `/api/observe/stream?session=${encodeURIComponent(this._session)}`);
                    this._es.onmessage = (e) => {
                        let m;
                        try { m = JSON.parse(e.data); } catch { return; }
                        this._handle(m);
                    };
                    this._helloSeen = false;
                });
            } else {
                this._queue = this._api.execute({ action: "unload" }).then(() => {});
            }
            if (s.lossy) this._showBanner(
                "Performer reported LOST publishes — the replica may diverge.", "warn");
            return;
        }
        if (msg.type === "checkpoint") {
            // Marker events do NOT consume an entry seq. Keep the list fresh
            // (live sessions checkpoint as they work; `late` markers describe
            // seqs the cursor already passed — still valid for future seeks).
            if (!this._checkpoints.some((c) => c.seq === msg.seq)) {
                this._checkpoints.push({ seq: msg.seq, bytes: msg.bytes,
                    exec_ms_since_start: msg.exec_ms_since_start || 0 });
                this._checkpoints.sort((a, b) => a.seq - b.seq);
            }
            return;
        }
        if (msg.type === "caught_up") {
            if (this._recording) return;   // recordings finish on `ended`
            // All engine work up to here is already queued; finish it, then
            // resume rendering and paint the accumulated state at once.
            // (run-guarded: after a leave, this stale continuation must not
            // touch the viewer or toast over the next session.)
            const run = this._runId;
            this._queue = this._queue.then(() => {
                if (run !== this._runId) return;
                this._viewer.endBulkReplay();
                this._caughtUp = true;
                // Divergence stays VISIBLE: progress updates overwrote any
                // per-error warning during catch-up, so the standing state
                // must be re-asserted once the dust settles (honesty rule).
                if (this._replayErrors > 0) {
                    this._showBanner(`Caught up with ${this._replayErrors} replay `
                        + "error(s) — the replica may have diverged.", "warn");
                } else {
                    this._hideBanner();
                }
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
                    // the work (run-guarded like caught_up).
                    const run = this._runId;
                    this._queue = this._queue.then(() => {
                        if (run !== this._runId) return;
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
            // Capture the run id NOW: a leave→re-join between queueing and
            // execution must orphan this continuation, not run session A's
            // command inside session B's scene.
            const run = this._runId;
            this._queue = this._queue.then(() => this._replay(cmd, run));
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

    /** Command-entry engine cost (exec_ms telemetry) in log range [a, b). */
    _execCost(a, b) {
        let ms = 0;
        for (let i = Math.max(0, a); i < Math.min(b, this._log.length); i++) {
            const e = this._log[i];
            if (e.kind === "command") ms += (e.exec_ms || 25);
        }
        return ms;
    }

    /** Newest checkpoint at or before absolute seq S, with its log index. */
    _checkpointBefore(seq) {
        let best = null;
        for (const c of this._checkpoints) {
            if (c.seq <= seq) best = c;
        }
        if (!best) return null;
        let idx = 0;
        while (idx < this._log.length && this._log[idx].seq <= best.seq) idx++;
        return { ck: best, idx };
    }

    /** Seek the playhead. Routes through the cheapest reconstruction:
     *  forward = incremental delta; backward or expensive forward = RESTORE
     *  the nearest checkpoint ≤ target and replay only the tail (the x-wing
     *  fix: a recorded 20-minute simplify must never re-execute on a scrub). */
    async playbackSeek(target) {
        if (!this._recording || this._seekBusy) return;
        target = Math.max(0, Math.min(this._log.length, Math.round(target)));
        if (target === this._pos) return;
        this.playbackPause();
        this._seekBusy = true;
        const run = this._runId;
        this._onPlayback(this._pos, this._log.length, false, true);
        // Brush-undo stashes are pure waste during a seek — observers cannot
        // invoke undo_paint — UNLESS the log itself replays one (the replica
        // must then restore the same texels the performer did). The log is
        // fully buffered here, so the check is exact, not a guess.
        const logReplaysUndo = this._log.some((e) => {
            if (e.kind !== "command" || !e.command) return false;
            if (e.command.action === "undo_paint") return true;
            if (e.command.action === "batch") {
                const subs = (e.command.params || {}).commands || [];
                return subs.some((s) => s && s.action === "undo_paint");
            }
            return false;
        });
        // Route decision (exec_ms telemetry): restoring a checkpoint costs a
        // few seconds; re-executing history costs the performer's engine
        // time. Take the snapshot whenever it wins.
        const RESTORE_EST_MS = 2500;
        const targetSeq = target > 0 ? this._log[target - 1].seq : -1;
        const cp = target > 0 ? this._checkpointBefore(targetSeq) : null;
        let progressShown = false;
        try {
            this._viewer.beginBulkReplay();
            this._viewer._suppressPaintUndo = !logReplaysUndo;
            let restored = false;
            if (cp && cp.idx <= target) {
                const incrementalCost = target >= this._pos
                    ? this._execCost(this._pos, target)          // forward delta
                    : RESTORE_EST_MS + this._execCost(0, target); // rebuild-from-zero baseline
                const checkpointCost = RESTORE_EST_MS + this._execCost(cp.idx, target);
                if (checkpointCost < incrementalCost) {
                    try {
                        await this._restoreFromCheckpoint(cp.ck, run);
                        if (run !== this._runId) return;
                        this._pos = cp.idx;
                        restored = true;
                    } catch (err) {
                        if (run !== this._runId) return;
                        // Fall back to full re-execution below.
                        this._showBanner("Checkpoint restore failed "
                            + `(${String(err.message).slice(0, 90)}) — replaying instead.`, "warn");
                    }
                }
            }
            if (!restored && target < this._pos) {
                await this._api.execute({ action: "unload" });
                if (run !== this._runId) return;
                this._pos = 0;
            }
            this._lastYieldAt = performance.now();
            while (this._pos < target) {
                // leave()/re-join aborts the loop at the next iteration —
                // the old code kept indexing the emptied log and threw.
                if (run !== this._runId) return;
                await this._applyLogEntry(this._log[this._pos++], true);
                // TIME-BUDGET yield (see _replay): a long rebuild must LOOK
                // like progress and stay cancellable, never a frozen tab.
                if (performance.now() - this._lastYieldAt >= REPLAY_BUDGET_MS) {
                    this._onPlayback(this._pos, this._log.length, false, true);
                    this._showProgress(this._pos, target);
                    progressShown = true;
                    await this._yieldFrame();
                    this._lastYieldAt = performance.now();
                }
            }
        } finally {
            this._seekBusy = false;
            // On abort, leave() already restored the viewer (endBulkReplay
            // clears the suppression flag too) — and a NEW session may have
            // re-entered bulk mode by now; touching it here would corrupt it.
            if (run === this._runId) this._viewer.endBulkReplay();
        }
        if (run !== this._runId) return;
        if (progressShown) {
            // Same honesty rule as caught_up: progress updates overwrote any
            // replay-error banner mid-seek — re-assert divergence at the end.
            if (this._replayErrors > 0) {
                this._showBanner(`Replayed with ${this._replayErrors} error(s) — `
                    + "the replica may have diverged.", "warn");
            } else {
                this._hideBanner();
            }
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

    // ------------------------------------------------------------------
    // Checkpoint restore (protocol: /tmp/observe_checkpoint_protocol.md —
    // port of the reference RESTORE_JS proven by test_observe_checkpoints)
    // ------------------------------------------------------------------

    /**
     * Restore the replica to checkpoint `ck` (unload → per-object blobs →
     * identity alignment → hierarchy/transforms/timeline/display). Throws on
     * any hard failure INCLUDING a fingerprint mismatch — callers fall back
     * to replay-from-zero or refuse honestly. A restored replica is
     * RECONSTRUCTED state, not command-derived: the fingerprint check is the
     * honesty mechanism.
     */
    async _restoreFromCheckpoint(ck, run) {
        const t0 = performance.now();
        this._showBanner(`Restoring checkpoint (command ${ck.seq})…`, "info");
        const base = `/api/observe/checkpoint?session=${encodeURIComponent(this._session)}`;
        const mr = await fetch(`${base}&seq=${ck.seq}`);
        if (!mr.ok) throw new Error(`manifest HTTP ${mr.status}`);
        const manifest = await mr.json();
        if (run !== this._runId) return null;

        // Blobs in parallel; object URLs so the loader needs no auth.
        const objs = (manifest.objects || []).slice().sort((a, b) => a.id - b.id);
        const urls = {};
        await Promise.all(objs.filter((o) => !o.empty).map(async (o) => {
            const br = await fetch(`${base}&seq=${ck.seq}&object=${o.id}`);
            if (!br.ok) throw new Error(`blob ${o.id} HTTP ${br.status}`);
            urls[o.id] = URL.createObjectURL(await br.blob());
        }));
        if (run !== this._runId) return null;

        const exec = async (action, params) => {
            const r = await this._api.execute({ action, params: params || {} });
            if (!r.ok) throw new Error(`${action}: ${r.error}`);
            return r.result;
        };
        const soft = async (action, params) => {
            try { return await exec(action, params); } catch { return null; }
        };
        const v = this._viewer;
        try {
            await exec("unload");
            // 1. Blobs + identity (the triple direct assignment is protocol,
            //    not a hack: no public command can set ids/revs/counter).
            for (const o of objs) {
                if (o.empty) continue;
                if (run !== this._runId) return null;
                await exec("add_model", { url: urls[o.id], extension: ".glb",
                                          name: o.name, frame: false });
                const e = v._objects[v._objects.length - 1];
                e.id = o.id;
                e.wrapper.name = "mv_object_" + o.id;
                e.geometryRev = o.geometryRev || 0;
                v._activeObjectId = o.id;
                if (o.pivot) e.pivot.set(o.pivot[0], o.pivot[1], o.pivot[2]);
            }
            // 2. Future ids continue the PERFORMER's counter (gaps included).
            v._nextObjectId = manifest.nextObjectId;
            // 3. Hierarchy, then parent-relative placements.
            const present = new Set(objs.filter((o) => !o.empty).map((o) => o.id));
            for (const o of objs) {
                if (!o.empty && o.parentId != null && present.has(o.parentId)) {
                    await exec("set_parent", { id: o.id, parent_id: o.parentId });
                }
            }
            for (const o of objs) {
                if (o.empty) continue;
                await exec("set_object_transform", { id: o.id, position: o.position,
                    quaternion: o.quaternion, scale_xyz: o.scale });
            }
            // 4. Tracked model scale (blobs export with it divided out).
            for (const o of objs) {
                if (o.empty || !o.modelScale || Math.abs(o.modelScale - 1) < 1e-9) continue;
                await exec("set_active_object", { id: o.id });
                await exec("set_scale", { scale: o.modelScale });
            }
            // 5. Visibility / opacity / morph weights.
            for (const o of objs) {
                if (o.visible === false) await exec("set_object_visible", { id: o.id, visible: false });
                if (o.opacity !== undefined && o.opacity < 1) {
                    await exec("set_object_opacity", { id: o.id, opacity: o.opacity });
                }
                const names = Object.keys(o.morphs || {});
                if (names.length) {
                    await exec("set_active_object", { id: o.id });
                    for (const n of names) {
                        if (o.morphs[n] > 0) await soft("set_morph", { name: n, weight: o.morphs[n] });
                    }
                }
            }
            // 6. Timeline (rotation keys are requested-Euler degrees).
            const tl = manifest.timeline;
            if (tl && tl.tracks && tl.tracks.length) {
                for (const t of tl.tracks) {
                    for (const ch of ["position", "rotation", "scale"]) {
                        for (const k of (t[ch] || [])) {
                            const p = { id: t.objectId, time: k.t };
                            p[ch] = k.v;
                            if (k.easing) p.easing = k.easing;
                            await exec("set_keyframe", p);
                        }
                    }
                    for (const key of Object.keys(t)) {
                        if (!key.startsWith("morph:")) continue;
                        for (const k of t[key]) {
                            const p = { id: t.objectId, time: k.t, morphs: {} };
                            p.morphs[key.slice(6)] = k.v;
                            if (k.easing) p.easing = k.easing;
                            await exec("set_keyframe", p);
                        }
                    }
                }
                if (tl.duration) await soft("set_timeline", { duration: tl.duration });
                if (tl.time) await soft("seek_timeline", { time: tl.time });
                if (tl.playing) await soft("play_timeline", { loop: tl.loop });
            }
            // 7. Display + lighting: best-effort visual parity.
            const d = manifest.display || {};
            if (d.background) await soft("set_background", { color: d.background });
            if (d.environment) await soft("set_environment", d.environment);
            if (d.renderMode === "wireframe" || d.wireframe) {
                await soft("set_wireframe", { enabled: true });
            } else if (d.renderMode && d.renderMode !== "textured") {
                await soft("set_render_mode", { mode: d.renderMode });
            }
            if (d.fog) await soft("set_fog", { enabled: true });
            if (d.clip) await soft("set_clip", { enabled: true, axis: d.clip.axis,
                position: d.clip.position, flip: d.clip.flip });
            const L = manifest.lighting || {};
            if (L.keyIntensity !== undefined) {
                await soft("set_lighting", { azimuth: L.keyAzimuth, elevation: L.keyElevation,
                    key_intensity: L.keyIntensity, fill_intensity: L.fillIntensity,
                    ambient: L.ambientIntensity, exposure: L.exposure });
            }
            // 8. Active object LAST (steps above move activation around).
            if (manifest.activeObjectId != null) {
                await exec("set_active_object", { id: manifest.activeObjectId });
            }
        } finally {
            for (const id of Object.keys(urls)) URL.revokeObjectURL(urls[id]);
        }
        if (run !== this._runId) return null;

        // VERIFY, don't trust: reconstructed state must match the manifest's
        // fingerprint exactly, or the caller falls back / refuses.
        if (manifest.fingerprint) {
            if (v.settleDeferredStats) v.settleDeferredStats();
            let vertices = 0, triangles = 0;
            for (const e of v._objects || []) {
                if (e.stats) { vertices += e.stats.vertices || 0; triangles += e.stats.faces || 0; }
            }
            const fp = manifest.fingerprint;
            if ((fp.objectCount !== undefined && fp.objectCount !== (v._objects || []).length)
                || (fp.triangles !== undefined && fp.triangles !== triangles)) {
                throw new Error(`fingerprint mismatch after restore `
                    + `(${(v._objects || []).length} obj/${triangles} tris vs `
                    + `${fp.objectCount}/${fp.triangles})`);
            }
        }
        this._restoredFrom = ck.seq;
        // Live-join progress: the tail is all that remains to replay — the
        // full-session command count would show "12/588" style nonsense.
        if (!this._recording && manifest.commands_published) {
            this._totalAtHello = Math.max(
                0, this._totalAtHello - manifest.commands_published);
        }
        const ms = Math.round(performance.now() - t0);
        // Honesty: the replica did NOT re-execute the skipped history.
        this._showBanner(`Restored from checkpoint at command ${ck.seq} in ${(ms / 1000).toFixed(1)} s `
            + "— earlier steps were not re-executed.", "info");
        return manifest;
    }

    async _replay(cmd, run) {
        if (!this.observing || run !== this._runId) return;
        const fastForward = !this._caughtUp && this._viewer._bulkReplay;
        await this._replayCore(cmd);
        if (run !== this._runId) return;   // left the seat mid-command
        this._replayedCount++;
        if (fastForward) {
            // No ghosts, no per-command frames — just progress. TIME-BUDGET
            // yield (not command-count): queued replays chain as microtasks
            // and never give the browser a frame on their own, so without a
            // real yield the banner never paints and the seat reads as
            // frozen (the "extremely slow" report was partly THIS). Counting
            // commands was the wrong unit — ten 300 ms paints blocked 3 s,
            // while one 30 s refine yielded nothing either way. Elapsed time
            // is the only honest trigger.
            if (performance.now() - this._lastYieldAt >= REPLAY_BUDGET_MS) {
                this._showProgress(this._replayedCount, this._totalAtHello);
                await this._yieldFrame();
                this._lastYieldAt = performance.now();
            }
            return;
        }
        if (!this._caughtUp && this.replaySpeed === "paced") {
            // Time-lapse: fast enough to not bore, slow enough to SEE.
            await new Promise((res) => setTimeout(res, 25));
        }
        this._ghostFor(cmd.action, cmd.params || {});
    }

    /**
     * Yield one REAL frame to the browser between replay slices.
     *
     * Visible tab: resume after the next paint (rAF marks the frame; the
     * 0-timeout lands after that frame's render steps) so the progress
     * banner/scrub actually reach the screen — a bare setTimeout(0) yield
     * lets input run but does not guarantee a paint before the next slice
     * blocks again. The 150 ms timer is the guard for occluded windows,
     * where rAF can be throttled indefinitely.
     *
     * Hidden tab: rAF never fires and setTimeout is clamped to ~1000 ms —
     * a MessageChannel macrotask is unthrottled, keeps the event loop
     * responsive, and skips paints nobody can see.
     */
    async _yieldFrame() {
        if (typeof document !== "undefined"
            && document.visibilityState === "visible") {
            await new Promise((res) => {
                let settled = false;
                const fin = () => { if (!settled) { settled = true; res(); } };
                requestAnimationFrame(() => setTimeout(fin, 0));
                setTimeout(fin, 150);
            });
        } else {
            await new Promise((res) => {
                const mc = new MessageChannel();
                mc.port1.onmessage = () => res();
                mc.port2.postMessage(0);
            });
        }
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

    /** Banner skeleton, built ONCE: spinner + text + cancel. Progress updates
     *  during catch-up touch only the text node — rebuilding the subtree at
     *  every ~80 ms yield would be pointless DOM churn. */
    _ensureBanner() {
        if (this._banner) return this._banner;
        const el = document.createElement("div");
        el.id = "observe-banner";
        const spin = document.createElement("span");
        spin.className = "observe-spin";
        const text = document.createElement("span");
        text.className = "observe-banner-text";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "observe-banner-cancel";
        cancel.textContent = "Cancel";
        cancel.title = "Stop replaying and leave the observation seat";
        // The seat must ALWAYS be escapable mid-catch-up: leave() bumps the
        // run id, which the replay loops check after every await.
        cancel.addEventListener("click", () => this.leave(true));
        el.append(spin, text, cancel);
        this._viewer._container.appendChild(el);
        this._banner = el;
        this._bannerText = text;
        this._bannerSpin = spin;
        this._bannerCancel = cancel;
        return el;
    }

    _showBanner(text, kind) {
        const el = this._ensureBanner();
        this._bannerText.textContent = text;
        this._bannerSpin.style.display = "none";
        this._bannerCancel.style.display = "none";
        el.className = `observe-banner ${kind || "info"}`;
        el.style.display = "flex";
    }

    /** Catch-up/seek progress: N/M + %, a spinner that visibly moves (CSS
     *  animation — compositor-driven, so it keeps spinning between yields),
     *  and a working Cancel. Updated at every scheduler yield. */
    _showProgress(done, total) {
        const el = this._ensureBanner();
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
        this._bannerText.textContent = `Replaying ${done}/${total || "?"} commands`
            + (pct !== null ? ` — ${pct}%` : "") + " (fast-forward)";
        this._bannerSpin.style.display = "inline-block";
        this._bannerCancel.style.display = "inline-block";
        el.className = "observe-banner info";
        el.style.display = "flex";
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
