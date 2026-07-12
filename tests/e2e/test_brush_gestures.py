"""E2E: brush gesture semantics — cycle-2 regressions + undo_group ledger.
Ported from the /tmp field harnesses (backlog 048). Run via scripts/e2e.sh.
"""
import pytest
import json, sys, urllib.parse
from playwright.sync_api import sync_playwright
import json, sys


@pytest.mark.e2e
def test_ui_gesture_regressions(mv_app):
    base_url, token, _serve = mv_app
    PASS, FAIL = [], []
    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 900},
                                extra_http_headers={"X-MeshVault-Token": token})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base_url + "/", wait_until="load")
        page.wait_for_function("() => window.app && window.app._controlAPI", timeout=45000)
        def api(a, p=None):
            return page.evaluate(
                "([a,p]) => window.app._controlAPI.execute({action:a, params:p||{}})", [a, p or {}])
    
        api("add_primitive", {"kind": "sphere", "color": "#c0c0c0", "params": {"radius": 1.0}})
        api("frame_all")
        canvas = page.locator("#viewer-3d canvas")
        box = canvas.bounding_box()
        cx, cy = box["x"] + box["width"]/2, box["y"] + box["height"]/2
    
        # Bug 1: FPV toggle exits tool mode; nav icon honest after re-entry.
        page.click("#edit-toggle")
        page.click("#edit-tab-paint")
        page.click("#nav-mode-toggle")   # -> fpv
        page.wait_for_timeout(150)
        mode = page.evaluate("() => window.app._viewer._toolMode")
        check("FPV toggle exits tool mode", mode == "none", mode)
        panel_hidden = not page.locator("#edit-panel").is_visible()
        check("edit panel closed on FPV", panel_hidden)
        page.click("#edit-toggle")       # re-enter -> forces orbit
        page.wait_for_timeout(150)
        nav = page.evaluate("() => window.app._viewer.getNavMode()")
        btn_active = page.evaluate("() => document.getElementById('nav-mode-toggle').classList.contains('active')")
        check("edit entry forces orbit AND nav icon follows", nav == "orbit" and not btn_active,
              f"nav={nav} btnActive={btn_active}")
    
        # Bug 2: edit + lights panels both visible (no burial).
        page.click("#light-toggle")
        page.wait_for_timeout(100)
        overlap = page.evaluate("""() => {
            const a = document.getElementById('edit-panel').getBoundingClientRect();
            const b = document.getElementById('light-panel').getBoundingClientRect();
            const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            return w * h;
        }""")
        check("edit + lights panels no longer overlap", overlap == 0, f"overlap {overlap}px²")
        page.click("#light-toggle")
    
        # Bug 6: invert (dent) — sculpt inward: the surface point under the brush
        # must move CLOSER to the sphere center (radius shrinks).
        page.click("#edit-tab-sculpt")
        import math
        def center_pick():
            r = api("pick", {"x": 0.5, "y": 0.5,
                             "width": int(box["width"]), "height": int(box["height"])})
            return r["result"]
        p0 = center_pick()["point"]
        n0 = math.sqrt(sum(v*v for v in p0))
        page.click("#edit-invert")
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + 20, cy, steps=3)
        page.mouse.move(cx - 20, cy, steps=3)
        page.mouse.up()
        page.wait_for_timeout(400)
        p1 = center_pick()["point"]
        n1 = math.sqrt(sum(v*v for v in p1))
        check("invert carves a dent (surface receded)", n1 < n0 - 1e-4, f"|p| {n0:.4f} -> {n1:.4f}")
        page.click("#edit-invert")   # off
    
        # Bug 4 + 8: one long paint gesture = ONE undo unit; opacity composes.
        page.click("#edit-tab-paint")
        page.evaluate("() => { const el = document.querySelector('#edit-opacity'); el.value = '0.3'; el.dispatchEvent(new Event('input')); }")
        api("fill_paint", {"color": "#d0d0d0"})
        def sphere_color():
            r = api("pick", {"x": 0.5, "y": 0.5,
                             "width": int(box["width"]), "height": int(box["height"])})["result"]
            uv = r["uv"]
            return page.evaluate("""(uv) => {
                const v = window.app._viewer;
                let layer = null;
                v._activeEntry().model.traverse(c => {
                    if (layer || !c.isMesh) return;
                    const stash = c._mvOriginalMaterial || c.material;
                    const m = Array.isArray(stash) ? stash[0] : stash;
                    if (m && m.userData && m.userData._mvPaint) layer = m.userData._mvPaint;
                });
                const x = Math.min(layer.size-1, Math.round(uv[0]*layer.size));
                const y = Math.min(layer.size-1, Math.round((layer.flipY ? 1-uv[1] : uv[1])*layer.size));
                const d = layer.ctx.getImageData(x, y, 1, 1).data;
                return [d[0], d[1], d[2]];
            }""", uv)
        base = sphere_color()
        # slow wiggle over the same spot: many flush slices, same gesture
        page.mouse.move(cx, cy)
        page.mouse.down()
        for i in range(24):
            page.mouse.move(cx + (8 if i % 2 else -8), cy + (i % 3), steps=2)
            page.wait_for_timeout(55)
        page.mouse.up()
        page.wait_for_timeout(500)
        after = sphere_color()
        # opacity 0.3 of red over #d0d0d0: expected r stays ~208, g/b drop ~30%: ≈145.
        # compounding to ~0.94 alpha would push g/b down to ~13-40.
        composed = after[1] > 110
        check("gesture opacity composes (no compounding)", composed,
              f"{base} -> {after}")
        r = api("undo_paint", {})
        page.wait_for_timeout(150)
        restored = sphere_color()
        check("undo_paint undoes the WHOLE gesture",
              r.get("ok") and abs(restored[1] - base[1]) <= 3,
              f"restored {restored} vs base {base} (patches {r.get('result',{}).get('restoredPatches')})")
    
        # Bug 5: first key auto-sets duration -> scrub usable.
        api("clear_timeline")
        page.click("#timeline-key-btn")
        page.wait_for_timeout(400)
        tl = api("get_timeline")["result"]
        check("first key auto-sets a workable duration", (tl.get("duration") or 0) >= 5,
              str(tl.get("duration")))
    
        check("no page errors", not errors, "; ".join(errors)[:200])
        browser.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"


