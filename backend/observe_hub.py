"""
Observation-seat hub — per-performer command logs + cursor-based SSE fan-out.

The observation seat lets a browser tab WATCH a performer session (an MCP
agent driving its own headless viewer) live: the performer publishes every
executed MUTATING command; observers replay the log through their own
deterministic viewer, so they see the same scene natively rendered, plus tool
telemetry (ghost brushes) derived from the command parameters.

Design rules (from the adversarial design review — each replaces a naive
choice that silently corrupts replicas):

- NOT the agent-bridge EventBroadcaster: that broadcaster deliberately drops
  messages for slow clients (fine for open_asset hints, catastrophic for
  replication — one dropped sculpt slice is permanent divergence). Here each
  session keeps a bounded RING LOG and every observer reads it through its own
  CURSOR: nothing is dropped, a slow observer only delays itself, and a cursor
  overrun (the ring overwrote unread entries) surfaces as an honest "desynced"
  event instead of silence.
- Server-assigned contiguous `seq` + performer `client_seq`: a lost publish
  never creates a server-side gap (the event never arrived), so the hub
  watches client_seq for skips and marks the session LOSSY — observers show a
  divergence banner instead of lying.
- Replay-from-zero is the ONLY join mode: object ids are assigned by a counter
  replayed from a fresh scene; mid-flight checkpoints cannot preserve them
  (GLB snapshots re-import with new ids; manifests drop paint/morphs by
  design). Once the ring overwrites entry 0 the session becomes unjoinable for
  NEW observers (existing ones already hold the state).
"""

from __future__ import annotations

import asyncio
import time
from typing import Optional

# Ring bounds: sculpt-heavy sessions run ~600 commands/min; 20k entries is a
# long session. The byte bound guards against pathological params.
RING_MAX_ENTRIES = 20000
RING_MAX_BYTES = 64 * 1024 * 1024
PUBLISH_MAX_BYTES = 256 * 1024
SESSION_PING_TIMEOUT_S = 20.0


class ObserveSession:
    """One performer's ordered log + live subscriber wakeup."""

    def __init__(self, meta: dict):
        self.meta = dict(meta)                 # {id, origin, pid, started_at, label}
        self.entries: list[dict] = []          # ring: seq-stamped published events
        self.first_seq = 0                     # seq of entries[0] (ring dropped below)
        self.next_seq = 0
        self.bytes = 0
        self.lossy = False
        self.ended = False
        self.last_ts = time.time()
        self.last_client_seq: Optional[int] = None
        self.model_label: Optional[str] = None
        self._wakeup: set[asyncio.Event] = set()

    @property
    def stale(self) -> bool:
        """Performer stopped pinging without saying goodbye (killed process)."""
        return not self.ended and (time.time() - self.last_ts) > SESSION_PING_TIMEOUT_S * 3

    @property
    def joinable(self) -> bool:
        # LIVE joining: a session whose performer stopped pinging is a corpse —
        # joining it live would replay a prefix then hang forever. Honesty: no.
        return self.first_seq == 0 and not self.ended and not self.stale

    @property
    def replayable(self) -> bool:
        # PAST sessions (ended cleanly or performer died) can be REPLAYED as a
        # recording whenever the log is complete from seq 0. The stream ends
        # with an explicit meta instead of hanging.
        return self.first_seq == 0 and (self.ended or self.stale)

    def append(self, event: dict, size: int) -> int:
        seq = self.next_seq
        event["seq"] = seq
        self.next_seq += 1
        self.entries.append(event)
        self.bytes += size
        self.last_ts = time.time()
        while (len(self.entries) > RING_MAX_ENTRIES
               or self.bytes > RING_MAX_BYTES):
            dropped = self.entries.pop(0)
            self.bytes -= dropped.get("_size", 0)
            self.first_seq += 1
        event["_size"] = size
        for ev in list(self._wakeup):
            ev.set()
        return seq

    def wake_all(self):
        for ev in list(self._wakeup):
            ev.set()


