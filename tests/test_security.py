"""
Security regression tests for the trust boundary.

These lock down the three original critical failures (arbitrary read, arbitrary
delete, arbitrary write / traversal), the auth requirement, the Host allow-list,
and the previously-broken /api/default_path route. They must stay green.

The tests confine the server to a temporary root via MESHVAULT_ROOT and exercise
the app through Starlette's TestClient. Auth is kept ON to prove the token gate,
except where we explicitly test the unauthenticated path.
"""

import os
import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def app_env(tmp_path, monkeypatch):
    """Build an app instance confined to a temp root with a known token."""
    root = tmp_path / "root"
    root.mkdir()
    (root / "model.obj").write_text("o test\n", encoding="utf-8")

    # A secret file OUTSIDE the root that must never be reachable.
    outside = tmp_path / "outside_secret.txt"
    outside.write_text("TOP SECRET", encoding="utf-8")

    monkeypatch.setenv("MESHVAULT_ROOT", str(root))
    monkeypatch.setenv("MESHVAULT_TOKEN", "test-token-123")
    monkeypatch.delenv("MESHVAULT_NO_AUTH", raising=False)
    monkeypatch.delenv("MESHVAULT_HOST", raising=False)

    # Reimport the app so it picks up the fresh environment.
    import backend.app as app_module
    importlib.reload(app_module)

    client = TestClient(app_module.app)
    # Authenticated client (token via header) and a valid Host.
    client.headers.update({
        "X-MeshVault-Token": "test-token-123",
        "Host": "localhost",
    })
    return client, root, outside


def test_default_path_route_is_fixed(app_env):
    """Regression: GET /api/default_path used to 422 due to a stacked decorator."""
    client, root, _ = app_env
    resp = client.get("/api/default_path")
    assert resp.status_code == 200
    assert resp.json()["path"] == str(root.resolve())


def test_home_falls_back_when_outside_roots(app_env):
    """Confined server: the OS home is outside the sandbox, so the Home target
    must fall back to the default browse path — never a 403-bound directory."""
    client, root, _ = app_env
    data = client.get("/api/default_path").json()
    assert data["home"] == data["path"] == str(root.resolve())


def test_home_returned_when_within_roots(app_env, monkeypatch):
    """When the OS home lies inside an allowed root, Home targets the real home."""
    client, root, _ = app_env
    fake_home = root / "home_dir"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: fake_home)
    data = client.get("/api/default_path").json()
    assert data["home"] == str(fake_home.resolve())
    assert data["path"] == str(root.resolve())


def test_arbitrary_read_is_blocked(app_env):
    """S1: reading a file outside the root must be denied."""
    client, _, outside = app_env
    resp = client.get("/api/asset/file", params={"path": str(outside)})
    assert resp.status_code == 403
    resp2 = client.get("/api/asset/file", params={"path": "/etc/passwd"})
    assert resp2.status_code == 403


def test_related_read_is_blocked(app_env):
    client, _, outside = app_env
    resp = client.get("/api/asset/related", params={"path": str(outside)})
    assert resp.status_code == 403


def test_in_root_read_is_allowed(app_env):
    client, root, _ = app_env
    resp = client.get("/api/asset/file", params={"path": str(root / "model.obj")})
    assert resp.status_code == 200


def test_arbitrary_delete_is_blocked(app_env):
    """S2: deleting a file outside the root must be denied and the file survives."""
    client, _, outside = app_env
    resp = client.post("/api/delete", json={"path": str(outside)})
    assert resp.status_code == 403
    assert outside.exists()


def test_write_traversal_is_blocked(app_env):
    """S3: export new_name must not escape the target directory."""
    client, root, _ = app_env
    resp = client.post("/api/export_modified", json={
        "target_dir": str(root),
        "new_name": "../../escape",
        "obj_content": "o x\n",
    })
    assert resp.status_code == 400


def test_export_target_outside_root_blocked(app_env):
    client, _, outside = app_env
    resp = client.post("/api/export_modified", json={
        "target_dir": str(outside.parent),  # tmp_path, outside the confined root
        "new_name": "ok",
        "obj_content": "o x\n",
    })
    assert resp.status_code == 403


