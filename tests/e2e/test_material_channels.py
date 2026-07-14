"""E2E: material-channel painting + procedural patterns + noise sculpting.

The mid-band levers (retro gauntlet): per-texel roughness/metalness/emissive/
height, world-space deterministic patterns, and seeded fBm displacement.
"""
import pytest

_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright


@pytest.mark.e2e
def test_material_channels(mv_app):
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

        mv("add_primitive", {"kind": "sphere",
                             "params": {"radius": 0.5, "widthSegments": 64,
                                        "heightSegments": 48}})
        mv("fill_paint", {"color": "#8a8f96", "texture_size": 512})

        # ---- channel paints land + material wiring --------------------------
        r = mv("paint", {"center": [0, 0, 0.5], "radius": 0.25,
                         "channel": "roughness", "value": 0.05,
                         "opacity": 1, "hardness": 0.8})
        check("roughness paint lands", r.get("ok")
              and r["result"]["painted"] > 1000
              and r["result"].get("channel") == "roughness",
              str(r.get("result", r.get("error")))[:100])
        r = mv("paint", {"center": [0.4, 0, 0.3], "radius": 0.2,
                         "channel": "metalness", "value": 1,
                         "opacity": 1, "hardness": 0.8})
        check("metalness paint lands", r.get("ok"))
        r = mv("paint", {"center": [0, 0.45, 0], "radius": 0.15,
                         "channel": "emissive", "color": "#ff5500",
                         "opacity": 1})
        check("emissive paint lands", r.get("ok"))

        wiring = page.evaluate("""() => {
            const v = window.mv.viewer;
            let mat = null;
            v._activeEntry().model.traverse((c) => {
                if (c.isMesh && !mat) {
                    const s = c._mvOriginalMaterial || c.material;
                    mat = Array.isArray(s) ? s[0] : s;
                }
            });
            return { rough: !!mat.roughnessMap,
                     shared: mat.roughnessMap === mat.metalnessMap,
                     scalars: [mat.roughness, mat.metalness],
                     emissive: !!mat.emissiveMap };
        }""")
        check("rm share one canvas, scalars neutral",
              wiring["rough"] and wiring["shared"]
              and wiring["scalars"] == [1, 1] and wiring["emissive"],
              str(wiring))

        # ---- teaching refusal ------------------------------------------------
        r = mv("paint", {"center": [0, 0, 0.5], "radius": 0.1,
                         "channel": "roughness"})
        check("channel without value refused",
              not r.get("ok") and "value" in str(r.get("error")))

        # ---- patterns: deterministic, seam-continuous ------------------------
        r = mv("paint_pattern", {"type": "noise", "color": "#5a4632",
                                 "color2": "#8a7358", "seed": 7, "scale": 0.2})
        check("noise pattern paints", r.get("ok")
              and r["result"]["painted"] > 100000,
              str(r.get("result", {}).get("painted")))
        r = mv("paint_pattern", {"type": "grunge", "channel": "roughness",
                                 "value": 0.25, "value2": 0.95, "seed": 3})
        check("pattern on a channel", r.get("ok")
              and r["result"].get("channel") == "roughness")

        digest = """() => {
            const v = window.mv.viewer;
            let l = null;
            v._activeEntry().model.traverse((c) => {
                if (c.isMesh && !l) {
                    const s = c._mvOriginalMaterial || c.material;
                    const m = Array.isArray(s) ? s[0] : s;
                    l = m.userData._mvPaint;
                }
            });
            const d = l.ctx.getImageData(0, 0, 64, 64).data;
            let h = 0;
            for (let i = 0; i < d.length; i += 13) h = (h * 31 + d[i]) | 0;
            return h;
        }"""
        mv("paint_pattern", {"type": "cells", "color": "#222222",
                             "color2": "#dddddd", "seed": 42, "scale": 0.15})
        h1 = page.evaluate(digest)
        mv("paint_pattern", {"type": "cells", "color": "#222222",
                             "color2": "#dddddd", "seed": 42, "scale": 0.15})
        h2 = page.evaluate(digest)
        check("patterns are seed-deterministic", h1 == h2, f"{h1} vs {h2}")

        # ---- noise sculpt ----------------------------------------------------
        r = mv("sculpt", {"tool": "noise", "center": [0, 0, 0.5],
                          "radius": 0.3, "strength": 0.02,
                          "wavelength": 0.08, "octaves": 3, "seed": 5})
        check("noise sculpt displaces", r.get("ok")
              and r["result"]["affected"] > 50
              and r["result"]["maxDisplacement"] > 0.001,
              str(r.get("result", r.get("error")))[:100])

        # ---- export carries channels; clear restores -------------------------
        r = mv("export_glb", {})
        payload = r.get("result") if isinstance(r.get("result"), str) \
            else (r.get("result") or {}).get("dataUrl")
        check("export with channels ok", r.get("ok")
              and isinstance(payload, str) and len(payload) > 100000)
        r = mv("clear_paint", {})
        check("clear_paint ok", r.get("ok"))
        wiring2 = page.evaluate("""() => {
            const v = window.mv.viewer;
            let mat = null;
            v._activeEntry().model.traverse((c) => {
                if (c.isMesh && !mat) {
                    const s = c._mvOriginalMaterial || c.material;
                    mat = Array.isArray(s) ? s[0] : s;
                }
            });
            return { rough: !!mat.roughnessMap, emissive: !!mat.emissiveMap };
        }""")
        check("clear restores channel slots",
              not wiring2["rough"] and not wiring2["emissive"], str(wiring2))

        b.close()

    assert not FAIL, f"failed: {FAIL} (passed: {PASS})"
