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
- Joining used to be replay-from-zero ONLY (object ids are assigned by a
  counter replayed from a fresh scene). CHECKPOINTS changed that: the
  publisher ships per-object GLB blobs + an identity manifest (ids, names,
  placements, nextObjectId) zipped per checkpoint, anchored to the seq of the
  last appended event (the upload rides the performer's ORDERED pipe, so
  arrival order is anchor truth). An observer restores a checkpoint and
  streams `from=seq+1` — replay-from-zero remains for sessions without
  checkpoints, and a full-from-zero log is no longer required to join when a
  checkpoint at/after first_seq exists.
- Checkpoint storage is BOUNDED three ways (checkpoints are an accelerator,
  never a memory liability): per-blob cap, per-session budget with
  evenly-spaced thinning (the newest and the final snapshot are always kept),
  and a global cross-session budget (8 retained sessions × 120 MB would
  otherwise let recordings pin ~1 GB of app RSS).
"""

from __future__ import annotations

import asyncio
import io
import json
import time
import zipfile
from typing import Optional

# Ring bounds: sculpt-heavy sessions run ~600 commands/min; 20k entries is a
# long session. The byte bound guards against pathological params.
RING_MAX_ENTRIES = 20000
RING_MAX_BYTES = 64 * 1024 * 1024
PUBLISH_MAX_BYTES = 256 * 1024
SESSION_PING_TIMEOUT_S = 20.0

# Checkpoint bounds. Per-blob: a snapshot weighs about as much as the scene
# it saves (measured: 217k tris ≈ 13.6 MB) — the motivating x-wing session
# peaked at 1.48M tris ≈ ~45 MB, so a 25 MB cap would refuse checkpoints on
# exactly the sessions that need them; 64 MB covers heavy scenes with margin.
# Per-session and global budgets bound app RSS: several retained recordings
# must not pin gigabytes in a long-running process.
CHECKPOINT_KEEP = 8
CHECKPOINT_MAX_BYTES = 64 * 1024 * 1024
CHECKPOINT_SESSION_BYTES = 256 * 1024 * 1024
CHECKPOINT_GLOBAL_BYTES = 512 * 1024 * 1024

# Public listing/marker fields of a stored checkpoint (zip + manifest stay
# server-side; the manifest is fetched through /api/observe/checkpoint).
_CHECKPOINT_PUBLIC_KEYS = ("seq", "bytes", "ts", "exec_ms_since_start",
                           "objects", "final", "reason", "capture_ms")


def parse_checkpoint_manifest(zip_bytes: bytes) -> dict:
    """Validate a checkpoint upload and return its manifest.

    The wire format is owned here (mirrored by the publisher's
    pack_checkpoint_zip): a ZIP with manifest.json + obj_<id>.glb members.
    Raises ValueError on anything malformed — the endpoint turns it into 422.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            manifest = json.loads(zf.read("manifest.json"))
    except (KeyError, OSError, zipfile.BadZipFile) as e:
        raise ValueError(f"not a checkpoint zip: {e}")
    except ValueError as e:
        raise ValueError(f"manifest.json is not valid JSON: {e}")
    if not isinstance(manifest, dict) or not isinstance(manifest.get("objects"), list):
        raise ValueError("manifest must be an object with an objects list")
    return manifest


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
        # State checkpoints, ascending seq: {seq, ts, bytes, exec_ms_since_start,
        # objects, final, reason, capture_ms, zip, manifest}.
        self.checkpoints: list[dict] = []
        self._wakeup: set[asyncio.Event] = set()

    @property
    def checkpoint_bytes(self) -> int:
        return sum(c["bytes"] for c in self.checkpoints)

    def public_checkpoints(self) -> list[dict]:
        return [{k: c.get(k) for k in _CHECKPOINT_PUBLIC_KEYS}
                for c in self.checkpoints]

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
                  "lifecycle", "exec_ms", "note") if k in body}
        if s.lossy:
            event["lossy"] = True
        size = len(str(event))
        seq = s.append(event, size)
        return {"ok": True, "seq": seq, "lossy": s.lossy}

    # -- checkpoints -----------------------------------------------------------

    def add_checkpoint(self, sid: str, zip_bytes: bytes, manifest: dict) -> dict:
        """Store one state checkpoint for a session.

        Anchor: the seq of the LAST APPENDED event. The publisher ships the
        checkpoint through the same ordered pipe as events, so at arrival the
        newest appended event IS the command the snapshot was taken after —
        no client/server seq mapping table needed.
        """
        s = self._sessions.get(sid)
        if s is None:
            return {"ok": False, "error": "unknown session — publish an event first"}
        if s.next_seq == 0:
            return {"ok": False, "error": "no events yet — a checkpoint needs an anchor"}
        size = len(zip_bytes)
        if size > CHECKPOINT_MAX_BYTES:
            return {"ok": False,
                    "error": f"checkpoint exceeds {CHECKPOINT_MAX_BYTES} bytes"}
        seq = s.next_seq - 1
        if s.checkpoints and s.checkpoints[-1]["seq"] == seq:
            # Same-anchor duplicate (e.g. trigger + immediate session end with
            # no state change in between should not happen — the publisher
            # debounces — but a retried POST can). Final wins: replace.
            if manifest.get("final"):
                s.checkpoints.pop()
            else:
                return {"ok": False, "error": f"checkpoint already anchored at seq {seq}"}
        # Per-session budget: evict oldest non-final until the new one fits.
        while (s.checkpoint_bytes + size > CHECKPOINT_SESSION_BYTES
               and any(not c.get("final") for c in s.checkpoints)):
            idx = next(i for i, c in enumerate(s.checkpoints) if not c.get("final"))
            s.checkpoints.pop(idx)
        if s.checkpoint_bytes + size > CHECKPOINT_SESSION_BYTES:
            return {"ok": False, "error": "session checkpoint budget exhausted"}
        record = {
            "seq": seq,
            "ts": time.time(),
            "bytes": size,
            "exec_ms_since_start": manifest.get("exec_ms_since_start"),
            "objects": len(manifest.get("objects") or []),
            "final": bool(manifest.get("final")),
            "reason": manifest.get("reason"),
            "capture_ms": manifest.get("capture_ms"),
            "zip": zip_bytes,
            "manifest": manifest,
        }
        s.checkpoints.append(record)
        self._thin_checkpoints(s)
        self._enforce_global_checkpoint_budget(sid)
        # Live streamers get a marker (late if their cursor already passed seq).
        s.wake_all()
        return {"ok": True, "seq": seq, "kept": len(s.checkpoints)}

    def _thin_checkpoints(self, s: ObserveSession) -> None:
        """Over CHECKPOINT_KEEP: drop the interior snapshot whose removal
        loses the least coverage (smallest seq-gap to its predecessor). The
        NEWEST and any FINAL snapshot are always kept — joining live and
        replaying an ended session are the two hot paths."""
        cks = s.checkpoints
        while len(cks) > CHECKPOINT_KEEP:
            candidates = [i for i in range(len(cks) - 1) if not cks[i].get("final")]
            if not candidates:
                cks.pop(0)
                continue
            best = min(candidates,
                       key=lambda i: cks[i]["seq"] - (cks[i - 1]["seq"] if i else -1))
            cks.pop(best)

    def _enforce_global_checkpoint_budget(self, incoming_sid: str) -> None:
        """Cross-session RSS bound: shed the OLDEST-activity sessions'
        checkpoints first (their logs stay — they degrade to replay-from-zero
        when the log is complete). The just-added snapshot survives if at all
        possible (join-live is the hot path)."""
        total = sum(sess.checkpoint_bytes for sess in self._sessions.values())
        if total <= CHECKPOINT_GLOBAL_BYTES:
            return
        victims = sorted((sess for sess in self._sessions.values() if sess.checkpoints),
                         key=lambda sess: sess.last_ts)
        for sess in victims:
            while sess.checkpoints and total > CHECKPOINT_GLOBAL_BYTES:
                if (sess.meta.get("id") == incoming_sid
                        and len(sess.checkpoints) == 1):
                    break
                dropped = sess.checkpoints.pop(0)
                total -= dropped["bytes"]
            if total <= CHECKPOINT_GLOBAL_BYTES:
                return

    def get_checkpoint(self, sid: str, seq: int) -> Optional[dict]:
        s = self._sessions.get(sid)
        if s is None:
            return None
        return next((c for c in s.checkpoints if c["seq"] == seq), None)

    @staticmethod
    def checkpoint_object(record: dict, object_id: int) -> Optional[bytes]:
        """One object's GLB blob out of a stored checkpoint zip."""
        try:
            with zipfile.ZipFile(io.BytesIO(record["zip"])) as zf:
                return zf.read(f"obj_{int(object_id)}.glb")
        except (KeyError, ValueError, zipfile.BadZipFile):
            return None

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
                # Checkpoint metadata (blobs stay server-side): the client
                # picks the newest checkpoint <= its target and streams
                # from=seq+1. first_seq tells it which checkpoints are still
                # replayable-after (the ring may have dropped early events).
                "first_seq": s.first_seq,
                "checkpoints": s.public_checkpoints(),
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

    async def stream(self, sid: str, from_seq: int = 0):
        """Async generator: replay (from seq 0 or from a checkpoint boundary
        via `from_seq`), then live — ONE server-side sequence under one cursor
        (no client-side stitching, no seq-gap race). Past sessions (ended or
        performer-dead) stream as RECORDINGS: full log, then an explicit
        terminal meta — never a hang.

        Checkpoint MARKER events ({type:"checkpoint", seq, ...}) are yielded
        right after the entry they anchor to, so a streaming observer knows
        where it may fast-forward. Old clients ignore unknown types — the
        markers deliberately do NOT consume entry seq numbers (that would
        break every existing contiguity check). Checkpoints that arrive after
        the cursor already passed their anchor are emitted with late:true.

        Yields dict events ready for SSE serialization."""
        s = self._sessions.get(sid)
        if s is None:
            yield {"type": "meta", "event": "unknown_session"}
            return
        start = max(0, int(from_seq))
        if start > s.next_seq:
            yield {"type": "meta", "event": "unjoinable",
                   "reason": f"from={start} is beyond the log end "
                             f"(next seq is {s.next_seq})"}
            return
        if start < s.first_seq:
            # The ring dropped everything below first_seq. from=0 on a partial
            # log is the historical "unjoinable" case; with checkpoints the
            # honest advice is to join from one.
            yield {"type": "meta", "event": "unjoinable",
                   "first_seq": s.first_seq,
                   "checkpoints": s.public_checkpoints(),
                   "reason": f"events below seq {s.first_seq} were overwritten "
                             "(session outgrew the ring) — restore a checkpoint "
                             "and stream from=<checkpoint seq>+1, or watch the "
                             "next session from its start"}
            return
        yield {"type": "hello", "session": self.sessions_one(sid),
               "joinable": s.joinable, "recording": not s.joinable,
               "from": start}
        cursor = start
        # Markers below the start are the client's own knowledge (it chose
        # `from` off the checkpoint list) — never re-emit them.
        emitted_markers = {c["seq"] for c in s.checkpoints if c["seq"] < start}
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
                markers = {c["seq"]: c for c in s.checkpoints}
                while cursor < s.next_seq:
                    entry = s.entries[cursor - s.first_seq]
                    out = {k: v for k, v in entry.items() if k != "_size"}
                    out["type"] = "entry"
                    yield out
                    ck = markers.get(cursor)
                    if ck is not None and cursor not in emitted_markers:
                        emitted_markers.add(cursor)
                        yield {"type": "checkpoint",
                               **{k: ck.get(k) for k in _CHECKPOINT_PUBLIC_KEYS}}
                    cursor += 1
                # Late markers: a checkpoint POST lands after its anchor event
                # (ordered pipe) — a live observer has usually streamed past it.
                for ck in s.checkpoints:
                    if ck["seq"] < cursor and ck["seq"] not in emitted_markers:
                        emitted_markers.add(ck["seq"])
                        yield {"type": "checkpoint", "late": True,
                               **{k: ck.get(k) for k in _CHECKPOINT_PUBLIC_KEYS}}
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
