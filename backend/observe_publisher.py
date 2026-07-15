"""
Observation-seat publisher — the MCP performer side.

Streams every executed MUTATING viewer command (plus camera telemetry,
fingerprints, lifecycle pings and now periodic STATE CHECKPOINTS) from the
headless viewer page to the running app's observe hub, so browser tabs can
WATCH the agent work live — and join/replay WITHOUT re-executing the whole
build history.

Contract (from the adversarial design review):
- The hook lives IN THE PAGE (window.mv "executed" events), not around Python
  dispatch sites — the MCP has several dispatch paths into the viewer
  (viewer_execute, load_local, raw page.evaluate loops) and only the page sees
  them all. Batch children are excluded via the event's `topLevel` flag.
- Publishing is ORDERED WITH RETRY, never fire-and-forget: a lost publish is
  invisible to observers (no server-side gap exists for an event that never
  arrived). The performer stamps a contiguous client_seq; the hub marks the
  session lossy on a skip. Publishing never blocks or fails the agent call —
  the queue is drained by a background task.
- Canonicalization happens in the hook, where the result is available:
  `set_keyframe {capture:true}` is rewritten to explicit values (the captured
  pose depends on the performer's wall-clock playhead), `project_paint`
  carries an env.camera envelope (its texels depend on the live camera).
- The app may not be running: events buffer locally (bounded like the hub's
  ring) and flush when discovery succeeds; if the app appears mid-session the
  full backlog goes first, so replay-from-zero still works.

Checkpoints (backlog: replay-from-checkpoint — the x-wing v3 finding: 588
events, a 20-minute simplify and a refine campaign made replay-from-zero
freeze the observer's tab; re-execution cannot be made fast enough, so we
snapshot state):
- exec_ms: the hook patches `window.mv.execute` (the ONE facade every MCP
  dispatch path funnels through) and attaches the measured engine time to
  every published command event — the frontend's progress/ETA signal.
- Capture triggers ARM on: a single command >= 2 s (the monster rule — no
  replay segment should hide a monster in its middle), >= 15 s cumulative
  engine time since the last capture, or >= 40 mutating commands (floor).
  An armed trigger only FIRES when the overhead budget allows: capture cost
  is measured and captures spend a budget that accrues as a fraction (8%) of
  engine time, so checkpoint frequency self-tunes to the actual capture cost
  (a fixed 15 s interval alone would blow the <10% overhead cap on heavy
  sessions: 63 min of engine time / 15 s ~ 250 captures). The budget is
  SEEDED with one capture so short sessions still get their first (most
  valuable) checkpoint; session end always captures when state changed.
- Captures run IN THE PAGE while the patched execute gate is held: no command
  can interleave a capture, so a snapshot is never torn (JS async capture +
  concurrent evaluate would otherwise race).
- Snapshot content: ONE GLB PER OBJECT (wrapper placement neutralized during
  export) + an identity manifest {id, name, logical TRS, pivot, parent,
  visibility, opacity, modelScale, geometryRev, morph weights} plus
  nextObjectId/activeObjectId, display+lighting state and the timeline.
  A single whole-scene GLB is NOT enough: export flattens all objects into
  one and re-import assigns fresh ids — every post-checkpoint command that
  references an object id would miss. Per-object blobs + the manifest let a
  restorer rebuild the registry with the PERFORMER's ids, which is what makes
  post-checkpoint replay correct (proven in tests/e2e/test_observe_checkpoints.py).
- The payload is staged in the page (bounded) and a small `checkpoint_ready`
  control item rides the SAME ordered queue as events; the drain pulls the
  payload, zips it (stdlib, ZIP_STORED — GLB textures are already compressed)
  and POSTs it to /api/observe/checkpoint. Ordering guarantees the hub can
  anchor the checkpoint to the last appended event's seq. Failures degrade to
  a lifecycle `checkpoint_skipped` note — checkpoints are an accelerator,
  never a correctness dependency.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import time
import urllib.parse
import urllib.request
import zipfile
from typing import Callable, Optional

from backend.agent_bridge import discover_app_session

BUFFER_MAX = 20000              # mirror the hub ring: keep replay-from-zero possible
DISCOVERY_RETRY_S = 5.0
POST_TIMEOUT_S = 5.0
POST_RETRIES = 3

# Checkpoint upload bounds (mirror backend/observe_hub.py — the publisher
# pre-checks so a pathological scene never even ships just to be refused).
CHECKPOINT_MAX_BYTES = 64 * 1024 * 1024
CHECKPOINT_POST_TIMEOUT_S = 60.0
FINAL_CAPTURE_TIMEOUT_S = 120.0
CLOSE_FLUSH_TIMEOUT_S = 90.0

# Installed once per page: subscribes to top-level mutating command events,
# patches the mv.execute facade to measure per-command engine time (exec_ms)
# and to run atomic state checkpoints, samples the camera at ~5 Hz (deduped),
# emits a fingerprint every 50 commands and a lifecycle ping every 10 s.
# All events flow through the exposed __mvObservePublish binding; ordering is
# the page's dispatch order. window.__mvObserveConfig (read once, BEFORE
# install) overrides the checkpoint tunables — calibration and tests only.
HOOK_JS = """
() => {
    if (window.__mvObserveHooked) return true;
    if (!window.mv || !window.mv.on || !window.mv.execute) return false;
    window.__mvObserveHooked = true;

    const cfgIn = window.__mvObserveConfig || {};
    const CFG = {
        cumMs: cfgIn.cumMs !== undefined ? cfgIn.cumMs : 15000,
        monsterMs: cfgIn.monsterMs !== undefined ? cfgIn.monsterMs : 2000,
        everyCmds: cfgIn.everyCmds !== undefined ? cfgIn.everyCmds : 40,
        // Overhead governor: captures spend a budget accrued as a fraction of
        // measured engine time, so checkpoint frequency adapts to the real
        // capture cost instead of hardcoding an interval.
        accrualRate: cfgIn.accrualRate !== undefined ? cfgIn.accrualRate : 0.08,
        expectedCaptureMs: cfgIn.expectedCaptureMs !== undefined ? cfgIn.expectedCaptureMs : 1500,
    };

    let published = 0;      // events sent (mirrors the publisher's client_seq)
    let cmdCount = 0;       // published mutating commands (fingerprint cadence)
    let execTotalMs = 0;    // cumulative mutating engine ms this session
    let cumMs = 0;          // engine ms since the last capture
    let cmdsSince = 0;      // commands since the last capture
    let mutationsSince = 0; // debounce: never snapshot an unchanged scene
    // Seeded budget: the FIRST checkpoint is the most valuable one (it makes
    // the session joinable-from-state at all) — pay for it up front, then
    // self-calibrate from measured cost.
    let budgetMs = CFG.expectedCaptureMs;
    let expectedMs = CFG.expectedCaptureMs;
    let ckToken = 0;

    const send = (event) => {
        try { window.__mvObservePublish(event); published++; } catch (e) { /* relay gone */ }
    };

    const fingerprint = () => {
        try {
            const v = window.mv.viewer;
            const objs = v._objects || [];
            let vertices = 0, triangles = 0;
            for (const e of objs) {
                if (e.stats) { vertices += e.stats.vertices || 0; triangles += e.stats.faces || 0; }
            }
            const active = v._activeEntry && v._activeEntry();
            return { objectCount: objs.length,
                     activeObjectId: active ? active.id : null,
                     vertices, triangles };
        } catch (e) { return null; }
    };

    // ---- command event construction (canonicalization as before) ----------
    const buildCommandEvent = (e) => {
        let params = e.params || {};
        const env = {};
        try {
            if (e.action === "project_paint") {
                // Camera-dependent mutation: replay must pin the camera.
                env.camera = window.mv.getState().camera;
            }
            if (e.action === "set_keyframe" && params.capture) {
                // Canonicalize: the captured pose depends on the local
                // playhead — replace capture with the values actually keyed.
                const v = window.mv.viewer;
                const id = params.id;
                const entry = v._entryById ? v._entryById(id) : null;
                if (entry && entry.logical) {
                    const chans = params.channels;
                    const p2 = { id, time: params.time };
                    if (params.easing) p2.easing = params.easing;
                    if (params.morphs) p2.morphs = params.morphs;
                    const want = (c) => !chans || chans.includes(c);
                    if (want("position")) p2.position = entry.logical.p.toArray();
                    if (want("rotation")) p2.quaternion = entry.logical.q.toArray();
                    if (want("scale")) p2.scale = entry.logical.s.toArray();
                    params = p2;
                }
            }
        } catch (err) { /* canonicalization is best-effort */ }
        return { kind: "command",
                 command: { action: e.action, params,
                            ...(env.camera ? { env } : {}) } };
    };

    // ---- checkpoint capture: per-object GLBs + identity manifest ----------
    const b64 = (buffer) => {
        const bytes = new Uint8Array(buffer);
        let out = "";
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return btoa(out);
    };

    const captureScene = async () => {
        const v = window.mv.viewer;
        const st = window.mv.getState();
        const entries = (v._objects || []).slice().sort((a, b) => a.id - b.id);
        for (const e of entries) e.wrapper.updateMatrixWorld(true);

        // Timeline via the ORIGINAL execute: the patched facade is gated on
        // this very capture — calling it here would deadlock.
        let timeline = null;
        try {
            const tr = await origExec({ action: "get_timeline", params: {} });
            if (tr.ok && tr.result && tr.result.tracks && tr.result.tracks.length) {
                timeline = tr.result;
            }
        } catch (e) { /* no timeline — fine */ }

        const roster = new Map();
        for (const o of (st.scene.objects || [])) roster.set(o.id, o);

        const objects = [];
        const blobs = [];
        for (const e of entries) {
            const info = roster.get(e.id) || {};
            // Pivot in WRAPPER-LOCAL coords (exact restore: assign directly
            // BEFORE set_object_transform so the placement composes about it
            // — set_pivot-after-transform would keep the pivot-less composed
            // matrix and diverge). pivotWorld is a convenience mirror.
            const hasPivot = e.pivot && e.pivot.lengthSq() > 0;
            const pivot = hasPivot ? e.pivot.toArray() : null;
            const pivotWorld = hasPivot
                ? e.wrapper.localToWorld(e.pivot.clone()).toArray() : null;
            const o = {
                id: e.id,
                name: e.name,
                visible: e.visible,
                opacity: e.opacity,
                skinned: !!e.skinned,
                modelScale: e.modelScale || 1,
                geometryRev: e.geometryRev || 0,
                parentId: e.parentId != null ? e.parentId : null,
                pivot,
                pivotWorld,
                position: e.logical.p.toArray(),
                quaternion: e.logical.q.toArray(),
                scale: e.logical.s.toArray(),
                morphs: info.morphs || {},
                blob: "obj_" + e.id + ".glb",
                bytes: 0,
            };
            const w = e.wrapper;
            const saved = {
                parent: w.parent,
                parentId: e.parentId,
                p: w.position.clone(), q: w.quaternion.clone(), s: w.scale.clone(),
                modelScale: e.model.scale.clone(),
                visibles: entries.map((x) => x.visible),
            };
            try {
                // Neutralize the wrapper (re-root to the scene with identity
                // TRS) so the blob carries geometry in OBJECT-LOCAL space —
                // placement lives in the manifest and is re-applied through
                // set_object_transform, exactly like the performer's state.
                // Baking placement into the blob would double-apply it after
                // any post-checkpoint absolute transform.
                v._scene.add(w);
                // Detach the articulation edge for the export: effective
                // visibility walks parentId, and the hidden parent would
                // otherwise hide the target too (empty blob for every
                // parented object).
                e.parentId = null;
                w.position.set(0, 0, 0);
                w.quaternion.set(0, 0, 0, 1);
                w.scale.set(1, 1, 1);
                // Divide out the TRACKED model scale (set_scale overwrites the
                // root scale, so tracked == root unless the loader authored
                // one) — restore re-applies it via set_scale, keeping absolute
                // post-checkpoint set_scale commands correct.
                const ms = e.modelScale || 1;
                e.model.scale.set(saved.modelScale.x / ms,
                                  saved.modelScale.y / ms,
                                  saved.modelScale.z / ms);
                w.updateMatrixWorld(true);
                // Isolate: exportAsGLB exports the VISIBLE entries.
                for (const x of entries) x.visible = (x === e);
                const buf = await v.exportAsGLB({ animation: false });
                if (buf) {
                    o.bytes = buf.byteLength;
                    blobs.push({ id: e.id, b64: b64(buf) });
                } else {
                    o.empty = true;   // no exportable mesh — restore best-effort
                }
            } finally {
                for (let i = 0; i < entries.length; i++) entries[i].visible = saved.visibles[i];
                e.parentId = saved.parentId;
                saved.parent.add(w);
                w.position.copy(saved.p);
                w.quaternion.copy(saved.q);
                w.scale.copy(saved.s);
                e.model.scale.copy(saved.modelScale);
                w.updateMatrixWorld(true);
            }
            objects.push(o);
        }
        if (v.invalidate) v.invalidate();

        return {
            token: ++ckToken,
            manifest: {
                v: 1,
                // Identity survives via the manifest; each object's SUBTREE is
                // flattened by GLB export (named meshes, composed matrices).
                restore_mode: "per_object_flattened",
                nextObjectId: v._nextObjectId,
                activeObjectId: v._activeObjectId,
                objects,
                display: st.display || {},
                lighting: v.getLightSettings ? v.getLightSettings() : {},
                timeline,
                fingerprint: fingerprint(),
                commands_published: cmdCount,
                captured_at: Date.now() / 1000,
            },
            blobs,
        };
    };

    // ---- exec timing + trigger evaluation ---------------------------------
    let invocation = 0;
    let current = null;     // token of the in-flight patched call
    let pending = null;     // {token, ev} awaiting its exec_ms
    let capturing = false;
    let captureChain = Promise.resolve();

    const startCapture = (reason, isFinal) => {
        capturing = true;
        captureChain = (async () => {
            const t0 = performance.now();
            let payload = null;
            try {
                payload = await captureScene();
            } catch (err) {
                send({ kind: "lifecycle", lifecycle: "checkpoint_skipped",
                       note: { reason: "capture_error",
                               error: String((err && err.message) || err) } });
            }
            const cost = performance.now() - t0;
            budgetMs = Math.max(0, budgetMs - cost);
            expectedMs = 0.5 * expectedMs + 0.5 * cost;   // EMA self-calibration
            cumMs = 0;
            cmdsSince = 0;
            if (payload) {
                mutationsSince = 0;
                payload.manifest.capture_ms = Math.round(cost);
                payload.manifest.reason = reason;
                payload.manifest.final = !!isFinal;
                payload.manifest.exec_ms_since_start = Math.round(execTotalMs);
                const q = (window.__mvObserveCheckpoints = window.__mvObserveCheckpoints || []);
                q.push(payload);
                while (q.length > 3) {
                    // Page-memory bound while the app is unreachable: drop the
                    // oldest staged payload (its ready marker will be answered
                    // with a skip note by the drain).
                    const dropped = q.shift();
                    send({ kind: "lifecycle", lifecycle: "checkpoint_skipped",
                           note: { reason: "backlog_overflow", token: dropped.token } });
                }
                send({ kind: "checkpoint_ready",
                       checkpoint: { token: payload.token, reason,
                                     final: !!isFinal,
                                     capture_ms: Math.round(cost),
                                     exec_ms_since_start: Math.round(execTotalMs),
                                     objects: payload.manifest.objects.length } });
            }
        })().finally(() => { capturing = false; });
        return captureChain;
    };

    const maybeCapture = (ms) => {
        if (capturing || mutationsSince === 0) return;
        const reason = (ms !== null && ms >= CFG.monsterMs) ? "monster"
            : cumMs >= CFG.cumMs ? "cumulative"
            : cmdsSince >= CFG.everyCmds ? "floor" : null;
        if (!reason) return;
        if (budgetMs < expectedMs) return;   // overhead governor (final bypasses)
        startCapture(reason, false);
    };

    const publishCommand = (ev, ms) => {
        if (ms !== null) {
            ev.exec_ms = Math.round(ms);
            execTotalMs += ms;
            cumMs += ms;
            budgetMs = Math.min(budgetMs + ms * CFG.accrualRate,
                                3 * Math.max(expectedMs, CFG.expectedCaptureMs));
        }
        cmdsSince++;
        send(ev);
        cmdCount++;
        if (cmdCount % 50 === 0) {
            const fp = fingerprint();
            if (fp) send({ kind: "fingerprint", fingerprint: fp });
        }
        maybeCapture(ms);
    };

    window.mv.on("executed", (e) => {
        if (!e.topLevel || !e.mutates) return;
        const ev = buildCommandEvent(e);
        mutationsSince++;
        if (current !== null) {
            // The facade wrapper owns this invocation: defer the publish so
            // exec_ms can be attached when it completes. Correlation is by
            // invocation token — correct for serialized dispatch (the MCP
            // runtime serializes tool calls); interleaved direct api.execute
            // callers would at worst misattribute a duration, never lose an
            // event.
            pending = { token: current, ev };
        } else {
            // Direct api.execute callers bypass the facade — publish
            // immediately, without timing (never lose the event).
            publishCommand(ev, null);
        }
    });

    // ONE patch on the mv.execute facade covers every MCP dispatch path
    // (viewer_execute, load_local, raw evaluate loops all call it).
    const origExec = window.mv.execute.bind(window.mv);
    window.__mvObserveOrigExecute = origExec;
    window.mv.execute = async (cmd) => {
        // ATOMICITY: captures are async (GLTFExporter) — a command running
        // mid-capture would tear the snapshot. Gate new commands behind the
        // capture chain.
        while (capturing) { await captureChain; }
        const token = ++invocation;
        current = token;
        const t0 = performance.now();
        try {
            return await origExec(cmd);
        } finally {
            const ms = performance.now() - t0;
            current = null;
            if (pending && pending.token === token) {
                const ev = pending.ev;
                pending = null;
                publishCommand(ev, ms);
            }
        }
    };

    // Session-end capture (called by the publisher's close()): capture only
    // when state changed since the last snapshot — the debounce that stops
    // back-to-back triggers from double-capturing the same state.
    window.__mvObserveFinalCapture = async () => {
        while (capturing) { await captureChain; }
        if (mutationsSince === 0) return null;
        await startCapture("final", true);
        const q = window.__mvObserveCheckpoints || [];
        return q.length ? q[q.length - 1].token : null;
    };

    // Camera telemetry (~5 Hz, deduped): agents also move the camera through
    // NON-command paths (screenshot views, capture_views, find_best_view) —
    // sampling is the only complete follow signal.
    let lastCam = "";
    setInterval(() => {
        try {
            const cam = window.mv.getState().camera;
            const key = JSON.stringify(cam);
            if (key !== lastCam) {
                lastCam = key;
                send({ kind: "camera", camera: cam });
            }
        } catch (e) { /* no state yet */ }
    }, 200);

    // Liveness ping (the hub's aliveness window keys off last_ts).
    setInterval(() => send({ kind: "lifecycle", lifecycle: "ping" }), 10000);
    return true;
}
"""

# Pull ONE staged checkpoint payload out of the page by token (consumes it).
_PULL_CHECKPOINT_JS = """
(token) => {
    const q = window.__mvObserveCheckpoints || [];
    const i = q.findIndex((c) => c.token === token);
    if (i < 0) return null;
    return q.splice(i, 1)[0];
}
"""


def pack_checkpoint_zip(payload: dict) -> bytes:
    """Bundle a page capture payload into the wire format: one ZIP with
    manifest.json + obj_<id>.glb members. ZIP_STORED — GLB payloads are
    dominated by already-compressed PNG textures; deflate would burn CPU on
    the performer for single-digit savings."""
    manifest = dict(payload.get("manifest") or {})
    blobs = payload.get("blobs") or []
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for b in blobs:
            zf.writestr(f"obj_{int(b['id'])}.glb", base64.b64decode(b["b64"]))
        zf.writestr("manifest.json", json.dumps(manifest))
    return buf.getvalue()


class ObservePublisher:
    """Ordered, retrying, non-blocking event pipe: page → app observe hub.

    `page_provider` (optional) returns the live Playwright page or None — the
    drain uses it to pull staged checkpoint payloads; without it, checkpoint
    ready markers degrade to skip notes (events still flow)."""

    def __init__(self, label: str = "mcp",
                 page_provider: Optional[Callable[[], object]] = None):
        self.session_id = f"mcp-{os.getpid()}-{int(time.time())}"
        self.session_meta = {
            "id": self.session_id,
            "origin": "mcp",
            "pid": os.getpid(),
            "started_at": time.time(),
            "label": label,
        }
        self._buffer: list[dict] = []
        self._client_seq = 0
        self._task: Optional[asyncio.Task] = None
        self._wakeup: Optional[asyncio.Event] = None
        self._session: Optional[dict] = None      # discovered app {url, token}
        self._ended = False
        self._page_provider = page_provider

    # -- page-facing (called via expose_function relay) ----------------------

    def enqueue(self, event: dict) -> None:
        """Stamp order + buffer (bounded); never blocks the page."""
        if self._ended:
            return
        event = dict(event)
        if event.get("kind") != "checkpoint_ready":
            # checkpoint_ready is a CONTROL item consumed by the drain (never
            # POSTed to /publish) — stamping it a client_seq would create a
            # false skip at the hub and mark the session lossy.
            event["client_seq"] = self._client_seq
            self._client_seq += 1
        event["ts"] = time.time()
        self._buffer.append(event)
        if len(self._buffer) > BUFFER_MAX:
            # Replay-from-zero is already lost for future observers; keep the
            # tail so LIVE observers stay correct.
            self._buffer.pop(0)
        if self._wakeup:
            self._wakeup.set()

    # -- lifecycle ------------------------------------------------------------

    def start(self) -> None:
        if self._task is None:
            self._wakeup = asyncio.Event()
            self._task = asyncio.create_task(self._drain())

    async def close(self) -> None:
        if self._ended:
            return
        # Final snapshot BEFORE sealing the queue: its ready marker must enter
        # the pipe. Guarded — a dead page must never block shutdown.
        page = self._get_page()
        if page is not None:
            try:
                await asyncio.wait_for(
                    page.evaluate("() => window.__mvObserveFinalCapture "
                                  "? window.__mvObserveFinalCapture() : null"),
                    timeout=FINAL_CAPTURE_TIMEOUT_S)
            except Exception:
                pass
        self._ended = True
        # Bounded flush: the final checkpoint may be tens of MB — give the
        # drain a real chance to ship it before the end lifecycle.
        deadline = time.monotonic() + CLOSE_FLUSH_TIMEOUT_S
        while self._buffer and self._task is not None and time.monotonic() < deadline:
            await asyncio.sleep(0.2)
        if self._session:
            try:
                await asyncio.to_thread(
                    self._post, {"session": self.session_meta,
                                 "kind": "lifecycle", "lifecycle": "end",
                                 "ts": time.time()})
            except Exception:
                pass
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    # -- worker ----------------------------------------------------------------

    async def _drain(self):
        while True:
            if not self._buffer:
                self._wakeup.clear()
                try:
                    await asyncio.wait_for(self._wakeup.wait(), timeout=DISCOVERY_RETRY_S)
                except asyncio.TimeoutError:
                    continue
            if self._session is None:
                try:
                    self._session = discover_app_session()
                except Exception:
                    self._session = None
                if self._session is None:
                    await asyncio.sleep(DISCOVERY_RETRY_S)
                    continue
            event = self._buffer[0]
            if event.get("kind") == "checkpoint_ready":
                # Control item: pull the staged payload, zip, POST. Success or
                # not, the pipe moves on — checkpoints accelerate replay, they
                # never dam the event stream.
                await self._ship_checkpoint(event)
                self._buffer.pop(0)
                continue
            body = {"session": self.session_meta, **event}
            ok = False
            for attempt in range(POST_RETRIES):
                try:
                    await asyncio.to_thread(self._post, body)
                    ok = True
                    break
                except Exception:
                    await asyncio.sleep(0.5 * (attempt + 1))
            if ok:
                self._buffer.pop(0)
            else:
                # The app went away — rediscover on the next loop; the event
                # stays queued (client_seq preserves order and loss honesty).
                self._session = None
                await asyncio.sleep(DISCOVERY_RETRY_S)

    # -- checkpoint shipping -----------------------------------------------------

    def _get_page(self):
        try:
            page = self._page_provider() if self._page_provider else None
            if page is not None and not page.is_closed():
                return page
        except Exception:
            pass
        return None

    def _note_skip(self, reason: str, token, detail: str = "") -> None:
        """Degrade honestly: the log records WHY a checkpoint is missing so
        the frontend can explain sparse checkpoints instead of guessing."""
        note = {"reason": reason, "token": token}
        if detail:
            note["detail"] = detail[:200]
        self.enqueue({"kind": "lifecycle", "lifecycle": "checkpoint_skipped",
                      "note": note})

    async def _ship_checkpoint(self, event: dict) -> None:
        info = event.get("checkpoint") or {}
        token = info.get("token")
        page = self._get_page()
        if page is None:
            self._note_skip("page_gone", token)
            return
        try:
            payload = await page.evaluate(_PULL_CHECKPOINT_JS, token)
        except Exception as e:
            self._note_skip("pull_failed", token, str(e))
            return
        if not payload:
            self._note_skip("payload_missing", token)
            return
        try:
            blob = pack_checkpoint_zip(payload)
        except Exception as e:
            self._note_skip("pack_failed", token, str(e))
            return
        if len(blob) > CHECKPOINT_MAX_BYTES:
            self._note_skip("too_large", token, f"{len(blob)} bytes")
            return
        for attempt in range(POST_RETRIES):
            try:
                out = await asyncio.to_thread(self._post_checkpoint, blob)
                if not out.get("ok"):
                    self._note_skip("hub_refused", token, str(out.get("error", "")))
                return
            except Exception:
                await asyncio.sleep(0.5 * (attempt + 1))
        self._note_skip("upload_failed", token)

    def _post_checkpoint(self, blob: bytes) -> dict:
        req = urllib.request.Request(
            self._session["url"] + "/api/observe/checkpoint?session="
            + urllib.parse.quote(self.session_id),
            data=blob,
            headers={"Content-Type": "application/zip",
                     "X-MeshVault-Token": self._session.get("token", "")},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=CHECKPOINT_POST_TIMEOUT_S) as resp:
            return json.loads(resp.read() or b"{}")

    def _post(self, body: dict) -> None:
        req = urllib.request.Request(
            self._session["url"] + "/api/observe/publish",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "X-MeshVault-Token": self._session.get("token", "")},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=POST_TIMEOUT_S) as resp:
            resp.read()
