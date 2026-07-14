"""E2E: field-gauntlet fix regressions — F1-1 refine→simplify corruption
(link condition + degenerate/fold-over gates in the collapse), F1-2 dropped-
morph phantoms (unconditional dictionary cleanup), F1-3 budget-resume livelock
(nextPassNeeds), F2-1/F2-2 observe-join scene destruction (validate before
unload; unknown_session handled; refusal toast outlives leave).
"""
import json
import time
import urllib.request

import pytest
_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright


@pytest.mark.e2e
def test_field_gauntlet_fixes(mv_app):
    BASE, TOKEN, _serve = mv_app

    PASS, FAIL = [], []
    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))

    def post(path, body):
        req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "X-MeshVault-Token": TOKEN})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())

    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        ctx = b.new_context(viewport={"width": 700, "height": 550},
                            extra_http_headers={"X-MeshVault-Token": TOKEN})
        page = ctx.new_page()
        page.goto(BASE + "/static/viewer.html", wait_until="load")
        page.wait_for_function("() => window.mv && window.mv.execute", timeout=45000)
        mv = lambda a, p=None: page.evaluate(
            "([a,p]) => window.mv.execute({action:a, params:p||{}})", [a, p or {}])
        def issues():
            r = mv("get_mesh_stats")["result"]["total"]
            return r.get("openEdges"), r.get("triangles")
    
        # ---- F1-1: refine -> simplify same region stays clean -------------------
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 24, "heightSegments": 16}})
        r = mv("refine_region", {"center": [0, 0, 1], "radius": 0.4, "target_edge": 0.03})
        check("refine clean", r.get("ok") and issues()[0] == 0, str(issues()))
        r = mv("simplify_region", {"center": [0, 0, 1], "radius": 0.4, "ratio": 0.12})
        oe, tris = issues()
        check("F1-1: simplify on refined topology keeps openEdges 0",
              r.get("ok") and oe == 0, f"openEdges {oe}, achieved {r.get('result', {}).get('achievedRatio')}")
        fx = mv("fix_mesh", {"operations": ["degenerate"]})
        dropped = fx["result"]["operations"][0].get("trianglesDropped", -1)
        oe2, _ = issues()
        check("F1-1: no degenerate fodder, fix_mesh no-op",
              dropped == 0 and oe2 == 0, f"dropped {dropped}, openEdges {oe2}")
        # gentler ratio too
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 24, "heightSegments": 16}})
        mv("refine_region", {"center": [0, 0, 1], "radius": 0.4, "target_edge": 0.03})
        r = mv("simplify_region", {"center": [0, 0, 1], "radius": 0.4, "ratio": 0.3})
        check("F1-1: ratio 0.3 clean too", r.get("ok") and issues()[0] == 0, str(issues()))
    
        # ---- F1-2: no morph phantom after refine drop ---------------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0}})
        mv("begin_morph")
        mv("sculpt", {"tool": "inflate", "center": [0, 1, 0], "radius": 0.4, "strength": 0.1})
        mv("capture_morph", {"name": "bump"})
        r = mv("refine_region", {"center": [0, 0, 1], "radius": 0.4, "detail_rel": 0.03})
        check("refine drops morphs loudly", "DROPPED" in str(r.get("result", {}).get("note", "")))
        r = mv("set_morph", {"name": "bump", "weight": 1})
        check("F1-2: dropped morph NOT addressable",
              not r.get("ok") and "begin_morph" in str(r.get("error", "")),
              str(r.get("error", r.get("result")))[:90])
        objs = mv("list_objects")["result"]["objects"]
        check("F1-2: no phantom in list_objects", not objs[0].get("morphs"),
              json.dumps(objs[0].get("morphs")))
        r = mv("sculpt", {"tool": "draw", "center": [0, 0, 1], "radius": 0.3, "strength": 0.05})
        check("F1-2: sculpt not bricked", r.get("ok"), str(r.get("error", ""))[:70])
        # same for simplify_region drop
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                             "widthSegments": 48, "heightSegments": 32}})
        mv("begin_morph")
        mv("sculpt", {"tool": "inflate", "center": [0, 1, 0], "radius": 0.4, "strength": 0.1})
        mv("capture_morph", {"name": "b2"})
        mv("simplify_region", {"center": [0, 1, 0], "radius": 0.6, "ratio": 0.4})
        r = mv("set_morph", {"name": "b2", "weight": 1})
        check("F1-2: simplify drop leaves no phantom either", not r.get("ok"),
              str(r.get("error", r.get("result")))[:80])
    
        # ---- F1-3: budget resume contract ---------------------------------------
        mv("unload")
        mv("add_primitive", {"kind": "sphere", "params": {"radius": 1.0}})
        r = mv("refine_region", {"center": [0, 0, 1], "radius": 0.4,
                                 "target_edge": 0.03, "max_triangles": 1000})
        res = r.get("result", {})
        if r.get("ok") and res.get("budgetHit"):
            need = res.get("nextPassNeeds")
            check("F1-3: budgetHit names the needed budget", isinstance(need, (int, float)) and need > 0,
                  json.dumps(res)[:120])
            r2 = mv("refine_region", {"center": [0, 0, 1], "radius": 0.4,
                                      "target_edge": 0.03, "max_triangles": int(need)})
            check("F1-3: re-issue with named budget progresses",
                  r2.get("ok") and (r2["result"]["edgesSplit"] > 0 or r2["result"].get("passes", 0) > 0
                                    or "no changes" in str(r2["result"].get("note", ""))),
                  json.dumps(r2.get("result", r2))[:110])
        else:
            check("F1-3: error names the needed budget",
                  not r.get("ok") and "max_triangles ≥" in str(r.get("error", "")),
                  str(r.get("error", ""))[:110])
    
        # ---- F2-1/F2-2: join safety ---------------------------------------------
        app = ctx.new_page()
        app.goto(BASE + "/", wait_until="load")
        app.wait_for_function("() => window.app && window.app._observeSeat", timeout=45000)
        app.evaluate("() => window.app._controlAPI.execute({action:'add_primitive',"
                     " params:{kind:'torus', params:{}}})")
        app.wait_for_timeout(400)
        tris0 = app.evaluate("() => window.app._controlAPI.execute("
                             "{action:'get_mesh_stats', params:{}})")["result"]["total"]["triangles"]
        app.evaluate("() => window.app._observeSeat.join('does-not-exist-42')")
        app.wait_for_timeout(1200)
        st = app.evaluate("""() => ({
            observing: window.app._observeSeat.observing,
            locked: document.body.classList.contains('observing'),
        })""")
        r1 = app.evaluate("() => window.app._controlAPI.execute({action:'get_mesh_stats', params:{}})")
        tris1 = None
        try: tris1 = r1["result"]["total"]["triangles"]
        except Exception: pass
        check("F2-1: unknown session preserves the scene", tris1 == tris0,
              f"{tris0} -> {tris1}")
        check("F2-1: seat not stuck observing/locked",
              st["observing"] is False and st["locked"] is False, json.dumps(st)[:90])
    
        # Ended sessions are REPLAYABLE recordings now (user ask): joining one
        # replays the full log and ends with an explicit banner — never hangs,
        # never refuses a complete log. UNIQUE session id per run: reusing an
        # id against a long-lived server restarts client_seq at 0 and the hub
        # honestly marks the session lossy.
        sid = f"smoke-ended-{int(time.time() * 1000)}"
        meta = {"id": sid, "origin": "mcp", "pid": 1,
                "started_at": time.time(), "label": "ended"}
        post("/api/observe/publish", {"session": meta, "client_seq": 0, "ts": time.time(),
            "kind": "command", "command": {"action": "add_primitive",
            "params": {"kind": "box", "params": {}}}})
        post("/api/observe/publish", {"session": meta, "kind": "lifecycle",
                                      "lifecycle": "end", "ts": time.time()})
        app.evaluate(f"() => window.app._observeSeat.join('{sid}')")
        app.wait_for_timeout(1500)
        st2 = app.evaluate("""() => ({
            observing: window.app._observeSeat.observing,
            bulk: !!window.app._viewer._bulkReplay,
            bar: document.getElementById('observe-replay-bar').style.display,
            pos: window.app._observeSeat._pos,
            log: window.app._observeSeat._log.length,
        })""")
        objs = app.evaluate("() => window.app._controlAPI.execute("
                            "{action:'list_objects', params:{}})")
        names = [o.get("name") for o in objs.get("result", {}).get("objects", [])]
        check("F2-2': ended session replays as a recording",
              st2["observing"] is True and any("box" in str(n) for n in names),
              json.dumps({"names": names, "st": st2})[:140])
        check("F2-2': replay bar shown, playhead at end (no hang)",
              st2["bar"] == "flex" and st2["pos"] == st2["log"] and st2["log"] > 0,
              json.dumps(st2)[:120])
        check("F2-2': rendering resumed after fast-forward", st2["bulk"] is False)
        app.evaluate("() => window.app._observeSeat.leave(false)")
    
        b.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
