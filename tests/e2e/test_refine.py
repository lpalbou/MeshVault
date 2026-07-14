"""E2E: refine_region (adaptive resolution, refinement half) — convergence,
UV-seam crack checks, paint-after-refine, atomic budget refusal, no-op state
preservation, morph guards, the refine+sculpt loop sliver audit, export.
"""
import json

import pytest
_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright


@pytest.mark.e2e
def test_refine_region(mv_app):
    base_url, token, _serve = mv_app
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
        def open_edges():
            return mv("get_mesh_stats")["result"]["total"].get("openEdges")
    
        # ---- 1. convergence on a coarse sphere --------------------------------
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 12, "heightSegments": 8}})
        ins = mv("inspect_region", {"center": [0, 0, 1], "radius": 0.5})
        med0 = ins["result"]["edgeLength"]["median"]
        oe0 = open_edges()
        r = mv("sculpt", {"tool": "draw", "center": [0, 0, 1], "radius": 0.25, "strength": 0.0001})
        affected0 = r["result"]["affected"] if r.get("ok") else 0
        mv("reset")
        r = mv("refine_region", {"center": [0, 0, 1], "radius": 0.5,
                                 "target_edge": med0 / 2})
        res = r.get("result", {})
        check("refine converges", r.get("ok") and res.get("edgesSplit", 0) > 0
              and res["region"]["edgeLength"]["median"] <= med0 * 0.75,
              json.dumps(res)[:160])
        check("no cracks after refine", open_edges() == oe0, f"{oe0} -> {open_edges()}")
    
        # sculpt lands with more vertices than before the refine
        r = mv("sculpt", {"tool": "draw", "center": [0, 0, 1], "radius": 0.25, "strength": 0.08})
        check("sculpt after refine dense",
              r.get("ok") and r["result"]["affected"] >= max(4, affected0 * 2),
              f"before {affected0} -> after {r.get('result', {}).get('affected')}")
    
        # ---- 2. UV seams (box atlas) + paint-after-refine ---------------------
        mv("unload")
        mv("add_primitive", {"kind": "box", "params": {}})
        mv("fill_paint", {"color": "#c0c0c0", "texture_size": 512})
        oe0 = open_edges()
        raw0 = mv("get_mesh_stats")["result"]["total"].get("vertexCount") or \
               mv("get_mesh_stats")["result"]["total"].get("vertices")
        r = mv("refine_region", {"center": [0.5, 0.5, 0.5], "radius": 1.2,
                                 "detail_rel": 0.08})
        check("box refine ok", r.get("ok"), str(r.get("error", ""))[:100])
        check("box seams stay welded (openEdges)", open_edges() == oe0,
              f"{oe0} -> {open_edges()}")
        r = mv("paint", {"center": [0, 0, 0.5], "radius": 0.2, "color": "#ff2200", "opacity": 1})
        check("paint after refine", r.get("ok") and r["result"]["painted"] > 30,
              json.dumps(r.get("result", r))[:90])
    
        # ---- 3. budget refusal atomic + pass-boundary stop ---------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0}})
        t0 = mv("get_mesh_stats")["result"]["total"]["triangles"]
        r = mv("refine_region", {"center": [0, 0, 1], "radius": 2.5,
                                 "target_edge": 0.001, "max_triangles": 1000})
        if r.get("ok"):
            check("budget stop flagged", r["result"].get("budgetHit") is True,
                  json.dumps(r.get("result", {}))[:120])
        else:
            check("budget refusal teaches", "max_triangles" in str(r.get("error", "")),
                  str(r.get("error", ""))[:110])
            t1 = mv("get_mesh_stats")["result"]["total"]["triangles"]
            check("refusal is atomic", t1 == t0, f"{t0} -> {t1}")
        check("post-budget openEdges intact", open_edges() in (0, None), str(open_edges()))
    
        # ---- 4. no-op preserves state ------------------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 64, "heightSegments": 48}})
        mv("sculpt", {"tool": "draw", "center": [0, 1, 0], "radius": 0.3, "strength": 0.1})
        r = mv("refine_region", {"center": [0, 0, 1], "radius": 0.4, "target_edge": 5.0})
        check("no-op returns zero split", r.get("ok") and r["result"]["edgesSplit"] == 0,
              json.dumps(r.get("result", r))[:100])
        r = mv("reset")
        check("reset still undoes sculpt after no-op", r.get("ok"),
              str(r.get("error", ""))[:60])
    
        # ---- 5. guards ----------------------------------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0}})
        mv("begin_morph")
        mv("sculpt", {"tool": "inflate", "center": [0, 1, 0], "radius": 0.4, "strength": 0.1})
        mv("capture_morph", {"name": "bump"})
        mv("set_morph", {"name": "bump", "weight": 0.7})
        r = mv("refine_region", {"center": [0, 0, 1], "radius": 0.5, "detail_rel": 0.03})
        check("refuses under morph influence",
              not r.get("ok") and "morph" in str(r.get("error", "")).lower(),
              str(r.get("error", ""))[:80])
        mv("set_morph", {"name": "bump", "weight": 0})
        r = mv("refine_region", {"center": [0, 0, 1], "radius": 0.5, "detail_rel": 0.03})
        check("drops zero-weight morphs loudly",
              r.get("ok") and "DROPPED" in str(r["result"].get("note", "")),
              str(r.get("result", {}).get("note", ""))[:90])
    
        # ---- 6. sliver audit: refine+sculpt loop x4, then fix_mesh -------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 16, "heightSegments": 12}})
        for i in range(4):
            mv("refine_region", {"center": [0, 0, 1], "radius": 0.5 - 0.06 * i,
                                 "detail_rel": 0.05 / (i + 1)})
            mv("sculpt", {"tool": "draw", "center": [0, 0, 1], "radius": 0.3,
                          "strength": 0.03})
        fx = mv("fix_mesh", {"operations": ["degenerate"]})
        dropped = fx["result"]["operations"][0].get("removed",
                  fx["result"]["operations"][0].get("dropped", 0))
        check("loop makes no fix_mesh fodder", fx.get("ok") and dropped == 0,
              json.dumps(fx.get("result", {}))[:120])
        check("loop keeps mesh closed", open_edges() == 0, str(open_edges()))
    
        # ---- 7. export round-trip ------------------------------------------------
        r = mv("export_glb", {})
        check("refined mesh exports", r.get("ok"),
              str(r.get("error", ""))[:60])

        # ---- 8. regularize_region: stretched facets equalized --------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 32, "heightSegments": 24}})
        mv("sculpt", {"tool": "grab", "center": [0, 0, 1], "radius": 0.45,
                      "direction": [0, 0, 1], "strength": 0.9})
        oe0 = open_edges()
        r = mv("regularize_region", {"center": [0, 0, 1.5], "radius": 0.9})
        res = r.get("result", {})
        se = res.get("stretchedEdges", {})
        check("regularize reduces stretched edges", r.get("ok")
              and se.get("after", 99) < se.get("before", 0), json.dumps(se))
        check("regularize keeps mesh closed", open_edges() == oe0,
              f"{oe0} -> {open_edges()}")
        fx = mv("fix_mesh", {"operations": ["degenerate"]})
        check("regularize leaves no degenerates",
              fx["result"]["operations"][0].get("trianglesDropped") == 0,
              json.dumps(fx.get("result", {}))[:100])
        mv("fill_paint", {"color": "#cccccc", "texture_size": 512})
        r = mv("paint", {"center": [0, 0, 1.8], "radius": 0.25,
                         "color": "#ff3300", "opacity": 1})
        check("paint after regularize", r.get("ok")
              and r["result"]["painted"] > 10,
              json.dumps(r.get("result", r))[:80])
        # Seam safety on an atlas primitive.
        mv("unload")
        mv("add_primitive", {"kind": "box", "params": {}})
        mv("sculpt", {"tool": "grab", "center": [0.5, 0.5, 0.5], "radius": 0.6,
                      "direction": [1, 1, 1], "strength": 0.4})
        oe0 = open_edges()
        r = mv("regularize_region", {"center": [0.5, 0.5, 0.5], "radius": 1.0})
        check("regularize respects atlas seams", r.get("ok")
              and open_edges() == oe0, f"{oe0} -> {open_edges()}")

        # ---- 9. dig tool: crater, clamp, piercing guard, volume ------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 64, "heightSegments": 48}})
        v0 = mv("get_mesh_stats")["result"]["total"]["volume"]
        r = mv("sculpt", {"tool": "dig", "center": [0, 0, 1], "radius": 0.35,
                          "strength": 0.15})
        res = r.get("result", {})
        check("dig carves a crater", r.get("ok") and res.get("appliedDepth", 0) > 0.1,
              json.dumps({k: res.get(k) for k in ("appliedDepth", "affected")}))
        v1 = mv("get_mesh_stats")["result"]["total"]["volume"]
        check("dig removes volume, mesh closed", v1 < v0 and open_edges() == 0,
              f"vol {v0} -> {v1}, openEdges {open_edges()}")
        r = mv("sculpt", {"tool": "dig", "center": [0.7, 0, 0.7], "radius": 0.3,
                          "strength": 5})
        check("dig clamps depth with note", r.get("ok")
              and r["result"].get("appliedDepth", 9) <= 0.151
              and "cap" in str(r["result"].get("note", "")),
              str(r.get("result", {}).get("note", ""))[:80])
        mv("unload")
        mv("add_primitive", {"kind": "box", "params": {"width": 2, "height": 0.05,
                             "depth": 2, "segments": 32}})
        r = mv("sculpt", {"tool": "dig", "center": [0, 0.025, 0], "radius": 0.4,
                          "strength": 0.3, "direction": [0, -1, 0]})
        check("dig refuses to pierce a shell", not r.get("ok")
              and "pierce" in str(r.get("error", "")), str(r.get("error", ""))[:100])

        # ---- 10. sculpt quality advisory + remesh:auto ---------------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 32, "heightSegments": 24}})
        r = mv("sculpt", {"tool": "grab", "center": [0, 0, 1], "radius": 0.45,
                          "direction": [0, 0, 1], "strength": 0.9, "remesh": "auto"})
        res = r.get("result", {})
        mq = res.get("meshQuality", {})
        rm = res.get("remesh", {})
        check("meshQuality trigger + auto remesh",
              mq.get("needsRemesh") is True and "stretchedEdges" in rm,
              json.dumps(mq))
        check("auto remesh restores quality",
              rm.get("stretchedEdges", {}).get("after", 99) <= 2
              and (rm.get("valence567Share") or 0) > 0.8,
              json.dumps({"se": rm.get("stretchedEdges"),
                          "v": rm.get("valence567Share")}))
        check("remesh keeps mesh closed", open_edges() == 0, str(open_edges()))

        # ---- 11. full pipeline: collapse prunes pinch needles --------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 48, "heightSegments": 36}})
        for _ in range(3):
            mv("sculpt", {"tool": "pinch", "center": [0, 0, 1], "radius": 0.4,
                          "strength": 0.9})
        r = mv("regularize_region", {"center": [0, 0, 1], "radius": 0.6})
        check("collapse+flip fire on needles", r.get("ok")
              and r["result"].get("collapsed", 0) > 0
              and r["result"].get("flipped", 0) > 0,
              json.dumps({k: r.get("result", {}).get(k)
                          for k in ("collapsed", "flipped", "edgesSplit")}))
        fx = mv("fix_mesh", {"operations": ["degenerate"]})
        check("no degenerate fodder after full remesh",
              fx["result"]["operations"][0].get("trianglesDropped") == 0
              and open_edges() == 0,
              json.dumps(fx.get("result", {}))[:80])
    
        check("no page errors", not errors, "; ".join(errors)[:300])
        b.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
