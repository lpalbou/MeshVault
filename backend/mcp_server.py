"""
MeshVault MCP server — a thin Model Context Protocol adapter over the viewer control API
(backlog 030).

Design: ~9 tools, NOT one-tool-per-command (wide tool surfaces measurably degrade agent
performance). Everything routes through the existing self-describing `execute()` registry
of the standalone viewer, which runs in a headless Chromium page hosted by a tiny
loopback model server (both shared with the app's /api/screenshot endpoint — see
backend/headless_viewer.py). The page is the single source of truth; this module only
marshals JSON in/out and images back to the MCP client. `open_in_app`/`get_app_state`
additionally bridge to a RUNNING MeshVault app (separate process) via
backend/agent_bridge.py, so a human and an agent can co-review in both directions.

Model input: `load_model` accepts EITHER an http(s) URL or a local file path.
- Local files are registered under an unguessable /models/<token> route on the loopback
  server (never exposed off-host), so the browser can fetch them without filesystem access.
- URLs are first loaded directly by the page (preserves relative resource resolution for
  multi-file assets); if the browser fetch fails (typically CORS), the server downloads
  the file itself and serves it locally — agents can paste arbitrary model URLs.

Run:  meshvault-mcp   (stdio transport; wire it into Claude/Cursor — see docs/mcp.md)
Deps: pip install "meshvault[mcp]"  then  playwright install chromium
"""

from __future__ import annotations

import base64
import json
import secrets
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

from typing import Annotated

from mcp.server.fastmcp import FastMCP, Image
from pydantic import Field

from backend.headless_viewer import (
    SUPPORTED_EXTENSIONS,
    VIEW_PRESETS,
    HeadlessSession,
)

# Hard cap for server-side URL downloads (CORS fallback) — keeps a hostile/mistyped URL
# from filling the disk. Large real-world GLBs are usually well under this.
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

# Strings longer than this inside `execute` results are truncated (screenshots must go
# through the dedicated tool, which returns proper MCP image content).
MAX_RESULT_STRING = 2000

