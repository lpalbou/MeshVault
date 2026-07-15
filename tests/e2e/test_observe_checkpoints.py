"""E2E: observation-seat CHECKPOINTS — the replay-from-state path.

A performer page publishes through the shipped HOOK_JS (exec_ms timing,
trigger logic, atomic per-object capture); the test mirrors the publisher's
ordered pipe (events → /api/observe/publish, staged captures → zip →
/api/observe/checkpoint), then PROVES the protocol end to end:

- checkpoints listed on /api/observe/sessions (anchored seqs, final flag),
- manifest + per-object blobs fetchable (content types, token gating),
- SSE `from=` support + {type:"checkpoint"} marker positions,
- a fresh headless viewer RESTORED from a checkpoint matches the performer's
  fingerprint, and — the hard problem — POST-checkpoint commands replay
  CORRECTLY on the restored replica: object ids survive (including a
  remove_object id gap), transforms, timeline, stats and fingerprint all
  converge to the performer's live end state.

The RESTORE_JS below is the REFERENCE IMPLEMENTATION of the restore contract
in /tmp/observe_checkpoint_protocol.md (the frontend agent's spec).
"""
import base64
import io
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

import pytest
_pw = pytest.importorskip("playwright.sync_api",
                          reason="playwright not installed (pip install 'meshvault[mcp]')")
sync_playwright = _pw.sync_playwright

from pathlib import Path

# The shipped hook, extracted from the module source (importing backend.* is
# not possible under the e2e pytest path config; the string is the contract).
_PUB = Path(__file__).resolve().parents[2] / "backend" / "observe_publisher.py"
_SRC = _PUB.read_text()
HOOK_JS = _SRC.split('HOOK_JS = """')[1].split('"""')[0]
PULL_JS = _SRC.split('_PULL_CHECKPOINT_JS = """')[1].split('"""')[0]

# Same fingerprint computation as the hook/seat — the honesty check both
# sides of a restore are compared with.
FINGERPRINT_JS = """
() => {
    const v = window.mv.viewer;
    const objs = v._objects || [];
    let vertices = 0, triangles = 0;
    for (const e of objs) {
        if (e.stats) { vertices += e.stats.vertices || 0; triangles += e.stats.faces || 0; }
    }
    const active = v._activeEntry && v._activeEntry();
    return { objectCount: objs.length,
             activeObjectId: active ? active.id : null,
             vertices, triangles };
}
"""

