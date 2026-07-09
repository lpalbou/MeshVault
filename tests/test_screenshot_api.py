"""
Tests for GET /api/screenshot — everything except the actual browser render (which
needs Chromium and is exercised by the live E2E scripts).

What must hold at unit level, per the adversarial review that shaped the endpoint:
the route lives behind the same auth as every /api route (401), enforces PathGuard
confinement (403/404) and the size cap (413) BEFORE any browser work, validates
view/preset names (422), and degrades with an actionable 503 when the headless
stack is unavailable.
"""

import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def app_env(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    (root / "model.glb").write_bytes(b"glTF fake content")

    monkeypatch.setenv("MESHVAULT_ROOT", str(root))
    monkeypatch.setenv("MESHVAULT_TOKEN", "test-token-123")
    monkeypatch.delenv("MESHVAULT_NO_AUTH", raising=False)
    monkeypatch.delenv("MESHVAULT_HOST", raising=False)

    import backend.app as app_module
    importlib.reload(app_module)

    client = TestClient(app_module.app)
    client.headers.update({"X-MeshVault-Token": "test-token-123", "Host": "localhost"})
    return app_module, client, root


def test_screenshot_requires_auth(app_env):
    app_module, _, root = app_env
    bare = TestClient(app_module.app)
    bare.headers.update({"Host": "localhost"})
    resp = bare.get("/api/screenshot", params={"path": str(root / "model.glb")})
    assert resp.status_code == 401
    resp = bare.get("/api/screenshot/harness")
    assert resp.status_code == 401


def test_screenshot_confined_to_root(app_env, tmp_path):
    _, client, _ = app_env
    outside = tmp_path / "outside.glb"
    outside.write_bytes(b"glTF")
    resp = client.get("/api/screenshot", params={"path": str(outside)})
    assert resp.status_code == 403


def test_screenshot_missing_file_is_404(app_env):
    _, client, root = app_env
    resp = client.get("/api/screenshot", params={"path": str(root / "nope.glb")})
    assert resp.status_code == 404


def test_screenshot_rejects_unknown_view_and_preset(app_env):
    _, client, root = app_env
    model = str(root / "model.glb")
    resp = client.get("/api/screenshot", params={"path": model, "view": "hero"})
    assert resp.status_code == 422 and "Unknown view" in resp.json()["detail"]
    resp = client.get("/api/screenshot", params={"path": model, "preset": "noir"})
    assert resp.status_code == 422 and "Unknown preset" in resp.json()["detail"]


def test_screenshot_rejects_out_of_range_dimensions(app_env):
    _, client, root = app_env
    resp = client.get("/api/screenshot",
                      params={"path": str(root / "model.glb"), "width": 4})
    assert resp.status_code == 422


def test_screenshot_size_cap_is_413(app_env, monkeypatch):
    _, client, root = app_env
    import backend.screenshot_api as sa
    monkeypatch.setattr(sa, "MAX_MODEL_BYTES", 8)  # model.glb is 17 bytes
    resp = client.get("/api/screenshot", params={"path": str(root / "model.glb")})
    assert resp.status_code == 413


def test_screenshot_503_when_headless_stack_unavailable(app_env, monkeypatch):
    """Missing playwright/Chromium must surface as an actionable 503, and the
    checks above must have run FIRST (no browser work for bad requests)."""
    _, client, root = app_env
    import backend.screenshot_api as sa

    class BrokenViewer:
        def __init__(self, **kwargs):
            pass

        async def ensure(self, *a, **kw):
            raise RuntimeError(
                "playwright is required: pip install 'meshvault[mcp]' && "
                "playwright install chromium")

        async def close(self):
            pass

    monkeypatch.setattr(sa, "HeadlessViewer", BrokenViewer)
    resp = client.get("/api/screenshot", params={"path": str(root / "model.glb")})
    assert resp.status_code == 503
    assert "playwright" in resp.json()["detail"]


def test_harness_serves_viewer_page(app_env):
    _, client, _ = app_env
    resp = client.get("/api/screenshot/harness")
    assert resp.status_code == 200
    assert "window.mv" in resp.text
    assert "/api/asset/related" in resp.text  # guarded resolver, not raw fs access


# ---------------------------------------------------------------------------
# Reverse bridge endpoints (item 2) — same auth/validation discipline
# ---------------------------------------------------------------------------

def test_agent_state_roundtrip(app_env):
    _, client, _ = app_env
    # Nothing reported yet.
    resp = client.get("/api/agent/state")
    assert resp.status_code == 200 and resp.json()["state"] is None

    report = {"path": "/some/model.glb", "name": "model.glb",
              "camera": {"position": [1, 2, 3], "target": [0, 0, 0], "fov": 45}}
    assert client.post("/api/agent/state", json=report).status_code == 200

    state = client.get("/api/agent/state").json()["state"]
    assert state["path"] == "/some/model.glb"
    assert state["camera"]["position"] == [1.0, 2.0, 3.0]
    assert state["age_seconds"] >= 0


def test_agent_state_requires_auth(app_env):
    app_module, _, _ = app_env
    bare = TestClient(app_module.app)
    bare.headers.update({"Host": "localhost"})
    assert bare.get("/api/agent/state").status_code == 401
    assert bare.post("/api/agent/state", json={"path": "/x"}).status_code == 401


def test_agent_state_rejects_malformed_camera(app_env):
    _, client, _ = app_env
    resp = client.post("/api/agent/state",
                       json={"path": "/x.glb", "camera": {"position": [1]}})
    assert resp.status_code == 422


def test_agent_state_bounds_lengths(app_env):
    _, client, _ = app_env
    resp = client.post("/api/agent/state", json={"path": "x" * 5000})
    assert resp.status_code == 422
