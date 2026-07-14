"""E2E: deform_region (taper/bend/twist/stretch) + bake_normals (height→normal).

The closed-form deformers replace grab salvos; the bake turns painted height
into shading-visible micro-relief.
"""
import pytest

_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright


@pytest.mark.e2e
def test_deform_and_bake(mv_app):
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

        # ---- taper: tip narrows, base anchored, mesh stays closed ------------
        mv("add_primitive", {"kind": "capsule",
                             "params": {"radius": 0.3, "length": 1.0,
                                        "capSegments": 24,
                                        "radialSegments": 48}})

        def flank(y):
            r = mv("raycast", {"origin": [2, y, 0], "direction": [-1, 0, 0]})
            return r["result"]["point"][0] if r["result"].get("hit") else None

        tip0, base0 = flank(0.45), flank(-0.45)
        r = mv("deform_region", {"kind": "taper",
                                 "axis": {"from": [0, 0, 0], "to": [0, 0.8, 0]},
                                 "factor": 0.35})
        check("taper ok", r.get("ok") and r["result"]["affected"] > 500,
              str(r.get("result", r.get("error")))[:100])
        tip1, base1 = flank(0.45), flank(-0.45)
        check("tip narrowed, base anchored",
              tip1 < tip0 * 0.7 and abs(base1 - base0) < 1e-3,
              f"tip {tip0}->{tip1}, base {base0}->{base1}")
        st = mv("get_mesh_stats")["result"]["total"]
        check("taper keeps mesh closed", st.get("openEdges") == 0)

        # ---- bend leans the top --------------------------------------------
        r = mv("deform_region", {"kind": "bend",
                                 "axis": {"from": [0, 0, 0], "to": [0, 0.8, 0]},
                                 "angle_deg": 45, "direction": [0, 0, 1]})
        check("bend ok", r.get("ok"))
        bb = mv("get_bounds")["result"]
        check("bend leaned the shape", bb["size"][0] > 0.62,
              str(bb["size"]))

        # ---- twist + stretch + teaching errors ------------------------------
        check("twist ok", mv("deform_region", {
            "kind": "twist", "axis": {"from": [0, -0.5, 0], "to": [0, 0.5, 0]},
            "angle_deg": 60}).get("ok"))
        check("stretch ok", mv("deform_region", {
            "kind": "stretch", "axis": {"from": [0, -0.5, 0], "to": [0, 0.5, 0]},
            "factor": 0.3}).get("ok"))
        r = mv("deform_region", {"kind": "bend",
                                 "axis": {"from": [0, 0, 0], "to": [0, 1, 0]},
                                 "angle_deg": 30, "direction": [0, 1, 0]})
        check("parallel bend axis refused",
              not r.get("ok") and "parallel" in str(r.get("error")))

        # ---- bake_normals: refusal without height, wiring with ---------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere",
                             "params": {"radius": 0.5, "widthSegments": 48,
                                        "heightSegments": 32}})
        mv("fill_paint", {"color": "#8a6a4a", "texture_size": 512})
        r = mv("bake_normals", {})
        check("bake without height refused",
              not r.get("ok") and "height" in str(r.get("error")))
        mv("paint_pattern", {"type": "cells", "channel": "height",
                             "value": 0.2, "value2": 0.8, "seed": 5,
                             "scale": 0.12})
        r = mv("bake_normals", {"strength": 3})
        check("bake ok", r.get("ok") and r["result"]["bakedMeshes"] == 1,
              str(r.get("result", r.get("error")))[:100])
        wired = page.evaluate("""() => {
            let mat = null;
            window.mv.viewer._activeEntry().model.traverse((c) => {
                if (c.isMesh && !mat) {
                    const s = c._mvOriginalMaterial || c.material;
                    mat = Array.isArray(s) ? s[0] : s;
                }
            });
            return !!mat.normalMap;
        }""")
        check("normalMap wired", wired)
        r = mv("clear_paint", {})
        check("clear_paint ok after bake", r.get("ok"))

        b.close()

    assert not FAIL, f"failed: {FAIL} (passed: {PASS})"