# REFERENCE RESTORE (protocol §restore): rebuild a scene from a checkpoint's
# manifest + per-object blob URLs so that post-checkpoint commands replay
# correctly. Identity that no public command can set is assigned directly
# (entry.id, entry.geometryRev, viewer._nextObjectId) — the documented,
# deliberate part of the contract; everything else goes through commands.
RESTORE_JS = """
async ([manifest, blobUrls]) => {
    const mv = window.mv;
    const v = mv.viewer;
    const run = async (action, params) => {
        const r = await mv.execute({ action, params: params || {} });
        if (!r.ok) throw new Error(action + ": " + r.error);
        return r.result;
    };
    const soft = async (action, params) => {
        try { return await run(action, params); } catch (e) { return null; }
    };

    await run("unload");
    const objs = manifest.objects.slice().sort((a, b) => a.id - b.id);

    // 1. Load per-object blobs; align identity as each lands.
    for (const o of objs) {
        if (o.empty) continue;   // no exportable mesh — degraded restore
        await run("add_model", { url: blobUrls[String(o.id)], extension: ".glb",
                                 name: o.name, frame: false });
        const e = v._objects[v._objects.length - 1];
        e.id = o.id;
        e.wrapper.name = "mv_object_" + o.id;
        e.geometryRev = o.geometryRev || 0;
        v._activeObjectId = o.id;   // addModel activated the pre-alignment id
        if (o.pivot) e.pivot.set(o.pivot[0], o.pivot[1], o.pivot[2]);
    }
    // 2. Future ids must continue the PERFORMER's counter (gaps included).
    v._nextObjectId = manifest.nextObjectId;

    // 3. Hierarchy, then parent-relative placements, per manifest.
    const present = new Set(objs.filter((o) => !o.empty).map((o) => o.id));
    for (const o of objs) {
        if (o.empty) continue;
        if (o.parentId != null && present.has(o.parentId)) {
            await run("set_parent", { id: o.id, parent_id: o.parentId });
        }
    }
    for (const o of objs) {
        if (o.empty) continue;
        await run("set_object_transform", { id: o.id, position: o.position,
                                            quaternion: o.quaternion,
                                            scale_xyz: o.scale });
    }
    // 4. Tracked model scale (blob was exported with it divided out).
    for (const o of objs) {
        if (o.empty || !o.modelScale || Math.abs(o.modelScale - 1) < 1e-9) continue;
        await run("set_active_object", { id: o.id });
        await run("set_scale", { scale: o.modelScale });
    }
    // 5. Visibility / opacity / morph weights.
    for (const o of objs) {
        if (o.visible === false) await run("set_object_visible", { id: o.id, visible: false });
        if (o.opacity !== undefined && o.opacity < 1) {
            await run("set_object_opacity", { id: o.id, opacity: o.opacity });
        }
        const names = Object.keys(o.morphs || {});
        if (names.length) {
            await run("set_active_object", { id: o.id });
            for (const n of names) {
                if (o.morphs[n] > 0) await soft("set_morph", { name: n, weight: o.morphs[n] });
            }
        }
    }
    // 6. Timeline (rotations arrive as requested-Euler degrees).
    const tl = manifest.timeline;
    if (tl && tl.tracks && tl.tracks.length) {
        for (const t of tl.tracks) {
            for (const ch of ["position", "rotation", "scale"]) {
                for (const k of (t[ch] || [])) {
                    const p = { id: t.objectId, time: k.t };
                    p[ch] = k.v;
                    if (k.easing) p.easing = k.easing;
                    await run("set_keyframe", p);
                }
            }
            for (const key of Object.keys(t)) {
                if (!key.startsWith("morph:")) continue;
                for (const k of t[key]) {
                    const p = { id: t.objectId, time: k.t, morphs: {} };
                    p.morphs[key.slice(6)] = k.v;
                    if (k.easing) p.easing = k.easing;
                    await run("set_keyframe", p);
                }
            }
        }
        if (tl.duration) await soft("set_timeline", { duration: tl.duration });
        if (tl.time) await soft("seek_timeline", { time: tl.time });
        if (tl.playing) await soft("play_timeline", { loop: tl.loop });
    }
    // 7. Display + lighting (best-effort: purely visual parity).
    const d = manifest.display || {};
    if (d.background) await soft("set_background", { color: d.background });
    if (d.environment) await soft("set_environment", d.environment);
    if (d.renderMode === "wireframe" || d.wireframe) {
        await soft("set_wireframe", { enabled: true });
    } else if (d.renderMode && d.renderMode !== "textured") {
        await soft("set_render_mode", { mode: d.renderMode });
    }
    if (d.fog) await soft("set_fog", { enabled: true });
    if (d.clip) await soft("set_clip", { enabled: true, axis: d.clip.axis,
                                         position: d.clip.position, flip: d.clip.flip });
    const L = manifest.lighting || {};
    if (L.keyIntensity !== undefined) {
        await soft("set_lighting", { azimuth: L.keyAzimuth, elevation: L.keyElevation,
                                     key_intensity: L.keyIntensity,
                                     fill_intensity: L.fillIntensity,
                                     ambient: L.ambientIntensity, exposure: L.exposure });
    }
    // 8. Active object LAST (steps above move activation around).
    if (manifest.activeObjectId != null) {
        await run("set_active_object", { id: manifest.activeObjectId });
    }
    return true;
}
"""


