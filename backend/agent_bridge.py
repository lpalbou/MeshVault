"""
Agent bridge — the shared-session channel between headless agents and the running app.

Why this exists: the MCP server (headless Chromium) and the browser app are separate
processes with separate state. When an agent inspects a model headless, a human
co-reviewing in the app cannot see what the agent sees. This module provides the two
halves of the bridge:

1. App side (server): an EventBroadcaster that fans messages out to every connected
   app tab over Server-Sent Events, plus the session file the app writes at launch so
   local agent processes can DISCOVER the running app (port + token) without any
   configuration.
2. Agent side (client): discover_app_session() + push_open_to_app(), used by the MCP
   `open_in_app` tool (and usable by any local script) to push a model + camera into
   the app.

Design notes:
- The session file (~/.meshvault/app_session.json, mode 0600) carries the session
  token. That is the same sensitivity as the launch banner that already prints the
  token to the terminal: readable only by the same OS user, who already has full
  control of the server. Env overrides (MESHVAULT_APP_URL / MESHVAULT_TOKEN) take
  precedence for remote/multi-instance setups.
- The broadcaster uses bounded per-client queues and drops messages for clients that
  stop draining (a wedged tab must not grow server memory without bound).
- This module deliberately imports NOTHING from FastAPI/Starlette so the agent-side
  helpers stay importable in processes that don't ship the web stack.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

# One well-known location so agents need zero configuration to find the app.
SESSION_DIR = Path.home() / ".meshvault"
SESSION_FILE = SESSION_DIR / "app_session.json"

# Model formats the viewer can load — single source of truth for the bridge's
# "open" contract (the MCP server and the /api/agent/open endpoint both use it).
SUPPORTED_MODEL_EXTENSIONS = {
    ".obj", ".fbx", ".gltf", ".glb", ".stl", ".ply", ".dae", ".3mf", ".usdz",
}

# A tab that stops reading for this many pending messages is considered wedged.
_CLIENT_QUEUE_SIZE = 32


# ---------------------------------------------------------------------------
# App side — session file lifecycle (written by backend.app at launch)
# ---------------------------------------------------------------------------

def write_session_file(url: str, token: str) -> None:
    """Record the running app's URL + token so local agents can discover it."""
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "url": url.rstrip("/"),
        "token": token,
        "pid": os.getpid(),
        "started_at": time.time(),
    }
    SESSION_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    # The file carries the session token — owner-only, like an ssh key.
    os.chmod(SESSION_FILE, 0o600)


def remove_session_file() -> None:
    """Remove the session file if it belongs to this process (best effort).

    The pid check keeps a newer app instance's file intact when an older instance
    shuts down after being superseded (last writer wins while running).
    """
    try:
        data = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
        if data.get("pid") == os.getpid():
            SESSION_FILE.unlink()
    except (OSError, ValueError):
        pass


# ---------------------------------------------------------------------------
# App side — SSE broadcaster
# ---------------------------------------------------------------------------

class EventBroadcaster:
    """Fan-out of agent events to every connected app tab (SSE clients).

    Single-process, single-event-loop by design (matches the app's uvicorn setup:
    one worker, no reload). subscribe/unsubscribe/publish are only called from
    coroutines running on that loop, so plain set/Queue operations are safe.
    """

    def __init__(self):
        self._clients: set[asyncio.Queue] = set()

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=_CLIENT_QUEUE_SIZE)
        self._clients.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._clients.discard(queue)

    def publish(self, message: dict) -> int:
        """Queue a message for every connected client; returns the delivery count.

        Clients whose queue is full are skipped (not disconnected): the SSE
        generator owns the connection lifecycle and will clean up on next write.
        """
        delivered = 0
        for queue in list(self._clients):
            try:
                queue.put_nowait(message)
                delivered += 1
            except asyncio.QueueFull:
                pass
        return delivered


def sse_format(message: dict) -> str:
    """Serialize a message as one SSE `data:` frame."""
    return f"data: {json.dumps(message)}\n\n"


class AppStateStore:
    """Last human-session state reported by app tabs (the REVERSE co-review bridge).

    open_in_app pushes agent → human; this store answers the opposite question —
    "what is the human looking at?" — so an agent can pick up the human's subject
    and continue headless. Tabs report {path, name, camera} on load and whenever
    the camera settles; the store keeps the most recent report (last writer wins,
    which matches the single-human co-review scenario the bridge exists for).
    """

    def __init__(self):
        self._state: Optional[dict] = None
        self._updated_at: Optional[float] = None

    def report(self, state: dict) -> None:
        self._state = state
        self._updated_at = time.time()

    def snapshot(self) -> Optional[dict]:
        """The last report plus its age, or None when no tab reported yet."""
        if self._state is None:
            return None
        return {**self._state,
                "age_seconds": round(time.time() - self._updated_at, 1)}


