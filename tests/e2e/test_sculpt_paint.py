"""E2E: sculpt / paint / pick agent loop (33 checks).
Ported from the /tmp field harness (backlog 048). Run via scripts/e2e.sh.
"""
"""Headless end-to-end smoke test of the sculpt/paint/pick agent loop.

Drives the standalone viewer harness (/static/viewer.html — the same window.mv
surface the MCP headless runtime drives). Verifies the adversary-driven fixes:
  1. add_primitive: honored color, param whitelist (typo -> error).
  2. sculpt: draw/inflate/smooth affect vertices, bounds grow, reset restores
     (accessor-decoded snapshots).
  3. paint: stamp lands, box UV atlas isolates faces (front red, back not),
     clear_paint restores, fill_paint floods.
  4. pick: screenshot-space -> world point with explicit aspect (width/height).
  5. manifest: primitive persists, unsavedPaint reported.
"""
import base64
import json
import struct
import sys
import zlib

import pytest
_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright





def png_red_fraction(data: bytes) -> float:
    """Fraction of decoded pixels that are strongly red (pure-python PNG walk)."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, w, h, idat, bpp = 8, 0, 0, b"", 4
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bit, color = struct.unpack(">IIBB", chunk[:10])
            assert bit == 8 and color in (2, 6), f"unsupported PNG {bit}/{color}"
            bpp = 3 if color == 2 else 4
        elif typ == b"IDAT":
            idat += chunk
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * bpp
    prev = bytearray(stride)
    p = 0
    red = total = 0
    for _row in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        for i in range(0, stride, bpp):
            r, g, b2 = line[i], line[i + 1], line[i + 2]
            total += 1
            if r > 130 and r > g + 60 and r > b2 + 60:
                red += 1
        prev = line
    return red / max(1, total)


@pytest.mark.e2e
def test_sculpt_paint(mv_app):
    base_url, token, _serve = mv_app
    PASS, FAIL = [], []
    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        page = browser.new_page(viewport={"width": 1000, "height": 800},
                                extra_http_headers={"X-MeshVault-Token": token})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base_url + "/static/viewer.html", wait_until="load")
        page.wait_for_function("() => window.mv && window.mv.execute", timeout=45000)

        def mv(action, params=None):
            return page.evaluate(
                "([a, p]) => window.mv.execute({ action: a, params: p || {} })",
                [action, params or {}])

        def shot() -> bytes:
            r = mv("screenshot", {"width": 512, "height": 512})
            assert r.get("ok"), r
            return base64.b64decode(r["result"].split(",", 1)[1])

        # ---- 1. primitives -------------------------------------------------
        r = mv("add_primitive", {"kind": "sphere", "color": "#111111",
                                 "params": {"radius": 1.0}})
        check("sphere created", r.get("ok"), json.dumps(r)[:120])
        desc = mv("describe_scene", {"maxItems": 2})
        mat = desc["result"]["materials"]["items"][0]
        check("dark color honored exactly (no _fixDarkColor clamp)",
              mat["color"] == "#111111", str(mat["color"]))

        r = mv("add_primitive", {"kind": "sphere", "params": {"radiu": 2}})
        check("param typo rejected", not r.get("ok") and "radiu" in str(r.get("error", "")),
              str(r.get("error", ""))[:80])

        # ---- 2. sculpt -----------------------------------------------------
        b0 = mv("get_bounds")["result"]
        r = mv("sculpt", {"tool": "draw", "center": [0, 1.0, 0], "radius": 0.5,
                          "strength": 0.4})
        check("sculpt draw affected vertices",
              r.get("ok") and r["result"]["affected"] > 30,
              json.dumps(r.get("result", r))[:100])
        b1 = mv("get_bounds")["result"]
        grew = b1["size"][1] > b0["size"][1] + 0.2
        check("bounds grew after draw (stats refreshed)", grew,
              f"y {b0['size'][1]:.3f} -> {b1['size'][1]:.3f}")

        r = mv("sculpt_stroke", {"tool": "inflate",
                                 "points": [[0.5, 0.5, 0.5], [0.6, 0.4, 0.5]],
                                 "radius": 0.4, "strength": 0.15})
        check("sculpt_stroke inflate ok", r.get("ok") and r["result"]["affected"] > 0,
              json.dumps(r)[:100])
        r = mv("sculpt", {"tool": "smooth", "center": [0, 1.0, 0], "radius": 0.6,
                          "strength": 0.8})
        check("smooth ok", r.get("ok") and r["result"]["affected"] > 0,
              json.dumps(r)[:100])

        r = mv("reset")
        b2 = mv("get_bounds")["result"]
        restored = abs(b2["size"][1] - b0["size"][1]) < 1e-3
        check("reset restored pre-sculpt geometry (accessor snapshot)",
              r.get("ok") and restored,
              f"y {b1['size'][1]:.3f} -> {b2['size'][1]:.3f} (orig {b0['size'][1]:.3f})")

        # miss -> teaching ERROR (agents must not burn a verify-render on a no-op)
        r = mv("sculpt", {"tool": "draw", "center": [99, 99, 99], "radius": 0.1})
        check("brush miss is a teaching error",
              not r.get("ok") and "center" in str(r.get("error", "")),
              str(r.get("error", ""))[:90])

        # radius_rel (scale-free addressing) + quantified newSize in returns
        r = mv("sculpt", {"tool": "inflate", "center": [0, 1.0, 0],
                          "radius_rel": 0.2, "strength": 0.05})
        check("radius_rel works and returns newSize",
              r.get("ok") and r["result"]["affected"] > 0
              and isinstance(r["result"].get("newSize"), list),
              json.dumps(r.get("result", r))[:110])
        mv("reset")

        # batch: several commands in one round-trip
        r = mv("batch", {"commands": [
            {"action": "sculpt", "params": {"tool": "draw", "center": [0, 1.0, 0],
                                            "radius": 0.4, "strength": 0.1}},
            {"action": "get_bounds"},
        ]})
        check("batch executes sequentially",
              r.get("ok") and r["result"]["completed"] == 2
              and all(x["ok"] for x in r["result"]["results"]),
              json.dumps(r.get("result", r))[:110])
        r = mv("batch", {"commands": [{"action": "batch", "params": {"commands": []}}]})
        check("batch cannot nest",
              r.get("ok") and not r["result"]["results"][0]["ok"],
              json.dumps(r.get("result", r))[:90])
        mv("reset")

        # ---- 3. paint + box UV atlas ----------------------------------------
        mv("unload")
        r = mv("add_primitive", {"kind": "box", "color": "#e8e8e8"})
        check("box created", r.get("ok"))
        # paint a red dot dead-center of the +Z face (box is 1x1x1 at origin)
        r = mv("paint", {"center": [0, 0, 0.5], "radius": 0.18, "color": "#ff0000"})
        check("paint stamp landed", r.get("ok") and r["result"]["painted"] > 50,
              json.dumps(r.get("result", r))[:120])

        mv("set_camera", {"position": [0, 0, 2.2], "target": [0, 0, 0]})
        front = png_red_fraction(shot())
        mv("set_camera", {"position": [0, 0, -2.2], "target": [0, 0, 0]})
        back = png_red_fraction(shot())
        check("UV atlas isolates faces (front painted, back clean)",
              front > 0.005 and back < front / 10,
              f"front {front:.4f}, back {back:.4f}")

        # manifest reports unsaved paint AND unsaved sculpt edits
        mv("sculpt", {"tool": "draw", "center": [0, 0.5, 0], "radius": 0.3,
                      "strength": 0.05})
        man = mv("get_scene_manifest")["result"]
        check("manifest lists unsavedPaint", len(man.get("unsavedPaint", [])) == 1,
              json.dumps(man.get("unsavedPaint")))
        check("manifest lists unsavedEdits (sculpt)",
              len(man.get("unsavedEdits", [])) == 1,
              json.dumps(man.get("unsavedEdits")))
        mv("reset")

        r = mv("clear_paint")
        check("clear_paint restored", r.get("ok") and r["result"]["clearedMeshes"] == 1,
              json.dumps(r)[:100])
        mv("set_camera", {"position": [0, 0, 2.2], "target": [0, 0, 0]})
        after_clear = png_red_fraction(shot())
        check("paint gone after clear_paint", after_clear < 0.002,
              f"red {after_clear:.4f}")

        r = mv("fill_paint", {"color": "#2244ff"})
        check("fill_paint ok", r.get("ok") and r["result"]["filledMeshes"] == 1,
              json.dumps(r)[:100])

        # ---- 3b. paint opacity honesty (T1 cycle-1 findings) -----------------
        # (a) meanAlpha reported; low-opacity soft paint flags near-invisibility.
        r = mv("paint", {"center": [0, 0, 0.5], "radius": 0.15, "color": "#ff0000",
                         "opacity": 0.04, "hardness": 0.1})
        check("low-opacity paint reports meanAlpha + warning note",
              r.get("ok") and r["result"].get("meanAlpha", 1) < 0.05
              and "invisible" in str(r["result"].get("note", "")),
              json.dumps(r.get("result", r))[:130])
        mv("clear_paint")
        # (b) plaid regression: overlapping soft stamps in ONE call must cap at
        # `opacity` (max-accumulate), not double-blend along triangle edges.
        # White base + red 0.5: green channel = 255*(1-a); double-blend would
        # push a to ~0.75 => g ~64. Assert min green stays near 128.
        mv("fill_paint", {"color": "#ffffff"})
        r = mv("paint_stroke", {"points": [[0, 0, 0.5], [0.04, 0, 0.5], [0.08, 0, 0.5]],
                                "radius": 0.15, "color": "#ff0000",
                                "opacity": 0.5, "hardness": 0.9})
        ming = page.evaluate("""() => {
            const v = window.mv.viewer;
            let ming = 255;
            v._currentModel.traverse((c) => {
                if (!c.isMesh) return;
                const m = c._mvOriginalMaterial || c.material;
                const layer = m && m.userData && m.userData._mvPaint;
                if (!layer) return;
                const d = layer.ctx.getImageData(0, 0, layer.size, layer.size).data;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i + 1] < ming) ming = d[i + 1];
                }
            });
            return ming;
        }""")
        check("overlapping stamps cap at opacity (no plaid double-blend)",
              r.get("ok") and 115 <= ming <= 140,
              f"min green {ming} (expect ~128 for a=0.5; ~64 would mean double-blend)")
        mv("clear_paint")

        # ---- 3c. shaped stamps + edge clamping (T2 cycle-2 findings) ---------
        # Square stamp on the box top must paint a crisp quad AND, with
        # max_normal_angle, must NOT wrap onto the side faces.
        mv("fill_paint", {"color": "#ffffff"})
        r = mv("paint", {"center": [0.45, 0.5, 0.45], "radius": 0.12,
                         "color": "#00aa00", "shape": "square", "hardness": 1,
                         "max_normal_angle": 45})
        sq = r.get("ok") and r["result"]["painted"] > 100
        # Inspect canvas: green must appear in the TOP-face atlas island only,
        # and at the requested sRGB value (g=170 for #00aa00 — a linear-space
        # blend would land at g=103). Box atlas rects follow the group order
        # +x,-x,+y,-y,+z,-z => top (+y) island: u in [2/3,1), texV in [0.5,1).
        regions = page.evaluate("""() => {
            const v = window.mv.viewer;
            let topG = 0, otherG = 0, maxGreen = 0;
            v._currentModel.traverse((m) => {
                if (!m.isMesh) return;
                const mat = m._mvOriginalMaterial || m.material;
                const layer = mat && mat.userData && mat.userData._mvPaint;
                if (!layer) return;
                const dim = layer.size;
                const d = layer.ctx.getImageData(0, 0, dim, dim).data;
                for (let py = 0; py < dim; py++) {
                    for (let px = 0; px < dim; px++) {
                        const o = (py * dim + px) * 4;
                        const green = d[o + 1] > 120 && d[o] < 100 && d[o + 2] < 100;
                        if (!green) continue;
                        if (d[o + 1] > maxGreen) maxGreen = d[o + 1];
                        const u = px / dim, texV = 1 - (py / dim);
                        if (u >= 2 / 3 && texV >= 0.5) topG++;
                        else otherG++;
                    }
                }
            });
            return { topG, otherG, maxGreen };
        }""")
        check("square stamp + edge clamp stays on the top face",
              sq and regions["topG"] > 100 and regions["otherG"] == 0,
              f"top-face texels {regions['topG']}, other-face {regions['otherG']}")
        check("paint blends in sRGB (color honored exactly)",
              regions["maxGreen"] >= 165,
              f"max green {regions['maxGreen']} (expect 170 for #00aa00; ~103 = linear-space bug)")

        # list_objects delta flags: painted (paint), sculpted (geometry), modified (union)
        objs = mv("list_objects")["result"]["objects"]
        box_obj = next(o for o in objs if o["active"])
        check("flags: paint-only object is painted+modified, NOT sculpted",
              box_obj.get("painted") and box_obj.get("modified")
              and not box_obj.get("sculpted"),
              json.dumps({k: box_obj.get(k) for k in ("painted", "sculpted", "modified")}))
        mv("sculpt", {"tool": "draw", "center": [0, 0.5, 0], "radius": 0.2,
                      "strength": 0.03})
        objs = mv("list_objects")["result"]["objects"]
        box_obj = next(o for o in objs if o["active"])
        check("flags: sculpt sets sculpted",
              box_obj.get("sculpted") and box_obj.get("modified"),
              json.dumps({k: box_obj.get(k) for k in ("painted", "sculpted", "modified")}))
        mv("reset")

        # parametric stroke path: circle band around the box (Y axis), one call
        r = mv("paint_stroke", {"path": {"type": "circle", "center": [0, 0, 0],
                                         "axis": [0, 1, 0], "radius": 0.5},
                                "radius": 0.1, "color": "#ff8800", "hardness": 1})
        check("parametric circle path paints a band in one call",
              r.get("ok") and r["result"]["stamps"] >= 16
              and r["result"]["painted"] > 1000,
              json.dumps(r.get("result", r))[:110])
        r = mv("paint_stroke", {"path": {"type": "line", "from": [-0.4, 0.5, 0],
                                         "to": [0.4, 0.5, 0]},
                                "radius": 0.08, "color": "#8800ff"})
        check("parametric line path works",
              r.get("ok") and 2 <= r["result"]["stamps"] <= 64,
              json.dumps(r.get("result", r))[:100])
        r = mv("paint_stroke", {"path": {"type": "circle", "center": [0, 0, 0]},
                                "points": [[0, 0, 0]], "radius": 0.1,
                                "color": "#ffffff"})
        check("points+path together rejected",
              not r.get("ok") and "not both" in str(r.get("error", "")),
              str(r.get("error", ""))[:80])
        mv("clear_paint")
        mv("fill_paint", {"color": "#2244ff"})

        # ---- 4. pick (with aspect correction) --------------------------------
        mv("set_camera", {"position": [0, 0, 2.2], "target": [0, 0, 0]})
        r = mv("pick", {"x": 0.5, "y": 0.5, "width": 512, "height": 512})
        hit = r.get("ok") and r["result"]["hit"]
        # camera looks at +Z face center from [0,0,2.2] -> expect z ~= 0.5
        zok = hit and abs(r["result"]["point"][2] - 0.5) < 0.05
        check("pick center hits +Z face", bool(zok),
              json.dumps(r.get("result", {}).get("point")))
        r = mv("raycast", {"origin": [0, 5, 0], "direction": [0, -1, 0]})
        check("raycast down hits top face",
              r.get("ok") and r["result"]["hit"]
              and abs(r["result"]["point"][1] - 0.5) < 0.05,
              json.dumps(r.get("result", {}))[:100])

        # off-model pick -> miss hint
        r = mv("pick", {"x": 0.02, "y": 0.02, "width": 512, "height": 512})
        check("pick miss returns hint", r.get("ok") and not r["result"]["hit"]
              and "hint" in r["result"], json.dumps(r)[:100])

        # ---- 5. scene manifest with primitive -------------------------------
        man = mv("get_scene_manifest")["result"]
        src = man["objects"][0]["source"]
        check("primitive persists in manifest",
              src["kind"] == "primitive" and src["primitive"] == "box",
              json.dumps(src)[:100])

        if errors:
            check("no page errors", False, "; ".join(errors)[:200])
        browser.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
