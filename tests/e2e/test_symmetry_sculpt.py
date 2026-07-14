"""E2E: mirror-symmetric sculpt/paint (`symmetry` param).

The contract: symmetry:"x" reflects every stamp across the active object's
LOCAL x=0 plane — points, direction, pivot/axis all reflected, hinge angle
negated — so bilateral work needs ONE call and the two sides match exactly.
"""
import pytest

_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright


@pytest.mark.e2e
def test_symmetry_sculpt_paint(mv_app):
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

        def bounds():
            return mv("get_bounds")["result"]

        # ---- 1. symmetric grab moves BOTH flanks equally --------------------
        mv("add_primitive", {"kind": "sphere",
                             "params": {"radius": 0.5, "widthSegments": 64,
                                        "heightSegments": 48}})
        b0 = bounds()
        r = mv("sculpt", {"tool": "grab", "center": [0.5, 0, 0],
                          "radius": 0.3, "strength": 0.2,
                          "direction": [1, 0, 0], "symmetry": "x"})
        check("symmetric grab ok + stamps doubled",
              r.get("ok") and r["result"]["stamps"] == 2,
              str(r.get("result", r.get("error")))[:120])
        b1 = bounds()
        grew_pos = b1["max"][0] - b0["max"][0]
        grew_neg = b0["min"][0] - b1["min"][0]
        check("both flanks grew equally (mirrored direction)",
              grew_pos > 0.1 and abs(grew_pos - grew_neg) < 1e-6,
              f"+x {grew_pos:.4f} vs -x {grew_neg:.4f}")

        # ---- 2. symmetric hinge stays bilateral (angle negated) -------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere",
                             "params": {"radius": 0.5, "widthSegments": 64,
                                        "heightSegments": 48}})
        r = mv("sculpt", {"tool": "hinge", "center": [0.45, 0.15, 0],
                          "radius": 0.25, "pivot": [0.45, 0, 0],
                          "axis": [0, 0, 1], "angle_deg": 25,
                          "symmetry": "x"})
        b2 = bounds()
        check("symmetric hinge keeps bilateral bounds",
              r.get("ok") and abs(abs(b2["min"][0]) - abs(b2["max"][0])) < 1e-6,
              f"min {b2['min'][0]:.4f} max {b2['max'][0]:.4f}")

        # ---- 3. symmetric paint covers ~double the texels --------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere",
                             "params": {"radius": 0.5, "widthSegments": 64,
                                        "heightSegments": 48}})
        mv("fill_paint", {"color": "#888888", "texture_size": 512})
        one = mv("paint", {"center": [0.5, 0, 0], "radius": 0.12,
                           "color": "#ff2200", "opacity": 1, "hardness": 0.9})
        both = mv("paint", {"center": [0.5, 0.25, 0], "radius": 0.12,
                            "color": "#ff2200", "opacity": 1, "hardness": 0.9,
                            "symmetry": "x"})
        ratio = (both.get("result", {}).get("painted", 0)
                 / max(1, one.get("result", {}).get("painted", 1)))
        check("symmetric paint lands both sides",
              one.get("ok") and both.get("ok") and 1.5 < ratio < 2.6,
              f"ratio {ratio:.2f}")

        # ---- 4. invalid axis refused by the schema ---------------------------
        r = mv("sculpt", {"tool": "draw", "center": [0.5, 0, 0],
                          "radius": 0.2, "symmetry": "w"})
        check("bad symmetry axis refused",
              not r.get("ok") and "symmetry" in str(r.get("error", "")),
              str(r.get("error"))[:100])

        b.close()

    assert not FAIL, f"failed: {FAIL} (passed: {PASS})"
