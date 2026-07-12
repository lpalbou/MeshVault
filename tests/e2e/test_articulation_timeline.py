"""E2E: pivots, parenting, keyframes, split/repair, texture tiers (35 checks).
Ported from the /tmp field harness (backlog 048). Run via scripts/e2e.sh.
"""
"""Smoke test: articulation (pivot/parent/split/detect), timeline, repair."""
import json
import sys

import pytest
from playwright.sync_api import sync_playwright




@pytest.mark.e2e
def test_articulation_timeline(mv_app):
    base_url, token, _serve = mv_app
    PASS, FAIL = [], []
    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        page = browser.new_page(viewport={"width": 900, "height": 700},
                                extra_http_headers={"X-MeshVault-Token": token})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base_url + "/static/viewer.html", wait_until="load")
        page.wait_for_function("() => window.mv && window.mv.execute", timeout=45000)

        def mv(a, prm=None):
            return page.evaluate(
                "([a,p]) => window.mv.execute({action:a, params:p||{}})", [a, prm or {}])

        # ---- pivot mechanics -------------------------------------------------
        r = mv("add_primitive", {"kind": "box", "params": {"width": 2, "height": 0.2, "depth": 0.5}})
        wing = r["result"]["objectId"]
        # pivot at the wing's left edge (x=-1); rotating 90 about Y should swing
        # the wing so its bounds move to z: [-2..0] roughly
        r = mv("set_pivot", {"id": wing, "point": [-1, 0, 0]})
        check("set_pivot ok", r["ok"], json.dumps(r)[:110])
        t0 = mv("get_object_transform", {"id": wing})["result"]
        check("pivot does not move object",
              abs(t0["world"]["position"][0]) < 1e-6, json.dumps(t0)[:110])
        r = mv("set_object_transform", {"id": wing, "rotation": [0, 90, 0]})
        objs = mv("list_objects")["result"]["objects"]
        wb = next(o for o in objs if o["id"] == wing)["bounds"]
        # After rotating about x=-1 edge by +90° around Y: x range collapses to
        # [-1-0.25? ...]; the far tip (x=1 originally, 2 units from pivot) goes to z=-? 
        check("rotation swings about pivot (bounds moved off-center)",
              wb["min"][2] < -1.5 or wb["max"][2] > 1.5,
              json.dumps(wb))
        mv("set_object_transform", {"id": wing, "rotation": [0, 0, 0]})

        # ---- parenting -------------------------------------------------------
        r = mv("add_primitive", {"kind": "box", "name": "body",
                                 "params": {"width": 0.5, "height": 0.5, "depth": 2}})
        body = r["result"]["objectId"]
        r = mv("set_parent", {"id": wing, "parent_id": body})
        check("set_parent ok", r["ok"] and r["result"]["parentId"] == body,
              json.dumps(r.get("result", r))[:110])
        # world pose preserved
        t1 = mv("get_object_transform", {"id": wing})["result"]
        check("keepWorld preserves world pose",
              abs(t1["world"]["position"][0]) < 1e-4, json.dumps(t1["world"])[:90])
        # moving parent moves child (world)
        mv("set_object_transform", {"id": body, "position": [0, 2, 0]})
        t2 = mv("get_object_transform", {"id": wing})["result"]
        check("parent motion carries child",
              abs(t2["world"]["position"][1] - 2) < 1e-4, json.dumps(t2["world"])[:90])
        # cycle refused
        r = mv("set_parent", {"id": body, "parent_id": wing})
        check("cycle refused with teaching error",
              not r["ok"] and "cycle" in r["error"], str(r.get("error"))[:80])

        # ---- timeline --------------------------------------------------------
        r = mv("set_keyframe", {"id": body, "time": 0, "capture": True})
        check("set_keyframe capture ok", r["ok"], json.dumps(r)[:110])
        r = mv("set_keyframe", {"id": body, "time": 2, "position": [0, 2, 3],
                                "rotation": [0, 0, 0]})
        check("set_keyframe explicit ok", r["ok"], json.dumps(r)[:110])
        r = mv("set_keyframe", {"id": wing, "time": 0, "capture": True})
        r = mv("set_keyframe", {"id": wing, "time": 2, "rotation": [0, 60, 0]})
        check("wing rotation key ok", r["ok"], json.dumps(r)[:100])
        # big-rotation teaching note
        r = mv("set_keyframe", {"id": wing, "time": 4, "rotation": [0, 250, 0]})
        check("large-arc note fires",
              r["ok"] and "SHORT arc" in str(r["result"].get("note", "")),
              str(r.get("result", {}).get("note", ""))[:80])
        mv("delete_keyframe", {"id": wing, "time": 4})

        # deterministic seek: body at t=1 should be halfway (z=1.5)
        r = mv("seek_timeline", {"time": 1})
        t3 = mv("get_object_transform", {"id": body})["result"]
        check("seek interpolates deterministically (z≈1.5)",
              abs(t3["position"][2] - 1.5) < 1e-3, json.dumps(t3["position"]))
        # get_state timeline block
        st = mv("get_state")["result"]["timeline"]
        check("get_state exposes timeline", st["tracks"] == 2 and st["duration"] == 2.0,
              json.dumps(st))
        # set_object_transform on keyframed object → note
        r = mv("set_object_transform", {"id": body, "position": [9, 9, 9]})
        check("keyframed-object note fires",
              "keyframed" in str(r["result"].get("note", "")),
              str(r.get("result", {}).get("note", ""))[:80])
        # play + pause
        r = mv("play_timeline", {})
        check("play_timeline ok", r["ok"] and r["result"]["playing"], json.dumps(r.get("result"))[:80])
        # sculpt refused while playing
        r = mv("sculpt", {"tool": "draw", "center": [0, 2, 0], "radius": 0.3})
        check("sculpt refused while playing",
              not r["ok"] and "pause_timeline" in r["error"], str(r.get("error"))[:80])
        mv("pause_timeline")
        # clear restores base placement
        r = mv("clear_timeline", {})
        t4 = mv("get_object_transform", {"id": body})["result"]
        check("clear_timeline restores base placement",
              abs(t4["position"][1] - 2) < 1e-4 and abs(t4["position"][2]) < 1e-4,
              json.dumps(t4["position"]))

        # ---- animated GLB export --------------------------------------------
        mv("set_keyframe", {"id": body, "time": 0, "capture": True})
        mv("set_keyframe", {"id": body, "time": 1, "position": [0, 2, 2]})
        r = mv("export_glb")
        ok_export = r["ok"] and isinstance(r["result"], str) and r["result"].startswith("data:model/gltf-binary")
        check("animated export produces GLB", ok_export, str(r.get("error", ""))[:100])
        if ok_export:
            import base64
            glb = base64.b64decode(r["result"].split(",", 1)[1])
            import struct
            jlen = struct.unpack("<I", glb[12:16])[0]
            gltf = json.loads(glb[20:20 + jlen])
            anims = gltf.get("animations", [])
            check("GLB contains animation with channels",
                  len(anims) == 1 and len(anims[0]["channels"]) >= 3,
                  f"{len(anims)} anims, {len(anims[0]['channels']) if anims else 0} channels")
            # nodes are TRS (not collapsed at origin): find mv_obj nodes with translation
            named = [n for n in gltf.get("nodes", []) if str(n.get("name", "")).startswith("mv_obj_")]
            check("export nodes carry TRS placements",
                  any("translation" in n or "rotation" in n for n in named) and len(named) >= 2,
                  f"{len(named)} obj nodes")
        mv("clear_timeline", {})

        # ---- detect_parts + split (plane) ------------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "box", "params": {"width": 2, "height": 0.4, "depth": 0.4}})
        r = mv("detect_parts")
        check("detect_parts single component honest",
              r["ok"] and len(r["result"]["parts"]) <= 1
              and "split_object" in r["result"]["note"],
              json.dumps(r.get("result", {}).get("note", ""))[:90])
        r = mv("split_object", {"axis": "x", "at": 0.5})
        ok_split = r["ok"] and r["result"]["created"][0]["objectId"]
        check("plane split creates object", bool(ok_split), json.dumps(r.get("result", r))[:140])
        if ok_split:
            res = r["result"]
            check("split returns suggestedPivot on the cut plane",
                  abs(res["created"][0]["suggestedPivot"][0] - 0.5) < 0.05,
                  json.dumps(res["created"][0]["suggestedPivot"]))
            check("split reports open edges + hollow note",
                  res["openEdgesAdded"] > 0 and "HOLLOW" in res["note"].upper(),
                  f"openEdges {res['openEdgesAdded']}")
            check("remainder kept on source",
                  res["remaining"] and res["remaining"]["triangles"] > 0,
                  json.dumps(res["remaining"]))
        # stale partition handshake
        r = mv("detect_parts")
        pid = r["result"]["partitionId"]
        mv("sculpt", {"tool": "draw", "center": [0.75, 0.2, 0], "radius": 0.3, "strength": 0.05})
        r = mv("split_object", {"parts": [0], "partitionId": pid})
        check("stale partition refused",
              not r["ok"] and "detect_parts" in r["error"], str(r.get("error"))[:80])

        # ---- repair: inspect_region / simplify_region / fix_mesh -------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1, "widthSegments": 96, "heightSegments": 72}})
        r = mv("inspect_region", {"grid": 3})
        check("inspect_region grid mode",
              r["ok"] and len(r["result"]["cells"]) > 0
              and "opportunity" in r["result"]["cells"][0],
              json.dumps(r.get("result", {}).get("cells", [{}])[0])[:120])
        r = mv("inspect_region", {"center": [0, 1, 0], "radius": 0.5})
        probe = r["result"]
        check("inspect_region probe mode",
              r["ok"] and probe["triangles"] > 50 and probe["triPerUnit2"] > 0,
              json.dumps(probe)[:120])
        before = mv("get_state")["result"]["model"]["faces"]
        r = mv("simplify_region", {"center": [0, 1, 0], "radius": 0.5, "ratio": 0.3})
        res = r.get("result", {})
        check("simplify_region decimates region",
              r["ok"] and res["region"]["trianglesAfter"] < res["region"]["trianglesBefore"] * 0.7,
              json.dumps(res)[:160])
        after = mv("get_state")["result"]["model"]["faces"]
        check("object triangle count dropped", after < before, f"{before} -> {after}")
        r = mv("fix_mesh", {})
        check("fix_mesh default ops",
              r["ok"] and len(r["result"]["operations"]) == 2
              and "openEdges" in r["result"]["issues"],
              json.dumps(r.get("result", r))[:140])

        # ---- texture inspect + repair brushes ---------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere"})
        mv("fill_paint", {"color": "#dddddd"})
        mv("paint", {"center": [0, 0, 0.5], "radius": 0.1, "color": "#ff0000"})  # "defect"
        r = mv("inspect_texture")
        mat = r["result"]["materials"][0]
        check("inspect_texture reports density + resolution",
              r["ok"] and mat["map"]["width"] == 1024 and "texelDensity" in mat,
              json.dumps(mat)[:140])
        r = mv("clone_paint", {"from": [0.15, 0, 0.477], "to": [0, 0, 0.5], "radius": 0.12})
        check("clone_paint heals region",
              r["ok"] and r["result"]["cloned"] > 100, json.dumps(r.get("result", r))[:100])
        r = mv("blur_paint", {"center": [0, 0, 0.5], "radius": 0.15, "strength": 0.8})
        check("blur_paint softens region",
              r["ok"] and r["result"]["blurred"] > 100, json.dumps(r.get("result", r))[:100])
        r = mv("resize_texture", {"size": "low"})
        check("resize_texture tier works",
              r["ok"] and r["result"]["to"] == 512, json.dumps(r.get("result", r))[:110])

        if errors:
            check("no page errors", False, "; ".join(errors)[:150])
        browser.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
