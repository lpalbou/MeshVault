"""
Tests for the agent bridge: /api/agent/open + /api/events endpoints, the
EventBroadcaster fan-out, and the session-file discovery used by MCP open_in_app.

The endpoint tests reuse the security-test pattern (temp root + known token via a
module reload) because the bridge MUST sit behind the same trust boundary as every
other /api route: an unauthenticated or unconfined "open" push would let any local
process steer the user's viewer to arbitrary files.
"""

import importlib
import json
import os

import pytest
from fastapi.testclient import TestClient

from backend import agent_bridge
from backend.agent_bridge import EventBroadcaster, discover_app_session, sse_format


@pytest.fixture()
def app_env(tmp_path, monkeypatch):
    """App confined to a temp root with a known token; returns (module, client, root)."""
    root = tmp_path / "root"
    root.mkdir()
    (root / "model.glb").write_bytes(b"glTF fake")
    (root / "notes.txt").write_text("not a model", encoding="utf-8")

    monkeypatch.setenv("MESHVAULT_ROOT", str(root))
    monkeypatch.setenv("MESHVAULT_TOKEN", "test-token-123")
    monkeypatch.delenv("MESHVAULT_NO_AUTH", raising=False)
    monkeypatch.delenv("MESHVAULT_HOST", raising=False)

    import backend.app as app_module
    importlib.reload(app_module)

    client = TestClient(app_module.app)
    client.headers.update({"X-MeshVault-Token": "test-token-123", "Host": "localhost"})
    return app_module, client, root


# ---------------------------------------------------------------------------
# /api/agent/open — auth + confinement + validation
# ---------------------------------------------------------------------------

def test_agent_open_requires_auth(app_env):
    app_module, _, root = app_env
    bare = TestClient(app_module.app)
    bare.headers.update({"Host": "localhost"})
    resp = bare.post("/api/agent/open", json={"path": str(root / "model.glb")})
    assert resp.status_code == 401


def test_agent_open_confined_to_root(app_env, tmp_path):
    _, client, _ = app_env
    outside = tmp_path / "outside.glb"
    outside.write_bytes(b"glTF fake")
    resp = client.post("/api/agent/open", json={"path": str(outside)})
    assert resp.status_code == 403


def test_agent_open_missing_file_is_404(app_env):
    _, client, root = app_env
    resp = client.post("/api/agent/open", json={"path": str(root / "nope.glb")})
    assert resp.status_code == 404


def test_agent_open_rejects_non_model_files(app_env):
    _, client, root = app_env
    resp = client.post("/api/agent/open", json={"path": str(root / "notes.txt")})
    assert resp.status_code == 422


