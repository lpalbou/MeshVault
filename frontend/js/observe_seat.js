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
 *
 * RECORDINGS (the replay bar): the log buffers fully, the seat lands on the
 * FINAL state (fast — checkpoint restore), and "▶ Watch how it was built"
 * replays the build as a paced, narrated time-lapse. Scrubs route through a
 * cost planner (client snapshots / cached checkpoints / forward delta /
 * from-zero — see observe_replay.js) and never re-execute a heavy command;
 * paced playback compresses heavies through their trailing reconstruction
 * point with an honest chip. All acceleration is verify-don't-trust:
 * structural checks + positions-hash write verification, with fallback to
 * plain re-execution.
 */

import * as THREE from "three";

import { clearPaintUndo } from "./viewer/sculpt.js";
import { CheckpointCache, SnapshotStore, computeBlockingPrefix,
         describeCommand, hashScenePositions } from "./observe_replay.js";

// Field-test polish: 450 ms made a fast stroke "a blink"; labels were
// borderline legible at 0.14× model scale.
const GHOST_FADE_MS = 750;

// Fast-forward scheduler TIME BUDGET (perf gauntlet: the old scheduler
// yielded every N commands, which is meaningless when one command takes
// seconds and N cheap ones fit in a frame — measured 8.5 s main-thread
// blocks on a 233-command catch-up). Process commands until the budget is
// spent, then yield a real frame: progress paints, input (Cancel/Leave)
// runs, and Firefox's "page is slowing down" detector stays quiet.
const REPLAY_BUDGET_MS = 80;