@pytest.mark.e2e
def test_undo_group_ledger(mv_app):
    base_url, token, _serve = mv_app
    PASS, FAIL = [], []
    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        page = b.new_page(viewport={"width": 800, "height": 600},
                      extra_http_headers={"X-MeshVault-Token": token})
        page.goto(base_url + "/static/viewer.html", wait_until="load")
        page.wait_for_function("() => window.mv && window.mv.execute")
        mv = lambda a, p=None: page.evaluate(
            "([a,p]) => window.mv.execute({action:a, params:p||{}})", [a, p or {}])
        mv("add_primitive", {"kind": "box", "color": "#ffffff"})
        mv("fill_paint", {"color": "#c8c8c8", "texture_size": 512})
        def texel():
            return page.evaluate("""() => {
                const v = window.mv.viewer;
                let layer = null;
                v._activeEntry().model.traverse(c => {
                    if (layer || !c.isMesh) return;
                    const stash = c._mvOriginalMaterial || c.material;
                    const m = Array.isArray(stash) ? stash[0] : stash;
                    if (m && m.userData && m.userData._mvPaint) layer = m.userData._mvPaint;
                });
                // +Z face center of unit box maps to its own atlas cell; find the
                // texel via a raycast pick uv.
                const r = window.mv.execute({action:'raycast',
                    params:{origin:[0,0,3], direction:[0,0,-1]}});
                return r.then ? r.then(async res => {
                    const [u, vv] = res.result.uv;
                    const x = Math.min(layer.size-1, Math.round(u * layer.size));
                    const y = Math.min(layer.size-1, Math.round((layer.flipY ? 1-vv : vv) * layer.size));
                    const d = layer.ctx.getImageData(x, y, 1, 1).data;
                    return [d[0], d[1], d[2]];
                }) : null;
            }""")
        base = texel()
        # 5 grouped stamps, same spot, opacity 0.3: composed total must stay ~0.3
        for i in range(5):
            r = mv("paint", {"center": [0, 0, 0.5], "radius": 0.2, "color": "#ff0000",
                             "opacity": 0.3, "undo_group": "g1"})
            assert r.get("ok"), r
        after = texel()
        # 0.3 red over gray-200: g ≈ 200*0.7 = 140. Compounded 5x (~0.83): g ≈ 34.
        check("grouped stamps compose to the target opacity", after[1] > 110,
              f"{base} -> {after}")
        # ungrouped control: 5 separate commands compound
        mv("clear_paint")
        mv("fill_paint", {"color": "#c8c8c8", "texture_size": 512})
        for i in range(5):
            mv("paint", {"center": [0, 0, 0.5], "radius": 0.2, "color": "#ff0000",
                         "opacity": 0.3})
        comp = texel()
        check("ungrouped commands still compound (per-command semantics)",
              comp[1] < 80, f"{comp}")
        # grouped undo restores across all 5 stamps
        mv("clear_paint")
        mv("fill_paint", {"color": "#c8c8c8", "texture_size": 512})
        base2 = texel()
        for i in range(5):
            mv("paint", {"center": [0, 0, 0.5], "radius": 0.15 + 0.02*i, "color": "#0040ff",
                         "opacity": 0.8, "undo_group": "g2"})
        r = mv("undo_paint", {})
        restored = texel()
        check("grouped undo restores all stamps",
              r.get("ok") and r["result"]["restoredPatches"] >= 5
              and abs(restored[1] - base2[1]) <= 2,
              f"patches {r.get('result',{}).get('restoredPatches')} {base2} -> {restored}")
        b.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