def test_agent_open_valid_push_returns_deep_link(app_env):
    app_module, client, root = app_env
    resp = client.post("/api/agent/open", json={"path": str(root / "model.glb")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["clients"] == 0  # no SSE subscriber in this test
    assert "?path=" in body["deep_link"]
    # The deep link must round-trip through URL decoding to the confined path.
    from urllib.parse import unquote, urlparse, parse_qs
    q = parse_qs(urlparse(body["deep_link"]).query)
    assert q["path"][0] == str((root / "model.glb").resolve())


def test_agent_open_delivers_to_subscribers(app_env):
    app_module, client, root = app_env
    queue = app_module.event_broadcaster.subscribe()
    try:
        resp = client.post(
            "/api/agent/open",
            json={"path": str(root / "model.glb"),
                  "camera": {"position": [1, 2, 3], "target": [0, 0, 0], "fov": 50},
                  "source": "mcp"},
        )
        assert resp.status_code == 200
        assert resp.json()["clients"] == 1
        msg = queue.get_nowait()
        assert msg["type"] == "open_asset"
        assert msg["path"] == str((root / "model.glb").resolve())
        assert msg["camera"] == {"position": [1.0, 2.0, 3.0],
                                 "target": [0.0, 0.0, 0.0], "fov": 50.0}
        assert msg["source"] == "mcp"
    finally:
        app_module.event_broadcaster.unsubscribe(queue)


@pytest.mark.parametrize("camera", [
    {"position": "not-a-vector"},
    {"position": [1, 2]},
    {"position": [1, 2, "x"]},
    {"target": [0, 0, 0]},                        # position is required
    {"position": [0, 0, 5], "fov": 0},            # fov out of range
    {"position": [0, 0, 5], "fov": "wide"},
    "not-an-object",
])
def test_agent_open_rejects_malformed_camera(app_env, camera):
    _, client, root = app_env
    resp = client.post("/api/agent/open",
                       json={"path": str(root / "model.glb"), "camera": camera})
    assert resp.status_code == 422


def test_agent_open_camera_is_optional(app_env):
    _, client, root = app_env
    resp = client.post("/api/agent/open", json={"path": str(root / "model.glb")})
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# /api/events — auth + first frame
# ---------------------------------------------------------------------------

def test_events_requires_auth(app_env):
    app_module, _, _ = app_env
    bare = TestClient(app_module.app)
    bare.headers.update({"Host": "localhost"})
    with bare.stream("GET", "/api/events") as resp:
        assert resp.status_code == 401


def test_events_stream_delivers_push_real_server(app_env):
    """Full-stack SSE test against a REAL uvicorn server.

    TestClient deadlocks on infinite streaming responses behind BaseHTTPMiddleware
    (its portal never cancels the generator), so the streaming path must be tested
    against the real ASGI stack: subscribe over HTTP, publish via /api/agent/open,
    assert the frame arrives on the open stream.
    """
    import socket
    import threading
    import time

    import httpx
    import uvicorn

    app_module, _, root = app_env

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    server = uvicorn.Server(uvicorn.Config(
        app_module.app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    assert server.started, "uvicorn did not start"

    base = f"http://127.0.0.1:{port}"
    headers = {"X-MeshVault-Token": "test-token-123"}
    model = str((root / "model.glb").resolve())
    try:
        with httpx.Client(timeout=10) as http:
            with http.stream("GET", f"{base}/api/events", headers=headers) as resp:
                assert resp.status_code == 200
                assert resp.headers["content-type"].startswith("text/event-stream")
                lines = resp.iter_lines()

                first = next(l for l in lines if l.startswith("data:"))
                assert json.loads(first[5:].strip())["type"] == "connected"

                push = http.post(f"{base}/api/agent/open", headers=headers,
                                 json={"path": model,
                                       "camera": {"position": [0, 1, 5]}})
                assert push.status_code == 200
                assert push.json()["clients"] == 1

                frame = next(l for l in lines if l.startswith("data:"))
                msg = json.loads(frame[5:].strip())
                assert msg["type"] == "open_asset"
                assert msg["path"] == model
                assert msg["camera"]["position"] == [0.0, 1.0, 5.0]
    finally:
        server.should_exit = True
        thread.join(timeout=5)


# ---------------------------------------------------------------------------
# EventBroadcaster semantics
# ---------------------------------------------------------------------------

def test_broadcaster_fanout_and_unsubscribe():
    b = EventBroadcaster()
    q1, q2 = b.subscribe(), b.subscribe()
    assert b.publish({"type": "x"}) == 2
    assert q1.get_nowait() == {"type": "x"}
    assert q2.get_nowait() == {"type": "x"}
    b.unsubscribe(q1)
    assert b.publish({"type": "y"}) == 1
    assert b.client_count == 1


def test_broadcaster_drops_for_wedged_clients():
    b = EventBroadcaster()
    q = b.subscribe()
    delivered = 0
    for i in range(agent_bridge._CLIENT_QUEUE_SIZE + 5):
        delivered = b.publish({"i": i})
    # The final publishes found the queue full and dropped instead of blocking.
    assert delivered == 0
    assert q.qsize() == agent_bridge._CLIENT_QUEUE_SIZE


def test_sse_format():
    assert sse_format({"a": 1}) == 'data: {"a": 1}\n\n'


# ---------------------------------------------------------------------------
# Session file + discovery (the MCP side of the bridge)
# ---------------------------------------------------------------------------

@pytest.fixture()
def isolated_session_file(tmp_path, monkeypatch):
    """Point the module's session file at a temp location."""
    session_dir = tmp_path / ".meshvault"
    monkeypatch.setattr(agent_bridge, "SESSION_DIR", session_dir)
    monkeypatch.setattr(agent_bridge, "SESSION_FILE", session_dir / "app_session.json")
    monkeypatch.delenv("MESHVAULT_APP_URL", raising=False)
    monkeypatch.delenv("MESHVAULT_TOKEN", raising=False)
    return agent_bridge.SESSION_FILE


def test_session_file_roundtrip(isolated_session_file):
    agent_bridge.write_session_file("http://localhost:8420/", "tok-abc")
    assert isolated_session_file.exists()
    # Owner-only: the file carries the session token.
    assert (isolated_session_file.stat().st_mode & 0o777) == 0o600

    session = discover_app_session()
    assert session == {"url": "http://localhost:8420", "token": "tok-abc"}

    agent_bridge.remove_session_file()  # same pid — must remove
    assert not isolated_session_file.exists()


def test_remove_session_file_respects_other_pids(isolated_session_file):
    agent_bridge.write_session_file("http://localhost:8420", "tok")
    data = json.loads(isolated_session_file.read_text())
    data["pid"] = os.getpid() + 99999  # pretend a newer instance owns it
    isolated_session_file.write_text(json.dumps(data))
    agent_bridge.remove_session_file()
    assert isolated_session_file.exists()


def test_discover_prefers_env_override(isolated_session_file, monkeypatch):
    agent_bridge.write_session_file("http://localhost:8420", "file-token")
    monkeypatch.setenv("MESHVAULT_APP_URL", "http://otherhost:9999/")
    monkeypatch.setenv("MESHVAULT_TOKEN", "env-token")
    assert discover_app_session() == {"url": "http://otherhost:9999", "token": "env-token"}


def test_discover_returns_none_without_sources(isolated_session_file):
    assert discover_app_session() is None


def test_discover_detects_stale_pid_and_cleans_up(isolated_session_file):
    """An uncleanly killed app (SIGKILL) leaves its session file behind; discovery
    must pid-probe, report the dead pid, and remove the file (external finding)."""
    import subprocess

    proc = subprocess.Popen(["true"])
    proc.wait()  # this pid is now dead (reuse within the test window is unrealistic)

    agent_bridge.write_session_file("http://localhost:8420", "tok")
    data = json.loads(isolated_session_file.read_text())
    data["pid"] = proc.pid
    isolated_session_file.write_text(json.dumps(data))

    with pytest.raises(agent_bridge.StaleSessionError, match=f"pid {proc.pid} dead"):
        discover_app_session()
    assert not isolated_session_file.exists()  # cleaned up
    assert discover_app_session() is None      # subsequent discovery is plain "missing"


def test_discover_env_override_skips_stale_file(isolated_session_file, monkeypatch):
    """Env overrides must win even over a stale file (no exception)."""
    agent_bridge.write_session_file("http://localhost:8420", "tok")
    data = json.loads(isolated_session_file.read_text())
    data["pid"] = 1  # PermissionError path on POSIX (alive, other user) — but env wins anyway
    isolated_session_file.write_text(json.dumps(data))
    monkeypatch.setenv("MESHVAULT_APP_URL", "http://otherhost:9999")
    assert discover_app_session()["url"] == "http://otherhost:9999"


def test_push_open_to_app_unreachable_raises_actionable_error(isolated_session_file):
    session = {"url": "http://127.0.0.1:9", "token": "t"}  # port 9: nothing listens
    with pytest.raises(RuntimeError, match="Is it running"):
        agent_bridge.push_open_to_app(session, "/tmp/x.glb", timeout=2)


def test_push_open_to_app_older_instance_404_names_the_cause():
    """A server WITHOUT the agent bridge (older MeshVault) answers FastAPI's plain
    'Not Found' — the error must say so instead of a bare 404 (external finding)."""
    import http.server
    import threading

    class NotFoundHandler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = b'{"detail": "Not Found"}'
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    httpd = http.server.HTTPServer(("127.0.0.1", 0), NotFoundHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        session = {"url": f"http://127.0.0.1:{httpd.server_address[1]}", "token": "t"}
        with pytest.raises(RuntimeError, match="older MeshVault"):
            agent_bridge.push_open_to_app(session, "/tmp/x.glb", timeout=5)
    finally:
        httpd.shutdown()


# ---------------------------------------------------------------------------
# Session publication happens only after a successful bind
# ---------------------------------------------------------------------------

def test_session_published_only_after_server_started(isolated_session_file):
    """A launch that never binds (port taken, reaped early) must NOT publish —
    otherwise the file points agents at a port owned by someone else."""
    import backend.app as app_module

    class FakeServer:
        started = False
        should_exit = False

    # Never starts, then exits: no file may appear.
    failing = FakeServer()
    failing.should_exit = True
    app_module._publish_session_when_started(failing, "http://localhost:1", "t")
    assert not isolated_session_file.exists()

    # Starts: file appears with the right content.
    ok = FakeServer()
    ok.started = True
    app_module._publish_session_when_started(ok, "http://localhost:8420", "tok")
    assert json.loads(isolated_session_file.read_text())["url"] == "http://localhost:8420"
