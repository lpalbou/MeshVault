"""E2E: morph targets via sculpt-pose capture (backlog 049) — the capture
loop, blending, guards, timeline weight channels, GLB export round-trip.
"""
import base64
import json
import struct
import urllib.parse
from pathlib import Path

import pytest
_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright


@pytest.mark.e2e
def test_morphs(mv_app):
    base_url, token, serve_dir = mv_app

    PASS, FAIL = [], []
    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))

    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        page = b.new_page(viewport={"width": 800, "height": 600},
                          extra_http_headers={"X-MeshVault-Token": token})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base_url + "/static/viewer.html", wait_until="load")
        page.wait_for_function("() => window.mv && window.mv.execute", timeout=45000)
        mv = lambda a, p=None: page.evaluate(
            "([a,p]) => window.mv.execute({action:a, params:p||{}})", [a, p or {}])
        def probe_z():
            # surface z at +Z pole via raycast (morphs must move the DISPLAYED surface)
            r = mv("raycast", {"origin": [0, 0, 3], "direction": [0, 0, -1]})
            return r["result"]["point"][2] if r.get("ok") and r["result"]["hit"] else None
    
        # ---- setup ----------------------------------------------------------
        mv("add_primitive", {"kind": "sphere", "color": "#d0b090",
                             "params": {"radius": 1.0, "widthSegments": 48, "heightSegments": 32}})
    
        # guards: capture without base
        r = mv("capture_morph", {"name": "nose"})
        check("capture without base errors", not r.get("ok") and "begin_morph" in str(r.get("error")),
              str(r.get("error", ""))[:70])
    
        r = mv("begin_morph")
        check("begin_morph ok", r.get("ok"), json.dumps(r)[:120])
    
        # zero-delta capture
        r = mv("capture_morph", {"name": "nose"})
        check("zero-delta capture errors", not r.get("ok") and "sculpt" in str(r.get("error")),
              str(r.get("error", ""))[:70])
    
        # sculpt pose 1: nose bump at +Z
        z0 = probe_z()
        mv("sculpt", {"tool": "draw", "center": [0, 0, 1.0], "radius": 0.35, "strength": 0.25})
        z_sculpted = probe_z()
        check("pose sculpted (surface moved)", z_sculpted > z0 + 0.05, f"{z0} -> {z_sculpted}")
        r = mv("capture_morph", {"name": "nose"})
        res = r.get("result", {})
        check("capture_morph ok", r.get("ok") and res.get("deltaVertices", 0) > 10,
              json.dumps(res)[:160])
        z_after = probe_z()
        check("base restored after capture", abs(z_after - z0) < 1e-3, f"{z_after} vs {z0}")
    
        # pose 2: dent at -Z (invert)
        mv("sculpt", {"tool": "draw", "center": [0, 0, -1.0], "radius": 0.35, "strength": -0.2})
        r = mv("capture_morph", {"name": "dent"})
        check("second capture ok", r.get("ok") and len(r["result"]["morphs"]) == 2,
              json.dumps(r.get("result", {}))[:120])
    
        # begin_morph refused while morphs exist
        r = mv("begin_morph")
        check("begin_morph refused with morphs", not r.get("ok") and "delete_morph" in str(r.get("error")),
              str(r.get("error", ""))[:80])
    
        # ---- blending --------------------------------------------------------
        r = mv("set_morph", {"name": "nose", "weight": 1})
        check("set_morph ok", r.get("ok"), json.dumps(r)[:100])
        z_full = probe_z()
        check("morph 1.0 moves displayed surface", z_full > z0 + 0.05, f"{z0} -> {z_full}")
        mv("set_morph", {"name": "nose", "weight": 0.5})
        z_half = probe_z()
        check("morph 0.5 is halfway-ish",
              z0 + 0.02 < z_half < z_full - 0.02, f"{z_half} between {z0} and {z_full}")
    
        # sculpt refused while influenced
        r = mv("sculpt", {"tool": "draw", "center": [0, 1, 0], "radius": 0.3})
        check("sculpt refused while morph active",
              not r.get("ok") and "weight" in str(r.get("error")),
              str(r.get("error", ""))[:80])
        # paint still allowed (S5)
        mv("fill_paint", {"color": "#d0b090", "texture_size": 256})
        r = mv("paint", {"center": [0, 0, 1.05], "radius": 0.2, "color": "#ff0000", "opacity": 1})
        check("paint allowed while morph active", r.get("ok"), json.dumps(r)[:90])
    
        # unknown morph teaching error
        r = mv("set_morph", {"name": "smile", "weight": 1})
        check("unknown morph error lists names",
              not r.get("ok") and "nose" in str(r.get("error")),
              str(r.get("error", ""))[:80])
    
        # list_objects morph summary
        objs = mv("list_objects")["result"]["objects"]
        check("list_objects reports morphs", "nose" in (objs[0].get("morphs") or {}),
              json.dumps(objs[0].get("morphs")))
    
        # ---- timeline --------------------------------------------------------
        mv("set_morph", {"name": "nose", "weight": 0})
        r = mv("set_keyframe", {"id": 1, "time": 0, "morphs": {"nose": 0}})
        check("morph keyframe t0", r.get("ok"), json.dumps(r)[:110])
        r = mv("set_keyframe", {"id": 1, "time": 1, "morphs": {"nose": 1}, "easing": "ease_in_out"})
        check("morph keyframe t1", r.get("ok") and any("morph:" in c for c in r["result"]["channels"]),
              json.dumps(r.get("result", {}))[:120])
        tl = mv("get_timeline")["result"]
        track = tl["tracks"][0]
        check("get_timeline shows scalar morph keys",
              "morph:nose" in track and track["morph:nose"][1]["v"] == 1,
              json.dumps(track)[:160])
        mv("seek_timeline", {"time": 1})
        z_seek = probe_z()
        check("seek applies morph weight", z_seek > z0 + 0.05, f"{z_seek}")
        mv("seek_timeline", {"time": 0})
        z_seek0 = probe_z()
        check("seek 0 returns to base", abs(z_seek0 - z0) < 1e-3, f"{z_seek0}")
    
        # deleteKeyframe all-channels covers morph channels
        r = mv("delete_keyframe", {"id": 1, "time": 1})
        check("delete morph key by time", r.get("ok") and r["result"]["removed"] >= 1,
              json.dumps(r)[:80])
        mv("set_keyframe", {"id": 1, "time": 1, "morphs": {"nose": 1}})
    
        # manifest exclusion
        man = mv("get_scene_manifest")["result"]
        tl_tracks = (man.get("timeline") or {}).get("tracks", [])
        check("manifest excludes morph channels",
              all(not t["channel"].startswith("morph:") for t in tl_tracks),
              json.dumps([t["channel"] for t in tl_tracks]))
    
        # ---- export round-trip ------------------------------------------------
        r = mv("export_glb", {"animation": True})
        check("animated export ok", r.get("ok"), str(r.get("error", ""))[:120])
        glb = base64.b64decode(r["result"].split(",", 1)[1])
        # parse GLB json: morph targets + weights animation present
        jlen = struct.unpack("<I", glb[12:16])[0]
        gltf = json.loads(glb[20:20 + jlen])
        prims = [p for m in gltf.get("meshes", []) for p in m["primitives"]]
        has_targets = any(p.get("targets") for p in prims)
        check("GLB carries morph targets", has_targets,
              f"{sum(1 for p in prims if p.get('targets'))} prims with targets")
        weight_channels = [c for a in gltf.get("animations", []) for c in a["channels"]
                           if c["target"]["path"] == "weights"]
        check("GLB carries weights animation", len(weight_channels) >= 1,
              f"{len(weight_channels)} weight channels")
        names_ok = any("nose" in json.dumps(m.get("extras", {})) for m in gltf.get("meshes", []))
        check("target names exported", names_ok,
              json.dumps([m.get("extras") for m in gltf.get("meshes", [])])[:120])
        # default weights zeroed (playhead pose must not become the asset default)
        default_w = [w for m in gltf.get("meshes", []) for w in (m.get("weights") or [])]
        check("default weights zero", all(w == 0 for w in default_w), str(default_w))
    
        # reload and verify the clip drives the morph
        path = str(serve_dir / "morph_roundtrip.glb")
        open(path, "wb").write(glb)
        url = "/api/asset/file?path=" + urllib.parse.quote(path)
        r = mv("load", {"url": url, "extension": ".glb", "name": "morph_roundtrip"})
        check("reload ok", r.get("ok"))
        st = mv("get_state")["result"]
        check("reloaded clip present", len((st.get("animation") or {}).get("clips", [])) >= 1,
              json.dumps(st.get("animation"))[:100])
        mv("pause_animation")
        mv("set_animation_time", {"seconds": 1.0})
        z_reload_1 = probe_z()
        mv("set_animation_time", {"seconds": 0.0})
        z_reload_0 = probe_z()
        check("reloaded morph animates the surface", z_reload_1 > z_reload_0 + 0.04,
              f"t0 {z_reload_0} -> t1 {z_reload_1}")
    
        # ---- reset drops morphs loudly ----------------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0}})
        mv("begin_morph")
        mv("sculpt", {"tool": "draw", "center": [0, 0, 1.0], "radius": 0.3, "strength": 0.2})
        mv("capture_morph", {"name": "bump"})
        r = mv("reset")
        note = json.dumps(r.get("result", ""))
        check("reset drops morphs with note", r.get("ok") and "DROPPED" in note, note[:120])
        r = mv("set_morph", {"name": "bump", "weight": 1})
        check("morph gone after reset", not r.get("ok"), str(r.get("error", ""))[:60])
    
        check("no page errors", not errors, "; ".join(errors)[:300])
        b.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"


