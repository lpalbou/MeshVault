"""E2E: human edit UI — arbitration, brushes, keyframe authoring (20 checks).
Ported from the /tmp field harness (backlog 048). Run via scripts/e2e.sh.
"""
"""Headless smoke test for backlog 054: human sculpt/paint/keyframe UI.

Drives the REAL app page (not the standalone harness) with trusted pointer
events, verifying the arbitration design:
  1. Edit panel opens; tabs switch mode; ESC exits.
  2. Sculpt drag on the model changes geometry (bounds grow) via the SAME
     control-API commands agents use; undo-gesture restores.
  3. Miss falls through to orbit (camera moves, geometry doesn't).
  4. Paint drag creates a paint layer (list_objects painted flag).
  5. Timeline bar visible with a model; Key button sets a key; tick appears;
     per-object delete removes it; duration clamps.
  6. Click-select guard: tool-mode click never retargets the active object.
"""
import json
import sys

import pytest
_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright




@pytest.mark.e2e
def test_edit_ui(mv_app):
    base_url, token, _serve = mv_app
    PASS, FAIL = [], []
    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        page = browser.new_page(
            viewport={"width": 1280, "height": 900},
            extra_http_headers={"X-MeshVault-Token": token})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base_url + "/", wait_until="load")
        page.wait_for_function("() => window.app && window.app._controlAPI",
                               timeout=45000)

        def api(action, params=None):
            return page.evaluate(
                "([a, p]) => window.app._controlAPI.execute({action: a, params: p || {}})",
                [action, params or {}])

        # ---- setup: a sphere via the agent surface --------------------------
        r = api("add_primitive", {"kind": "sphere", "color": "#c0c0c0",
                                  "params": {"radius": 1.0}})
        check("primitive added through app control API", r.get("ok"),
              json.dumps(r)[:100])
        api("frame_all")

        canvas = page.locator("#viewer-3d canvas")
        box = canvas.bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

        # ---- 1. edit mode lifecycle ----------------------------------------
        page.click("#edit-toggle")
        check("edit panel opens", page.locator("#edit-panel").is_visible())
        mode = page.evaluate("() => window.app._viewer._toolMode")
        check("sculpt mode active", mode == "sculpt", mode)

        # ---- 2. sculpt drag changes geometry -------------------------------
        def pos_checksum():
            return page.evaluate("""() => {
                const e = window.app._viewer._activeEntry();
                let s = 0, n = 0;
                e.model.traverse(c => {
                    if (!c.isMesh || n) return;
                    const p = c.geometry.getAttribute('position');
                    for (let i = 0; i < p.count; i++) s += p.getX(i) + p.getY(i) + p.getZ(i);
                    n = 1;
                });
                return s;
            }""")
        s0 = pos_checksum()
        page.mouse.move(cx, cy)
        page.mouse.down()
        for i in range(1, 14):
            page.mouse.move(cx + i * 8, cy + (i % 3) * 4, steps=2)
        page.mouse.up()
        page.wait_for_timeout(400)   # let the last flush land
        s1 = pos_checksum()
        check("sculpt drag displaced geometry", abs(s1 - s0) > 1e-4,
              f"checksum {s0:.5f} -> {s1:.5f}")
        status = page.text_content("#edit-sculpt-status") or ""
        check("sculpt status line updated", "affected" in status, status[:60])

        # undo the gesture
        page.click("#edit-undo")
        page.wait_for_timeout(150)
        s2 = pos_checksum()
        check("undo gesture restored geometry", abs(s2 - s0) < 1e-4,
              f"checksum {s2:.5f} vs {s0:.5f}")

        # ---- 3. miss falls through to orbit --------------------------------
        cam0 = api("get_camera")["result"]["position"]
        # Empty space clear of the sphere AND the panels: the edit panel now
        # docks top-LEFT, the toolbar column top-right — use the upper area
        # between them.
        edge_x = box["x"] + box["width"] * 0.72
        edge_y = box["y"] + 50
        page.mouse.move(edge_x, edge_y)
        page.mouse.down()
        page.mouse.move(edge_x + 140, edge_y + 90, steps=6)
        page.mouse.up()
        page.wait_for_timeout(120)
        cam1 = api("get_camera")["result"]["position"]
        moved = any(abs(cam1[i] - cam0[i]) > 1e-3 for i in range(3))
        check("miss falls through to orbit (camera moved)", moved,
              f"{[round(x,2) for x in cam0]} -> {[round(x,2) for x in cam1]}")

        # ---- 4. paint tab ----------------------------------------------------
        page.click("#edit-tab-paint")
        mode = page.evaluate("() => window.app._viewer._toolMode")
        check("paint mode via tab", mode == "paint", mode)
        api("frame_all")
        page.mouse.move(cx, cy)
        page.mouse.down()
        for i in range(1, 10):
            page.mouse.move(cx - i * 7, cy + i * 3, steps=2)
        page.mouse.up()
        page.wait_for_timeout(400)
        objs = api("list_objects")["result"]["objects"]
        check("paint drag created a paint layer", any(o.get("painted") for o in objs),
              json.dumps(objs)[:120])

        # ---- 5. timeline authoring ------------------------------------------
        check("timeline bar visible with model",
              page.locator("#timeline-bar").is_visible())
        check("empty hint shown before first key",
              page.locator("#timeline-empty-hint").is_visible())
        page.click("#timeline-key-btn")
        page.wait_for_timeout(300)
        tl = api("get_timeline")["result"]
        keyed = tl.get("tracks") and len(tl["tracks"]) >= 1
        check("Key button created a keyframe", bool(keyed), json.dumps(tl)[:140])
        page.wait_for_timeout(300)
        ticks = page.locator(".timeline-tick").count()
        check("tick rendered", ticks >= 1, str(ticks))

        # duration clamp: try to set duration below the last key
        page.fill("#timeline-duration", "0.1")
        page.dispatch_event("#timeline-duration", "change")
        page.wait_for_timeout(200)
        tl2 = api("get_timeline")["result"]
        check("duration clamped to last key",
              (tl2.get("duration") or 0) >= (tl.get("tracks")[0]["keys"][0]["t"]
                                             if tl.get("tracks") and tl["tracks"][0].get("keys")
                                             else 0),
              str(tl2.get("duration")))

        # per-object tick delete via context menu
        page.locator(".timeline-tick").first.dispatch_event("contextmenu")
        page.wait_for_timeout(150)
        rows = page.locator(".timeline-tick-menu-row").count()
        check("tick context menu lists per-object rows", rows >= 1, str(rows))
        if rows:
            page.locator(".timeline-tick-menu-row").first.click()
            page.wait_for_timeout(250)
            tl3 = api("get_timeline")["result"]
            empty = not tl3.get("tracks")
            check("tick delete removed the key", empty, json.dumps(tl3)[:120])

        # ---- 6. click-select guard in tool mode ------------------------------
        api("add_primitive", {"kind": "box", "color": "#3050ff",
                              "params": {"width": 0.5, "height": 0.5, "depth": 0.5},
                              })
        api("set_object_transform", {"id": 2, "position": [2.2, 0, 0]})
        api("set_active_object", {"id": 1})
        api("frame_all")
        page.click("#edit-tab-sculpt")
        # click directly on the sphere (active obj 1) — must stamp, not select
        active0 = page.evaluate("() => window.app._viewer._activeObjectId")
        page.mouse.click(cx - 100, cy)
        page.wait_for_timeout(200)
        active1 = page.evaluate("() => window.app._viewer._activeObjectId")
        check("tool-mode click never re-selects", active0 == active1,
              f"{active0} -> {active1}")

        # ESC exits
        page.keyboard.press("Escape")
        mode = page.evaluate("() => window.app._viewer._toolMode")
        check("ESC exits tool mode", mode == "none", mode)
        check("panel hidden after ESC", not page.locator("#edit-panel").is_visible())

        # ---- page errors -----------------------------------------------------
        check("no page errors", not errors, "; ".join(errors)[:300])
        browser.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
