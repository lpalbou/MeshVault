"""E2E: detect_symmetry + mirror_paint + undo_paint (26 checks).
Ported from the /tmp field harness (backlog 048). Run via scripts/e2e.sh.
"""
"""Headless smoke test for backlog 050: detect_symmetry + mirror_paint.

Verification is NUMERIC (canvas texel reads at raycast UVs), not visual:
  1. detect_symmetry on a sphere -> strong verdict, candidate numbers present.
  2. Two colored features on the RIGHT (+X) hemisphere (green at +Z, blue at -Z),
     mirror_paint on the LEFT -> texels at the mirrored positions carry the right
     colors (correspondence AND chirality: a flip bug would swap green/blue).
  3. Right side untouched (donor unchanged).
  4. Staleness: sculpt after detect -> mirror_paint auto-redetects (autoDetected).
  5. Explicit plane override works without a cached plane.
  6. Asymmetric sculpting degrades the x-plane score (regression direction).
"""
import json
import sys

import pytest
from playwright.sync_api import sync_playwright




@pytest.mark.e2e
def test_symmetry_heal(mv_app):
    base_url, token, _serve = mv_app
    PASS, FAIL = [], []
    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        page = browser.new_page(viewport={"width": 900, "height": 700},
                                extra_http_headers={"X-MeshVault-Token": token})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base_url + "/static/viewer.html", wait_until="load")
        page.wait_for_function("() => window.mv && window.mv.execute", timeout=45000)

        def mv(action, params=None):
            return page.evaluate(
                "([a, p]) => window.mv.execute({ action: a, params: p || {} })",
                [action, params or {}])

        def texel_at(direction):
            """RGB of the paint-layer texel where the ray from `direction`*3 hits."""
            return page.evaluate(
                """(dir) => {
                    const r = window.mv.execute({action:'raycast', params:{
                        origin: [dir[0]*3, dir[1]*3, dir[2]*3],
                        direction: [-dir[0], -dir[1], -dir[2]]}});
                    return r.then ? r.then(res => res) : r;
                }""", direction)

        # texel read: raycast for uv, then read the canvas pixel directly.
        def color_at(direction):
            return page.evaluate(
                """async (dir) => {
                    const res = await window.mv.execute({action:'raycast', params:{
                        origin: [dir[0]*3, dir[1]*3, dir[2]*3],
                        direction: [-dir[0], -dir[1], -dir[2]]}});
                    if (!res.ok || !res.result.hit || !res.result.uv) return {error: JSON.stringify(res).slice(0,150)};
                    const [u, v] = res.result.uv;
                    const viewer = window.mv.viewer;
                    const entry = viewer._activeEntry();
                    let layer = null;
                    entry.model.traverse(c => {
                        if (layer || !c.isMesh) return;
                        const stash = c._mvOriginalMaterial || c.material;
                        const m = Array.isArray(stash) ? stash[0] : stash;
                        if (m && m.userData && m.userData._mvPaint) layer = m.userData._mvPaint;
                    });
                    if (!layer) return {error: 'no paint layer'};
                    const x = Math.min(layer.size-1, Math.max(0, Math.round(u * layer.size)));
                    const y = Math.min(layer.size-1, Math.max(0, Math.round((layer.flipY ? 1-v : v) * layer.size)));
                    const d = layer.ctx.getImageData(x, y, 1, 1).data;
                    return {r: d[0], g: d[1], b: d[2], uv: [u, v]};
                }""", direction)

        # ---- setup: white sphere ------------------------------------------
        r = mv("add_primitive", {"kind": "sphere", "color": "#ffffff",
                                 "params": {"radius": 1.0, "widthSegments": 96,
                                            "heightSegments": 64}})
        check("sphere created", r.get("ok"), json.dumps(r)[:100])
        r = mv("fill_paint", {"color": "#c8c8c8", "texture_size": 1024})
        check("base fill", r.get("ok"), json.dumps(r)[:100])

        # ---- 1. detect_symmetry -------------------------------------------
        r = mv("detect_symmetry", {})
        ok = r.get("ok")
        res = r.get("result", {})
        check("detect_symmetry strong on sphere",
              ok and res.get("verdict") == "strong",
              json.dumps({k: res.get(k) for k in ("verdict", "medianDistRel", "normalAgreement")}))
        check("per-candidate numbers present",
              ok and len(res.get("candidates", [])) >= 3
              and all("medianDistRel" in c for c in res.get("candidates", [])),
              str(len(res.get("candidates", []))))

        # ---- 2. features on the right, heal the left ----------------------
        import math
        def on_sphere(v):
            n = math.sqrt(sum(x * x for x in v))
            return [x / n for x in v]

        RG = on_sphere([0.85, 0.30, 0.45])    # right, toward +Z
        RB = on_sphere([0.85, 0.30, -0.45])   # right, toward -Z
        r = mv("paint", {"center": RG, "radius": 0.22, "color": "#00c800",
                         "opacity": 1, "hardness": 0.9})
        check("green feature painted (right,+Z)", r.get("ok") and r["result"]["painted"] > 30,
              json.dumps(r.get("result", r))[:90])
        r = mv("paint", {"center": RB, "radius": 0.22, "color": "#0050ff",
                         "opacity": 1, "hardness": 0.9})
        check("blue feature painted (right,-Z)", r.get("ok") and r["result"]["painted"] > 30,
              json.dumps(r.get("result", r))[:90])

        L_CENTER = on_sphere([-0.85, 0.30, 0.0])
        r = mv("mirror_paint", {"center": L_CENTER, "radius": 0.75,
                                "strength": 1, "hardness": 0.9})
        res = r.get("result", {})
        check("mirror_paint healed", r.get("ok") and res.get("healed", 0) > 200,
              json.dumps(res)[:160])
        check("meanAlpha reported", r.get("ok") and res.get("meanAlpha", 0) > 0.5,
              str(res.get("meanAlpha")))

        LG = on_sphere([-0.85, 0.30, 0.45])   # mirror of RG (x flipped, z SAME)
        LB = on_sphere([-0.85, 0.30, -0.45])
        cg = color_at(LG)
        cb = color_at(LB)
        check("mirrored green at left,+Z (chirality)",
              "error" not in cg and cg["g"] > 140 and cg["g"] > cg["r"] + 60 and cg["g"] > cg["b"] + 60,
              json.dumps(cg))
        check("mirrored blue at left,-Z (chirality)",
              "error" not in cb and cb["b"] > 140 and cb["b"] > cb["g"] + 40 and cb["b"] > cb["r"] + 60,
              json.dumps(cb))

        # ---- 3. donor side unchanged --------------------------------------
        cr = color_at(RG)
        check("right donor unchanged",
              "error" not in cr and cr["g"] > 140,
              json.dumps(cr))

        # ---- 4. staleness: sculpt bumps geometryRev -> auto-redetect ------
        r = mv("sculpt", {"tool": "draw", "center": [0, 1.0, 0], "radius": 0.4,
                          "strength": 0.2})
        check("sculpt for staleness", r.get("ok"))
        r = mv("mirror_paint", {"center": on_sphere([-0.8, 0.35, 0.1]), "radius": 0.3,
                                "strength": 0.5})
        check("stale plane auto-redetected",
              r.get("ok") and r["result"].get("autoDetected") is True,
              json.dumps(r.get("result", r))[:140])

        # ---- 5. explicit plane override ------------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "box", "color": "#ffffff",
                             "params": {"width": 1, "height": 1, "depth": 1}})
        mv("fill_paint", {"color": "#d0d0d0", "texture_size": 512})
        mv("paint", {"center": [0.35, 0.2, 0.5], "radius": 0.15, "color": "#ff0000",
                     "opacity": 1, "hardness": 0.9})
        r = mv("mirror_paint", {"center": [-0.35, 0.2, 0.5], "radius": 0.25,
                                "plane": "x", "strength": 1})
        check("explicit plane override works",
              r.get("ok") and r["result"]["healed"] > 20,
              json.dumps(r.get("result", r))[:130])
        cm = color_at([-0.35 / 0.71, 0.2 / 0.71, 0.5 / 0.71])  # direction toward the face point
        # (box face +Z at z=0.5; ray from direction*3 toward origin hits +Z face)
        check("box mirrored red present",
              "error" not in cm and cm["r"] > 150 and cm["r"] > cm["g"] + 60,
              json.dumps(cm))

        # ---- 5b. cycle-2 gauntlet regressions -------------------------------
        # (a) on-plane brush: selfSourceFraction must be substantial + noted
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "color": "#ffffff",
                             "params": {"radius": 1.0}})
        mv("fill_paint", {"color": "#c0c0c0", "texture_size": 512})
        mv("paint", {"center": [0.5, 0.5, 0.7071], "radius": 0.3,
                     "color": "#00c800", "opacity": 1})
        r = mv("mirror_paint", {"center": [0, 0.2, 1.0], "radius": 0.4,
                                "plane": "x", "strength": 1})
        res = r.get("result", {})
        check("on-plane brush: selfSourceFraction is substantial",
              r.get("ok") and res.get("selfSourceFraction", 0) > 0.4,
              str(res.get("selfSourceFraction")))
        check("on-plane brush: note fires",
              r.get("ok") and "straddles" in str(res.get("note", "")),
              str(res.get("note", ""))[:80])

        # (b) explicit override reports a score and (weak) warns
        r = mv("mirror_paint", {"center": [0.4, 0.4, 0.75], "radius": 0.2,
                                "plane": "y", "strength": 0.8})
        res = r.get("result", {})
        check("explicit override echoes its score",
              r.get("ok") and "score" in res and "verdict" in res.get("score", {}),
              json.dumps(res.get("score", {})))

        # (c) undo_paint restores the mirrored texels
        before = color_at([0.5, 0.5, 0.7071])
        r = mv("mirror_paint", {"center": [0.5, 0.5, 0.7071], "radius": 0.25,
                                "plane": "z", "strength": 1})
        check("mirror for undo test", r.get("ok"), json.dumps(r)[:80])
        after = color_at([0.5, 0.5, 0.7071])
        r = mv("undo_paint", {})
        check("undo_paint restores patches",
              r.get("ok") and r["result"]["restoredPatches"] >= 1,
              json.dumps(r.get("result", r))[:90])
        restored = color_at([0.5, 0.5, 0.7071])
        check("undo restored the texel",
              "error" not in restored and abs(restored["g"] - before["g"]) <= 2
              and abs(restored["r"] - before["r"]) <= 2,
              f"{before} -> {after} -> {restored}")
        r = mv("undo_paint", {})
        check("undo slot is one-shot",
              not r.get("ok") and "Nothing to undo" in str(r.get("error", "")),
              str(r.get("error", ""))[:60])

        # (d) sub-texel brush: teaching error, not a bogus cross-mesh hint
        r = mv("mirror_paint", {"center": [0.5, 0.5, 0.7071], "radius": 0.0005,
                                "plane": "x"})
        err = str(r.get("error", ""))
        check("sub-texel brush error is honest",
              not r.get("ok") and "smaller than one texel" in err
              and "cross-mesh" not in err,
              err[:100])

        # ---- 6. asymmetry degrades the score -------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0}})
        base = mv("detect_symmetry", {})["result"]["medianDistRel"]
        r = mv("sculpt", {"tool": "draw", "center": on_sphere([0.7, 0.5, 0.3]),
                          "radius": 0.55, "strength": 1.0})
        check("asym sculpt ok", r.get("ok"))
        r = mv("sculpt", {"tool": "draw", "center": on_sphere([0.75, 0.4, 0.25]),
                          "radius": 0.5, "strength": 1.0})
        after = mv("detect_symmetry", {})["result"]
        check("asymmetric bump degrades best score",
              after["medianDistRel"] > base,
              f"{base} -> {after['medianDistRel']} (verdict {after['verdict']})")

        # ---- console/page errors -------------------------------------------
        check("no page errors", not errors, "; ".join(errors)[:200])

        browser.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
