"""
Tests for the shared headless-viewer support code: companion-file discovery (the
multi-file/texture fix), mtllib parsing, MIME guessing, and the MCP runtime's
directory-confined model serving.

The browser itself is NOT started here (CI has no Chromium); the rendering path is
exercised by the live E2E scripts. What matters at unit level is the part that was
WRONG before: which companion files are advertised, and what the loopback server
will and will not serve.
"""

import urllib.request
import urllib.error
from pathlib import Path

import pytest

from backend.headless_viewer import (
    companion_files,
    guess_mime,
    parse_mtllib_refs,
)


# ---------------------------------------------------------------------------
# mtllib parsing
# ---------------------------------------------------------------------------

def test_parse_mtllib_single(tmp_path):
    obj = tmp_path / "m.obj"
    obj.write_text("# hdr\nmtllib m.mtl\nv 0 0 0\n", encoding="utf-8")
    assert parse_mtllib_refs(obj) == ["m.mtl"]


def test_parse_mtllib_name_with_spaces_and_backslashes(tmp_path):
    obj = tmp_path / "m.obj"
    obj.write_text("mtllib my materials\\pack one.mtl\nv 0 0 0\n", encoding="utf-8")
    assert parse_mtllib_refs(obj) == ["my materials/pack one.mtl"]


def test_parse_mtllib_case_insensitive_keyword(tmp_path):
    obj = tmp_path / "m.obj"
    obj.write_text("MTLLIB Weird.MTL\n", encoding="utf-8")
    assert parse_mtllib_refs(obj) == ["Weird.MTL"]


def test_parse_mtllib_binaryish_content_is_safe(tmp_path):
    obj = tmp_path / "m.obj"
    obj.write_bytes(b"\xff\xfe garbage \x00\nmtllib ok.mtl\n")
    assert parse_mtllib_refs(obj) == ["ok.mtl"]


# ---------------------------------------------------------------------------
# companion_files
# ---------------------------------------------------------------------------

def test_obj_companions_from_mtllib(tmp_path):
    (tmp_path / "cube.obj").write_text("mtllib cube.mtl\nv 0 0 0\n")
    (tmp_path / "cube.mtl").write_text("newmtl m\nmap_Kd tex.png\n")
    assert companion_files(tmp_path / "cube.obj") == ["cube.mtl"]


def test_obj_companion_in_subdir(tmp_path):
    (tmp_path / "mats").mkdir()
    (tmp_path / "mats" / "cube.mtl").write_text("newmtl m\n")
    (tmp_path / "cube.obj").write_text("mtllib mats/cube.mtl\n")
    assert companion_files(tmp_path / "cube.obj") == ["mats/cube.mtl"]


def test_obj_missing_mtllib_falls_back_to_same_stem(tmp_path):
    (tmp_path / "cube.obj").write_text("mtllib gone.mtl\nv 0 0 0\n")
    (tmp_path / "cube.mtl").write_text("newmtl m\n")
    # Declared library doesn't exist -> same-stem fallback.
    assert companion_files(tmp_path / "cube.obj") == ["cube.mtl"]


def test_obj_mtllib_escaping_the_directory_is_dropped(tmp_path):
    outside = tmp_path / "outside.mtl"
    outside.write_text("newmtl evil\n")
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "cube.obj").write_text("mtllib ../outside.mtl\n")
    # ../ escapes the serving boundary -> not advertised (and not servable).
    assert companion_files(model_dir / "cube.obj") == []


def test_fbx_companions_are_nearby_textures(tmp_path):
    (tmp_path / "rig.fbx").write_bytes(b"fbx")
    (tmp_path / "skin.png").write_bytes(b"png")
    (tmp_path / "textures").mkdir()
    (tmp_path / "textures" / "normal.jpg").write_bytes(b"jpg")
    (tmp_path / "notes.txt").write_text("not a texture")
    (tmp_path / "deep" / "deeper").mkdir(parents=True)
    (tmp_path / "deep" / "deeper" / "far.png").write_bytes(b"png")  # depth 3: skipped
    refs = companion_files(tmp_path / "rig.fbx")
    assert "skin.png" in refs
    assert "textures/normal.jpg" in refs
    assert all("deep/" not in r for r in refs)
    assert all(not r.endswith(".txt") for r in refs)


def test_single_file_formats_have_no_companions(tmp_path):
    (tmp_path / "model.glb").write_bytes(b"glTF")
    (tmp_path / "tex.png").write_bytes(b"png")
    assert companion_files(tmp_path / "model.glb") == []


def test_guess_mime():
    assert guess_mime(Path("a.mtl")) == "model/mtl"
    assert guess_mime(Path("a.png")) == "image/png"
    assert guess_mime(Path("a.glb")) == "model/gltf-binary"
    assert guess_mime(Path("a.unknownext")) == "application/octet-stream"


# ---------------------------------------------------------------------------
# LocalModelServer: directory-confined model serving (no browser needed)
# ---------------------------------------------------------------------------

@pytest.fixture()
def model_server():
    from backend.headless_viewer import LocalModelServer
    server = LocalModelServer("<html>harness</html>")
    server.start()
    yield server
    server.shutdown()


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def test_model_url_serves_model_and_companions(model_server, tmp_path):
    (tmp_path / "cube.obj").write_text("mtllib cube.mtl\nv 0 0 0\n")
    (tmp_path / "cube.mtl").write_text("newmtl m\nmap_Kd tex tures/red.png\n")
    (tmp_path / "tex tures").mkdir()
    (tmp_path / "tex tures" / "red.png").write_bytes(b"\x89PNGfake")

    url = model_server.register(tmp_path / "cube.obj")
    assert url.endswith("/cube.obj")

    status, body = _get(url)
    assert status == 200 and b"mtllib" in body

    base = url.rsplit("/", 1)[0]
    status, body = _get(base + "/cube.mtl")
    assert status == 200 and b"newmtl" in body

    # Subdirectory companion with a space in the name (URL-encoded).
    status, body = _get(base + "/tex%20tures/red.png")
    assert status == 200 and body.startswith(b"\x89PNG")


def test_model_serving_confined_to_model_directory(model_server, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP SECRET")
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "cube.obj").write_text("v 0 0 0\n")

    url = model_server.register(model_dir / "cube.obj")
    base = url.rsplit("/", 1)[0]

    # Traversal out of the registered directory must 404 (encoded and raw).
    status, _ = _get(base + "/..%2Fsecret.txt")
    assert status == 404
    status, _ = _get(base + "/%2e%2e/secret.txt")
    assert status == 404


def test_harness_and_unknown_token(model_server):
    status, body = _get(model_server.base_url + "/")
    assert status == 200 and b"harness" in body
    status, _ = _get(model_server.base_url + "/models/nope/file.obj")
    assert status == 404
    # No static root configured -> anything else is 404, not a file probe.
    status, _ = _get(model_server.base_url + "/etc/passwd")
    assert status == 404
