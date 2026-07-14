"""E2E: merge_objects (mesh fusion) — union, seam blending, cross-boundary
sculpting, concat fallback, teaching refusals.

The advanced-sculpting contract: assemble primitives (draft) → merge_objects
→ sculpt/dig ACROSS old part boundaries → texture the fused skin.
"""
import pytest

_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright


@pytest.mark.e2e
def test_merge_objects(mv_app):
    base_url, token, _serve = mv_app
    PASS, FAIL = [], []

    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name
              + (f"  [{detail}]" if detail else ""))

    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        page = b.new_page(viewport={"width": 640, "height": 500},
                          extra_http_headers={"X-MeshVault-Token": token})
        page.goto(base_url + "/static/viewer.html", wait_until="load")
        page.wait_for_function("() => window.mv && window.mv.execute",
                               timeout=45000)
        mv = lambda a, p=None: page.evaluate(
            "([a,p]) => window.mv.execute({action:a, params:p||{}})",
            [a, p or {}])

        # ---- union of two overlapping spheres -------------------------------
        mv("add_primitive", {"kind": "sphere",
                             "params": {"radius": 0.4, "widthSegments": 48,
                                        "heightSegments": 36}, "name": "A"})
        mv("add_primitive", {"kind": "sphere",
                             "params": {"radius": 0.32, "widthSegments": 48,
                                        "heightSegments": 36}, "name": "B",
                             "transform": {"position": [0.45, 0.15, 0]}})
        r = mv("merge_objects", {"ids": [1, 2], "blend": 0.06, "name": "blob"})
        check("union ok", r.get("ok"), str(r.get("error"))[:120])
        res = r.get("result", {})
        check("sources removed, one object left",
              mv("list_objects")["result"]["objects"].__len__() == 1)
        check("seam blend reported",
              (res.get("seams") or {}).get("blended", 0) > 100,
              str(res.get("seams")))

        st = mv("get_mesh_stats")["result"]["total"]
        check("union nearly closed (T-junctions stitched)",
              st.get("openEdges", 9999) <= 8, f"openEdges {st.get('openEdges')}")

        # Sculpt ACROSS the old boundary — the whole point of fusion.
        r = mv("sculpt", {"tool": "draw", "center": [0.25, 0.2, 0.3],
                          "radius": 0.18, "strength": 0.03})
        check("cross-boundary sculpt lands",
              r.get("ok") and r["result"]["affected"] > 50,
              str(r.get("result", {}).get("affected")))
        st2 = mv("get_mesh_stats")["result"]["total"]
        check("sculpt tears nothing",
              st2.get("openEdges") == st.get("openEdges"),
              f"{st.get('openEdges')} -> {st2.get('openEdges')}")

        # Paint the fused skin (re-atlassed UVs).
        mv("fill_paint", {"color": "#8899aa", "texture_size": 512})
        r = mv("paint", {"center": [0.25, 0.2, 0.3], "radius": 0.15,
                         "color": "#ff4433", "opacity": 0.9})
        check("paint on fused surface", r.get("ok")
              and r["result"]["painted"] > 500,
              str(r.get("result", {}).get("painted")))

        # ---- dig across the seam (piercing guard must see ONE volume) -------
        r = mv("sculpt", {"tool": "dig", "center": [0.25, -0.1, 0.35],
                          "radius": 0.09, "strength": 0.03})
        check("dig on fused volume", r.get("ok"),
              str(r.get("error"))[:120])

        # ---- concat with open source never refuses ---------------------------
        mv("unload")
        mv("add_primitive", {"kind": "box", "params": {}, "name": "bx"})
        mv("add_primitive", {"kind": "plane", "params": {}, "name": "pl",
                             "transform": {"position": [0.6, 0, 0]}})
        r = mv("merge_objects", {"ids": [1, 2], "mode": "concat"})
        check("concat with open source ok", r.get("ok"),
              str(r.get("error"))[:120])

        # ---- union refuses open sources with a teaching error ----------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {}})
        mv("add_primitive", {"kind": "plane", "params": {},
                             "transform": {"position": [0.3, 0, 0]}})
        r = mv("merge_objects", {"ids": [1, 2]})
        check("union refuses open shell",
              not r.get("ok") and "open edges" in str(r.get("error")),
              str(r.get("error"))[:100])

        # ---- validation teaching errors ---------------------------------------
        r = mv("merge_objects", {"ids": [1]})
        check("needs two ids", not r.get("ok"))
        r = mv("merge_objects", {"ids": [1, 99]})
        check("unknown id refused", not r.get("ok")
              and "list_objects" in str(r.get("error")))

        b.close()

    assert not FAIL, f"failed: {FAIL} (passed: {PASS})"