class _Runtime:
    """Lazily-started HeadlessSession (loopback model server + shared headless
    viewer page) plus the MCP-specific state: URL download tempdir and the
    last-loaded local file (open_in_app's subject)."""

    def __init__(self):
        # The session serves the harness, the viewer bundle + decoders, and
        # registered models WITH their directory companions (the untextured
        # multi-file fix) — see backend/headless_viewer.py.
        self.session = HeadlessSession()
        self._tmpdir = tempfile.TemporaryDirectory(prefix="meshvault_mcp_")
        # Local file behind the currently loaded model (None for direct URL loads).
        # open_in_app uses it to push "what the agent is looking at" into the app.
        self.last_local_model: Path | None = None

    @property
    def base_url(self):
        return self.session.base_url

    async def page(self):
        return await self.session.page()

    @property
    def viewer(self):
        return self.session.viewer

    def register_local_file(self, file_path: Path) -> str:
        return self.session.register(file_path)

    def download_to_temp(self, url: str) -> Path:
        """Server-side fetch for CORS-blocked URLs; size-capped, into the runtime tempdir.

        Each download gets its OWN subdirectory: model URLs now expose their whole
        directory (companion serving), so isolating downloads keeps one registered
        model from advertising unrelated ones as siblings.
        """
        suffix = Path(url.split("?", 1)[0]).suffix.lower() or ".glb"
        download_dir = Path(self._tmpdir.name) / secrets.token_hex(8)
        download_dir.mkdir(parents=True, exist_ok=True)
        target = download_dir / ("model" + suffix)
        req = urllib.request.Request(url, headers={"User-Agent": "meshvault-mcp"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(target, "wb") as out:
            total = 0
            while chunk := resp.read(1 << 16):
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise RuntimeError(f"Download exceeds {MAX_DOWNLOAD_BYTES // (1 << 20)} MB cap")
                out.write(chunk)
        return target

    async def close(self):
        await self.session.close()
        self._tmpdir.cleanup()


_runtime = _Runtime()


def _truncate_strings(value: Any) -> Any:
    """Recursively truncate huge strings (data URLs etc.) in execute results."""
    if isinstance(value, str) and len(value) > MAX_RESULT_STRING:
        return value[:200] + (f"… [truncated — {len(value)} chars total. Large payloads are "
                              "not returned through this tool; for images use the "
                              "screenshot tool.]")
    if isinstance(value, dict):
        return {k: _truncate_strings(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_truncate_strings(v) for v in value]
    return value


async def _mv_execute(action: str, params: dict | None = None) -> dict:
    page = await _runtime.page()
    return await page.evaluate(
        "([action, params]) => window.mv.execute({ action, params: params || {} })",
        [action, params or {}],
    )


from contextlib import asynccontextmanager


@asynccontextmanager
async def _lifespan(_server):
    try:
        yield {}
    finally:
        # Shut the browser + loopback server down cleanly when the MCP client disconnects.
        await _runtime.close()


mcp = FastMCP(
    "meshvault",
    lifespan=_lifespan,
    instructions=(
        "MeshVault: a headless 3D studio you can drive entirely through JSON — "
        "load, inspect, CREATE (primitives/sculpt/paint), repair (fix_mesh/"
        "simplify_region/clone_paint), articulate (split_object/set_parent/"
        "set_pivot), and ANIMATE (set_keyframe/play_timeline) 3D scenes. "
        "Typical flow: load_model (URL or local path; multi-file OBJ/FBX assets load "
        "with their MTL/textures) → describe_scene (understand WHAT loaded, no vision "
        "needed) → viewer_execute for every viewer command (discover them "
        "with list_viewer_commands) → screenshot to SEE the result "
        "(pass preset:\"studio\" for renders comparable across sessions; "
        "times:[...] for a motion contact sheet) → export_model to persist sculpt/"
        "paint/animation as a GLB file. "
        "When a human is co-reviewing: open_in_app pushes your current model + camera "
        "into their running MeshVault app so they see what you see; get_app_state reads "
        "back what THEY are looking at so you can pick up their subject headless. "
        "Supports .obj .fbx .gltf .glb (incl. Draco/KTX2/Meshopt) .stl .ply .dae .3mf .usdz."
    ),
)


# Serializes load_model's load→describe pair. The page is one shared scene: two loads
# racing in a single session would otherwise return descriptions of the wrong model
# (found by the concurrency field test).
_load_lock = None


@mcp.tool()
async def load_model(
    source: str,
    name: str | None = None,
    add: bool = False,
    transform: dict | None = None,
) -> dict:
    """Load a 3D model into the viewer from an http(s) URL or a LOCAL FILE PATH.

    IMPORTANT: by default this REPLACES the entire scene — including a composed
    multi-object scene built with add:true. Pass add:true to CO-LOAD into the
    current scene (scene composition); the new object becomes active and its
    objectId is returned for set_object_transform / remove_object / etc.

    Local paths are served to the sandboxed viewer over loopback; URLs are fetched by
    the browser first and, if blocked by CORS, downloaded server-side automatically.
    Returns the load result plus a structured scene description (same as describe_scene),
    so one call tells you what you loaded.

    Args:
        source: http(s) URL of a model, or an absolute/home-relative local file path.
        name: optional display name (defaults to the file name).
        add: co-load into the current scene instead of replacing it.
        transform: optional initial placement when add:true —
                   {position:[x,y,z], quaternion:[x,y,z,w] or rotation:[x,y,z]
                   Euler degrees, scale:[x,y,z] or uniform number}.
    """
    async with await _get_load_lock():
        result = await _load_source(source, name, add=add, transform=transform)
        if not result.get("ok"):
            return _truncate_strings(result)
        description = await _mv_execute("describe_scene", {})
        out = {"ok": True, "loaded": True,
               "description": description.get("result")}
        if add and isinstance(result.get("result"), dict):
            out["objectId"] = result["result"].get("objectId")
        return _truncate_strings(out)


async def _get_load_lock():
    import asyncio
    global _load_lock
    if _load_lock is None:
        _load_lock = asyncio.Lock()
    return _load_lock


async def _load_source(source: str, name: str | None = None,
                       add: bool = False, transform: dict | None = None) -> dict:
    """Shared load path: URL (browser-first, server-download CORS fallback) or local file.
    Callers must hold the load lock. Returns the raw viewer load result {ok, ...}.

    add=True composes into the current scene (viewer add_model) instead of
    replacing it; `transform` optionally places the added object. The viewer entry
    records the SOURCE identity (local path/URL), which is what save_scene reads —
    no Python-side correlation table to fall out of sync (adversarial finding)."""
    action = "add_model" if add else "load"

    def params(url, ext, display, src, related=None):
        p = {"url": url, "name": display, "source": src}
        if ext:
            p["extension"] = ext
        if related:
            p["relatedFiles"] = related
        if add and transform:
            p["transform"] = transform
        return p

    is_url = source.startswith("http://") or source.startswith("https://")
    if is_url:
        display = name or source.rstrip("/").rsplit("/", 1)[-1]
        result = await _mv_execute(
            action, params(source, None, display, {"kind": "url", "url": source}))
        if result.get("ok"):
            # Loaded straight from the URL — no local file exists for open_in_app.
            _runtime.last_local_model = None
            return result
        # Browser-side fetch failed — typically CORS. Retry via server-side download.
        try:
            local = _runtime.download_to_temp(source)
        except Exception as e:
            return {"ok": False, "error": f"Browser load failed ({result.get('error')}); "
                                          f"server-side download also failed: {e}"}
        url = _runtime.register_local_file(local)
        result = await _mv_execute(
            action, params(url, local.suffix, display, {"kind": "url", "url": source}))
        if result.get("ok"):
            _runtime.last_local_model = local
        return result
    # Local file: the session's shared load path (validation, registration,
    # companion discovery — what makes multi-file assets load TEXTURED).
    path = Path(source).expanduser()
    result = await _runtime.session.load_local(
        path, name=name, add=add, transform=transform)
    if result.get("ok"):
        _runtime.last_local_model = path
    return result


@mcp.tool()
async def describe_scene(max_items: int = 8, checks: bool = True, views: bool = False) -> dict:
    """Structured TEXT snapshot of the loaded model — reason about it WITHOUT vision.

    Returns a plain-language summary, live inventory (meshes/materials/textures/
    triangles), world bounds + real-world size hint, hierarchy outline, largest meshes,
    material properties, detected geometry issues (missing normals/UVs, degenerate faces,
    watertightness, flipped normals, scale sanity), and the current camera/render state.

    Args:
        max_items: cap for list lengths (1-50).
        checks: run geometry QA (skipped automatically above 300k triangles).
        views: also rank the top-3 most detailed camera angles (renders ~24 offscreen
               views — slow on software GL; only request when you need candidate fronts).
    """
    result = await _mv_execute(
        "describe_scene", {"maxItems": max_items, "checks": checks, "views": views})
    return _truncate_strings(result)


@mcp.tool()
async def viewer_execute(action: str, params: dict | None = None) -> dict:
    """Run any viewer control-API command: camera, render modes, lighting, transforms,
    measurement, animation, clipping...

    Discover every action and its parameter schema with list_viewer_commands.
    Examples: {action:"find_best_view"} moves the camera to the model's semantic front;
    {action:"set_render_mode", params:{mode:"wireframe"}}; {action:"set_clip",
    params:{enabled:true, axis:"x", position:0.5}}; {action:"rotate",
    params:{axis:"y", degrees:90}}.

    Returns {ok, result|error} — it never throws; errors are structured strings.
    Image-returning actions are truncated here: use the screenshot tool for images.
    """
    result = _truncate_strings(await _mv_execute(action, params))
    # The browser-side API mentions its own JS entry points; translate them to the
    # MCP tool names so an agent's next move is obvious.
    if isinstance(result, dict) and isinstance(result.get("error"), str):
        result["error"] = result["error"].replace(
            "listCommands()", "the list_viewer_commands tool")
    return result


@mcp.tool()
async def list_viewer_commands() -> dict:
    """List every viewer command with its parameter schema (types, ranges, defaults).
    Call once, then drive everything through viewer_execute."""
    page = await _runtime.page()
    commands = await page.evaluate("() => window.mv.listCommands()")
    return {"count": len(commands), "commands": commands}


@mcp.tool()
async def get_state() -> dict:
    """Current viewer state snapshot: model (name/counts/bounds), camera (position/
    target/fov/mode), display (render mode, clip, environment/IBL, grid), animation,
    lighting. Re-read after commands to verify their effect without a screenshot."""
    page = await _runtime.page()
    return await page.evaluate("() => window.mv.getState()")


@mcp.tool()
async def open_in_app(path: str | None = None, camera: bool = True) -> dict:
    """Push a model into the running MeshVault desktop app so a human can co-view it.

    The headless MCP viewer and the browser app are separate processes; this tool
    bridges them. It discovers the local app via ~/.meshvault/app_session.json
    (written when `meshvault` starts; override with MESHVAULT_APP_URL +
    MESHVAULT_TOKEN) and pushes the model — by default the one currently loaded
    here — into every open app tab, live. The human instantly sees the same file,
    framed by the same camera.

    Args:
        path: absolute local file path to open. Defaults to the model currently
              loaded in this session (must have been loaded from a local path —
              URL-loaded models have no local file; download or export them first).
        camera: also apply this session's current camera pose in the app, so the
                human sees exactly what you see (only sent when the pushed path IS
                the currently loaded model). Default true.

    Returns {ok, clients, deep_link, camera_sent}. `clients` is how many app tabs
    received the push; if 0, give the human the `deep_link` — opening it reproduces
    the same view (the app honors ?path= deep links).
    """
    from backend.agent_bridge import (
        StaleSessionError, discover_app_session, push_open_to_app)

    # Resolve what to push: explicit path, or what this session is looking at.
    if path is not None:
        if path.startswith("http://") or path.startswith("https://"):
            return {"ok": False, "error": "open_in_app takes a LOCAL file path. For URLs, "
                                          "give the human the hosted viewer link instead: "
                                          f"https://www.lpalbou.info/MeshVault/?src={path}"}
        target = Path(path).expanduser()
        if not target.is_absolute():
            return {"ok": False, "error": f"Local path must be absolute: {path}"}
        if not target.is_file():
            return {"ok": False, "error": f"File not found: {target}"}
        if target.suffix.lower() not in SUPPORTED_EXTENSIONS:
            return {"ok": False, "error": f"Unsupported format '{target.suffix}'. "
                                          f"Supported: {' '.join(sorted(SUPPORTED_EXTENSIONS))}"}
    elif _runtime.last_local_model is not None:
        target = _runtime.last_local_model
    else:
        return {"ok": False, "error": "Nothing to push: no `path` given and no local model "
                                      "is loaded in this session (URL loads have no local "
                                      "file). Call load_model with a local path first, or "
                                      "pass `path` explicitly."}

    # Only attach the camera when the app will show the SAME model this session has
    # loaded — a pose from a different model would frame the wrong thing.
    camera_payload = None
    if camera and _runtime.viewer.page is not None and _runtime.last_local_model == target:
        state = await _runtime.viewer.page.evaluate("() => window.mv.getState()")
        if state.get("model", {}).get("loaded"):
            cam = state.get("camera", {})
            camera_payload = {"position": cam.get("position"),
                              "target": cam.get("target"), "fov": cam.get("fov")}

    try:
        session = discover_app_session()
    except StaleSessionError as e:
        # An uncleanly killed app (SIGKILL) can't remove its session file; the
        # pid probe catches it (and removed the file) instead of letting the push
        # hit whatever old instance answers that port.
        return {"ok": False, "error": f"Stale session file: the app that published it "
                                      f"(pid {e.pid}) is dead — likely an unclean "
                                      "shutdown. The file has been cleaned up. Ask the "
                                      "human to start the app (`meshvault`), or set "
                                      "MESHVAULT_APP_URL/MESHVAULT_TOKEN explicitly."}
    if session is None:
        return {"ok": False, "error": "No running MeshVault app found: "
                                      "~/.meshvault/app_session.json is missing and "
                                      "MESHVAULT_APP_URL is not set. Ask the human to "
                                      "start the app with `meshvault`."}
    import asyncio
    try:
        # Sync urllib call — keep it off the event loop (MCP protocol keeps flowing).
        result = await asyncio.to_thread(
            push_open_to_app, session, str(target), camera_payload, "mcp")
    except RuntimeError as e:
        return {"ok": False, "error": str(e)}

    out = {"ok": True, "clients": result.get("clients", 0),
           "deep_link": result.get("deep_link"),
           "camera_sent": camera_payload is not None}
    if out["clients"] == 0:
        out["hint"] = ("The app is running but no browser tab is connected. Give the "
                       "human the deep_link — opening it shows the same model.")
    return out


@mcp.tool()
async def compare_models(
    reference: str,
    candidates: list[str],
    samples: Annotated[int, Field(ge=256, le=16384)] = 4096,
    align: bool = True,
) -> dict:
    """Compare ONE reference model against N candidates — geometrically, via shape
    registration, not screenshots.

    For each candidate the report gives:
    - alignment: uniform scale ratio (unit-mismatch detection), rotation angle,
      translation — how the candidate had to be transformed to best match.
    - distances: symmetric chamfer mean/p95 and Hausdorff between the registered
      surfaces, normalized by the reference bbox diagonal; `asymmetry` flags
      missing/extra regions.
    - classification: identical | near_identical | same_shape_modified | different
      (documented thresholds included in the result — apply your own if needed).
    - structural: triangle/vertex/texture/material/dimension deltas and QA-issue diff.

    Models are loaded sequentially (each may be a local path or URL); the LAST candidate
    stays loaded afterwards. Registration uses deterministic area-weighted surface
    samples (PCA-initialized ICP), so results are reproducible. Set align:false to skip
    registration and compare in-place (detects pose changes instead of ignoring them).

    Args:
        reference: local path or URL of the reference model.
        candidates: 1..8 local paths or URLs to compare against the reference.
        samples: surface sample count per model (more = finer, slower; default 4096).
        align: register candidates onto the reference before measuring (default true).
    """
    import numpy as np
    from backend.mesh_compare import compare_point_sets

    if not candidates:
        return {"ok": False, "error": "`candidates` is empty — provide 1..8 models."}
    if len(candidates) > 8:
        return {"ok": False, "error": f"Too many candidates ({len(candidates)}); max 8 per call."}

    # A composed scene would be silently DESTROYED by the sequential loads below.
    # Refuse instead of surprising the agent (save_scene first, or unload).
    page = await _runtime.page()
    scene_state = await page.evaluate("() => window.mv.getState().scene")
    if scene_state and scene_state.get("objectCount", 0) > 1:
        return {"ok": False,
                "error": f"A composed scene with {scene_state['objectCount']} objects is "
                         "loaded, and compare_models replaces the whole scene while "
                         "loading candidates. save_scene first (then load_scene to "
                         "restore), or viewer_execute unload to discard it."}

    async def _snapshot(source: str, extra_seed: bool = False) -> dict:
        r = await _load_source(source)
        if not r.get("ok"):
            return {"error": r.get("error", "load failed")}
        desc = (await _mv_execute("describe_scene", {"maxItems": 4})).get("result", {})
        pts = await _mv_execute("sample_points", {"count": samples, "seed": 42})
        if not pts.get("ok"):
            return {"error": f"sampling failed: {pts.get('error')}"}
        out = {"description": desc,
               "points": np.asarray(pts["result"]["points"], dtype=np.float64)}
        if extra_seed:
            # Second independent sampling of the same surface → sampling-noise floor.
            alt = await _mv_execute("sample_points", {"count": samples, "seed": 1337})
            if alt.get("ok"):
                out["points_alt"] = np.asarray(alt["result"]["points"], dtype=np.float64)
        return out

    async with await _get_load_lock():
        ref_snap = await _snapshot(reference, extra_seed=True)
        if "error" in ref_snap:
            return {"ok": False, "error": f"reference: {ref_snap['error']}"}

        comparisons = []
        for source in candidates:
            snap = await _snapshot(source)
            if "error" in snap:
                comparisons.append({"source": source, "ok": False, "error": snap["error"]})
                continue
            try:
                # Registration/NN is CPU-bound numpy — run it in a thread so the asyncio
                # event loop (and MCP protocol traffic) is not starved during long
                # compares (adversarial finding: 87 s event-loop stall at 16k samples).
                import asyncio
                geo = await asyncio.to_thread(
                    compare_point_sets, ref_snap["points"], snap["points"], align,
                    ref_snap.get("points_alt"))
            except Exception as e:
                comparisons.append({"source": source, "ok": False,
                                    "error": f"registration failed: {e}"})
                continue
            comparisons.append({
                "source": source,
                "ok": True,
                **geo,
                "structural": _structural_delta(ref_snap["description"], snap["description"]),
            })

    ref_model = ref_snap["description"].get("model", {})
    # Rank successful candidates by similarity (the headline 1-vs-N use case) so the
    # caller doesn't have to sort a metrics dict per candidate.
    ranked = sorted(
        (c for c in comparisons if c.get("ok")),
        key=lambda c: c["distances"]["chamferMeanNormalized"])
    ranking = [{"source": c["source"], "classification": c["classification"],
                "chamferMeanNormalized": c["distances"]["chamferMeanNormalized"]}
               for c in ranked]
    # The last SUCCESSFULLY loaded model is what's actually in the viewer now.
    last_loaded = next((c["source"] for c in reversed(comparisons) if c.get("ok")), reference)
    return _truncate_strings({
        "ok": True,
        "reference": {"source": reference,
                      "triangles": ref_model.get("triangles"),
                      "dimensions": ref_model.get("dimensions")},
        "samplesPerModel": samples,
        "aligned": align,
        "comparisons": comparisons,
        "rankingBySimilarity": ranking,
        "loadedModel": last_loaded,
    })


def _structural_delta(ref_desc: dict, cand_desc: dict) -> dict:
    """Count/inventory diff between two describe_scene results (asset-level facts)."""
    rm, cm = ref_desc.get("model", {}), cand_desc.get("model", {})

    def pct(a, b):
        return round(((b - a) / a) * 100, 2) if a else None

    return {
        "triangles": {"reference": rm.get("triangles"), "candidate": cm.get("triangles"),
                      "deltaPct": pct(rm.get("triangles", 0), cm.get("triangles", 0))},
        "vertices": {"reference": rm.get("vertices"), "candidate": cm.get("vertices")},
        "meshCount": {"reference": rm.get("meshCount"), "candidate": cm.get("meshCount")},
        "textures": {"reference": rm.get("textureCount"), "candidate": cm.get("textureCount")},
        "materials": {"reference": rm.get("materialCount"), "candidate": cm.get("materialCount")},
        "dimensions": {"reference": rm.get("dimensions"), "candidate": cm.get("dimensions")},
        "animated": {"reference": rm.get("animated"), "candidate": cm.get("animated")},
        "issues": {
            "reference": [i.get("code") for i in ref_desc.get("issues", [])],
            "candidate": [i.get("code") for i in cand_desc.get("issues", [])],
        },
    }


# View + render presets live in backend/headless_viewer.py (shared with the app's
# /api/screenshot endpoint so both surfaces expose identical documented looks).


async def _shot(width, height, transparent, hide_ground, ssao=True) -> Image:
    png = await _runtime.viewer.capture_png(
        width, height, transparent=transparent, hide_ground=hide_ground, ssao=ssao)
    return Image(data=png, format="png")


async def _timeline_sheet(times: list[float], width: int, height: int,
                          ssao: bool) -> bytes:
    """Seek → capture per time, composited into ONE contact-sheet PNG in the
    browser (grid canvas with the time burned into each tile). One image ≈
    hundreds of vision tokens versus thousands for N separate captures.
    The camera AUTO-FRAMES the union of all requested poses first (keeping the
    view direction) — animation must not walk out of frame (T1 finding)."""
    page = await _runtime.page()
    return base64.b64decode(await page.evaluate(
        """async ([times, w, h, ssao]) => {
            const v = window.mv.viewer;
            // Swept framing: union the visible bounds across ALL requested times.
            let union = null;
            for (const t of times) {
                await window.mv.execute({ action: 'seek_timeline', params: { time: t } });
                const box = v._visibleUnionBox();
                if (!box) continue;
                union = union ? union.union(box) : box.clone();
            }
            if (union && !union.isEmpty()) v._frameToBox(union);
            const cols = Math.ceil(Math.sqrt(times.length));
            const rows = Math.ceil(times.length / cols);
            const sheet = document.createElement('canvas');
            sheet.width = cols * w; sheet.height = rows * h;
            const ctx = sheet.getContext('2d');
            ctx.fillStyle = '#181820'; ctx.fillRect(0, 0, sheet.width, sheet.height);
            // Hatch unused tiles so they read as 'empty', not 'broken render'.
            ctx.strokeStyle = '#2a2a35'; ctx.lineWidth = 2;
            for (let i = times.length; i < cols * rows; i++) {
                const x = (i % cols) * w, y = Math.floor(i / cols) * h;
                for (let d = -h; d < w; d += 24) {
                    ctx.beginPath();
                    ctx.moveTo(x + d, y + h); ctx.lineTo(x + d + h, y);
                    ctx.stroke();
                }
            }
            for (let i = 0; i < times.length; i++) {
                const r = await window.mv.execute({ action: 'seek_timeline',
                                                    params: { time: times[i] } });
                if (!r.ok) throw new Error('seek failed: ' + r.error);
                const shot = await window.mv.execute({ action: 'screenshot',
                    params: { width: w, height: h, ssao } });
                if (!shot.ok) throw new Error('capture failed: ' + shot.error);
                const img = new window.Image();
                await new Promise((res, rej) => {
                    img.onload = res; img.onerror = rej; img.src = shot.result;
                });
                const x = (i % cols) * w, y = Math.floor(i / cols) * h;
                ctx.drawImage(img, x, y, w, h);
                const label = 't=' + times[i].toFixed(2) + 's';
                ctx.font = 'bold 16px monospace';
                const tw = ctx.measureText(label).width + 14;
                ctx.fillStyle = 'rgba(0,0,0,0.75)';
                ctx.fillRect(x, y, tw, 26);
                ctx.fillStyle = '#ffd75e';
                ctx.fillText(label, x + 7, y + 18);
                ctx.strokeStyle = 'rgba(255,255,255,0.18)';
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            }
            return sheet.toDataURL('image/png').split(',')[1];
        }""",
        [times, width, height, ssao]))


@mcp.tool()
async def screenshot(
    width: Annotated[int, Field(ge=16, le=8192)] = 1024,
    height: Annotated[int, Field(ge=16, le=8192)] = 1024,
    transparent: bool = False,
    hide_ground: bool = False,
    best_view: bool = False,
    views: list[str] | None = None,
    preset: str | None = None,
    ssao: bool = True,
    times: list[float] | None = None,
) -> list:
    """Render the model and return PNG image(s), with a JSON metadata text block first.

    One call, one OR many views:
    - default: the CURRENT camera view, one image.
    - best_view: first move the camera to the model's most detailed angle and upright it
      (semantic front) — good hero shot for an unknown model. The chosen
      azimuth/elevation/score are returned in the metadata block.
    - views: list of views captured in one call (cheaper than orbit+screenshot per angle).
      Each entry is a preset (front/back/left/right/top/bottom/iso) or "azimuth,elevation"
      in degrees (e.g. "45,20"). Images are returned in the same order as `views`.

    Args:
        width/height: output resolution per image (16-8192).
        transparent: alpha background (cutout for compositing).
        hide_ground: hide the ground/shadow plane.
        best_view: move to the semantic front first (ignored when `views` is given).
        views: capture several angles in one call.
        preset: pin the full lighting/background state to a documented, reproducible
                look BEFORE capturing, so renders are comparable across sessions and
                agents: "studio" (factory studio look), "neutral" (even light on
                mid-gray, for color/texture comparison), "dark" (hero shots on
                near-black). Sets IBL, key/fill/ambient lights, exposure, and
                background; the preset stays active for the session afterwards.
        ssao: render through the SSAO/tone-mapping composer (default). Set False
              for PROOF renders during sculpt/paint loops — combine with a small
              size (e.g. 192x192) for a cheap "did that land?" check, and save
              full-size composed captures for final verification.
        times: MOTION CONTACT SHEET — seek the scene timeline to each time
               (seconds, ≤12) and return ONE composite grid image with the time
               burned into each tile. THE cheap animation preview: one image,
               one round trip (e.g. times=[0, 0.5, 1, 1.5, 2] after keyframing).
               width/height set the PER-TILE size (use ≤384 for proofs).
               Ignores views/best_view.

    Hand-eye loop: when you spot a feature at pixel (px, py) in a returned image,
    convert it to a 3D surface point with viewer_execute pick
    {x: px/width, y: py/height, width, height} — pass THIS screenshot's
    width/height, and re-pick after any camera move.
    """
    page = await _runtime.page()
    loaded = await page.evaluate("() => window.mv.getState().model.loaded")
    if not loaded:
        # Fail loudly instead of returning a wordless black frame.
        raise RuntimeError("No model is loaded — call load_model first.")

    meta: dict = {"width": width, "height": height}
    contents: list = []

    if preset is not None:
        await _runtime.viewer.apply_render_preset(preset)
        meta["preset"] = preset

    if times is not None:
        if len(times) == 0 or len(times) > 12:
            raise RuntimeError("`times` takes 1-12 timeline seconds.")
        tl_state = await page.evaluate("() => window.mv.getState().timeline")
        if not tl_state or not tl_state.get("tracks"):
            raise RuntimeError("The scene timeline is empty — set_keyframe first "
                               "(times previews TIMELINE motion).")
        sheet = await _timeline_sheet([float(t) for t in times],
                                      min(width, 1024), min(height, 1024), ssao)
        meta["times"] = times
        meta["sheet"] = True
        return [json.dumps(meta), Image(data=sheet, format="png")]

    if views is not None:
        if len(views) == 0:
            raise RuntimeError("`views` is an empty list — pass view specs or omit it.")
        if len(views) > 12:
            # Each 1024² PNG is ~0.5-1 MB base64; some MCP clients cap result sizes,
            # and the session blocks for the whole render batch.
            raise RuntimeError(f"Too many views ({len(views)}); max 12 per call.")
        captured = []
        for spec in views:
            spec = str(spec).strip().lower()
            if spec in VIEW_PRESETS:
                r = await _mv_execute("set_view", {"preset": spec, "scope": "scene"})
            else:
                try:
                    az, el = (float(x) for x in spec.split(","))
                except ValueError:
                    raise RuntimeError(
                        f"Invalid view '{spec}'. Use a preset ({'/'.join(sorted(VIEW_PRESETS))}) "
                        f"or 'azimuth,elevation' degrees like '45,20'.")
                # scope:"scene" — framing the ACTIVE object alone can put the
                # camera INSIDE another object of a composed scene (T2: a split
                # wheel was active; 'right' rendered the car's interior).
                r = await _mv_execute("orbit", {"azimuth": az, "elevation": el,
                                                "scope": "scene"})
            if not r.get("ok"):
                raise RuntimeError(f"View '{spec}' failed: {r.get('error')}")
            contents.append(await _shot(width, height, transparent, hide_ground, ssao))
            captured.append(spec)
        meta["views"] = captured
    else:
        if best_view:
            r = await _mv_execute("find_best_view", {"fill": 0.85})
            if not r.get("ok"):
                raise RuntimeError(f"find_best_view failed: {r.get('error')}")
            bv = r.get("result") or {}
            meta["best_view"] = {k: bv.get(k) for k in ("azimuth", "elevation", "score")}
        contents.append(await _shot(width, height, transparent, hide_ground, ssao))

    return [json.dumps(meta), *contents]


@mcp.tool()
async def save_scene(path: str, overwrite: bool = False) -> dict:
    """Save the CURRENT composed scene as a .mvscene manifest file.

    The manifest records each object's SOURCE (original local path or URL), its
    placement transform, visibility and opacity, plus scene lighting/environment/
    background — load_scene rebuilds the exact composition. Objects loaded from
    volatile sources cannot be persisted and are reported in skipped_volatile.

    Args:
        path: absolute destination path (.mvscene appended if missing).
        overwrite: replace an existing scene file (only ever overwrites .mvscene).
    """
    import json as _json

    from backend.scene_api import SCENE_EXTENSION

    target = Path(path).expanduser()
    if not target.is_absolute():
        return {"ok": False, "error": f"Path must be absolute: {path}"}
    if not target.name or target.name in {".", ".."}:
        return {"ok": False, "error": "Path has no file name"}
    if not target.name.lower().endswith(SCENE_EXTENSION):
        target = target.with_name(target.name + SCENE_EXTENSION)
    if target.exists():
        if not overwrite:
            return {"ok": False, "error": f"Already exists: {target} "
                                          "(pass overwrite=true to replace)"}
        if not (target.is_file() and target.suffix.lower() == SCENE_EXTENSION):
            return {"ok": False, "error": "Refusing to overwrite a non-scene file"}

    result = await _mv_execute("get_scene_manifest", {})
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error", "no scene to save")}
    manifest = result["result"]
    if not manifest.get("objects"):
        return {"ok": False, "error": "Nothing persistable in the scene "
                                      f"(volatile-only: {manifest.get('skippedVolatile')})"}

    # Save-time metadata, not scene data — reported to the caller, not persisted.
    skipped_volatile = manifest.pop("skippedVolatile", [])
    unsaved_paint = manifest.pop("unsavedPaint", [])
    unsaved_edits = manifest.pop("unsavedEdits", [])

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(_json.dumps(manifest, indent=2), encoding="utf-8")
    out = {"ok": True, "path": str(target), "objects": len(manifest["objects"]),
           "skipped_volatile": skipped_volatile}
    warnings = []
    if unsaved_paint:
        warnings.append(f"paint layers on {unsaved_paint}")
    if unsaved_edits:
        warnings.append(f"sculpt/geometry edits on {unsaved_edits}")
    if warnings:
        out["warning"] = (
            "NOT persisted in .mvscene manifests (they store sources + "
            f"placements, not deltas): {'; '.join(warnings)}. "
            "Use export_model (GLB) to keep sculpted geometry and paint.")
    return out


@mcp.tool()
async def get_texture(
    size: Annotated[int, Field(ge=128, le=2048)] = 1024,
    wireframe: bool = True,
    markers: list[list[float]] | None = None,
    outline_island_of: list[float] | None = None,
    crop_center: list[float] | None = None,
    crop_size: float | None = None,
) -> list:
    """SEE the active object's texture in TEXTURE SPACE — the texture image with
    the mesh's UV wireframe overlaid (green) and optional crosshair markers.

    THE texture-to-mesh misalignment diagnostic: `viewer_execute pick` returns
    the surface point's `.uv`; pass it here as a marker. If the marker (where
    the mesh SAMPLES) sits offset from the matching texture feature (where the
    detail IS), the UVs are shifted/stretched — measure the delta in UV units
    and repair with `viewer_execute transform_uv {offset|scale}`. Iterate:
    small transform → get_texture + 3D screenshot → converge.

    Args:
        size: output resolution (128-2048).
        wireframe: overlay the UV triangulation (where the mesh samples).
        markers: [[u, v], ...] crosshairs (typically pick results' .uv).
        outline_island_of: [u, v] — outline the UV ISLAND (chart) containing
            this point in orange. Fragmented atlases: shows exactly which chart
            a feature lives in (scope for transform_uv {island_of}).
        crop_center/crop_size: zoom into a UV window (the measurement view for
            tiny charts — e.g. crop_center=<pick uv>, crop_size=0.15).
    """
    page = await _runtime.page()
    params = {"size": size, "wireframe": wireframe}
    if markers:
        params["markers"] = markers
    if outline_island_of:
        params["outline_island_of"] = outline_island_of
    if crop_center:
        params["crop_center"] = crop_center
        params["crop_size"] = crop_size or 0.2
    result = await page.evaluate(
        "([p]) => window.mv.execute({ action: 'render_texture', params: p })",
        [params])
    if not result.get("ok"):
        raise RuntimeError(result.get("error", "render_texture failed"))
    png = base64.b64decode(result["result"].split(",", 1)[1])
    meta = {"size": size, "wireframe": wireframe, "markers": markers or []}
    if outline_island_of:
        meta["outline_island_of"] = outline_island_of
    if crop_center:
        meta["crop"] = {"center": crop_center, "size": crop_size or 0.2}
    return [json.dumps(meta), Image(data=png, format="png")]


@mcp.tool()
async def export_model(
    path: str,
    animation: bool | None = None,
    texture_size: str | int | None = None,
) -> dict:
    """Export the visible scene as a GLB FILE — the persistence path for sculpted
    geometry, painted textures, articulation and timeline animation (none of
    which survive in .mvscene manifests).

    Args:
        path: absolute destination (.glb appended if missing; parent dirs created).
        animation: include the scene timeline as a glTF animation (default: auto
                   — included whenever the timeline has tracks). Exports 30 fps
                   resampled TRS tracks; pivots are composed in (an off-origin
                   rotation exports an arced position track — correct, glTF has
                   no pivots). Verify by re-loading: get_state().animation.
        texture_size: cap texture resolution on write — number or tier
                      low(512)/medium(1024)/high(2048)/xhigh(4096). The
                      non-destructive LoD path (re-export at any tier).
    """
    target = Path(path).expanduser()
    if not target.is_absolute():
        return {"ok": False, "error": f"Path must be absolute: {path}"}

    tiers = {"low": 512, "medium": 1024, "high": 2048, "xhigh": 4096}
    tex: int | None = None
    if texture_size is not None:
        if isinstance(texture_size, str):
            if texture_size not in tiers:
                return {"ok": False,
                        "error": f"texture_size must be a number or one of: {', '.join(tiers)}"}
            tex = tiers[texture_size]
        else:
            tex = int(texture_size)
            if not (64 <= tex <= 4096):
                return {"ok": False, "error": "texture_size must be 64-4096"}

    # The session fetches the data URL in-process and writes to disk (the
    # viewer_execute tool path truncates strings >2 KB — a GLB is megabytes).
    out = await _runtime.session.export_glb_to_file(
        target, animation=animation, texture_size=tex)
    if not out.get("ok"):
        return out

    page = await _runtime.page()
    tl_state = await page.evaluate("() => window.mv.getState().timeline")
    if tl_state and tl_state.get("tracks") and animation is not False:
        out["animation"] = {"tracks": tl_state["tracks"],
                            "duration": tl_state.get("duration")}
        out["verify"] = ("load_model the exported path and check "
                         "get_state().animation.clips == 1")
    return out


@mcp.tool()
async def load_scene(path: str) -> dict:
    """Rebuild a composed scene from a .mvscene manifest file.

    REPLACES the current scene, then adds every object with its saved placement,
    visibility and opacity, and restores lighting/environment/background. Objects
    whose source no longer resolves are reported per-object; the rest still load.
    Archive-member sources are app-only and reported as unsupported here.

    Args:
        path: absolute path of the .mvscene file.
    """
    import json as _json

    from backend.scene_api import (
        MAX_MANIFEST_BYTES, SCENE_EXTENSION, validate_manifest)

    file_path = Path(path).expanduser()
    if not file_path.is_absolute():
        return {"ok": False, "error": f"Path must be absolute: {path}"}
    if not file_path.is_file():
        return {"ok": False, "error": f"File not found: {file_path}"}
    if file_path.suffix.lower() != SCENE_EXTENSION:
        return {"ok": False, "error": f"Not a scene file (expected {SCENE_EXTENSION})"}
    if file_path.stat().st_size > MAX_MANIFEST_BYTES:
        return {"ok": False, "error": "Scene file too large"}
    try:
        manifest = _json.loads(file_path.read_text(encoding="utf-8"))
        validate_manifest(manifest)  # raises HTTPException-like on bad structure
    except Exception as e:
        detail = getattr(e, "detail", None)
        return {"ok": False, "error": f"Invalid scene file: {detail or e}"}

    async with await _get_load_lock():
        await _mv_execute("unload", {})
        loaded, failed = [], []
        id_by_index: list = []   # manifest index -> new objectId (None on failure)
        for obj in manifest["objects"]:
            src = obj.get("source", {})
            if src.get("kind") == "primitive":
                result = await _mv_execute("add_primitive", {
                    "kind": src.get("primitive"),
                    "params": src.get("params"),
                    "color": src.get("color"),
                    "name": obj.get("name"),
                    "transform": obj.get("transform"),
                    "frame": False,
                })
            elif src.get("kind") == "file":
                result = await _load_source(src.get("path", ""), obj.get("name"),
                                            add=True, transform=obj.get("transform"))
            elif src.get("kind") == "url":
                result = await _load_source(src.get("url", ""), obj.get("name"),
                                            add=True, transform=obj.get("transform"))
            else:
                failed.append({"name": obj.get("name"),
                               "error": "archive-member sources are app-only"})
                id_by_index.append(None)
                continue
            if not result.get("ok"):
                failed.append({"name": obj.get("name"), "error": result.get("error")})
                id_by_index.append(None)
                continue
            object_id = (result.get("result") or {}).get("objectId")
            id_by_index.append(object_id)
            if object_id is not None:
                if obj.get("visible") is False:
                    await _mv_execute("set_object_visible",
                                      {"id": object_id, "visible": False})
                opacity = obj.get("opacity")
                if isinstance(opacity, (int, float)) and opacity < 1:
                    await _mv_execute("set_object_opacity",
                                      {"id": object_id, "opacity": opacity})
            loaded.append(obj.get("name"))

        # Manifest v2: articulation (pivots + hierarchy) and the timeline —
        # index-based references, tracks of failed objects dropped and reported.
        articulation = None
        if manifest.get("version", 1) >= 2:
            page = await _runtime.page()
            articulation = await page.evaluate(
                "([m, ids]) => window.mv.viewer.applyManifestArticulation(m, ids)",
                [manifest, id_by_index])

        # Scene-level looks: lighting, IBL, background.
        lighting = manifest.get("lighting")
        if isinstance(lighting, dict):
            await _mv_execute("set_lighting", {
                "azimuth": lighting.get("keyAzimuth"),
                "elevation": lighting.get("keyElevation"),
                "key_intensity": lighting.get("keyIntensity"),
                "fill_intensity": lighting.get("fillIntensity"),
                "ambient": lighting.get("ambientIntensity"),
                "exposure": lighting.get("exposure"),
            })
        environment = manifest.get("environment")
        if isinstance(environment, dict):
            await _mv_execute("set_environment", {
                "enabled": environment.get("enabled"),
                "intensity": environment.get("intensity"),
                "asBackground": environment.get("asBackground"),
            })
        if isinstance(manifest.get("background"), str):
            await _mv_execute("set_background", {"color": manifest["background"]})
        await _mv_execute("frame_all", {})

    out = {
        "ok": len(loaded) > 0,
        "loaded": loaded,
        "failed": failed,
        "objectCount": len(loaded),
    }
    if articulation:
        out["articulation"] = articulation
    return _truncate_strings(out)


@mcp.tool()
async def get_app_state() -> dict:
    """What is the human looking at in the running MeshVault app, right now?

    The reverse of open_in_app: reads the state the app tabs report (current asset
    path + camera pose + freshness), so you can pick up the human's subject and
    continue headless — typically `load_model` with the returned path, then
    `viewer_execute {action:"set_camera", params:{position, target, fov}}` to see
    exactly what they see. Discovery works like open_in_app
    (~/.meshvault/app_session.json, env overrides MESHVAULT_APP_URL/MESHVAULT_TOKEN).

    Returns {ok, state: {path, name, camera, age_seconds} | null, clients}.
    state:null means the app is running but no tab has loaded anything yet.
    """
    from backend.agent_bridge import (
        StaleSessionError, discover_app_session, fetch_app_state)

    try:
        session = discover_app_session()
    except StaleSessionError as e:
        return {"ok": False, "error": f"Stale session file: the app that published it "
                                      f"(pid {e.pid}) is dead. Ask the human to start "
                                      "the app (`meshvault`)."}
    if session is None:
        return {"ok": False, "error": "No running MeshVault app found: "
                                      "~/.meshvault/app_session.json is missing and "
                                      "MESHVAULT_APP_URL is not set."}
    import asyncio
    try:
        result = await asyncio.to_thread(fetch_app_state, session)
    except RuntimeError as e:
        return {"ok": False, "error": str(e)}

    state = result.get("state")
    out = {"ok": True, "app": session["url"], "state": state,
           "clients": result.get("clients", 0)}
    if state and state.get("path"):
        out["hint"] = (f"Continue headless: load_model {{source: \"{state['path']}\"}} "
                       "then viewer_execute set_camera with the returned camera.")
    elif state is None:
        out["hint"] = "The app is running but no tab has reported a loaded model yet."
    return out


def main():
    """Entry point for the `meshvault-mcp` console script (stdio transport)."""
    mcp.run()


if __name__ == "__main__":
    main()
