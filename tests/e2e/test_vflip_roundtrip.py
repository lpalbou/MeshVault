"""E2E: GLB→GLB export must not re-flip texture coordinates.

Regression test for the critical v0.7.0 data-loss bug: the exporter V-flipped
TEXCOORD_0 unconditionally — correct for GL-convention textures (loaders,
paint layers) but wrong for GLB-sourced ones (already in glTF convention),
so every glTF round-trip scrambled its textures into a mosaic.

Self-contained variant of the original portrait-based proof: paint a
primitive (creates a GL-convention layer), export (conversion #1 → glTF
convention), reload that GLB through the guarded file route, export again —
the second export's TEXCOORD_0 V-range must be bit-identical to the first
(no double conversion).
"""

import base64
import json
import struct
import urllib.parse

import pytest
from playwright.sync_api import sync_playwright


def uv_v_range(glb_bytes):
    jlen = struct.unpack("<I", glb_bytes[12:16])[0]
    gltf = json.loads(glb_bytes[20:20 + jlen])
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            acc_i = prim.get("attributes", {}).get("TEXCOORD_0")
            if acc_i is None:
                continue
            acc = gltf["accessors"][acc_i]
            if "min" in acc and "max" in acc:
                return acc["min"][1], acc["max"][1]
    return None


@pytest.mark.e2e
def test_vflip_roundtrip(mv_app):
    base_url, token, serve_dir = mv_app
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        ctx = browser.new_context(
            extra_http_headers={"X-MeshVault-Token": token})
        page = ctx.new_page()
        page.goto(base_url + "/static/viewer.html", wait_until="load")
        page.wait_for_function("() => window.mv && window.mv.execute",
                               timeout=45000)

        def mv(action, params=None):
            return page.evaluate(
                "([a,p]) => window.mv.execute({action:a, params:p||{}})",
                [action, params or {}])

        # A painted primitive: the paint layer is a GL-convention canvas
        # texture, so export #1 performs the V conversion.
        assert mv("add_primitive", {"kind": "sphere",
                                    "params": {"radius": 1.0}})["ok"]
        assert mv("fill_paint", {"color": "#c08040",
                                 "texture_size": 256})["ok"]
        assert mv("paint", {"center": [0, 0, 1], "radius": 0.3,
                            "color": "#2040ff", "opacity": 1})["ok"]
        r = mv("export_glb", {})
        assert r["ok"], r
        glb1 = base64.b64decode(r["result"].split(",", 1)[1])
        v1 = uv_v_range(glb1)
        assert v1 is not None, "export #1 has no TEXCOORD_0 accessor bounds"

        # Round-trip: reload export #1 from disk, export again.
        path = serve_dir / "vflip_roundtrip.glb"
        path.write_bytes(glb1)
        url = "/api/asset/file?path=" + urllib.parse.quote(str(path))
        r = mv("load", {"url": url, "extension": ".glb", "name": path.name})
        assert r["ok"], r
        r = mv("export_glb", {})
        assert r["ok"], r
        glb2 = base64.b64decode(r["result"].split(",", 1)[1])
        v2 = uv_v_range(glb2)
        assert v2 is not None, "export #2 has no TEXCOORD_0 accessor bounds"

        print(f"V range export#1 {v1} vs export#2 {v2}")
        assert abs(v1[0] - v2[0]) < 1e-6 and abs(v1[1] - v2[1]) < 1e-6, (
            f"TEXCOORD_0 V-range changed across a GLB round-trip: {v1} -> {v2} "
            "(the exporter double-flipped glTF-convention UVs)")
        browser.close()
