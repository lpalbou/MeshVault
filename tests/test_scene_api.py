"""
Tests for scene manifest persistence (POST /api/scene/save, GET /api/scene/load).

The save contract exists because the naive version ({path, manifest}) is an
arbitrary-file-write primitive under the default unconfined root (042 adversarial
review): these tests lock down the sanitized-name + forced-suffix + overwrite
protection + size/object caps behavior, and the load-side validation.
"""

import importlib
import json

import pytest
from fastapi.testclient import TestClient

from backend.scene_api import MAX_SCENE_OBJECTS


def make_manifest(n_objects=2, root="/tmp"):
    return {
        "version": 1,
        "objects": [
            {
                "source": {"kind": "file", "path": f"{root}/model_{i}.glb"},
                "name": f"model_{i}.glb",
                "transform": {"position": [i, 0, 0],
                              "quaternion": [0, 0, 0, 1],
                              "scale": [1, 1, 1]},
                "visible": True,
                "opacity": 1,
            }
            for i in range(n_objects)
        ],
        "lighting": {"keyAzimuth": 45},
        "environment": {"enabled": True, "intensity": 1.0, "asBackground": False},
        "background": "#33373f",
    }


@pytest.fixture()
def app_env(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()

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
# Save
# ---------------------------------------------------------------------------

def test_scene_save_roundtrip(app_env):
    _, client, root = app_env
    manifest = make_manifest(root=str(root))
    resp = client.post("/api/scene/save", json={
        "target_dir": str(root), "name": "myscene", "manifest": manifest})
    assert resp.status_code == 200
    saved = resp.json()
    assert saved["path"].endswith("myscene.mvscene")
    assert saved["objects"] == 2

    loaded = client.get("/api/scene/load", params={"path": saved["path"]})
    assert loaded.status_code == 200
    assert loaded.json()["manifest"]["objects"][1]["transform"]["position"] == [1, 0, 0]


def test_scene_save_requires_auth(app_env):
    app_module, _, root = app_env
    bare = TestClient(app_module.app)
    bare.headers.update({"Host": "localhost"})
    resp = bare.post("/api/scene/save", json={
        "target_dir": str(root), "name": "x", "manifest": make_manifest()})
    assert resp.status_code == 401
    assert bare.get("/api/scene/load", params={"path": str(root / "x.mvscene")}).status_code == 401


def test_scene_save_confined_and_sanitized(app_env, tmp_path):
    _, client, root = app_env
    # Outside the root: denied.
    resp = client.post("/api/scene/save", json={
        "target_dir": str(tmp_path), "name": "esc", "manifest": make_manifest()})
    assert resp.status_code == 403
    # Path separators in the NAME: rejected (no directory smuggling).
    resp = client.post("/api/scene/save", json={
        "target_dir": str(root), "name": "../evil", "manifest": make_manifest()})
    assert resp.status_code == 400


def test_scene_save_forces_extension_and_never_clobbers_other_files(app_env):
    _, client, root = app_env
    # A name aimed at an existing NON-scene file must not overwrite it, even
    # with overwrite=true — the suffix is forced, so it writes secret.txt.mvscene.
    victim = root / "secret.txt"
    victim.write_text("KEEP ME")
    resp = client.post("/api/scene/save", json={
        "target_dir": str(root), "name": "secret.txt",
        "manifest": make_manifest(), "overwrite": True})
    assert resp.status_code == 200
    assert victim.read_text() == "KEEP ME"
    assert resp.json()["path"].endswith("secret.txt.mvscene")


def test_scene_save_overwrite_protocol(app_env):
    _, client, root = app_env
    body = {"target_dir": str(root), "name": "s", "manifest": make_manifest()}
    assert client.post("/api/scene/save", json=body).status_code == 200
    # Same name again: 409 without the explicit flag.
    assert client.post("/api/scene/save", json=body).status_code == 409
    assert client.post("/api/scene/save",
                       json={**body, "overwrite": True}).status_code == 200


def test_scene_save_caps_object_count(app_env):
    _, client, root = app_env
    manifest = make_manifest(n_objects=MAX_SCENE_OBJECTS + 1)
    resp = client.post("/api/scene/save", json={
        "target_dir": str(root), "name": "big", "manifest": manifest})
    assert resp.status_code == 422
    assert "Too many objects" in resp.json()["detail"]


@pytest.mark.parametrize("mutate", [
    lambda m: m.update(version=2),
    lambda m: m.update(objects=[]),
    lambda m: m["objects"].append({"source": {"kind": "exec", "path": "/x"}}),
    lambda m: m["objects"].append("not-an-object"),
    lambda m: m["objects"][0]["source"].update(path="x" * 5000),
])
def test_scene_save_rejects_malformed_manifests(app_env, mutate):
    _, client, root = app_env
    manifest = make_manifest()
    mutate(manifest)
    resp = client.post("/api/scene/save", json={
        "target_dir": str(root), "name": "bad", "manifest": manifest})
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Load
# ---------------------------------------------------------------------------

def test_scene_load_rejects_non_scene_files(app_env):
    _, client, root = app_env
    other = root / "model.glb"
    other.write_bytes(b"glTF")
    resp = client.get("/api/scene/load", params={"path": str(other)})
    assert resp.status_code == 422


def test_scene_load_rejects_garbage_json(app_env):
    _, client, root = app_env
    bad = root / "broken.mvscene"
    bad.write_text("{not json")
    resp = client.get("/api/scene/load", params={"path": str(bad)})
    assert resp.status_code == 422


def test_scene_load_confined(app_env, tmp_path):
    _, client, _ = app_env
    outside = tmp_path / "outside.mvscene"
    outside.write_text(json.dumps(make_manifest()))
    resp = client.get("/api/scene/load", params={"path": str(outside)})
    assert resp.status_code == 403