def test_auth_required_without_token(app_env):
    """S4/S5: /api/* must reject requests without a valid token."""
    client, root, _ = app_env
    bare = TestClient(client.app)  # no auth headers, no cookie
    resp = bare.get("/api/default_path", headers={"Host": "localhost"})
    assert resp.status_code == 401


def test_bad_host_rejected(app_env):
    """DNS-rebinding guard: a foreign Host header is rejected."""
    client, _, _ = app_env
    resp = client.get("/api/default_path", headers={"Host": "evil.example.com"})
    assert resp.status_code == 400


def test_empty_host_rejected(app_env):
    """Host guard fails closed: an empty Host is not allowed through."""
    client, _, _ = app_env
    resp = client.get("/api/default_path", headers={"Host": ""})
    assert resp.status_code == 400


def test_export_related_files_cannot_escape_root(app_env):
    """
    Regression for the CRITICAL export breakout: naming an out-of-root file as a
    'related' file must be rejected, not copied into the sandbox.
    """
    client, root, outside = app_env
    resp = client.post("/api/export", json={
        "source_path": str(root / "model.obj"),
        "target_dir": str(root),
        "new_name": "exfil",
        "related_files": [str(outside), "/etc/passwd"],
    })
    assert resp.status_code == 403
    # And nothing was copied into the sandbox.
    assert not (root / "exfil").exists()


def test_export_archive_mode_without_inner_path_still_guards_related(app_env):
    """
    Regression for the cycle-2 archive-branch bypass: is_in_archive=true but
    inner_path omitted makes ExportManager fall back to a filesystem copy, so
    related_files must still be guarded. Out-of-root related must be rejected.
    """
    client, root, outside = app_env
    resp = client.post("/api/export", json={
        "source_path": str(root / "model.obj"),
        "target_dir": str(root),
        "new_name": "exfil2",
        "is_in_archive": True,
        "archive_path": str(root / "model.obj"),  # in-root, but no inner_path
        "inner_path": None,
        "related_files": [str(outside), "/etc/passwd"],
    })
    assert resp.status_code == 403
    assert not (root / "exfil2").exists()


def test_query_param_token_is_rejected(app_env):
    """The ?token= query param must NOT authenticate (leak-prone)."""
    bare = TestClient(client_app(app_env))
    resp = bare.get(
        "/api/default_path?token=test-token-123", headers={"Host": "localhost"}
    )
    assert resp.status_code == 401


def test_docs_and_openapi_disabled(app_env):
    """OpenAPI schema and docs must not be served (recon surface)."""
    client, _, _ = app_env
    assert client.get("/openapi.json").status_code == 404
    assert client.get("/docs").status_code == 404


def client_app(app_env):
    """Helper: the FastAPI app object from the fixture's client."""
    client, _, _ = app_env
    return client.app


def test_default_config_is_unconfined_but_opens_at_home(monkeypatch):
    """
    Default (no MESHVAULT_ROOT): the whole filesystem is allowed (preserving the
    original 'browse anywhere' behavior; auth+loopback+Host are the real guards),
    but the browser opens at home and `confined` is False.
    """
    from pathlib import Path
    from backend.security import SecurityConfig

    monkeypatch.delenv("MESHVAULT_ROOT", raising=False)
    cfg = SecurityConfig.from_env()
    assert cfg.confined is False
    assert cfg.default_browse_path == Path.home().resolve()
    # The single allowed root is the filesystem anchor, so any real path is inside it.
    assert cfg.allowed_roots[0] == Path(Path.home().anchor).resolve()


def test_meshvault_root_confines(monkeypatch, tmp_path):
    """Setting MESHVAULT_ROOT narrows access and marks the config confined."""
    from backend.security import SecurityConfig, PathGuard

    monkeypatch.setenv("MESHVAULT_ROOT", str(tmp_path))
    cfg = SecurityConfig.from_env()
    assert cfg.confined is True
    guard = PathGuard(cfg.allowed_roots)
    with pytest.raises(PermissionError):
        guard.resolve("/etc/passwd", must_exist=False)
