"""E2E: cut-face capping (backlog 051) — numeric closure, winding sanity,
pre-existing holes never sealed, parts-mode refusal.
"""
import base64
import json

import pytest
_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright


@pytest.mark.e2e
def test_capping(mv_app):
    base_url, token, _serve = mv_app

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
    
        # ---- 1. capped sphere cut: both sides watertight --------------------
        mv("add_primitive", {"kind": "sphere", "color": "#c08040",
                             "params": {"radius": 1.0, "widthSegments": 48, "heightSegments": 32}})
        mv("fill_paint", {"color": "#c08040", "texture_size": 512})
        mv("paint", {"center": [0, 0.4, 0.9], "radius": 0.4, "color": "#2050ff", "opacity": 1})
        r = mv("split_object", {"axis": "y", "at": 0.3, "cap": True, "name": "top"})
        res = r.get("result", {})
        check("capped split ok", r.get("ok"), json.dumps(r)[:150])
        capped = res.get("capped", {})
        check("cap report present", "part" in capped and "remaining" in capped,
              json.dumps(capped)[:200])
        check("part watertight after cap", capped.get("part", {}).get("openEdges") == 0,
              str(capped.get("part")))
        check("remainder watertight after cap",
              capped.get("remaining", {}).get("openEdges") == 0,
              str(capped.get("remaining")))
        check("cap triangles reported",
              capped.get("part", {}).get("capTriangles", 0) > 10
              and capped.get("remaining", {}).get("capTriangles", 0) > 10,
              f"part {capped.get('part',{}).get('capTriangles')} rem {capped.get('remaining',{}).get('capTriangles')}")
    
        # winding sanity: closed meshes with positive volume (fix_mesh's
        # flipped_faces gate is armed on closed meshes — inverted caps would
        # flip signed volume negative)
        stats = mv("get_mesh_stats")["result"]
        vol_part = stats["total"].get("volume")
        check("part volume positive (winding sane)", vol_part is not None and vol_part > 0,
              str(vol_part))
        mv("set_active_object", {"id": 1})
        stats = mv("get_mesh_stats")["result"]
        vol_rem = stats["total"].get("volume")
        check("remainder volume positive", vol_rem is not None and vol_rem > 0,
              str(vol_rem))
    
        # ---- 2. renders: open lid must show NO black void ------------------
        mv("set_active_object", {"id": 2})
        mv("set_pivot", {"id": 2, "point": [0, 0.3, -0.9]})
        mv("set_object_transform", {"id": 2, "rotation": [-50, 0, 0]})
        mv("orbit", {"azimuth": 25, "elevation": 25, "scope": "scene"})
        shot = mv("screenshot", {"width": 420, "height": 420, "ssao": False})
        assert len(base64.b64decode(shot["result"].split(",", 1)[1])) > 1000
        check("render captured", shot.get("ok"))
    
        # ---- 3. explicit cap:false opt-out (regression; plane cuts now cap
        # by default after the 051 field verdict) ------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0}})
        r = mv("split_object", {"axis": "y", "at": 0.2, "cap": False})
        res = r.get("result", {})
        check("uncapped split keeps openEdgesAdded", res.get("openEdgesAdded", 0) > 0,
              str(res.get("openEdgesAdded")))
        check("uncapped note mentions cap:true", "cap:true" in str(res.get("note", "")),
              str(res.get("note", ""))[:80])
        check("no capped block when cap:false", "capped" not in res)

        # ---- 3c. plane cuts CAP BY DEFAULT (051 field verdict) ---------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0}})
        r = mv("split_object", {"axis": "y", "at": 0.2})
        res = r.get("result", {})
        check("default plane split caps",
              "capped" in res
              and res["capped"]["part"]["openEdges"] == 0
              and res["capped"]["remaining"]["openEdges"] == 0,
              json.dumps(res.get("capped", {}))[:120])
        # parts-mode still refuses only EXPLICIT cap:true; default is no-cap
        mv("unload")
    
        # ---- 3b. box cut: axis-aligned rims project with collinear runs ------
        # (ear-clip legitimately fails there; the centroid-fan fallback must
        # guarantee closure anyway)
        mv("unload")
        mv("add_primitive", {"kind": "box", "params": {"width": 1, "height": 1, "depth": 1}})
        r = mv("split_object", {"axis": "y", "at": 0.1, "cap": True})
        res = r.get("result", {})
        cp = res.get("capped", {})
        check("box cut: both sides closed",
              cp.get("part", {}).get("openEdges") == 0
              and cp.get("remaining", {}).get("openEdges") == 0,
              json.dumps(cp)[:160])
        stats = mv("get_mesh_stats")["result"]
        check("box part volume positive", (stats["total"].get("volume") or 0) > 0,
              str(stats["total"].get("volume")))
    
        # ---- 4. cap on parts-mode split refused -------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "box", "params": {}})
        r = mv("detect_parts")
        pid = r["result"]["partitionId"]
        r = mv("split_object", {"parts": [0], "partitionId": pid, "cap": True})
        check("cap refused for parts mode",
              not r.get("ok") and "PLANE" in str(r.get("error", "")),
              str(r.get("error", ""))[:90])
    
        # ---- 5. pre-existing holes never sealed -------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "plane", "params": {"width": 2, "height": 2}})
        r = mv("split_object", {"axis": "x", "at": 0, "cap": True})
        res = r.get("result", {})
        # A plane is ALL boundary: its rim edges pre-exist, only the cut line is new.
        part_open = res.get("capped", {}).get("part", {}).get("openEdges")
        check("plane split: pre-existing boundary NOT sealed",
              r.get("ok") and part_open is not None and part_open > 0,
              f"part openEdges {part_open}")
    
        check("no page errors", not errors, "; ".join(errors)[:200])
        b.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"


