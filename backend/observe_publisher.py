"""
Observation-seat publisher — the MCP performer side.

Streams every executed MUTATING viewer command (plus camera telemetry,
fingerprints and lifecycle pings) from the headless viewer page to the running
app's observe hub, so browser tabs can WATCH the agent work live.

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
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.request
from typing import Optional

from backend.agent_bridge import discover_app_session

BUFFER_MAX = 20000              # mirror the hub ring: keep replay-from-zero possible
DISCOVERY_RETRY_S = 5.0
POST_TIMEOUT_S = 5.0
POST_RETRIES = 3

# Installed once per page: subscribes to top-level mutating command events,
# samples the camera at ~5 Hz (deduped), emits a fingerprint every 50 commands
# and a lifecycle ping every 10 s. All events flow through the exposed
# __mvObservePublish binding; ordering is the page's dispatch order.
HOOK_JS = """
() => {
    if (window.__mvObserveHooked) return true;
    if (!window.mv || !window.mv.on) return false;
    window.__mvObserveHooked = true;
    let published = 0;

    const send = (event) => {
        try { window.__mvObservePublish(event); } catch (e) { /* relay gone */ }
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

    window.mv.on("executed", (e) => {
        if (!e.topLevel || !e.mutates) return;
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
        send({ kind: "command",
               command: { action: e.action, params,
                          ...(env.camera ? { env } : {}) } });
        published++;
        if (published % 50 === 0) {
            const fp = fingerprint();
            if (fp) send({ kind: "fingerprint", fingerprint: fp });
        }
    });

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


class ObservePublisher:
    """Ordered, retrying, non-blocking event pipe: page → app observe hub."""

    def __init__(self, label: str = "mcp"):
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

    # -- page-facing (called via expose_function relay) ----------------------

    def enqueue(self, event: dict) -> None:
        """Stamp order + buffer (bounded); never blocks the page."""
        if self._ended:
            return
        event = dict(event)
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
        self._ended = True
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
