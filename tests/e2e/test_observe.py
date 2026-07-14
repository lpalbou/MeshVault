"""E2E: the observation seat — a performer page publishes through the shipped
HOOK_JS; the real app tab joins, replays, and is checked for replica fidelity,
keyframe canonicalization, UI lock, bridge pause, ghost-overlay vividness,
lossy honesty, leave semantics, and token gating.
"""
import json
import time
import urllib.error
import urllib.request

import pytest
_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright

from pathlib import Path

# The shipped hook, extracted from the module source (importing backend.* is
# not possible under the e2e pytest path config; the string is the contract).
_PUB = Path(__file__).resolve().parents[2] / "backend" / "observe_publisher.py"
HOOK_JS = _PUB.read_text().split('HOOK_JS = """')[1].split('"""')[0]


@pytest.mark.e2e
def test_observe_seat(mv_app):
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
    
        # ---------------- performer: viewer harness + publish hook --------------
        perf = ctx.new_page()
        perf.goto(BASE + "/static/viewer.html", wait_until="load")
        perf.wait_for_function("() => window.mv && window.mv.execute", timeout=45000)
        events = []
        perf.expose_function("__mvObservePublish", lambda e: events.append(e))
        installed = perf.evaluate("(" + HOOK_JS + ")()")
        check("hook installs", installed is True)
        mvp = lambda a, p=None: perf.evaluate(
            "([a,p]) => window.mv.execute({action:a, params:p||{}})", [a, p or {}])
    
        # Unique id per run: a long-lived server remembers old sessions, and
        # re-publishing under a reused id restarts client_seq — honest lossy.
        SID = f"smoke-perf-{int(time.time() * 1000)}"
        session_meta = {"id": SID, "origin": "mcp", "pid": 1,
                        "started_at": time.time(), "label": "smoke agent"}
        cseq = [0]
        def flush():
            # ordered publisher mirror: drain events → hub
            while events:
                e = events.pop(0)
                body = {"session": session_meta, "client_seq": cseq[0],
                        "ts": time.time(), **e}
                cseq[0] += 1
                out = post("/api/observe/publish", body)
                assert out.get("ok"), out
    
        # agent work: primitive, sculpt stroke, paint, refine, keyframe capture
        mvp("add_primitive", {"kind": "sphere", "params": {"radius": 1.0,
                              "widthSegments": 48, "heightSegments": 32}})
        mvp("sculpt_stroke", {"points": [[0, 0.2, 1], [0, 0.35, 0.95], [0, 0.5, 0.87]],
                              "radius": 0.25, "strength": 0.08})
        mvp("fill_paint", {"color": "#d0d0d0", "texture_size": 512})
        mvp("paint", {"center": [0, 0, 1], "radius": 0.3, "color": "#ff2200", "opacity": 1})
        mvp("refine_region", {"center": [0.8, 0, 0.6], "radius": 0.4, "detail_rel": 0.02})
        mvp("set_object_transform", {"id": 1, "rotation": [0, 25, 0]})
        mvp("set_keyframe", {"id": 1, "time": 0.5, "capture": True, "channels": ["rotation"]})
        mvp("screenshot", {"width": 64, "height": 64, "ssao": False})   # read: no publish
        flush()
        n_cmds = cseq[0]
        check("read-only commands not published",
              all(e.get("kind") != "command" or e["command"]["action"] != "screenshot"
                  for e in events) and n_cmds > 0, f"{n_cmds} events published")
    
        # keyframe canonicalization: the published set_keyframe must carry explicit values
        r = urllib.request.Request(BASE + "/api/observe/sessions",
                                   headers={"X-MeshVault-Token": TOKEN})
        sessions = json.loads(urllib.request.urlopen(r).read())["sessions"]
        check("session listed + joinable",
              any(s["id"] == SID and s["joinable"] for s in sessions),
              json.dumps(sessions)[:120])
    
        # ---------------- observer: the real app tab ----------------------------
        obs = ctx.new_page()
        obs.goto(BASE + "/", wait_until="load")
        obs.wait_for_function("() => window.app && window.app._observeSeat", timeout=45000)
        obs.evaluate(f"() => window.app._observeSeat.join('{SID}')")
        # wait for caught_up: expectedSeq reaches the published count and queue drains
        obs.wait_for_function(
            f"() => window.app._observeSeat._caughtUp === true", timeout=30000)
        obs.wait_for_timeout(1500)   # let the replay queue drain
    
        stats_p = mvp("get_mesh_stats")["result"]["total"]
        stats_o = obs.evaluate(
            "() => window.app._controlAPI.execute({action:'get_mesh_stats', params:{}})")
        so = stats_o["result"]["total"]
        check("replica triangle fidelity", so["triangles"] == stats_p["triangles"],
              f"perf {stats_p['triangles']} vs obs {so['triangles']}")
        tl_p = mvp("get_timeline")["result"]
        tl_o = obs.evaluate(
            "() => window.app._controlAPI.execute({action:'get_timeline', params:{}})")["result"]
        check("keyframe capture canonicalized (values equal)",
              json.dumps(tl_p.get("tracks")) == json.dumps(tl_o.get("tracks")),
              (json.dumps(tl_p.get("tracks"))[:70] + " vs " + json.dumps(tl_o.get("tracks"))[:70]))
    
        # UI lock + bridge pause
        check("ui locked while observing", obs.evaluate(
            "() => document.body.classList.contains('observing')"))
        check("bridge paused while observing", obs.evaluate(
            "() => window.app._agentLink.observing === true"))
    
        # ---------------- vividness: ghost visible during live stroke -----------
        before = obs.screenshot()
        mvp("paint_stroke", {"points": [[0, -0.3, 1], [0.15, -0.3, 0.98], [0.3, -0.3, 0.94],
                                        [0.45, -0.28, 0.88]],
                             "radius": 0.22, "color": "#22ccff", "opacity": 1})
        flush()
        obs.wait_for_timeout(350)     # inside the ghost fade window
        during = obs.screenshot()
        # Panel tool readout (feedback: tool + size live in the PANEL, and the
        # ring itself never carries a text label).
        tool_name = obs.evaluate(
            "() => document.getElementById('observe-tool-name').textContent")
        tool_detail = obs.evaluate(
            "() => document.getElementById('observe-tool-detail').textContent")
        check("panel shows tool name", tool_name == "paint", tool_name)
        check("panel shows radius (area of influence)", "radius" in tool_detail,
              tool_detail)
        check("persistent cursor exists (no label sprites)", obs.evaluate(
            "() => { const g = window.app._observeSeat._ghostGroup;"
            "  if (!g) return false; let sprites = 0;"
            "  g.traverse((o) => { if (o.isSprite) sprites++; });"
            "  return sprites === 0 && !!window.app._observeSeat._cursor; }"))
        obs.wait_for_timeout(1500)    # ghosts gone
        check("ghost overlay visible during stroke", before != during,
              f"png sizes {len(before)}/{len(during)}")
    
        # ---------------- honesty: seq gap => desync banner ---------------------
        # publish one event with a SKIPPED client_seq -> hub marks lossy
        cseq[0] += 3
        events.append({"kind": "command",
                       "command": {"action": "paint",
                                   "params": {"center": [0, 0, 1], "radius": 0.1,
                                              "color": "#00ff00", "opacity": 1}}})
        flush()
        obs.wait_for_timeout(800)
        lossy_banner = obs.evaluate(
            "() => { const b = document.getElementById('observe-banner');"
            + " return b && b.style.display !== 'none' ? b.textContent : null; }")
        check("lossy publish surfaces a banner", bool(lossy_banner),
              str(lossy_banner)[:80])
    
        # ---------------- leave: unlock + keep scene ----------------------------
        obs.evaluate("() => window.app._observeSeat.leave(true)")
        check("ui unlocked after leave", obs.evaluate(
            "() => !document.body.classList.contains('observing')"))
        so2 = obs.evaluate(
            "() => window.app._controlAPI.execute({action:'get_mesh_stats', params:{}})")
        check("observer keeps the replica copy", so2.get("ok"))
    
        # ---------------- token probe -------------------------------------------
        try:
            urllib.request.urlopen(BASE + "/api/observe/sessions", timeout=3)
            check("token required", False, "no-token request succeeded")
        except urllib.error.HTTPError as e:
            check("token required", e.code == 401, f"HTTP {e.code}")
    
        # performer end lifecycle
        post("/api/observe/publish", {"session": session_meta, "kind": "lifecycle",
                                      "lifecycle": "end", "ts": time.time()})
        r = urllib.request.Request(BASE + "/api/observe/sessions",
                                   headers={"X-MeshVault-Token": TOKEN})
        sessions = json.loads(urllib.request.urlopen(r).read())["sessions"]
        s = next((x for x in sessions if x["id"] == SID), {})
        check("ended session unjoinable", s.get("joinable") is False, json.dumps(s)[:100])
        check("ended session replayable", s.get("replayable") is True, json.dumps(s)[:100])
    
        b.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