@pytest.mark.e2e
def test_morph_field_fixes(mv_app):
    base_url, token, serve_dir = mv_app

    PASS, FAIL = [], []
    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))

    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        page = b.new_page(viewport={"width": 700, "height": 550},
                          extra_http_headers={"X-MeshVault-Token": token})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base_url + "/static/viewer.html", wait_until="load")
        page.wait_for_function("() => window.mv && window.mv.execute", timeout=45000)
        mv = lambda a, p=None: page.evaluate(
            "([a,p]) => window.mv.execute({action:a, params:p||{}})", [a, p or {}])
    
        # ---- B4: bake ops keep base in sync -----------------------------------
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 64, "heightSegments": 48}})
        mv("begin_morph")
        mv("sculpt", {"tool": "inflate", "center": [0, 1, 0], "radius": 0.5, "strength": 0.15})
        r = mv("capture_morph", {"name": "bump"})
        check("capture 1 ok", r.get("ok"), str(r.get("error", ""))[:80])
        n1 = r["result"]["deltaVertices"]
        mv("rotate", {"axis": "y", "angle": 37})            # bake mid-session
        mv("recenter")                                       # another bake
        mv("sculpt", {"tool": "inflate", "center": [1, 0, 0], "radius": 0.4, "strength": 0.12})
        r = mv("capture_morph", {"name": "bump2"})
        n2 = r["result"]["deltaVertices"] if r.get("ok") else -1
        # Without the fix, n2 exploded to ALL vertices (float residue). With it,
        # n2 stays local — same order as n1.
        check("B4: bake mid-session keeps captures sparse",
              r.get("ok") and n2 < n1 * 4,
              f"n1={n1} n2={n2}")
        # rotated morph still renders: weight 1 shifts the bump correctly
        r = mv("set_morph", {"name": "bump", "weight": 1})
        check("morph after bakes applies", r.get("ok"))
        mv("set_morph", {"name": "bump", "weight": 0})
    
        # ---- B1: GPU morph budget teaching error ------------------------------
        # sphere 64x48 ≈ 3k verts → budget 512k/3k ≈ 170 morphs — too small to trip.
        # Use a dense primitive: 250k-vert cap is the primitive limit; use 200
        # segments ≈ 40k verts → 8 morphs = 320k < 512k. So trip it with a denser
        # mesh: 256 segments sphere ≈ 66k verts → 8×66k=528k > 512k at the 8th.
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 256, "heightSegments": 255}})
        st = mv("get_mesh_stats")["result"]["total"]
        verts = st.get("vertices") or st.get("vertexCount") or st.get("verts") or -1
        mv("begin_morph")
        tripped = None
        for i in range(8):
            ang = 20 + i * 40
            mv("sculpt", {"tool": "inflate", "center": [0, 1, 0], "radius": 0.6,
                          "strength": 0.05 + 0.01 * i})
            r = mv("capture_morph", {"name": f"m{i}"})
            if not r.get("ok"):
                tripped = (i, str(r.get("error", "")))
                break
        check("B1: GPU budget trips before the wedge",
              tripped is not None and "GPU budget" in tripped[1],
              f"verts={verts} tripped_at={tripped[0] if tripped else None} "
              f"err={tripped[1][:90] if tripped else ''}")
        # Viewer still responsive after the refusal:
        r = mv("get_state")
        check("B1: viewer responsive after refusal", r.get("ok"))
        mv("delete_morph")
    
        # ---- hinge brush -------------------------------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "cylinder", "params": {"radiusTop": 0.15,
                             "radiusBottom": 0.15, "height": 2,
                             "radialSegments": 24, "heightSegments": 40}})
        b0 = mv("get_bounds")["result"]
        # bend the top half about a pivot at the middle, axis z
        r = mv("sculpt", {"tool": "hinge", "center": [0, 0.75, 0], "radius": 0.8,
                          "pivot": [0, 0, 0], "axis": [0, 0, 1], "angle_deg": -40,
                          "falloff": "smooth"})
        check("hinge stamp ok", r.get("ok") and r["result"]["affected"] > 50,
              json.dumps(r.get("result", r))[:100])
        b1 = mv("get_bounds")["result"]
        check("hinge bends (bbox x grows)",
              b1["size"][0] > b0["size"][0] + 0.15,
              f"{b0['size'][0]:.3f} -> {b1['size'][0]:.3f}")
        r = mv("sculpt", {"tool": "hinge", "center": [0, 0.75, 0], "radius": 0.8})
        check("hinge without pivot/axis teaches",
              not r.get("ok") and "pivot" in str(r.get("error", "")),
              str(r.get("error", ""))[:80])
    
        # ---- B3: paint aims at the DISPLAYED (morphed) surface ----------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 64, "heightSegments": 48}})
        mv("fill_paint", {"color": "#d0d0d0", "texture_size": 512})
        mv("begin_morph")
        # big protrusion on +x: displaces surface from x=1 to x~1.5
        mv("sculpt", {"tool": "hinge", "center": [1, 0, 0], "radius": 0.7,
                      "pivot": [0, -1, 0], "axis": [0, 0, 1], "angle_deg": -25})
        mv("capture_morph", {"name": "stick"})
        mv("set_morph", {"name": "stick", "weight": 1})
        # The hinge (-25 deg about z at pivot [0,-1,0]) moved the +x bulge to
        # ~[1.33, -0.52, 0]; the base surface at that height is x=0.854. A ray
        # there separates base from displayed cleanly.
        r = mv("raycast", {"origin": [3, -0.52, 0], "direction": [-1, 0, 0]})
        hit = r["result"]["point"] if r.get("ok") and r["result"].get("hit") else None
        check("raycast hits morphed surface", hit is not None and hit[0] > 1.05,
              json.dumps(hit))
        if hit:
            r = mv("paint", {"center": hit, "radius": 0.25, "color": "#ff2200",
                             "opacity": 1})
            ok_painted = r.get("ok") and r["result"]["painted"] > 20
            check("B3: paint lands on morphed surface", ok_painted,
                  json.dumps(r.get("result", r))[:100])
        # heal brush refuses while morphed
        r = mv("blur_paint", {"center": [1.2, -0.5, 0], "radius": 0.2})
        check("heal brush refuses while morphed",
              not r.get("ok") and "morph" in str(r.get("error", "")).lower(),
              str(r.get("error", ""))[:80])
        mv("set_morph", {"name": "stick", "weight": 0})
    
        # ---- B2: exported GLB morphs re-addressable ---------------------------
        mv("set_morph", {"name": "stick", "weight": 0})
        tmpdir = serve_dir
        glb64 = mv("export_glb", {})
        if glb64.get("ok"):
            raw = glb64["result"]
            if isinstance(raw, dict):
                raw = raw.get("data") or raw.get("dataUri") or ""
            data = base64.b64decode(raw.split(",", 1)[1] if "," in raw else raw)
            p = tmpdir / "morphed.glb"
            p.write_bytes(data)
            url = "/api/asset/file?path=" + urllib.parse.quote(str(p))
            mv("unload")   # the reload checks must not see the ORIGINAL object
            r = mv("load", {"url": url, "extension": ".glb", "name": "reloaded"})
            check("reload exported glb", r.get("ok"), str(r.get("error", ""))[:60])
            objs = mv("list_objects")["result"]["objects"]
            morphs = objs[0].get("morphs") if objs else None
            check("B2: imported morphs listed", bool(morphs) and "stick" in morphs,
                  json.dumps(morphs))
            r = mv("set_morph", {"name": "stick", "weight": 0.8})
            check("B2: set_morph drives imported morph",
                  r.get("ok") and r["result"].get("source") == "imported",
                  json.dumps(r.get("result", r))[:110])
            r = mv("set_keyframe", {"id": objs[0]["id"], "time": 1,
                                    "morphs": {"stick": 0.5}})
            check("B2: keyframe imported morph", r.get("ok"),
                  str(r.get("error", ""))[:80])
            r = mv("begin_morph")
            check("B2: begin_morph refuses on imported",
                  not r.get("ok") and "IMPORTED" in str(r.get("error", "")),
                  str(r.get("error", ""))[:80])
            r = mv("delete_morph", {"name": "stick"})
            check("B2: delete_morph teaches drive-only",
                  not r.get("ok") and "drive-only" in str(r.get("error", "")),
                  str(r.get("error", ""))[:80])
            r = mv("sculpt", {"tool": "draw", "center": [0, 1, 0], "radius": 0.3})
            check("sculpt refused while imported morph active",
                  not r.get("ok") and "morph" in str(r.get("error", "")).lower(),
                  str(r.get("error", ""))[:80])
        else:
            check("export glb", False, str(glb64.get("error", ""))[:80])
    
        check("no page errors", not errors, "; ".join(errors)[:300])
        b.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