# ---------------------------------------------------------------------------
# Agent side — discovery + push (stdlib only; used by the MCP server and scripts)
# ---------------------------------------------------------------------------

class StaleSessionError(RuntimeError):
    """The session file points at a dead app process (unclean shutdown, e.g.
    SIGKILL, left it behind). The file has already been removed when this is
    raised — callers should tell the human to restart the app or use env vars."""

    def __init__(self, pid: int):
        super().__init__(f"stale session file (pid {pid} dead)")
        self.pid = pid


def _pid_alive(pid: int) -> bool:
    """Liveness probe for the session file's pid.

    POSIX only: `os.kill(pid, 0)` is a pure existence check there. On Windows it
    is NOT safe — os.kill implements non-CTRL signals via TerminateProcess, so a
    "probe" would kill the process. On non-POSIX we trust the file (worst case:
    the connection error surfaces the problem, as before).
    """
    if os.name != "posix":
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by another user — alive
    return True


def discover_app_session() -> Optional[dict]:
    """Locate a running MeshVault app: env overrides first, then the session file.

    Returns {"url", "token"} or None when neither source is available.

    Raises StaleSessionError when the file's publisher pid is dead (unclean
    shutdown — SIGKILL can't run cleanup). The stale file is removed so the next
    discovery is clean; the error message carries the dead pid so tools can say
    exactly what happened instead of chasing 404s on whatever answers that port.
    """
    env_url = os.environ.get("MESHVAULT_APP_URL", "").strip()
    env_token = os.environ.get("MESHVAULT_TOKEN", "").strip()
    if env_url:
        return {"url": env_url.rstrip("/"), "token": env_token}

    try:
        data = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    pid = data.get("pid")
    if isinstance(pid, int) and pid > 0 and not _pid_alive(pid):
        try:
            SESSION_FILE.unlink()
        except OSError:
            pass
        raise StaleSessionError(pid)

    url = str(data.get("url", "")).strip()
    if not url:
        return None
    return {"url": url.rstrip("/"), "token": str(data.get("token", ""))}


def push_open_to_app(
    session: dict,
    path: str,
    camera: Optional[dict] = None,
    source: str = "agent",
    timeout: float = 10.0,
) -> dict[str, Any]:
    """POST /api/agent/open on the running app. Returns the response JSON.

    Raises RuntimeError with an actionable message on connection/auth failures so
    tool callers can relay it verbatim to the agent.
    """
    body = json.dumps({"path": path, "camera": camera, "source": source}).encode("utf-8")
    req = urllib.request.Request(
        session["url"] + "/api/agent/open",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-MeshVault-Token": session.get("token", ""),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8")).get("detail", "")
        except Exception:
            pass
        if e.code == 401:
            raise RuntimeError(
                "MeshVault app rejected the token (401). The session file may be "
                "stale — restart the app (`meshvault`) or set MESHVAULT_APP_URL/"
                "MESHVAULT_TOKEN.") from e
        if e.code == 404 and detail == "Not Found":
            # FastAPI's unmatched-route 404 uses exactly "Not Found"; our handler's
            # 404s carry specific messages ("Not found: <path>"). So this response
            # means whatever answers the port doesn't HAVE the agent bridge —
            # typically an older MeshVault build still running across an upgrade.
            raise RuntimeError(
                f"The server at {session['url']} has no /api/agent/open endpoint — "
                "it looks like an older MeshVault (< 0.4) still running. Restart it "
                "to pick up the agent bridge.") from e
        raise RuntimeError(f"MeshVault app returned {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Could not reach the MeshVault app at {session['url']} ({e.reason}). "
            "Is it running? Start it with `meshvault`.") from e


def fetch_app_state(session: dict, timeout: float = 10.0) -> dict[str, Any]:
    """GET /api/agent/state on the running app (the reverse bridge read).

    Returns the response JSON; raises RuntimeError with an actionable message on
    connection/auth failures (same contract as push_open_to_app).
    """
    req = urllib.request.Request(
        session["url"] + "/api/agent/state",
        headers={"X-MeshVault-Token": session.get("token", "")},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise RuntimeError(
                "MeshVault app rejected the token (401). The session file may be "
                "stale — restart the app (`meshvault`) or set MESHVAULT_APP_URL/"
                "MESHVAULT_TOKEN.") from e
        if e.code == 404:
            raise RuntimeError(
                f"The server at {session['url']} has no /api/agent/state endpoint — "
                "it looks like an older MeshVault still running. Restart it.") from e
        raise RuntimeError(f"MeshVault app returned {e.code}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Could not reach the MeshVault app at {session['url']} ({e.reason}). "
            "Is it running? Start it with `meshvault`.") from e