// Watchable-playback pacing (mandate: SEE the AI work). The show is
// FRAME-PACED: an rAF tick executes at most ONE due command per frame, so
// ghost fades / cursor glides / camera lerps get real frames between
// commands (the previous command-paced loop fused consecutive heavy
// commands into multi-second frozen runs — measured 9.5 s single rAF gaps
// on the falcon recording). Dwell between commands follows the RECORDED
// rhythm (entry ts deltas — the craftsman's own cadence), clamped below.
const PACE_BASE_DWELL_MS = 320;    // fallback when entries carry no ts
const PACE_MIN_DWELL_MS = 140;     // ghosts need frames to register
const PACE_MAX_GAP_MS = 2000;      // performer pauses compress to ≤2 s
// A command at or past this measured engine cost is a "heavy" — during
// paced playback it is COMPRESSED through a checkpoint/snapshot restore
// (state exact, honestly chipped) instead of stalling the show.
const PACE_HEAVY_MS = 1500;
// Camera telemetry glide time at 1× (snap looked robotic at 5 Hz sampling).
const CAM_GLIDE_MS = 260;
// Drop a breadcrumb snapshot roughly every this much replayed engine cost
// during seeks/playback — later scrubs into the segment restore locally.
const SNAPSHOT_INTERVAL_MS = 2000;
// LIVE smoothing buffer (broadcast delay): watching live runs a few seconds
// behind the performer ON PURPOSE so bursts drain at a watchable cadence
// instead of frantic back-to-back flashes. Above MAX lag the drain rushes
// (ghost-less fast path, still frame-paced) back down to TARGET.
const LIVE_TARGET_LAG_S = 2.5;
const LIVE_MAX_LAG_S = 7;
// Narration ticker DOM writes are batched (≤ ~5/s) — per-command writes
// forced style/layout work right between frames.
const TICKER_MIN_INTERVAL_MS = 200;

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
        // Replay-bar narration ticker: one line per replayed command during
        // paced playback ("paint #a33226 r=0.12"). Null clears it. DOM
        // writes are batched through _setTicker (≤ ~5/s).
        this._onTicker = deps.onTicker || (() => {});
        // Live broadcast-delay readout: (lagSeconds|null, rushing) — the
        // panel renders "live · Ns behind" from this (null hides it).
        this._onLag = deps.onLag || (() => {});

        this.observing = false;
        this.follow = true;
        // "instant" fast-forwards LIVE catch-up (no ghosts, rendering
        // suspended); "paced" replays the catch-up as a time-lapse with
        // ghosts. Recordings ignore this: they always land at the end, and
        // the replay bar's ▶ plays the watchable build.
        this.replaySpeed = "instant";
        // Paced-playback rate multiplier (replay-bar selector, 0.5-4×).
        this.playRate = 1;
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
        this._playTimer = null;    // truthy while the pacing loop runs
        this._playGen = 0;         // bumped by pause/leave — loop exit signal
        this._playDone = null;     // resolves when the pacing loop exits
        this._seekBusy = false;
        // Scrub acceleration (mandate A): checkpoint manifests/blobs are
        // fetched ONCE per session; visited positions leave client-side
        // state snapshots that later scrubs restore locally. Both cleared
        // on leave. EMA restore costs feed the seek planner.
        this._ckCache = new CheckpointCache();
        this._snaps = new SnapshotStore(THREE);
        this._blockedBefore = null;    // blocking-command prefix (recordings)
        this._restoreMsEma = 2500;     // measured checkpoint-restore cost
        this._logHasUndoPaint = false; // disables snapshots (hidden stash state)
        this._camGlide = null;         // in-flight camera interpolation
        // LIVE smoothing buffer (broadcast delay): post-catch-up entries
        // queue here and a frame-paced drain replays them a few seconds
        // behind the performer — bursts become an even, watchable cadence.
        this._liveBuf = [];
        this._liveEnded = false;
        this._liveShowRunning = false;
        this._lagPushedAt = 0;
        // Batched narration ticker state (DOM writes ≤ ~5/s).
        this._tickerTimer = null;
        this._tickerText = null;
        this._tickerAt = 0;
        this._chipAt = 0;              // chip throttle (DOM churn)
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
        // IDEMPOTENT under double-click (field report: "no feedback → I
        // re-clicked" — the second click tore down the half-joined seat and
        // restarted everything, which is exactly the wrong reward for an
        // impatient click).
        if (this._joining) return;
        if (this.observing && this._session === sessionId) return;
        if (this.observing) this.leave(false);

        // INSTANT feedback — before any network. The click must visibly do
        // something within one frame.
        this._joining = sessionId;
        this._showBanner("Joining session — loading…", "info");

        // VALIDATE BEFORE DESTROYING ANYTHING (field bug F2-1: an unconditional
        // unload on a stale/unknown session id wiped the user's scene, and the
        // unhandled `unknown_session` meta left the seat locked forever). The
        // scene is only cleared once the stream says `hello` (joinable).
        let sessionInfo = null;
        try {
            const sessions = await this.sessions();
            const s = sessions.find((x) => x.id === sessionId);
            if (!s) {
                this._joining = null;
                this._hideBanner();
                this._toast("That session no longer exists — refresh the list.", "error");
                return;
            }
            const hasCheckpoint = (s.checkpoints || []).some(
                (c) => c.seq + 1 >= (s.first_seq || 0));
            if (!s.joinable && !s.replayable && !hasCheckpoint) {
                this._joining = null;
                this._hideBanner();
                this._toast("Cannot join: the session outgrew its log — "
                    + "replay-from-zero is impossible.", "error");
                return;
            }
            sessionInfo = s;
        } catch (err) {
            this._joining = null;
            this._hideBanner();
            this._toast(`Observe hub unreachable: ${err.message}`, "error");
            return;
        }

        this.observing = true;
        this._joining = null;   // committed — the seat owns feedback from here
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
        // Follow is the DEFAULT experience of a seat (a previous session's
        // free-look opt-out must not silently carry over).
        this.follow = true;
        this._ckCache.clear();
        this._snaps.clear();
        this._blockedBefore = null;
        this._logHasUndoPaint = false;
        this._liveBuf = [];
        this._liveEnded = false;
        this._liveShowRunning = false;
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
        // Recordings land on their final state first — warm that restore's
        // manifest+blobs IN PARALLEL with the log buffering.
        if (!sessionInfo.alive && this._checkpoints.length) {
            this._ckCache.warm(
                sessionId, this._checkpoints[this._checkpoints.length - 1].seq);
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
        this._joining = null;
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
        this._ckCache.clear();      // revokes cached blob object-URLs
        this._snaps.clear();
        this._blockedBefore = null;
        this._cancelCamGlide();
        this._liveBuf = [];
        this._liveEnded = false;
        this._liveShowRunning = false;
        this._onLag(null, false);
        this._setTicker(null);
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
                this._toast("Caught up — watching live (a few seconds behind, "
                    + "so strokes stay watchable).", "info");
            });
            // From here the live tail is a SHOW: buffered + frame-paced.
            this._startLiveShow();
            return;
        }
        if (msg.type === "meta") {
            if (msg.event === "ended" || msg.event === "performer_lost") {
                const text = msg.event === "ended"
                    ? "Session ended — final state shown."
                    : "Recording ends here (the performer stopped publishing "
                      + "without ending its session).";
                if (this._recording) {
                    // The log is fully buffered — jump to the END (the user
                    // wants the result immediately) and hand control to the
                    // replay bar; its ▶ "Watch how it was built" replays the
                    // build as a paced, narrated time-lapse.
                    this._caughtUp = true;
                    this._hideBanner();
                    this._blockedBefore = computeBlockingPrefix(this._log);
                    this._logHasUndoPaint = this._logReplaysUndo();
                    this.playbackSeek(this._log.length);
                    this._toast(`Recording loaded (${this._log.length} events) — `
                        + "press ▶ below to watch how it was built.", "info");
                } else {
                    // Let the smoothing buffer DRAIN first (the show's
                    // done() needs the ended flag), then banner — queued
                    // behind the show on the same _queue (run-guarded).
                    this._liveEnded = true;
                    const run = this._runId;
                    this._queue = this._queue.then(() => {
                        if (run !== this._runId) return;
                        this._viewer.endBulkReplay();
                        this._showBanner(text, "info");
                    });
                }
                if (this._es) { this._es.close(); this._es = null; }
            } else if (msg.event === "desynced") {
                // STOP, don't drain: buffered entries after a desync would
                // replay onto a state already declared divergent.
                this._liveBuf = [];
                this._liveEnded = true;
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

        // Recordings buffer; the replay bar drives application. Buffering is
        // fast (no execution) but not instant on long logs — keep the user
        // informed instead of silent (field report: "it feels like I clicked
        // and nothing happened").
        if (this._recording) {
            if (msg.kind === "command" || msg.kind === "camera") {
                this._log.push(msg);
                if (this._log.length % 50 === 0) {
                    this._showBanner(
                        `Loading recording — ${this._log.length} events…`, "info");
                }
                this._onPlayback(this._pos, this._log.length, false, true);
            }
            return;
        }

        // Post-catch-up LIVE entries flow through the smoothing buffer: the
        // frame-paced drain replays them a few seconds behind the performer
        // (broadcast delay) so bursts land at a watchable cadence with
        // ghosts + camera glides instead of frantic back-to-back flashes.
        // Gate on _liveShowRunning (set SYNCHRONOUSLY at the caught_up
        // message): everything the stream delivered before that message is
        // already chained on _queue, and the drain chains AFTER it — exact
        // ordering across the boundary. (Gating on the _caughtUp flag would
        // race: it flips inside a queued continuation, and an entry landing
        // in the gap would chain BEHIND the never-resolving drain.)
        if (this._liveShowRunning
            && (msg.kind === "command" || msg.kind === "camera"
                || msg.kind === "fingerprint")) {
            if (msg.kind === "camera") this._lastCam = msg.camera || this._lastCam;
            this._liveBuf.push({ ...msg, arrivedAt: performance.now() });
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
                this._applyCamera(msg.camera, { glideMs: CAM_GLIDE_MS });
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
            if (this.follow && entry.camera && !fast) {
                this._applyCamera(entry.camera,
                                  { glideMs: CAM_GLIDE_MS / this.playRate });
            }
            return;
        }
        if (entry.kind !== "command") return;
        const cmd = entry.command || {};
        await this._replayCore(cmd);
        if (!fast) {
            this._ghostFor(cmd.action, cmd.params || {});
            this._setTicker(describeCommand(cmd.action, cmd.params));
        }
    }

    /**
     * Batched narration ticker: DOM writes cost layout right where frames
     * are tightest, so updates coalesce to ≤ ~5/s (latest text wins).
     * null clears immediately (pause/leave must not leave stale narration).
     */
    _setTicker(text) {
        if (text === null) {
            if (this._tickerTimer) {
                clearTimeout(this._tickerTimer);
                this._tickerTimer = null;
            }
            this._tickerText = null;
            this._tickerAt = 0;
            this._onTicker(null);
            return;
        }
        this._tickerText = text;
        if (this._tickerTimer) return;   // flush scheduled; latest text wins
        const since = performance.now() - this._tickerAt;
        if (since >= TICKER_MIN_INTERVAL_MS) {
            this._tickerAt = performance.now();
            this._onTicker(text);
        } else {
            this._tickerTimer = setTimeout(() => {
                this._tickerTimer = null;
                this._tickerAt = performance.now();
                if (this._tickerText !== null) this._onTicker(this._tickerText);
            }, TICKER_MIN_INTERVAL_MS - since);
        }
    }

    /**
     * WATCHABLE playback — the point of the seat is seeing HOW the agent
     * worked, not just the end state.
     *
     * FRAME-PACED, not command-paced (fluidity round): the previous loop
     * executed a command, slept, executed the next — with 150-800 ms engine
     * commands the main thread was frozen for most of the wall time and the
     * ghost fades / camera glides only animated in the gaps (measured on
     * falcon v3: 72% of playback wall time inside >100 ms frame gaps). Now
     * an rAF ticker owns the show: each frame executes AT MOST one due
     * entry, so at least one real frame separates any two commands and all
     * per-frame animators (ghost fade, cursor glide, camera lerp) keep
     * running. A single heavy command still blocks — irreducible engine
     * cost — but the cadence around it stays even, and heavies with a
     * reconstruction point are COMPRESSED (chip: "⏩ … compressed").
     *
     * Cadence follows the RECORDED rhythm: dwell between commands = the
     * performer's own ts delta, clamped to [140 ms, 2 s] (pauses are part
     * of the show but compressed), scaled by the 0.5-4× selector.
     */
    playbackPlay() {
        if (!this._recording || this._playTimer || this._seekBusy) return;
        if (this._pos >= this._log.length) {
            // Play from the start when the playhead sits at the end.
            this.playbackSeek(0).then(() => this.playbackPlay());
            return;
        }
        const run = this._runId;
        const gen = ++this._playGen;
        const token = { gen };
        this._playTimer = token;
        const alive = () => this.observing && run === this._runId
            && this._playTimer === token && !this._seekBusy;
        let loopDone;
        // Seeks await this before touching the scene: a pause signal can
        // land while the show is mid-command, and a seek that starts
        // rebuilding while that command still executes would interleave
        // two writers on one replica.
        this._playDone = new Promise((res) => { loopDone = res; });
        let costSinceSnap = 0;
        const controller = {
            hasNext: () => this._pos < this._log.length,
            done: () => this._pos >= this._log.length,
            peek: () => this._log[this._pos],
            pop: () => this._log[this._pos++],
            rate: () => this.playRate,
            rush: () => false,
            coalesceCameras: true,
            // The craftsman's own cadence: dwell after a command = the
            // performer's publish gap to its NEXT command, clamped (≥140 ms
            // so ghosts register; thinking pauses cap at 2 s).
            gapAfter: (entry) => {
                let gap = PACE_BASE_DWELL_MS;
                if (typeof entry.ts === "number") {
                    for (let i = this._pos; i < this._log.length; i++) {
                        const n = this._log[i];
                        if (n.kind !== "command") continue;
                        if (typeof n.ts === "number") {
                            const d = (n.ts - entry.ts) * 1000;
                            if (d >= 0) gap = d;
                            if (d > 2 * PACE_MAX_GAP_MS) {
                                this._chip("⏸ agent pause compressed");
                            }
                        }
                        break;
                    }
                }
                return Math.max(PACE_MIN_DWELL_MS,
                                Math.min(gap, PACE_MAX_GAP_MS));
            },
            alive,
            compress: (entry) => this._compressHeavy(entry, run),
            onApplied: (execMs) => {
                costSinceSnap += execMs || 25;
                if (costSinceSnap >= 2 * SNAPSHOT_INTERVAL_MS) {
                    this._takeSnapshot();
                    costSinceSnap = 0;
                }
                this._onPlayback(this._pos, this._log.length, true, true);
            },
            onCompressed: () => { costSinceSnap = 0; },
            onIdle: () => {},
            finish: () => {
                if (this._playTimer === token) {
                    this._playTimer = null;
                    if (this.observing && run === this._runId) {
                        this._setTicker(null);
                        this._onPlayback(this._pos, this._log.length, false, true);
                    }
                }
                loopDone();
            },
        };
        this._onPlayback(this._pos, this._log.length, true, true);
        this._queue = this._queue.then(() => this._frameShow(controller));
    }

    /**
     * The frame-paced show engine — shared by recording playback and the
     * live smoothing drain. One rAF tick executes at most ONE due entry
     * (camera runs coalesce into a single glide); everything animated
     * (ghosts, cursor, camera, spinner) gets real frames between commands.
     * A hidden tab falls back to a coarse interval so playback still
     * progresses (rAF stops firing there; nobody is watching frames).
     * Resolves when controller.done() or the run guards trip.
     */
    async _frameShow(controller) {
        let nextDueAt = performance.now();
        let executing = false;
        const step = async () => {
            executing = true;
            try {
                const rush = controller.rush();
                const entry = controller.peek();
                if (!entry) return;
                if (entry.kind === "camera") {
                    controller.pop();
                    let last = entry;
                    // Recordings coalesce camera RUNS (a long orbit between
                    // strokes would stall the show); the live drain glides
                    // through EACH sample — successive short glides chase
                    // the performer's path smoothly (each re-lerps from the
                    // current pose), which IS the broadcast-delay camera.
                    if (controller.coalesceCameras) {
                        while (controller.hasNext()
                               && controller.peek().kind === "camera") {
                            last = controller.pop();
                        }
                    }
                    this._lastCam = last.camera || this._lastCam;
                    if (this.follow && last.camera) {
                        // Rushing: snap (a glide would lag the drain);
                        // paced: eased glide — the craftsman camera.
                        this._applyCamera(last.camera, rush ? {}
                            : { glideMs: CAM_GLIDE_MS / controller.rate() });
                    }
                    // Camera-only stretches read as dead air at full dwell —
                    // a short beat keeps the glide visible but brisk.
                    nextDueAt = performance.now()
                        + (rush ? 0 : 90 / controller.rate());
                    controller.onApplied(0);
                    return;
                }
                if (entry.kind !== "command") {
                    controller.pop();
                    if (entry.kind === "fingerprint") {
                        await this._checkFingerprint(entry.fingerprint);
                    }
                    controller.onApplied(0);
                    return;
                }
                const execMs = entry.exec_ms || 0;
                if (!rush && execMs >= PACE_HEAVY_MS) {
                    if (await controller.compress(entry)) {
                        controller.onCompressed();
                        nextDueAt = performance.now()
                            + PACE_MIN_DWELL_MS / controller.rate();
                        return;
                    }
                    if (!controller.alive()) return;
                    // No reconstruction point — execute honestly, with the
                    // chip PAINTED before the block.
                    this._chip(`⏳ heavy ${entry.command.action} `
                        + `(~${Math.round(execMs / 1000)}s) — executing…`,
                        { force: true });
                    await this._yieldFrame();
                    if (!controller.alive()) return;
                }
                controller.pop();
                const t0 = performance.now();
                await this._applyLogEntry(entry, rush);
                const spent = performance.now() - t0;
                controller.onApplied(execMs);
                if (rush) {
                    // Catch-up drain: burn a bounded budget per frame, then
                    // let a real frame through (progress stays visible).
                    let budget = 60 - spent;
                    while (budget > 0 && controller.rush()
                           && controller.alive() && controller.hasNext()
                           && controller.peek().kind === "command"
                           && (controller.peek().exec_ms || 0) < PACE_HEAVY_MS) {
                        const e = controller.pop();
                        const t1 = performance.now();
                        await this._applyLogEntry(e, true);
                        budget -= performance.now() - t1;
                        controller.onApplied(e.exec_ms || 0);
                    }
                    nextDueAt = performance.now();
                } else {
                    const period = controller.gapAfter(entry) / controller.rate();
                    nextDueAt = performance.now() + Math.max(0, period - spent);
                }
            } catch (err) {
                // A thrown replay is divergence, never a silent show stop.
                this._replayErrors++;
                this._showBanner(`Replay error: ${String(err && err.message)
                    .slice(0, 100)} — the replica may have diverged.`, "warn");
            } finally {
                executing = false;
            }
        };
        await new Promise((resolve) => {
            let intervalId = null;
            let finished = false;
            const tick = () => {
                if (finished) return;
                if (!executing && (!controller.alive() || controller.done())) {
                    cleanup();
                    return;
                }
                if (!executing && controller.alive()) {
                    if (!controller.hasNext()) {
                        controller.onIdle();
                    } else if (performance.now() >= nextDueAt
                               || controller.rush()) {
                        step();   // async; `executing` gates re-entry
                    }
                }
                schedule();
            };
            const schedule = () => {
                if (finished) return;
                if (typeof document !== "undefined"
                    && document.visibilityState !== "visible") {
                    // rAF is parked in hidden tabs; a coarse timer keeps the
                    // show progressing (frames don't matter unseen).
                    if (intervalId === null) {
                        intervalId = setInterval(tick, 120);
                    }
                } else {
                    if (intervalId !== null) {
                        clearInterval(intervalId);
                        intervalId = null;
                    }
                    requestAnimationFrame(tick);
                }
            };
            const cleanup = () => {
                if (finished) return;
                finished = true;
                if (intervalId !== null) clearInterval(intervalId);
                controller.finish();
                resolve();
            };
            schedule();
        });
    }

    /**
     * LIVE smoothing drain (broadcast delay). Buffered stream entries replay
     * frame-paced at the performer's own publish rhythm (clamped like the
     * recording show) — ghosts get their fade time, the follow camera
     * glides, and the seat honestly reports "live · Ns behind". Adaptive:
     * dwell shrinks smoothly as lag approaches LIVE_MAX_LAG_S; past it the
     * drain RUSHES (ghost-less fast path, still one frame per slice) until
     * lag falls under LIVE_TARGET_LAG_S. Runs chained on _queue so it can
     * never interleave with catch-up replays.
     */
    _startLiveShow() {
        if (this._liveShowRunning || this._recording) return;
        this._liveShowRunning = true;
        const run = this._runId;
        let rushing = false;
        let lastTs = null;
        const lag = () => this._liveBuf.length
            ? (performance.now() - this._liveBuf[0].arrivedAt) / 1000 : 0;
        const controller = {
            hasNext: () => this._liveBuf.length > 0,
            done: () => this._liveEnded && this._liveBuf.length === 0,
            peek: () => this._liveBuf[0],
            pop: () => this._liveBuf.shift(),
            rate: () => 1,
            coalesceCameras: false,
            rush: () => {
                const l = lag();
                if (rushing && l <= LIVE_TARGET_LAG_S) rushing = false;
                else if (!rushing && l >= LIVE_MAX_LAG_S) {
                    rushing = true;
                    this._chip("⏩ falling behind — catching up…", { force: true });
                }
                return rushing;
            },
            // Publish-rhythm dwell with smooth pressure: as lag climbs from
            // TARGET toward MAX the dwell compresses (×1 → ×0.28), so the
            // drain speeds up long before the hard rush kicks in.
            gapAfter: (entry) => {
                let gap = PACE_BASE_DWELL_MS;
                if (typeof entry.ts === "number" && lastTs !== null) {
                    const d = (entry.ts - lastTs) * 1000;
                    if (d >= 0) gap = d;
                }
                if (typeof entry.ts === "number") lastTs = entry.ts;
                gap = Math.max(PACE_MIN_DWELL_MS,
                               Math.min(gap, PACE_MAX_GAP_MS));
                const pressure = Math.max(0, Math.min(1,
                    (lag() - LIVE_TARGET_LAG_S)
                    / (LIVE_MAX_LAG_S - LIVE_TARGET_LAG_S)));
                return gap * (1 - 0.72 * pressure);
            },
            alive: () => this.observing && run === this._runId,
            // The live tail has no reconstruction point AT a heavy's
            // completion (checkpoint blobs trail the head) — heavies
            // execute honestly with the chip.
            compress: async () => false,
            onApplied: () => this._pushLag(lag(), rushing),
            onCompressed: () => {},
            onIdle: () => this._pushLag(lag(), false),
            finish: () => {
                if (run === this._runId) {
                    this._liveShowRunning = false;
                    this._onLag(null, false);
                }
            },
        };
        this._queue = this._queue.then(() => this._frameShow(controller));
    }

    /** Throttled lag readout (≤2/s — it's a status line, not telemetry). */
    _pushLag(lagS, rushing) {
        const now = performance.now();
        if (now - this._lagPushedAt < 500) return;
        this._lagPushedAt = now;
        this._onLag(lagS, !!rushing);
    }

    /**
     * Compress a heavy command during paced playback: land on the nearest
     * reconstruction point AT or just after its completion (client snapshot,
     * or the checkpoint the monster rule captured — its anchor seq can TRAIL
     * the command by a few events because the publisher anchors the upload
     * to the last appended event). The landing window is COST-bounded: only
     * the heavy command plus a trivial tail (≤ ~0.5 s telemetry, ≤ 8
     * entries) may be compressed together — the show never silently skips
     * meaningful work. Returns false when no point exists in the window —
     * the caller executes the command honestly.
     */
    async _compressHeavy(entry, run) {
        const pos = this._pos;
        const action = entry.command ? entry.command.action : "command";
        const secs = Math.round((entry.exec_ms || 0) / 1000);
        // Landing window [pos+1 .. end] (position p = state after log[p-1]).
        let end = pos + 1;
        let extraCost = 0;
        while (end < this._log.length && end - (pos + 1) < 8) {
            const e = this._log[end];
            if (e.kind === "command") {
                const c = e.exec_ms || 25;
                if (extraCost + c > 500) break;
                extraCost += c;
            }
            end++;
        }
        const finish = (landing) => {
            const skipped = landing - (pos + 1);
            const extra = skipped > 0 ? ` (+${skipped} trailing)` : "";
            this._chip(`⏩ heavy ${action} (${secs}s)${extra} compressed — state exact`);
            this._setTicker(`⏩ ${describeCommand(action, entry.command.params)} `
                + `— ${secs}s compressed`);
        };
        // 1. Client snapshot in the window (local write, ~tens of ms).
        if (this._blockedBefore && !this._logHasUndoPaint) {
            for (let p = pos + 1; p <= end; p++) {
                const snap = this._snaps.bestAtOrBefore(
                    p, this._pos, this._blockedBefore);
                if (!snap || snap.pos !== p) continue;
                if (await this._snaps.restore(this._viewer, this._api, snap)) {
                    this._pos = p;
                    this._settleAfterLocalRestore();
                    finish(p);
                    return true;
                }
                if (run !== this._runId) return true;
                if (this._snaps.lastRefusalPhase === "write") {
                    // The scene mutated before the refusal — it can no
                    // longer be trusted as state(pos). Exit the show and
                    // rebuild exactly through the seek machinery, then
                    // resume playing from the same point.
                    this._playTimer = null;
                    this._showBanner("Snapshot failed verification — "
                        + "rebuilding exactly…", "warn");
                    setTimeout(() => {
                        if (run !== this._runId) return;
                        this.playbackSeek(p).then(() => {
                            if (run === this._runId) this.playbackPlay();
                        });
                    }, 0);
                    return true;
                }
                break;   // structural refusal — snapshots won't differ per p
            }
        }
        // 2. Checkpoint anchored in the window.
        let ck = null, ckIdx = -1;
        for (const c of this._checkpoints) {
            let idx = 0;
            while (idx < this._log.length && this._log[idx].seq <= c.seq) idx++;
            if (idx >= pos + 1 && idx <= end) { ck = c; ckIdx = idx; break; }
        }
        if (!ck) return false;
        this._chip(`⏩ heavy ${action} (${secs}s) — restoring its checkpoint…`);
        await this._yieldFrame();
        if (run !== this._runId) return true;   // left mid-chip
        try {
            this._viewer.beginBulkReplay();
            await this._restoreFromCheckpoint(ck, run, { quiet: true });
        } catch {
            if (run === this._runId) this._viewer.endBulkReplay();
            return false;   // restore failed — execute honestly instead
        }
        if (run !== this._runId) return true;
        this._viewer.endBulkReplay();
        this._pos = ckIdx;
        this._takeSnapshot();   // the point most worth pinning locally
        finish(ckIdx);
        return true;
    }

    playbackPause() {
        this._playGen++;
        if (this._playTimer) { this._playTimer = null; }
        this._setTicker(null);   // stale narration reads as "still playing"
        this._onPlayback(this._pos, this._log.length, false, true);
    }

    /** Playback speed multiplier (replay-bar selector). */
    setPlayRate(rate) {
        const r = Number(rate);
        if (r > 0) this.playRate = r;
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

    /**
     * Newest checkpoint whose reconstructed LOG POSITION is ≤ targetPos.
     *
     * Position space, not seq space: a checkpoint's anchor seq can be a
     * NON-BUFFERED event (lifecycle ping, fingerprint) — its seq then
     * exceeds the last buffered command's seq while the state it restores
     * is exactly that command's position. Seq-space comparison hid such
     * checkpoints from the planner and forced a monster re-execution one
     * position after the monster (measured on the bench: an 11 s "shadow"
     * seek that position-space planning restores in ~0.5 s).
     */
    _checkpointBefore(targetPos) {
        let best = null;
        for (const c of this._checkpoints) {
            let idx = 0;
            while (idx < this._log.length && this._log[idx].seq <= c.seq) idx++;
            if (idx <= targetPos && (!best || idx > best.idx)) {
                best = { ck: c, idx };
            }
        }
        return best;
    }

    /**
     * Heavy-shadow landing adjustment (bounded, honest). A position is "in
     * the shadow" of a heavy command when EVERY reconstruction path to it
     * re-executes that command (no checkpoint/snapshot between the heavy
     * and the position). Move such landings to the nearest reconstruction
     * point just ahead — within the same small window the paced compressor
     * uses (≤8 entries, ≤500 ms telemetry) — and the caller tells the user.
     * Everything else lands EXACTLY where requested.
     */
    _adjustHeavyLanding(target) {
        if (target <= 0 || target >= this._log.length) return target;
        // Best reconstruction base ≤ target.
        let base = 0;
        if (this._pos <= target) base = Math.max(base, this._pos);
        const sb = this._logHasUndoPaint ? null
            : this._snaps.bestAtOrBefore(target, this._pos, this._blockedBefore);
        if (sb) base = Math.max(base, sb.pos);
        const cpb = this._checkpointBefore(target);
        if (cpb) base = Math.max(base, cpb.idx);
        let shadowed = false;
        for (let i = base; i < target; i++) {
            const e = this._log[i];
            if (e.kind === "command" && (e.exec_ms || 0) >= PACE_HEAVY_MS) {
                shadowed = true;
                break;
            }
        }
        if (!shadowed) return target;
        // Nearest fast point AT or just after the target.
        let best = -1;
        for (const c of this._checkpoints) {
            let idx = 0;
            while (idx < this._log.length && this._log[idx].seq <= c.seq) idx++;
            if (idx >= target && (best < 0 || idx < best)) best = idx;
        }
        for (const p of this._snaps.positions()) {
            if (p < target || (best >= 0 && p >= best)) continue;
            const lo = Math.min(p, this._pos), hi = Math.max(p, this._pos);
            if (this._blockedBefore[hi] === this._blockedBefore[lo]) best = p;
        }
        if (best >= target && best - target <= 8
            && this._execCost(target, best) <= 500) {
            return best;
        }
        return target;   // no near fast point — land exactly, pay honestly
    }

    /** Does the buffered log replay an undo_paint anywhere? (Exact check —
     *  the log is fully buffered.) Snapshots are disabled in that case: the
     *  single-slot paint-undo stash is hidden state a snapshot cannot carry. */
    _logReplaysUndo() {
        return this._log.some((e) => {
            if (e.kind !== "command" || !e.command) return false;
            if (e.command.action === "undo_paint") return true;
            if (e.command.action === "batch") {
                const subs = (e.command.params || {}).commands || [];
                return subs.some((s) => s && s.action === "undo_paint");
            }
            return false;
        });
    }

    /** Scrub-bar marks (checkpoint/snapshot log positions) — honest UI:
     *  these are the fast landing points. */
    replayMarks() {
        const cks = [];
        for (const c of this._checkpoints) {
            let idx = 0;
            while (idx < this._log.length && this._log[idx].seq <= c.seq) idx++;
            cks.push(idx);
        }
        return { total: this._log.length, checkpoints: cks,
                 snapshots: this._snaps.positions() };
    }

    /** Positions hash of the current replica state (e2e equivalence proof +
     *  snapshot verification share this exact formula). */
    stateHash() {
        return hashScenePositions(this._viewer);
    }

    /** Take a client snapshot at the CURRENT playhead (bounded store).
     *  Positions are always settled here (writes are direct); deferred
     *  normals/stats are irrelevant to the captured buffers + hash. */
    _takeSnapshot() {
        if (!this._recording || this._logHasUndoPaint) return;
        try {
            this._snaps.capture(this._viewer, this._pos);
        } catch { /* snapshot capture is an optimization, never a failure */ }
    }

    /** After a local snapshot restore: settle whatever the deferral contract
     *  left dirty so the next frame paints the exact restored state. */
    _settleAfterLocalRestore() {
        const v = this._viewer;
        for (const e of v._objects || []) {
            e.model.traverse((c) => {
                if (c.isMesh && c.geometry && c.geometry.userData
                    && c.geometry.userData._mvNormalsDirty) {
                    c.geometry.computeVertexNormals();
                    delete c.geometry.userData._mvNormalsDirty;
                }
            });
        }
        if (v.settleDeferredStats) v.settleDeferredStats();
        v.invalidate();
    }

    /**
     * Seek the playhead through the CHEAPEST reconstruction. Candidate
     * routes, costed with measured telemetry (exec_ms sums; EMA restore
     * costs) and attempted in cost order with graceful fallback:
     *
     *   1. client snapshot ≤ target with no blocking command between it and
     *      the playhead — a local memory write (~tens of ms), verified
     *      structurally before writing and by positions hash after;
     *   2. forward incremental replay from the current position;
     *   3. server checkpoint ≤ target (manifest/blobs from the per-session
     *      cache — the network+parse cost is paid once, not per seek);
     *   4. rebuild from zero.
     *
     * Long tails drop breadcrumb snapshots every ~2 s of replayed engine
     * cost, so later scrubs into the same region restore locally. Heavy
     * commands never re-execute mid-seek: the monster rule anchors a
     * checkpoint right after each one, which route 3 lands on.
     */
    async playbackSeek(target) {
        if (!this._recording || this._seekBusy) return;
        target = Math.max(0, Math.min(this._log.length, Math.round(target)));
        if (target === this._pos && !this._playTimer) return;
        const run = this._runId;
        this.playbackPause();
        // The pacing loop may be mid-command — wait for it to notice the
        // pause before rebuilding state under it (two writers, one replica).
        if (this._playDone) await this._playDone;
        if (run !== this._runId || !this._recording || this._seekBusy) return;
        if (target === this._pos) return;
        this._seekBusy = true;
        this._setTicker(null);
        this._onPlayback(this._pos, this._log.length, false, true);

        // ---- plan (no work yet) ------------------------------------------
        if (!this._blockedBefore) {
            this._blockedBefore = computeBlockingPrefix(this._log);
        }
        // Landing adjustment (lever 3, deliberately BOUNDED): a target in
        // the "shadow" of a heavy command — between its completion and the
        // nearest reconstruction point — could only be reached exactly by
        // re-executing the monster (≥ PACE_HEAVY_MS). Land on the nearest
        // fast point just ahead instead, and SAY so. Ordinary positions are
        // never snapped: you land exactly where you release.
        const requested = target;
        target = this._adjustHeavyLanding(target);
        if (target !== requested) {
            this._toast(`Landed at ${target} (+${target - requested}): position `
                + `${requested} sits behind a heavy command — reconstructing it `
                + "exactly would re-execute those seconds.", "info");
        }
        if (target === this._pos) {
            this._seekBusy = false;
            this._onPlayback(this._pos, this._log.length, false, true);
            return;
        }
        const snap = this._logHasUndoPaint ? null
            : this._snaps.bestAtOrBefore(target, this._pos, this._blockedBefore);
        const cp = target > 0 ? this._checkpointBefore(target) : null;
        const routes = [];
        if (snap) {
            routes.push({ kind: "snapshot",
                          cost: this._snaps.restoreMsEma
                              + this._execCost(snap.pos, target) });
        }
        if (target >= this._pos) {
            routes.push({ kind: "forward",
                          cost: this._execCost(this._pos, target) });
        }
        if (cp) {
            routes.push({ kind: "checkpoint",
                          cost: this._restoreMsEma
                              + this._execCost(cp.idx, target) });
        }
        routes.push({ kind: "zero", cost: 50 + this._execCost(0, target) });
        routes.sort((a, b) => a.cost - b.cost);

        // ---- feedback: instant for real work, silent for sub-perceptual
        // seeks (a banner that flashes for 60 ms is flicker, not honesty;
        // the scrub thumb + position label already confirmed the click).
        let bannerShown = false;
        let bannerTimer = null;
        if (routes[0].cost >= 200) {
            this._showBanner(`Seeking to ${target}…`, "info");
            bannerShown = true;
        } else {
            bannerTimer = setTimeout(() => {
                if (this._seekBusy && run === this._runId) {
                    this._showBanner(`Seeking to ${target}…`, "info");
                    bannerShown = true;
                }
            }, 150);
        }

        // Brush-undo stashes are pure waste during a seek — observers cannot
        // invoke undo_paint — UNLESS the log itself replays one (the replica
        // must then restore the same texels the performer did). Exact check,
        // precomputed at load.
        let progressShown = false;
        let costSinceSnap = 0;
        try {
            this._viewer.beginBulkReplay();
            this._viewer._suppressPaintUndo = !this._logHasUndoPaint;
            let placed = false;
            let sceneDirty = false;   // snapshot write-phase refusal poisons
                                      // the in-place state — rebuild routes only
            for (const route of routes) {
                if (run !== this._runId) return;
                if (route.kind === "snapshot") {
                    if (await this._snaps.restore(this._viewer, this._api, snap)) {
                        this._pos = snap.pos;
                        placed = true;
                    }
                    if (run !== this._runId) return;
                    if (this._snaps.lastRefusalPhase === "write") sceneDirty = true;
                    // Failed validation → try the next route (costs were
                    // sorted with it — close enough).
                } else if (route.kind === "forward") {
                    if (sceneDirty) continue;   // needs pristine current state
                    placed = true;   // replay tail below handles the rest
                } else if (route.kind === "checkpoint") {
                    try {
                        await this._restoreFromCheckpoint(cp.ck, run);
                        if (run !== this._runId) return;
                        this._pos = cp.idx;
                        placed = true;
                    } catch (err) {
                        if (run !== this._runId) return;
                        this._showBanner("Checkpoint restore failed "
                            + `(${String(err.message).slice(0, 90)}) — replaying instead.`,
                            "warn");
                        bannerShown = true;
                    }
                } else {
                    await this._api.execute({ action: "unload" });
                    if (run !== this._runId) return;
                    this._pos = 0;
                    placed = true;
                }
                if (placed) break;
            }
            this._lastYieldAt = performance.now();
            while (this._pos < target) {
                // leave()/re-join aborts the loop at the next iteration —
                // the old code kept indexing the emptied log and threw.
                if (run !== this._runId) return;
                const entry = this._log[this._pos++];
                await this._applyLogEntry(entry, true);
                if (entry.kind === "command") {
                    costSinceSnap += entry.exec_ms || 25;
                    // Breadcrumbs: a long tail leaves restore points behind,
                    // so the NEXT scrub into this segment is near-instant.
                    if (costSinceSnap >= SNAPSHOT_INTERVAL_MS
                        && this._pos < target) {
                        this._takeSnapshot();
                        costSinceSnap = 0;
                    }
                }
                // TIME-BUDGET yield (see _replay): a long rebuild must LOOK
                // like progress and stay cancellable, never a frozen tab.
                if (performance.now() - this._lastYieldAt >= REPLAY_BUDGET_MS) {
                    this._onPlayback(this._pos, this._log.length, false, true);
                    this._showProgress(this._pos, target);
                    progressShown = true;
                    bannerShown = true;
                    await this._yieldFrame();
                    this._lastYieldAt = performance.now();
                }
            }
        } finally {
            if (bannerTimer) clearTimeout(bannerTimer);
            this._seekBusy = false;
            // On abort, leave() already restored the viewer (endBulkReplay
            // clears the suppression flag too) — and a NEW session may have
            // re-entered bulk mode by now; touching it here would corrupt it.
            if (run === this._runId) this._viewer.endBulkReplay();
        }
        if (run !== this._runId) return;
        // Pin the landing: the position the user chose is the position they
        // will scrub back to (dedup + bounds live in the store).
        if (this._pos === target && target > 0) this._takeSnapshot();
        // Banner lifecycle: ALWAYS resolve (the stuck "Seeking to 0…" after
        // a play-from-end restart was exactly a non-resolved banner), and
        // re-assert standing divergence that progress updates overwrote.
        if (this._replayErrors > 0 && progressShown) {
            this._showBanner(`Replayed with ${this._replayErrors} error(s) — `
                + "the replica may have diverged.", "warn");
        } else if (bannerShown) {
            this._hideBanner();
        }
        // Land on the performer's camera at this point when following.
        if (this.follow && this._lastCam) this._applyCamera(this._lastCam);
        this._onPlayback(this._pos, this._log.length, false, true);
    }

    /** Turn camera-follow on/off (panel checkbox / view grab). Engaging
     *  SNAPS to the performer's latest known camera immediately; disengaging
     *  cancels any in-flight glide so free-look wins the very same frame. */
    setFollow(on) {
        this.follow = !!on;
        if (!this.follow) this._cancelCamGlide();
        else if (this._lastCam) this._applyCamera(this._lastCam);
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
    async _restoreFromCheckpoint(ck, run, opts = {}) {
        const t0 = performance.now();
        if (!opts.quiet) {
            this._showBanner(`Restoring checkpoint (command ${ck.seq})…`, "info");
        }
        // Manifest + blob object-URLs come from the per-session cache: the
        // fetch/parse of ~MBs of GLBs is paid ONCE, then every later seek
        // through this checkpoint reuses them (the dominant repeat cost of
        // the "much too slow" scrubbing round).
        let cachedCk;
        try {
            cachedCk = await this._ckCache.get(this._session, ck.seq);
        } catch (err) {
            // Thinned/evicted server-side between list and fetch — drop the
            // cache entry so a refreshed checkpoint list can retry cleanly.
            this._ckCache.invalidate(ck.seq);
            throw err;
        }
        const { manifest, urls } = cachedCk;
        if (run !== this._runId) return null;
        const objs = (manifest.objects || []).slice().sort((a, b) => a.id - b.id);

        const exec = async (action, params) => {
            const r = await this._api.execute({ action, params: params || {} });
            if (!r.ok) throw new Error(`${action}: ${r.error}`);
            return r.result;
        };
        const soft = async (action, params) => {
            try { return await exec(action, params); } catch { return null; }
        };
        const v = this._viewer;
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
        // (Blob object-URLs stay alive: the cache owns them until leave().)
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
        // Self-calibrating planner input: the real cost of THIS machine's
        // restores (cached restores pull the estimate down automatically).
        this._restoreMsEma = 0.5 * this._restoreMsEma + 0.5 * ms;
        // Honesty: the replica did NOT re-execute the skipped history.
        if (!opts.quiet) {
            this._showBanner(`Restored from checkpoint at command ${ck.seq} in ${(ms / 1000).toFixed(1)} s `
                + "— earlier steps were not re-executed.", "info");
        }
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

    /**
     * Apply performer camera telemetry. Default = snap (seek landings, live
     * catch-up). With {glideMs} the camera LERPs there over that window —
     * 5 Hz telemetry snapping read as robotic during paced playback; a
     * short eased glide is the follow-camera the mandate asked for.
     */
    _applyCamera(cam, opts = {}) {
        const v = this._viewer;
        if (!cam.position || !v._camera) return;
        this._cancelCamGlide();
        const ms = opts.glideMs || 0;
        if (!ms || ms < 32 || v._bulkReplay
            || typeof requestAnimationFrame === "undefined") {
            v._camera.position.set(...cam.position);
            if (cam.target && v._controls) v._controls.target.set(...cam.target);
            if (cam.fov && Math.abs(v._camera.fov - cam.fov) > 0.01) {
                v._camera.fov = cam.fov;
                v._camera.updateProjectionMatrix();
            }
            if (v._controls) v._controls.update();
            v.invalidate();
            return;
        }
        const from = {
            p: v._camera.position.clone(),
            t: v._controls ? v._controls.target.clone() : null,
            fov: v._camera.fov,
        };
        const to = {
            p: new THREE.Vector3(...cam.position),
            t: cam.target ? new THREE.Vector3(...cam.target) : null,
            fov: cam.fov || from.fov,
        };
        const start = performance.now();
        const token = {};
        this._camGlide = token;
        const step = () => {
            if (this._camGlide !== token || !this.observing) return;
            const t = Math.min(1, (performance.now() - start) / ms);
            const k = t * (2 - t);   // ease-out
            v._camera.position.lerpVectors(from.p, to.p, k);
            if (from.t && to.t && v._controls) {
                v._controls.target.lerpVectors(from.t, to.t, k);
            }
            if (Math.abs(to.fov - from.fov) > 0.01) {
                v._camera.fov = from.fov + (to.fov - from.fov) * k;
                v._camera.updateProjectionMatrix();
            }
            if (v._controls) v._controls.update();
            v.invalidate();
            if (t < 1) requestAnimationFrame(step);
            else this._camGlide = null;
        };
        requestAnimationFrame(step);
    }

    _cancelCamGlide() {
        this._camGlide = null;
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
             "set_morph", "fill_paint", "bake_ao", "bake_normals",
             "remove_object", "merge_objects", "set_scale"].includes(action)) {
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
     * rAF-driven CONTINUOUS interpolation (fluidity round): the old 45 ms
     * setInterval stepped the cursor point-to-point at ~22 Hz — visibly
     * choppy next to 60 fps ghost fades. Position lerps and orientation
     * slerps between per-point surface frames every animation frame; trail
     * stamps still drop once per stamp point.
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
        if (this._cursorAnim) this._cursorAnim.cancelled = true;
        const anim = { cancelled: false };
        this._cursorAnim = anim;
        const PER_POINT_MS = 45;   // same overall stroke cadence as before
        const start = performance.now();
        const frames = [];   // lazy per-point surface frames (raycast once)
        const frameFor = (i) => {
            if (!frames[i]) {
                const p = new THREE.Vector3(...points[i]);
                const normal = this._surfaceNormal(p);
                frames[i] = {
                    p: p.addScaledVector(normal, radius * 0.03),
                    q: new THREE.Quaternion().setFromUnitVectors(
                        new THREE.Vector3(0, 0, 1), normal),
                };
            }
            return frames[i];
        };
        let lastStamp = -1;
        const tick = () => {
            if (anim.cancelled || !this.observing) return;
            const t = (performance.now() - start) / PER_POINT_MS;
            const i = Math.min(points.length - 1, Math.floor(t));
            const frac = Math.max(0, Math.min(1, t - i));
            const a = frameFor(i);
            const b = frameFor(Math.min(points.length - 1, i + 1));
            cur.group.position.lerpVectors(a.p, b.p, frac);
            cur.group.quaternion.slerpQuaternions(a.q, b.q, frac);
            // Faint trail stamps behind the cursor (once per stamp point).
            while (lastStamp < i) {
                lastStamp++;
                this._spawnGhost(points[lastStamp], radius, colorHex, null);
            }
            this._viewer.invalidate();
            if (t < points.length - 1) {
                requestAnimationFrame(tick);
            } else if (this._cursorAnim === anim) {
                this._cursorAnim = null;
            }
        };
        requestAnimationFrame(tick);
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

    /** Shared unit geometries for trail stamps: per-stamp RingGeometry
     *  allocation was ~100 geometry builds/s of pure GC churn during dense
     *  strokes — stamps now scale a shared unit ring/disc (materials stay
     *  per-ghost: each fades independently). */
    _ghostUnitGeo() {
        if (!this._ghostGeo) {
            this._ghostGeo = {
                ring: new THREE.RingGeometry(0.92, 1, 48),
                disc: new THREE.CircleGeometry(0.9, 48),
            };
        }
        return this._ghostGeo;
    }

    _spawnGhost(pointArr, radius, colorHex, _label) {
        if (!this.observing) return;
        const v = this._viewer;
        const group = this._ensureGhostGroup();
        const point = new THREE.Vector3(...pointArr);
        const normal = this._surfaceNormal(point);
        const color = new THREE.Color(colorHex);
        const geo = this._ghostUnitGeo();

        // Trail stamps are FAINT by design — the persistent cursor is the
        // strong mark; the trail just shows where the stroke has been.
        const ghost = new THREE.Group();
        const ring = new THREE.Mesh(
            geo.ring,
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4,
                                          side: THREE.DoubleSide, depthTest: false }));
        const disc = new THREE.Mesh(
            geo.disc,
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14,
                                          blending: THREE.AdditiveBlending,
                                          side: THREE.DoubleSide, depthTest: false }));
        ghost.add(ring, disc);
        ghost.scale.setScalar(Math.max(1e-6, radius));
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
                // Geometries are SHARED — dispose materials only.
                ghost.traverse((o) => { if (o.material) o.material.dispose(); });
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
        if (this._cursorAnim) { this._cursorAnim.cancelled = true; this._cursorAnim = null; }
        this._cursor = null;
        this._onToolChange(null);
        if (this._ghostGeo) {
            this._ghostGeo.ring.dispose();
            this._ghostGeo.disc.dispose();
            this._ghostGeo = null;
        }
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

    /** Transient action chip. Throttled (DOM churn costs frames exactly
     *  where the show is tightest); {force:true} bypasses — heavy-command
     *  and catch-up chips must never be swallowed. */
    _chip(text, opts = {}) {
        const now = performance.now();
        if (!opts.force && now - this._chipAt < 400) return;
        this._chipAt = now;
        const el = document.createElement("div");
        el.className = "observe-chip";
        el.textContent = text;
        this._viewer._container.appendChild(el);
        setTimeout(() => { el.classList.add("gone"); }, 900);
        setTimeout(() => { el.remove(); }, 1400);
    }
}