def _sse_events(base, token, sid, from_seq, timeout=60):
    """Read one observe SSE stream until caught_up (entries + markers)."""
    url = f"{base}/api/observe/stream?session={urllib.parse.quote(sid)}&from={from_seq}"
    req = urllib.request.Request(url, headers={"X-MeshVault-Token": token})
    out = []
    deadline = time.time() + timeout
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            if time.time() > deadline:
                break
            line = raw.decode("utf-8").strip()
            if not line.startswith("data: "):
                continue
            ev = json.loads(line[6:])
            out.append(ev)
            if ev.get("type") == "caught_up":
                break
    return out


@pytest.mark.e2e
def test_observe_checkpoints(mv_app):
    BASE, TOKEN, _serve = mv_app

    PASS, FAIL = [], []
    def check(name, cond, detail=""):
        (PASS if cond else FAIL).append(name)
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))

    def api(path, data=None, headers=None, method=None):
        h = {"X-MeshVault-Token": TOKEN}
        if headers:
            h.update(headers)
        req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
        with urllib.request.urlopen(req, timeout=90) as r:
            ctype = r.headers.get("Content-Type", "")
            body = r.read()
        return ctype, body

    def post_json(path, body):
        ctype, raw = api(path, data=json.dumps(body).encode(),
                         headers={"Content-Type": "application/json"})
        return json.loads(raw)

    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
        ctx = b.new_context(viewport={"width": 700, "height": 550},
                            extra_http_headers={"X-MeshVault-Token": TOKEN})

        # ---------------- performer: viewer harness + publish hook ----------
        perf = ctx.new_page()
        perf.goto(BASE + "/static/viewer.html", wait_until="load")
        perf.wait_for_function("() => window.mv && window.mv.execute", timeout=45000)
        events = []
        perf.expose_function("__mvObservePublish", lambda e: events.append(e))
        # accrualRate 1.0 makes trigger arithmetic deterministic for the test
        # (production default 0.08 self-tunes on real capture cost); the
        # config knob is part of the hook, read once at install.
        perf.evaluate("() => { window.__mvObserveConfig = { accrualRate: 1.0 }; }")
        installed = perf.evaluate("(" + HOOK_JS + ")()")
        check("hook installs", installed is True)
        mvp = lambda a, p=None: perf.evaluate(
            "([a,p]) => window.mv.execute({action:a, params:p||{}})", [a, p or {}])

        SID = f"smoke-ckpt-{int(time.time() * 1000)}"
        session_meta = {"id": SID, "origin": "mcp", "pid": 1,
                        "started_at": time.time(), "label": "checkpoint smoke"}
        cseq = [0]
        ck_posts = []          # hub responses for shipped checkpoints, in order

        def flush():
            """Ordered publisher mirror: events → hub; staged captures →
            zip → checkpoint endpoint (same split as ObservePublisher)."""
            while events:
                e = events.pop(0)
                if e.get("kind") == "checkpoint_ready":
                    token = e["checkpoint"]["token"]
                    payload = perf.evaluate("(" + PULL_JS + ")", token)
                    assert payload, f"staged payload {token} missing"
                    buf = io.BytesIO()
                    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
                        for blob in payload["blobs"]:
                            zf.writestr(f"obj_{blob['id']}.glb",
                                        base64.b64decode(blob["b64"]))
                        zf.writestr("manifest.json", json.dumps(payload["manifest"]))
                    ctype, raw = api("/api/observe/checkpoint?session="
                                     + urllib.parse.quote(SID),
                                     data=buf.getvalue(),
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

        def ready_count():
            return len(ck_posts)

        # ---------------- phase A: scene setup + floor trigger --------------
        mvp("add_primitive", {"kind": "sphere",
                              "params": {"radius": 1.0, "widthSegments": 48,
                                         "heightSegments": 32}})          # id 1
        mvp("add_primitive", {"kind": "cylinder",
                              "params": {"radius": 0.3, "height": 1.2}})  # id 2
        mvp("set_object_transform", {"id": 2, "position": [1.6, 0, 0],
                                     "rotation": [0, 0, 20]})
        mvp("set_parent", {"id": 2, "parent_id": 1})
        mvp("set_pivot", {"id": 2, "point": [1.6, 0.6, 0]})
        mvp("set_object_opacity", {"id": 2, "opacity": 0.55})
        mvp("set_active_object", {"id": 1})
        mvp("fill_paint", {"color": "#d0d0d0", "texture_size": 512})
        mvp("paint", {"center": [0, 0, 1], "radius": 0.3,
                      "color": "#ff2200", "opacity": 1})
        mvp("set_keyframe", {"id": 1, "time": 0, "position": [0, 0, 0]})
        mvp("set_keyframe", {"id": 1, "time": 1, "rotation": [0, 90, 0]})
        mvp("set_lighting", {"azimuth": 100, "elevation": 45, "exposure": 1.4})
        # pad to the 40-mutation floor (seeded budget ⇒ deterministic capture)
        for i in range(40):
            mvp("paint", {"center": [0, -0.2 + i * 0.01, 1], "radius": 0.12,
                          "color": "#3355aa", "opacity": 0.8})
            perf.wait_for_timeout(10)   # let binding callbacks land in order
            flush()
            if ready_count() >= 1:
                break
        check("floor trigger captured checkpoint 1", ready_count() == 1,
              f"{ready_count()} after floor padding")

        # ---------------- phase B: monster trigger ---------------------------
        # Grow the mesh (refine is budget-capped and quick), then run a
        # regularize_region — a genuinely heavy remesh, the class of command
        # the monster rule exists for (measured here: ~12 s on ~100k tris;
        # a real session logged one at 14.6 s on 116k).
        mvp("set_active_object", {"id": 1})
        mvp("refine_region", {"center": [0, 0, 1], "radius": 1.2,
                              "detail_rel": 0.008, "max_triangles": 300000})
        mvp("regularize_region", {"center": [0, 0, 1], "radius": 1.2,
                                  "detail_rel": 0.008})
        perf.wait_for_timeout(100)
        flush()
        check("heavy command captured checkpoint 2", ready_count() >= 2,
              f"{ready_count()} checkpoints, posts={json.dumps(ck_posts)}")
        ck2_seq = ck_posts[-1]["seq"]

        # exec_ms telemetry present on published mutating commands
        log = _sse_events(BASE, TOKEN, SID, 0)
        cmd_entries = [e for e in log if e.get("type") == "entry"
                       and e.get("kind") == "command"]
        timed = [e for e in cmd_entries if isinstance(e.get("exec_ms"), (int, float))]
        check("exec_ms attached to command events",
              len(timed) >= len(cmd_entries) - 1,   # first may predate patch timing
              f"{len(timed)}/{len(cmd_entries)} timed")
        heavy = max((e.get("exec_ms", 0) for e in cmd_entries), default=0)
        check("monster command measured >2s", heavy >= 2000, f"max exec_ms {heavy}")

        # ---------------- phase C: post-checkpoint commands (the hard part) -
        mvp("add_primitive", {"kind": "box",
                              "params": {"width": 0.4, "height": 0.4,
                                         "depth": 0.4}})                  # id 3
        mvp("set_object_transform", {"id": 3, "position": [0, 1.8, 0]})
        mvp("set_active_object", {"id": 1})
        mvp("sculpt_stroke", {"points": [[0, 0.2, 1], [0, 0.35, 0.95], [0, 0.5, 0.87]],
                              "radius": 0.25, "strength": 0.08})
        mvp("paint", {"center": [0, -0.4, 0.9], "radius": 0.25,
                      "color": "#2266ff", "opacity": 1})
        mvp("remove_object", {"id": 3})                                   # id gap
        mvp("add_primitive", {"kind": "torus",
                              "params": {"radius": 0.5, "tube": 0.15}})   # id 4
        mvp("set_object_transform", {"id": 4, "position": [-1.6, 0.3, 0]})
        perf.wait_for_timeout(50)
        flush()
        n_before_final = ready_count()

        # ---------------- session end: final capture + lifecycle ------------
        perf.evaluate("() => window.__mvObserveFinalCapture()")
        perf.wait_for_timeout(50)
        flush()
        check("final capture on session end", ready_count() == n_before_final + 1,
              f"{ready_count()} vs {n_before_final}")
        post_json("/api/observe/publish", {"session": session_meta,
                                           "kind": "lifecycle",
                                           "lifecycle": "end", "ts": time.time()})

        # ---------------- listing + marker + fetch + auth assertions --------
        ctype, raw = api("/api/observe/sessions")
        row = next(s for s in json.loads(raw)["sessions"] if s["id"] == SID)
        cks = row.get("checkpoints") or []
        check("checkpoints listed on session row",
              len(cks) == ready_count()
              and [c["seq"] for c in cks] == sorted(c["seq"] for c in cks)
              and cks[-1]["final"] is True,
              json.dumps(cks))
        check("exec_ms_since_start monotonic on checkpoints",
              all(cks[i]["exec_ms_since_start"] <= cks[i + 1]["exec_ms_since_start"]
                  for i in range(len(cks) - 1)), json.dumps(cks))
        check("first_seq exposed for join math", row.get("first_seq") == 0,
              str(row.get("first_seq")))

        log = _sse_events(BASE, TOKEN, SID, 0)
        entry_seqs = [e["seq"] for e in log if e.get("type") == "entry"]
        check("entry seqs contiguous from 0",
              entry_seqs == list(range(len(entry_seqs))), f"{len(entry_seqs)} entries")
        marker_seqs = [e["seq"] for e in log if e.get("type") == "checkpoint"]
        check("stream carries checkpoint markers at anchor seqs",
              marker_seqs == [c["seq"] for c in cks], f"{marker_seqs}")
        for e in log:
            if e.get("type") == "checkpoint":
                idx = log.index(e)
                check("marker follows its anchor entry",
                      log[idx - 1].get("type") == "entry"
                      and log[idx - 1].get("seq") == e["seq"], f"seq {e['seq']}")
                break

        ctype, man_raw = api("/api/observe/checkpoint?session="
                             + urllib.parse.quote(SID) + f"&seq={ck2_seq}")
        check("manifest content-type json", "application/json" in ctype, ctype)
        manifest = json.loads(man_raw)
        check("manifest carries identity",
              manifest["nextObjectId"] == 3
              and sorted(o["id"] for o in manifest["objects"]) == [1, 2]
              and manifest["restore_mode"] == "per_object_flattened",
              json.dumps({k: manifest[k] for k in ("nextObjectId", "restore_mode")}))
        ctype, blob = api("/api/observe/checkpoint?session="
                          + urllib.parse.quote(SID) + f"&seq={ck2_seq}&object=1")
        check("blob content-type + glTF magic",
              "model/gltf-binary" in ctype and blob[:4] == b"glTF",
              f"{ctype} {blob[:4]!r} {len(blob)} bytes")
        try:
            urllib.request.urlopen(
                BASE + "/api/observe/checkpoint?session=x&seq=0", timeout=3)
            check("checkpoint fetch token-gated", False, "no-token request succeeded")
        except urllib.error.HTTPError as e:
            check("checkpoint fetch token-gated", e.code == 401, f"HTTP {e.code}")

        # ---------------- restore in a FRESH viewer + tail replay -----------
        obs = ctx.new_page()
        obs.goto(BASE + "/static/viewer.html", wait_until="load")
        obs.wait_for_function("() => window.mv && window.mv.execute", timeout=45000)
        blob_urls = obs.evaluate(
            """async ([base, sid, seq, ids]) => {
                const out = {};
                for (const id of ids) {
                    const r = await fetch(base + "/api/observe/checkpoint?session="
                        + encodeURIComponent(sid) + "&seq=" + seq + "&object=" + id);
                    out[String(id)] = URL.createObjectURL(await r.blob());
                }
                return out;
            }""",
            [BASE, SID, ck2_seq,
             [o["id"] for o in manifest["objects"] if not o.get("empty")]])
        obs.evaluate("(" + RESTORE_JS + ")", [manifest, blob_urls])

        fp_restored = obs.evaluate("(" + FINGERPRINT_JS + ")()")
        check("fingerprint matches checkpoint after restore",
              fp_restored == manifest["fingerprint"],
              f"{fp_restored} vs {manifest['fingerprint']}")

        tail = _sse_events(BASE, TOKEN, SID, ck2_seq + 1)
        tail_entries = [e for e in tail if e.get("type") == "entry"]
        check("stream from=N starts at N", tail_entries[0]["seq"] == ck2_seq + 1,
              f"first {tail_entries[0]['seq']}")
        replay_fail = []
        for e in tail_entries:
            if e.get("kind") != "command":
                continue
            r = obs.evaluate(
                "async (cmd) => window.mv.execute({action: cmd.action, params: cmd.params||{}})",
                e["command"])
            if not r.get("ok"):
                replay_fail.append((e["command"]["action"], r.get("error")))
        check("post-checkpoint commands replay clean on the replica",
              not replay_fail, json.dumps(replay_fail)[:200])

        # ---------------- convergence: replica == performer live state ------
        fp_perf = perf.evaluate("(" + FINGERPRINT_JS + ")()")
        fp_obs = obs.evaluate("(" + FINGERPRINT_JS + ")()")
        check("final fingerprint parity (incl. id gap 3→4)",
              fp_perf == fp_obs, f"perf {fp_perf} vs obs {fp_obs}")
        ctype, fin_raw = api("/api/observe/checkpoint?session="
                             + urllib.parse.quote(SID) + f"&seq={cks[-1]['seq']}")
        fin_manifest = json.loads(fin_raw)
        check("final checkpoint fingerprint agrees with both replicas",
              fin_manifest["fingerprint"] == fp_perf,
              f"{fin_manifest['fingerprint']} vs {fp_perf}")

        for oid in (1, 2, 4):
            tp = mvp("get_object_transform", {"id": oid})["result"]
            to = obs.evaluate(
                "async (i) => window.mv.execute({action:'get_object_transform', params:{id:i}})",
                oid)["result"]
            same = (all(abs(a - b) < 1e-3 for a, b in zip(tp["position"], to["position"]))
                    and all(abs(a - b) < 1e-3 for a, b in
                            zip(tp["quaternion"], to["quaternion"])))
            check(f"object {oid} transform parity", same,
                  f"{tp['position']} vs {to['position']}")
        tl_p = mvp("get_timeline")["result"]
        tl_o = obs.evaluate(
            "async () => window.mv.execute({action:'get_timeline', params:{}})")["result"]
        check("timeline survives checkpoint restore",
              json.dumps(tl_p.get("tracks")) == json.dumps(tl_o.get("tracks")),
              (json.dumps(tl_p.get("tracks"))[:60] or "") + " vs "
              + (json.dumps(tl_o.get("tracks"))[:60] or ""))
        lp = mvp("list_objects")["result"]["objects"]
        lo = obs.evaluate(
            "async () => window.mv.execute({action:'list_objects', params:{}})")["result"]["objects"]
        ident_p = [(o["id"], o["name"], o.get("parentId")) for o in lp]
        ident_o = [(o["id"], o["name"], o.get("parentId")) for o in lo]
        check("object identity roster parity", ident_p == ident_o,
              f"{ident_p} vs {ident_o}")

        # ---------------- backward compat: checkpoint-less session ----------
        SID2 = SID + "-plain"
        meta2 = dict(session_meta, id=SID2)
        post_json("/api/observe/publish",
                  {"session": meta2, "kind": "command", "client_seq": 0,
                   "ts": time.time(),
                   "command": {"action": "add_primitive",
                               "params": {"kind": "box"}}})
        post_json("/api/observe/publish", {"session": meta2, "kind": "lifecycle",
                                           "lifecycle": "end", "ts": time.time()})
        ctype, raw = api("/api/observe/sessions")
        row2 = next(s for s in json.loads(raw)["sessions"] if s["id"] == SID2)
        plain = _sse_events(BASE, TOKEN, SID2, 0)
        check("checkpoint-less sessions still list and stream",
              row2["checkpoints"] == [] and row2["replayable"] is True
              and any(e.get("type") == "entry" for e in plain),
              json.dumps(row2)[:120])

        b.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    assert not FAIL, f"failed checks: {FAIL}"