class ObserveHub:
    """All performer sessions. Single event loop (matches the app's uvicorn)."""

    def __init__(self):
        self._sessions: dict[str, ObserveSession] = {}

    def publish(self, body: dict) -> dict:
        meta = body.get("session") or {}
        sid = str(meta.get("id") or "")
        if not sid:
            raise ValueError("session.id is required")
        s = self._sessions.get(sid)
        if s is None:
            s = ObserveSession(meta)
            self._sessions[sid] = s
            self._evict_ended()
        # Refresh label metadata (first publish may predate a model load).
        if meta.get("label"):
            s.meta["label"] = meta["label"]

        kind = body.get("kind")
        if kind == "lifecycle" and body.get("lifecycle") == "end":
            s.ended = True
            s.last_ts = time.time()
            s.wake_all()
            return {"ok": True, "seq": s.next_seq - 1, "lossy": s.lossy}

        # client_seq skip detection: a lost publish never reaches the server,
        # so contiguity of the PERFORMER's counter is the only truth signal.
        cs = body.get("client_seq")
        if isinstance(cs, int):
            if s.last_client_seq is not None and cs != s.last_client_seq + 1:
                s.lossy = True
            s.last_client_seq = cs

        if kind == "command":
            cmd = body.get("command") or {}
            if cmd.get("action") in ("load", "add_model", "add_primitive"):
                name = ((cmd.get("params") or {}).get("name")
                        or (cmd.get("params") or {}).get("kind"))
                if name:
                    s.model_label = str(name)[:64]

        event = {k: body[k] for k in
                 ("kind", "ts", "client_seq", "command", "camera", "fingerprint",
                  "lifecycle") if k in body}
        if s.lossy:
            event["lossy"] = True
        size = len(str(event))
        seq = s.append(event, size)
        return {"ok": True, "seq": seq, "lossy": s.lossy}

    def _evict_ended(self, keep: int = 8) -> None:
        """Bound long-running apps: dead sessions beyond `keep` are dropped
        (oldest first). Live sessions are never evicted. keep was 3 when dead
        rows buried the joinable session; now that the panel collapses
        non-replayable rows AND recordings are deletable from the UI, keep=8
        lets several parallel builders' recordings coexist (field: three
        concurrent fusion builds evicted each other's replays at keep=3)."""
        ended = sorted((s for s in self._sessions.values() if s.ended),
                       key=lambda s: s.last_ts)
        for s in ended[:-keep] if len(ended) > keep else []:
            self._sessions.pop(s.meta.get("id"), None)

    def sessions(self) -> list[dict]:
        now = time.time()
        out = []
        for s in self._sessions.values():
            out.append({
                "id": s.meta.get("id"),
                "origin": s.meta.get("origin", "mcp"),
                "label": s.meta.get("label") or s.model_label,
                "model": s.model_label,
                "started_at": s.meta.get("started_at"),
                "age_seconds": round(now - (s.meta.get("started_at") or now), 1),
                "last_ts": s.last_ts,
                "commands": s.next_seq,
                "joinable": s.joinable,
                "replayable": s.replayable,
                "lossy": s.lossy,
                "alive": not s.ended and (now - s.last_ts) < SESSION_PING_TIMEOUT_S * 3,
                # Live stream generators = seated observers. Lets a performer
                # WAIT for its audience instead of guessing (live-demo need).
                "observers": len(s._wakeup),
            })
        # Watchable sessions FIRST (alive+joinable, newest activity on top),
        # replayable recordings after, dead-unreplayable last — the list must
        # never bury the live show.
        out.sort(key=lambda r: (not (r["joinable"] and r["alive"]),
                                not r["replayable"], -(r["last_ts"] or 0)))
        return out

    def get(self, sid: str) -> Optional[ObserveSession]:
        return self._sessions.get(sid)

    def delete(self, sid: str) -> dict:
        """Delete ONE past session (field request: broken/flooded recordings
        cluttered the list and some could not even be opened). LIVE sessions
        refuse — end the performer first; deleting under an active stream
        would silently strand its observers."""
        s = self._sessions.get(sid)
        if s is None:
            return {"ok": False, "error": "unknown session"}
        if not s.ended and not s.stale:
            return {"ok": False, "error": "session is LIVE — end the performer "
                                          "first (deleting would strand observers)"}
        # Wake any replaying observers so their streams terminate honestly.
        for ev in list(s._wakeup):
            ev.set()
        self._sessions.pop(sid, None)
        return {"ok": True, "deleted": sid}

    def delete_past(self) -> dict:
        """Delete EVERY past (ended or performer-lost) session in one sweep."""
        gone = []
        for sid, s in list(self._sessions.items()):
            if s.ended or s.stale:
                for ev in list(s._wakeup):
                    ev.set()
                self._sessions.pop(sid, None)
                gone.append(sid)
        return {"ok": True, "deleted": gone, "count": len(gone)}

    async def stream(self, sid: str):
        """Async generator: replay-from-zero, then live — ONE server-side
        sequence under one cursor (no client-side stitching, no seq-gap race).
        Past sessions (ended or performer-dead) stream as RECORDINGS: full
        log, then an explicit terminal meta — never a hang.
        Yields dict events ready for SSE serialization."""
        s = self._sessions.get(sid)
        if s is None:
            yield {"type": "meta", "event": "unknown_session"}
            return
        if not (s.joinable or s.replayable):
            yield {"type": "meta", "event": "unjoinable",
                   "reason": "log overwritten (session outgrew the ring) — "
                             "replay-from-zero is impossible; watch the next "
                             "session from its start"}
            return
        yield {"type": "hello", "session": self.sessions_one(sid),
               "joinable": s.joinable, "recording": not s.joinable}
        cursor = 0
        caught_up = False
        wakeup = asyncio.Event()
        s._wakeup.add(wakeup)
        try:
            while True:
                # Cursor overrun = the ring dropped unread entries: desync.
                if cursor < s.first_seq:
                    yield {"type": "meta", "event": "desynced",
                           "reason": "observer fell behind the ring buffer"}
                    return
                while cursor < s.next_seq:
                    entry = s.entries[cursor - s.first_seq]
                    out = {k: v for k, v in entry.items() if k != "_size"}
                    out["type"] = "entry"
                    yield out
                    cursor += 1
                if not caught_up:
                    caught_up = True
                    yield {"type": "caught_up", "seq": cursor - 1}
                if s.ended:
                    yield {"type": "meta", "event": "ended"}
                    return
                if s.stale:
                    yield {"type": "meta", "event": "performer_lost",
                           "reason": "the performer stopped publishing without "
                                     "ending the session — recording ends here"}
                    return
                wakeup.clear()
                try:
                    await asyncio.wait_for(wakeup.wait(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield {"type": "heartbeat"}
        finally:
            s._wakeup.discard(wakeup)

    def sessions_one(self, sid: str) -> Optional[dict]:
        for row in self.sessions():
            if row["id"] == sid:
                return row
        return None
