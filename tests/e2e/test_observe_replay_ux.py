"""E2E: observation-seat replay UX — the fast-scrub + watchable-playback round.

Proves the four behaviors that round added on top of the checkpoint protocol:

- CHECKPOINT CACHE REUSE: manifests/blobs are fetched once per session; every
  later seek through the same checkpoint restores from the cache (fetch
  counter frozen, hit counter climbing).
- SNAPSHOT-RESTORE EQUIVALENCE: a position first reached by re-execution and
  later reached through a client-side snapshot restore must hash identically
  (FNV positions hash — the same formula the seat verifies restores with).
- PACED-PLAYBACK SANITY incl. HEAVY COMPRESSION: paced playback advances with
  narration, and a heavy command (exec_ms >= ~1.5 s) with a trailing
  checkpoint is COMPRESSED (restored, never re-executed) during the show.
- PLAY-FROM-END RESTART: a recording opens at its end; pressing play there
  restarts from zero.

Session built through the shipped HOOK_JS + zip checkpoint flow (the
test_observe_seat_checkpoints pattern) and DELETED from the hub at the end —
e2e runs must not clutter a user's session list.
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
def test_replay_ux(mv_app):
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
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.headers.get("Content-Type", ""), r.read()

    def post_json(path, body):
        _, raw = api(path, data=json.dumps(body).encode(),
                     headers={"Content-Type": "application/json"})
        return json.loads(raw)

    SID = f"smoke-replayux-{int(time.time() * 1000)}"
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        ctx = b.new_context(viewport={"width": 900, "height": 650},
                            extra_http_headers={"X-MeshVault-Token": TOKEN})

        # ---------------- performer: build a heavy-bearing recording --------
        perf = ctx.new_page()
        perf.goto(BASE + "/static/viewer.html", wait_until="load")
        perf.wait_for_function("() => window.mv && window.mv.execute",
                               timeout=45000)
        events = []
        perf.expose_function("__mvObservePublish", lambda e: events.append(e))
        # accrualRate 1.0 = reference-test governor setting; monsterMs 1200
        # keeps the monster rule armed for this session's ~2 s regularize
        # (engine times vary ~2x across SwiftShader hosts — the seat's
        # compression threshold is 1.5 s, so the checkpoint must anchor for
        # anything the seat will call heavy).
        perf.evaluate("() => { window.__mvObserveConfig ="
                      " { accrualRate: 1.0, monsterMs: 1200 }; }")
        assert perf.evaluate("(" + HOOK_JS + ")()") is True
        mvp = lambda a, p=None: perf.evaluate(
            "([a,p]) => window.mv.execute({action:a, params:p||{}})", [a, p or {}])

        session_meta = {"id": SID, "origin": "mcp", "pid": 1,
                        "started_at": time.time(), "label": "replay ux smoke"}
        cseq = [0]
        exec_log = []

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
                    assert json.loads(raw).get("ok")
                    continue
                if e.get("kind") == "command":
                    exec_log.append((e["command"]["action"], e.get("exec_ms", 0)))
                body = {"session": session_meta, "client_seq": cseq[0],
                        "ts": time.time(), **e}
                cseq[0] += 1
                out = post_json("/api/observe/publish", body)
                assert out.get("ok"), out

        mvp("add_primitive", {"kind": "sphere",
                              "params": {"radius": 1.0, "widthSegments": 48,
                                         "heightSegments": 32}})
        mvp("fill_paint", {"color": "#d0d0d0", "texture_size": 512})
        for i in range(40):
            mvp("paint", {"center": [0, -0.5 + i * 0.025, 1], "radius": 0.1,
                          "color": ["#a33226", "#2a6f4e"][i % 2], "opacity": 0.85})
            if i % 10 == 0:
                perf.wait_for_timeout(10)
                flush()
        flush()
        # THE HEAVY: refine to a dense region, then a >=1.5 s regularize.
        # The monster rule anchors a checkpoint right after it.
        mvp("refine_region", {"center": [0, 0, 1], "radius": 1.2,
                              "detail_rel": 0.015, "max_triangles": 200000})
        mvp("regularize_region", {"center": [0, 0, 1], "radius": 1.2,
                                  "detail_rel": 0.012})
        perf.wait_for_timeout(100)
        flush()
        heavy_ms = max((ms for a, ms in exec_log
                        if a == "regularize_region"), default=0)
        check("heavy command is heavy (>=1.5s)", heavy_ms >= 1500,
              f"{heavy_ms} ms")
        for i in range(10):
            mvp("paint", {"center": [0, 0.3 - i * 0.04, 0.95], "radius": 0.09,
                          "color": "#3355aa", "opacity": 0.9})
        flush()
        perf.evaluate("() => window.__mvObserveFinalCapture()")
        perf.wait_for_timeout(200)
        flush()
        post_json("/api/observe/publish", {"session": session_meta,
                                           "kind": "lifecycle",
                                           "lifecycle": "end",
                                           "ts": time.time()})

        # ---------------- observer: the real app tab ------------------------
        obs = ctx.new_page()
        obs.goto(BASE + "/", wait_until="load")
        obs.wait_for_function("() => window.app && window.app._observeSeat",
                              timeout=45000)
        obs.evaluate("""
        () => {
            const seat = window.app._observeSeat;
            window.__ux = { snapRestores: 0, heavyExecs: 0 };
            const origRestore = seat._snaps.restore.bind(seat._snaps);
            seat._snaps.restore = async (...a) => {
                const ok = await origRestore(...a);
                if (ok) window.__ux.snapRestores++;
                return ok;
            };
            const origCore = seat._replayCore.bind(seat);
            seat._replayCore = async (cmd) => {
                if (cmd && cmd.action === 'regularize_region') window.__ux.heavyExecs++;
                return origCore(cmd);
            };
        }
        """)
        t0 = time.time()
        obs.evaluate(f"() => window.app._observeSeat.join('{SID}')")
        obs.wait_for_function(
            "() => { const s = window.app._observeSeat;"
            " return s._recording === true && s._log.length > 0"
            " && s._pos === s._log.length && !s._seekBusy; }", timeout=120000)
        open_s = time.time() - t0
        check("recording opens at the END", True, f"{open_s:.1f}s")
        check("end landing restored a checkpoint (no heavy re-exec)",
              obs.evaluate("() => window.app._observeSeat._restoredFrom") is not None
              and obs.evaluate("() => window.__ux.heavyExecs") == 0,
              f"heavyExecs={obs.evaluate('() => window.__ux.heavyExecs')}")
        hash_end = obs.evaluate("() => window.app._observeSeat.stateHash()")
        log_len = obs.evaluate("() => window.app._observeSeat._log.length")
        fetches_after_open = obs.evaluate(
            "() => window.app._observeSeat._ckCache.fetches")

        def seek(pos, timeout=120000):
            t = time.time()
            obs.evaluate(f"() => window.app._observeSeat.playbackSeek({pos})")
            obs.wait_for_function(
                f"() => {{ const s = window.app._observeSeat;"
                f" return s._pos === {pos} && !s._seekBusy; }}", timeout=timeout)
            return time.time() - t

        # ---- snapshot-restore equivalence hash ------------------------------
        P = 30   # mid paint era, before the heavy
        seek(P)
        hash_cold = obs.evaluate("() => window.app._observeSeat.stateHash()")
        check("landing left a client snapshot", obs.evaluate(
            f"() => window.app._observeSeat._snaps.positions().includes({P})"))
        seek(log_len)
        check("re-seek to end reproduces the end hash",
              obs.evaluate("() => window.app._observeSeat.stateHash()") == hash_end)
        snap_restores_before = obs.evaluate("() => window.__ux.snapRestores")
        back_s = seek(P)
        diag = obs.evaluate(
            "() => JSON.stringify({ ux: window.__ux,"
            " refusal: window.app._observeSeat._snaps.lastRefusal,"
            " snaps: window.app._observeSeat._snaps.positions() })")
        check("repeat scrub used the snapshot",
              obs.evaluate("() => window.__ux.snapRestores") > snap_restores_before,
              f"{back_s:.2f}s before={snap_restores_before} {diag}")
        check("snapshot-restored state EQUALS re-executed state (hash)",
              obs.evaluate("() => window.app._observeSeat.stateHash()") == hash_cold,
              hash_cold)

        # ---- checkpoint cache reuse -----------------------------------------
        check("no checkpoint re-fetch across seeks",
              obs.evaluate("() => window.app._observeSeat._ckCache.fetches")
              == fetches_after_open,
              f"fetches={obs.evaluate('() => window.app._observeSeat._ckCache.fetches')}")
        check("checkpoint cache recorded hits",
              obs.evaluate("() => window.app._observeSeat._ckCache.hits") >= 1)
        check("no heavy re-execution during any seek",
              obs.evaluate("() => window.__ux.heavyExecs") == 0)

        # ---- paced playback: FRAME-PACED fluidity + heavy compression -------
        heavy_idx = obs.evaluate(
            "() => window.app._observeSeat._log.findIndex("
            "(e) => e.kind === 'command' && (e.exec_ms || 0) >= 1500)")
        check("heavy entry present in log", heavy_idx > 0, f"idx={heavy_idx}")
        seek(2)
        # Frame + apply cadence probe: fluid playback means frames keep
        # flowing BETWEEN commands (rAF count >> command count) and no two
        # commands land back-to-back (the old command-paced loop fused them).
        obs.evaluate("""
        () => {
            window.__flu = { frames: 0, applies: [] };
            const loop = () => {
                if (window.__flu.stop) return;
                window.__flu.frames++;
                requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
            const seat = window.app._observeSeat;
            const orig = seat._applyLogEntry.bind(seat);
            seat._applyLogEntry = async (entry, fast) => {
                if (entry.kind === 'command') {
                    window.__flu.applies.push(performance.now());
                }
                return orig(entry, fast);
            };
        }
        """)
        obs.evaluate("() => window.app._observeSeat.playbackPlay()")
        t1 = time.time()
        obs.wait_for_function(
            f"() => window.app._observeSeat._pos > {heavy_idx + 1}",
            timeout=60000)
        cross_s = time.time() - t1
        obs.wait_for_timeout(300)
        flu = obs.evaluate(
            "() => { window.__flu.stop = true;"
            " const a = window.__flu.applies;"
            " const gaps = [];"
            " for (let i = 1; i < a.length; i++) gaps.push(a[i] - a[i-1]);"
            " return { frames: window.__flu.frames, applied: a.length,"
            "          minGap: gaps.length ? Math.min(...gaps) : null }; }")
        check("frames flow between commands (frame-paced)",
              flu["frames"] > 3 * max(1, flu["applied"]),
              f"{flu['frames']} frames / {flu['applied']} commands")
        check("no back-to-back command fusion (min inter-apply ≥ 90 ms)",
              flu["minGap"] is None or flu["minGap"] >= 90,
              f"min gap {flu['minGap']} ms")
        ticker = obs.evaluate(
            "() => document.getElementById('observe-ticker').textContent")
        playing = obs.evaluate(
            "() => window.app._observeSeat._playTimer !== null")
        check("paced playback advances and narrates",
              playing and bool(ticker), repr(ticker)[:60])
        check("heavy command COMPRESSED during playback (never executed)",
              obs.evaluate("() => window.__ux.heavyExecs") == 0
              and cross_s < max(15.0, heavy_ms / 1000.0 * 0.8),
              f"crossed heavy in {cross_s:.1f}s (engine {heavy_ms} ms)")
        obs.evaluate("() => window.app._observeSeat.playbackPause()")
        obs.wait_for_timeout(200)

        # ---- play-from-end restart ------------------------------------------
        seek(log_len)
        obs.evaluate("() => window.app._observeSeat.playbackPlay()")
        limit = min(30, log_len)
        obs.wait_for_function(
            "() => { const s = window.app._observeSeat;"
            " return s._playTimer !== null && s._pos > 0"
            + f" && s._pos < {limit}; }}",
            timeout=60000)
        check("play at the end restarts from zero", True,
              f"pos={obs.evaluate('() => window.app._observeSeat._pos')}")
        obs.evaluate("() => window.app._observeSeat.playbackPause()")

        obs.evaluate("() => window.app._observeSeat.leave(false)")
        b.close()

    # ---------------- hub hygiene: the test deletes its session -------------
    out = post_json("/api/observe/delete", {"id": SID})
    check("test session deleted from the hub", out.get("ok") is True, str(out))
    _, raw = api("/api/observe/sessions")
    left = [s for s in json.loads(raw)["sessions"] if s["id"] == SID]
    check("session gone from the list", not left)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"


@pytest.mark.e2e
def test_live_smoothing(mv_app):
    """LIVE observation is a SHOW too (fluidity round): post-catch-up bursts
    drain through a broadcast-delay buffer at a watchable cadence — never
    frantic back-to-back replication — with an honest lag readout."""
    BASE, TOKEN, _serve = mv_app
    PASS, FAIL = [], []

    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name
              + (f"  [{detail}]" if detail else ""))

    def post(path, body):
        req = urllib.request.Request(
            BASE + path, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json",
                     "X-MeshVault-Token": TOKEN})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    SID = f"smoke-livesmooth-{int(time.time() * 1000)}"
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        ctx = b.new_context(viewport={"width": 900, "height": 650},
                            extra_http_headers={"X-MeshVault-Token": TOKEN})
        perf = ctx.new_page()
        perf.goto(BASE + "/static/viewer.html", wait_until="load")
        perf.wait_for_function("() => window.mv && window.mv.execute",
                               timeout=45000)
        events = []
        perf.expose_function("__mvObservePublish", lambda e: events.append(e))
        assert perf.evaluate("(" + HOOK_JS + ")()") is True
        mvp = lambda a, p=None: perf.evaluate(
            "([a,p]) => window.mv.execute({action:a, params:p||{}})", [a, p or {}])
        meta = {"id": SID, "origin": "mcp", "pid": 1,
                "started_at": time.time(), "label": "live smooth smoke"}
        cseq = [0]

        def flush():
            while events:
                e = events.pop(0)
                if e.get("kind") == "checkpoint_ready":
                    continue
                body = {"session": meta, "client_seq": cseq[0],
                        "ts": time.time(), **e}
                cseq[0] += 1
                out = post("/api/observe/publish", body)
                assert out.get("ok"), out

        mvp("add_primitive", {"kind": "sphere",
                              "params": {"radius": 1.0, "widthSegments": 32,
                                         "heightSegments": 24}})
        mvp("fill_paint", {"color": "#d0d0d0", "texture_size": 256})
        flush()

        obs = ctx.new_page()
        obs.goto(BASE + "/", wait_until="load")
        obs.wait_for_function("() => window.app && window.app._observeSeat",
                              timeout=45000)
        obs.evaluate(f"() => window.app._observeSeat.join('{SID}')")
        obs.wait_for_function(
            "() => window.app._observeSeat._caughtUp === true", timeout=60000)
        check("live show engaged after catch-up",
              obs.evaluate("() => window.app._observeSeat._liveShowRunning"))
        obs.evaluate("""
        () => {
            window.__ls = { applies: [], maxLag: 0 };
            const seat = window.app._observeSeat;
            const orig = seat._applyLogEntry.bind(seat);
            seat._applyLogEntry = async (entry, fast) => {
                if (entry.kind === 'command') {
                    window.__ls.applies.push(performance.now());
                    if (entry.arrivedAt !== undefined) {
                        const lag = (performance.now() - entry.arrivedAt) / 1000;
                        if (lag > window.__ls.maxLag) window.__ls.maxLag = lag;
                    }
                }
                return orig(entry, fast);
            };
        }
        """)

        # BURST: 20 paints published as fast as the pipe allows.
        import math
        for i in range(20):
            a = i * 0.4
            mvp("paint", {"center": [math.cos(a) * 0.92, -0.3 + i * 0.03,
                                     math.sin(a) * 0.92],
                          "radius": 0.1, "color": "#a33226", "opacity": 0.85})
        flush()
        obs.wait_for_timeout(1200)
        lag_txt = obs.evaluate(
            "() => { const el = document.getElementById('observe-lag');"
            " return el && el.style.display !== 'none' ? el.textContent : null; }")
        check("lag readout visible mid-drain", bool(lag_txt), str(lag_txt))
        buffered = obs.evaluate("() => window.app._observeSeat._liveBuf.length")
        check("burst is buffered, not replayed frantically", buffered > 0,
              f"{buffered} still queued after 1.2 s")
        # Drain completes; cadence stays watchable end to end.
        obs.wait_for_function(
            "() => window.app._observeSeat._liveBuf.length === 0",
            timeout=30000)
        stats = obs.evaluate(
            "() => { const a = window.__ls.applies; const gaps = [];"
            " for (let i = 1; i < a.length; i++) gaps.push(a[i] - a[i-1]);"
            " return { n: a.length, minGap: gaps.length ? Math.min(...gaps) : null,"
            "          maxLag: window.__ls.maxLag }; }")
        check("all burst commands drained", stats["n"] >= 20, str(stats["n"]))
        check("drain cadence smoothed (min inter-apply ≥ 90 ms)",
              stats["minGap"] is not None and stats["minGap"] >= 90,
              f"min gap {stats['minGap']} ms")
        check("lag stays bounded (< 8 s)", stats["maxLag"] < 8,
              f"max lag {stats['maxLag']:.1f}s")
        check("ghost cursor present during live drain",
              obs.evaluate("() => !!window.app._observeSeat._cursor"))
        check("no replay errors",
              obs.evaluate("() => window.app._observeSeat._replayErrors") == 0)

        post("/api/observe/publish", {"session": meta, "kind": "lifecycle",
                                      "lifecycle": "end", "ts": time.time()})
        obs.wait_for_timeout(800)
        obs.evaluate("() => window.app._observeSeat.leave(false)")
        b.close()

    out = post("/api/observe/delete", {"id": SID})
    check("live-smooth session deleted", out.get("ok") is True, str(out))

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
