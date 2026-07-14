"""E2E: sculpt_sweep (one weight field per stroke) + bake_ao (cavity grounding).

Sweeps kill stamp-chain beading: constant cross-section along the curve,
majority-side guard on thin sheets. bake_ao grounds paint into crevices.
"""
import pytest

_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright


@pytest.mark.e2e
def test_sweep_and_ao(mv_app):
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

        def ray(origin, direction):
            r = mv("raycast", {"origin": origin, "direction": direction})
            res = r.get("result") or {}
            return res.get("point") if res.get("hit") else None

        # ---- panel line on a slab: crease cuts top, bottom stays ------------
        mv("add_primitive", {"kind": "box",
                             "params": {"width": 1, "height": 0.3,
                                        "depth": 0.6, "segments": 64}})
        r = mv("sculpt_sweep", {
            "path": {"type": "line", "from": [-0.45, 0.15, 0],
                     "to": [0.45, 0.15, 0]},
            "radius": 0.03, "strength": -0.02, "profile": "crease"})
        check("crease sweep lands", r.get("ok")
              and r["result"]["affected"] > 200
              and r["result"]["profile"] == "crease",
              str(r.get("result", r.get("error")))[:110])
        groove = ray([0, 2, 0], [0, -1, 0])
        check("groove cut into the top", groove and groove[1] < 0.1455,
              str(groove))
        bottom = ray([0, -2, 0], [0, 1, 0])
        check("majority-side guard: bottom intact",
              bottom and abs(bottom[1] + 0.15) < 1e-4, str(bottom))

        # ---- symmetric ridge ring: crest raised on BOTH mirrored rings ------
        r = mv("sculpt_sweep", {
            "path": {"type": "circle", "center": [0.25, 0.15, 0],
                     "axis": [0, 1, 0], "radius": 0.12},
            "radius": 0.025, "strength": 0.015, "profile": "round",
            "symmetry": "x"})
        check("symmetric ring sweep", r.get("ok"))
        # Probe the ring's z-extreme — clear of the groove cut along the
        # x-axis at z=0 (probing there measures groove+ridge overlap).
        crest_p = ray([0.25, 2, 0.12], [0, -1, 0])
        crest_m = ray([-0.25, 2, 0.12], [0, -1, 0])
        check("both mirrored crests raised",
              crest_p and crest_m and crest_p[1] > 0.152
              and abs(crest_p[1] - crest_m[1]) < 0.004,
              f"{crest_p} vs {crest_m}")

        st = mv("get_mesh_stats")["result"]
        total = st.get("total") or st
        check("mesh closed after sweeps", total.get("openEdges") == 0)

        r = mv("sculpt_sweep", {"points": [[0, 0, 0], [1, 0, 0]],
                                "radius": 0.05, "strength": 0})
        check("zero strength refused",
              not r.get("ok") and "non-zero" in str(r.get("error")))

        # ---- bake_ao ---------------------------------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere",
                             "params": {"radius": 0.5, "widthSegments": 64,
                                        "heightSegments": 48}})
        mv("fill_paint", {"color": "#a08a6a", "texture_size": 512})
        r = mv("bake_ao", {"strength": 0.6})
        check("uniform curvature refused (nothing visible)",
              not r.get("ok") and "curvature" in str(r.get("error")))
        mv("sculpt_stroke", {"path": {"type": "circle", "center": [0, 0, 0],
                                      "axis": [0, 0, 1], "radius": 0.35},
                             "tool": "dig", "radius": 0.08, "strength": 0.05})
        r = mv("bake_ao", {"strength": 0.7, "highlight": 0.3})
        check("cavity bake lands", r.get("ok")
              and r["result"]["method"] == "curvature"
              and r["result"]["shadedTexels"] > 500,
              str(r.get("result", r.get("error")))[:110])
        r = mv("undo_paint", {})
        check("bake_ao undoable", r.get("ok")
              and r["result"]["undone"] == "bake_ao")

        b.close()

    assert not FAIL, f"failed: {FAIL} (passed: {PASS})"