@pytest.mark.e2e
def test_capping_fixes(mv_app):
    base_url, token, _serve = mv_app

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
    
        # (BUG-1) anchor UVs: after a capped cut, ALL cap vertices of a loop share
        # ONE uv — verify directly on the geometry.
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 32, "heightSegments": 24}})
        r = mv("split_object", {"axis": "y", "at": 0.2, "cap": True})
        check("capped split ok", r.get("ok"))
        uv_spread = page.evaluate("""() => {
            const v = window.mv.viewer;
            const entry = v._activeEntry();   // new part
            let g = null;
            entry.model.traverse(c => { if (!g && c.isMesh) g = c.geometry; });
            const uv = g.getAttribute('uv');
            const idx = g.getIndex();
            // cap verts = appended at the end; find them via normal == cap normal?
            // simpler: cap vertices are those beyond the original count — the cap
            // loop shares one uv, so the UNIQUE uv count among the last N verts
            // (N = loop length + maybe centroid) should be 1.
            const total = uv.count;
            const uniq = new Set();
            // scan the last 60 vertices (loop ~32 verts + fan centroid)
            for (let i = Math.max(0, total - 60); i < total; i++) {
                uniq.add(uv.getX(i).toFixed(6) + '_' + uv.getY(i).toFixed(6));
            }
            return uniq.size;
        }""")
        # the last 60 include some original rim-wall verts too; the cap block itself
        # is single-uv — spread must be tiny (<= a handful), NOT ~60.
        check("cap UVs collapsed to anchor", uv_spread <= 30, f"unique uvs in tail: {uv_spread}")
    
        # (BUG-2) fix_mesh degenerate pass must NOT reopen capped rims
        stats0 = mv("get_mesh_stats")["result"]["total"]
        r = mv("fix_mesh", {"operations": ["degenerate"]})
        res = r.get("result", {})
        oe = res.get("issues", {}).get("openEdges", {})
        check("fix_mesh does not reopen caps",
              r.get("ok") and oe.get("after", 99) == 0,
              json.dumps(oe))
    
        # (BUG-4 + torus) multi-loop cut: 2 loops per side
        mv("unload")
        mv("add_primitive", {"kind": "torus", "params": {"radius": 1.0, "tube": 0.3}})
        r = mv("split_object", {"axis": "y", "at": 0.0, "cap": True})
        cp = r.get("result", {}).get("capped", {})
        check("torus cut: 2 loops per side",
              cp.get("part", {}).get("loops") == 2 and cp.get("remaining", {}).get("loops") == 2,
              json.dumps(cp)[:150])
        check("torus sides closed",
              cp.get("part", {}).get("openEdges") == 0 and cp.get("remaining", {}).get("openEdges") == 0,
              json.dumps(cp)[:100])
        check("uvMode measured", cp.get("uvMode") in ("rim-sample", "none", "mixed"),
              str(cp.get("uvMode")))
    
        check("no page errors", not errors, "; ".join(errors)[:200])
        b.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"


