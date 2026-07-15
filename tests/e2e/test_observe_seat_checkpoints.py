"""E2E: the observation SEAT consumes checkpoints — live joins restore the
newest snapshot and replay only the tail; recording seeks route through the
nearest checkpoint instead of re-executing history (the x-wing freeze fix).
"""
import base64
import io
import json
import time
import urllib.parse
import urllib.request
import zipfile

import pytest
_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright

from pathlib import Path

_SRC = (Path(__file__).resolve().parents[2] / "backend"
        / "observe_publisher.py").read_text()
HOOK_JS = _SRC.split('HOOK_JS = """')[1].split('"""')[0]
PULL_JS = _SRC.split('_PULL_CHECKPOINT_JS = """')[1].split('"""')[0]


@pytest.mark.e2e
def test_seat_checkpoint_join_and_seek(mv_app):
    BASE, TOKEN, _serve = mv_app
    PASS, FAIL = [], []

    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name
              + (f"  [{detail}]" if detail else ""))

    def api(path, data=None, headers=None):
        h = {"X-MeshVault-Token": TOKEN}
        if headers:
            h.update(headers)
        req = urllib.request.Request(BASE + path, data=data, headers=h)
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.headers.get("Content-Type", ""), r.read()

    def post_json(path, body):
        _, raw = api(path, data=json.dumps(body).encode(),
                     headers={"Content-Type": "application/json"})
        return json.loads(raw)

    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        ctx = b.new_context(viewport={"width": 700, "height": 550},
                            extra_http_headers={"X-MeshVault-Token": TOKEN})

        # ---------------- performer with the shipped hook --------------------
        perf = ctx.new_page()
        perf.goto(BASE + "/static/viewer.html", wait_until="load")
        perf.wait_for_function("() => window.mv && window.mv.execute",
                               timeout=45000)
        events = []
        perf.expose_function("__mvObservePublish", lambda e: events.append(e))
        perf.evaluate("() => { window.__mvObserveConfig = { accrualRate: 1.0 }; }")
        assert perf.evaluate("(" + HOOK_JS + ")()") is True
        mvp = lambda a, p=None: perf.evaluate(
            "([a,p]) => window.mv.execute({action:a, params:p||{}})", [a, p or {}])

        SID = f"smoke-seatck-{int(time.time() * 1000)}"
        session_meta = {"id": SID, "origin": "mcp", "pid": 1,
                        "started_at": time.time(), "label": "seat ckpt smoke"}
        cseq = [0]
        ck_posts = []

        def flush():
            while events:
                e = events.pop(0)
                if e.get("kind") == "checkpoint_ready":
                    token = e["checkpoint"]["token"]
                    payload = perf.evaluate("(" + PULL_JS + ")", token)
                    assert payload
                    buf = io.BytesIO()
                    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
                        for blob in payload["blobs"]:
                            zf.writestr(f"obj_{blob['id']}.glb",
                                        base64.b64decode(blob["b64"]))
                        zf.writestr("manifest.json", json.dumps(payload["manifest"]))
                    _, raw = api("/api/observe/checkpoint?session="
                                 + urllib.parse.quote(SID), data=buf.getvalue(),
                                 headers={"Content-Type": "application/zip"})
                    out = json.loads(raw)
                    assert out.get("ok"), out
                    ck_posts.append(out)
                    continue
                body = {"session": session_meta, "client_seq": cseq[0],
                        "ts": time.time(), **e}
                cseq[0] += 1
                out = post_json("/api/observe/publish", body)
                assert out.get("ok"), out

        # Scene: two objects, hierarchy, paint, keyframes — then pad to the
        # 40-mutation floor so a checkpoint lands.
        mvp("add_primitive", {"kind": "sphere",
                              "params": {"radius": 1.0, "widthSegments": 48,
                                         "heightSegments": 32}})
        mvp("add_primitive", {"kind": "cylinder",
                              "params": {"radius": 0.3, "height": 1.2}})
        mvp("set_object_transform", {"id": 2, "position": [1.6, 0, 0],
                                     "rotation": [0, 0, 20]})
        mvp("set_parent", {"id": 2, "parent_id": 1})
        mvp("set_active_object", {"id": 1})
        mvp("fill_paint", {"color": "#d0d0d0", "texture_size": 512})
        mvp("set_keyframe", {"id": 1, "time": 1, "rotation": [0, 90, 0]})
        for i in range(40):
            mvp("paint", {"center": [0, -0.2 + i * 0.01, 1], "radius": 0.12,
                          "color": "#3355aa", "opacity": 0.8})
            perf.wait_for_timeout(10)
            flush()
            if ck_posts:
                break
        check("floor checkpoint captured", len(ck_posts) == 1, json.dumps(ck_posts))

        # HEAVY phase (the x-wing scenario): a genuinely expensive remesh.
        # The monster rule captures a checkpoint right after it, so seeks
        # past this point must RESTORE instead of re-executing ~10s.
        mvp("set_active_object", {"id": 1})
        mvp("refine_region", {"center": [0, 0, 1], "radius": 1.2,
                              "detail_rel": 0.008, "max_triangles": 300000})
        mvp("regularize_region", {"center": [0, 0, 1], "radius": 1.2,
                                  "detail_rel": 0.008})
        perf.wait_for_timeout(100)
        flush()
        check("monster checkpoint captured", len(ck_posts) >= 2,
              json.dumps(ck_posts))
        ck_seq = ck_posts[-1]["seq"]

        # Post-checkpoint tail: a visible paint + a transform + a NEW object
        # (id continuity through the restored counter).
        mvp("paint", {"center": [0, 0.4, 0.9], "radius": 0.25,
                      "color": "#ff2200", "opacity": 1})
        mvp("set_object_transform", {"id": 2, "position": [1.9, 0.2, 0]})
        mvp("add_primitive", {"kind": "box", "params": {"width": 0.4,
                              "height": 0.4, "depth": 0.4}})
        perf.wait_for_timeout(50)
        flush()

        # ---------------- live join → restore + tail ------------------------
        obs = ctx.new_page()
        obs.goto(BASE + "/", wait_until="load")
        obs.wait_for_function("() => window.app && window.app._observeSeat",
                              timeout=45000)
        t0 = time.time()
        obs.evaluate(f"() => window.app._observeSeat.join('{SID}')")
        obs.wait_for_function(
            "() => window.app._observeSeat._caughtUp === true", timeout=30000)
        obs.wait_for_timeout(1200)
        join_s = time.time() - t0
        check("live join used the checkpoint",
              obs.evaluate("() => window.app._observeSeat._restoredFrom") == ck_seq,
              f"restoredFrom={obs.evaluate('() => window.app._observeSeat._restoredFrom')}"
              f" expected {ck_seq}; join {join_s:.1f}s")
        stats_p = mvp("get_mesh_stats")["result"]["total"]
        stats_o = obs.evaluate(
            "() => window.app._controlAPI.execute({action:'get_mesh_stats', params:{}})")
        so = stats_o["result"]["total"]
        check("replica fidelity after restore+tail",
              so["triangles"] == stats_p["triangles"],
              f"perf {stats_p['triangles']} vs obs {so['triangles']}")
        objs_o = obs.evaluate(
            "() => window.app._controlAPI.execute({action:'list_objects', params:{}})"
        )["result"]["objects"]
        check("tail id continuity (new box = performer's id)",
              any(o["id"] == 3 for o in objs_o),
              json.dumps([o["id"] for o in objs_o]))
        pos2 = obs.evaluate(
            "() => { const e = window.app._observeSeat._viewer._objects"
            ".find((o) => o.id === 2); return e ? e.logical.p.toArray() : null; }")
        check("tail transform applied", pos2 == [1.9, 0.2, 0], str(pos2))
        check("no replay errors",
              obs.evaluate("() => window.app._observeSeat._replayErrors") == 0)

        # ---------------- end session → recording seek via checkpoint --------
        post_json("/api/observe/publish", {"session": session_meta,
                                           "kind": "lifecycle",
                                           "lifecycle": "end",
                                           "ts": time.time()})
        obs.evaluate("() => window.app._observeSeat.leave(true)")
        obs.wait_for_timeout(300)
        t1 = time.time()
        obs.evaluate(f"() => window.app._observeSeat.join('{SID}')")
        obs.wait_for_function(
            "() => window.app._observeSeat._recording === true"
            " && window.app._observeSeat._pos"
            "      === window.app._observeSeat._log.length"
            " && window.app._observeSeat._log.length > 0"
            " && !window.app._observeSeat._seekBusy", timeout=30000)
        load_s = time.time() - t1
        check("recording end-jump used a checkpoint",
              obs.evaluate("() => window.app._observeSeat._restoredFrom") is not None,
              f"load {load_s:.1f}s")
        so3 = obs.evaluate(
            "() => window.app._controlAPI.execute({action:'get_mesh_stats', params:{}})"
        )["result"]["total"]
        check("recording end state fidelity",
              so3["triangles"] == stats_p["triangles"],
              f"{so3['triangles']} vs {stats_p['triangles']}")

        # Backward scrub to just AFTER the checkpoint: must restore, not
        # rebuild from zero.
        ck_idx = obs.evaluate(
            f"() => {{ const s = window.app._observeSeat;"
            f" let i = 0; while (i < s._log.length && s._log[i].seq <= {ck_seq}) i++;"
            f" return i; }}")
        obs.evaluate(f"() => window.app._observeSeat.playbackSeek({ck_idx + 1})")
        obs.wait_for_function(
            f"() => window.app._observeSeat._pos === {ck_idx + 1}"
            " && !window.app._observeSeat._seekBusy", timeout=30000)
        check("backward scrub landed", True)
        check("backward scrub restored (not from zero)",
              obs.evaluate("() => window.app._observeSeat._restoredFrom") == ck_seq)

        obs.evaluate("() => window.app._observeSeat.leave(false)")
        b.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