@pytest.mark.e2e
def test_capping_field_fixes(mv_app):
    base_url, token, _serve = mv_app

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
    
        # ---- B1: re-split THROUGH an existing cap -----------------------------
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 48, "heightSegments": 32}})
        r = mv("split_object", {"axis": "y", "at": 0.2, "cap": True, "name": "top"})
        check("first capped split ok",
              r.get("ok") and r["result"]["capped"]["part"]["openEdges"] == 0,
              json.dumps(r.get("result", {}).get("capped", {}))[:100])
        # the new part (top, id 2) is active — cut IT vertically through its cap
        r = mv("split_object", {"axis": "x", "at": 0.0, "cap": True, "name": "top_right"})
        res = r.get("result", {})
        cp = res.get("capped", {})
        check("re-split through cap: part closed",
              r.get("ok") and cp.get("part", {}).get("openEdges") == 0,
              json.dumps(cp.get("part", {}))[:120])
        check("re-split through cap: REMAINDER closed (B1)",
              cp.get("remaining", {}).get("openEdges") == 0
              and cp.get("remaining", {}).get("skippedEdges") == 0,
              json.dumps(cp.get("remaining", {}))[:120])
        stats = mv("get_mesh_stats")["result"]["total"]
        check("re-split part volume positive", (stats.get("volume") or 0) > 0,
              str(stats.get("volume")))
        mv("set_active_object", {"id": 2})
        stats = mv("get_mesh_stats")["result"]["total"]
        check("re-split remainder volume positive", (stats.get("volume") or 0) > 0,
              str(stats.get("volume")))
    
        # ---- B2: caps accept paint --------------------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0}})
        mv("fill_paint", {"color": "#c0c0c0", "texture_size": 512})
        r = mv("split_object", {"axis": "y", "at": 0.0, "cap": True})
        check("split for paint test", r.get("ok"))
        # top half active; its cap faces -y at y=0 → brush at the cap center
        r = mv("paint", {"center": [0, 0, 0], "radius": 0.3, "color": "#ff2200",
                         "opacity": 1})
        check("paint lands on a cap (B2)",
              r.get("ok") and r["result"]["painted"] >= 1,
              json.dumps(r.get("result", r))[:110])
    
        # ---- B3 sanity: anchor picking doesn't break untextured/painted meshes -
        # (functional: capped split still closes when a paint layer exists)
        mv("unload")
        mv("add_primitive", {"kind": "box", "params": {}})
        mv("fill_paint", {"color": "#8080ff", "texture_size": 256})
        r = mv("split_object", {"axis": "y", "at": 0.1, "cap": True})
        cp = r.get("result", {}).get("capped", {})
        check("painted-box capped split closed",
              r.get("ok") and cp.get("part", {}).get("openEdges") == 0
              and cp.get("remaining", {}).get("openEdges") == 0,
              json.dumps(cp)[:140])
    
        check("no page errors", not errors, "; ".join(errors)[:300])
        b.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
