"""
MeshVault MCP server — a thin Model Context Protocol adapter over the viewer control API
(backlog 030).

Design: ~6 tools, NOT one-tool-per-command (wide tool surfaces measurably degrade agent
performance). Everything routes through the existing self-describing `execute()` registry
of the standalone viewer, which runs in a headless Chromium page hosted by a tiny
loopback HTTP server. The page is the single source of truth; this module only marshals
JSON in/out and images back to the MCP client.

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
import http.server
import json
import secrets
import socket
import tempfile
import threading
import urllib.request
from pathlib import Path
from typing import Any

from typing import Annotated

from mcp.server.fastmcp import FastMCP, Image
from pydantic import Field

# Formats the viewer can load (kept in sync with frontend loaders).
SUPPORTED_EXTENSIONS = {
    ".obj", ".fbx", ".gltf", ".glb", ".stl", ".ply", ".dae", ".3mf", ".usdz",
}

# Hard cap for server-side URL downloads (CORS fallback) — keeps a hostile/mistyped URL
# from filling the disk. Large real-world GLBs are usually well under this.
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

# Strings longer than this inside `execute` results are truncated (screenshots must go
# through the dedicated tool, which returns proper MCP image content).
MAX_RESULT_STRING = 2000

FRONTEND_ROOT = Path(__file__).resolve().parent.parent / "frontend"

HARNESS_HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MeshVault MCP host</title>
<style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#33373f}</style>
</head><body><div id="app"></div>
<script type="module">
import { createViewer } from "./dist/meshvault-viewer.js";
window.mv = createViewer(document.getElementById("app"));
window.mvReady = true;
</script></body></html>"""


class _AssetHandler(http.server.BaseHTTPRequestHandler):
    """Serves the harness page, the viewer bundle + decoders, and registered models."""

    runtime: "_Runtime" = None  # set by _Runtime

    def do_GET(self):  # noqa: N802 (http.server API)
        path = self.path.split("?", 1)[0]
        if path == "/":
            return self._send(200, HARNESS_HTML.encode("utf-8"), "text/html")
        if path.startswith("/models/"):
            token = path.split("/", 2)[2]
            file_path = self.runtime.registered_models.get(token)
            if not file_path:
                return self._send(404, b"unknown model token", "text/plain")
            return self._send_file(file_path)
        # Static frontend assets (bundle, vendor decoders) — confined to FRONTEND_ROOT.
        # is_relative_to gives a real path-boundary check; a string prefix compare would
        # wrongly admit sibling dirs like frontend_x/ (adversarial review finding).
        rel = path.lstrip("/")
        candidate = (FRONTEND_ROOT / rel).resolve()
        if candidate.is_file() and candidate.is_relative_to(FRONTEND_ROOT):
            return self._send_file(candidate)
        return self._send(404, b"not found", "text/plain")

    def _send_file(self, file_path: Path):
        ctype = {
            ".js": "text/javascript", ".wasm": "application/wasm",
            ".html": "text/html", ".glb": "model/gltf-binary",
            ".gltf": "model/gltf+json",
        }.get(file_path.suffix.lower(), "application/octet-stream")
        try:
            data = file_path.read_bytes()
        except OSError:
            return self._send(404, b"unreadable", "text/plain")
        return self._send(200, data, ctype)

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # stdio transport: NOTHING may pollute stdout/stderr noise
        pass


class _Runtime:
    """Lazily-started loopback HTTP server + headless browser page hosting the viewer."""

    def __init__(self):
        self.registered_models: dict[str, Path] = {}
        self._httpd = None
        self._page = None
        self._playwright = None
        self._browser = None
        self._tmpdir = tempfile.TemporaryDirectory(prefix="meshvault_mcp_")
        self._lock = None  # created lazily inside the running event loop
        self.base_url = None

    async def page(self):
        import asyncio
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if self._page is not None:
                return self._page
            self._start_http()
            await self._start_browser()
            return self._page

    def _start_http(self):
        if self._httpd:
            return
        handler = _AssetHandler
        handler.runtime = self
        # Bind loopback on an ephemeral port; never reachable off-host.
        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        port = self._httpd.server_address[1]
        self.base_url = f"http://127.0.0.1:{port}"
        threading.Thread(target=self._httpd.serve_forever, daemon=True).start()

    async def _start_browser(self):
        try:
            from playwright.async_api import async_playwright
        except ImportError as e:
            raise RuntimeError(
                "playwright is required: pip install 'meshvault[mcp]' && playwright install chromium"
            ) from e
        self._playwright = await async_playwright().start()
        try:
            self._browser = await self._playwright.chromium.launch(
                headless=True,
                # SwiftShader keeps WebGL working on GPU-less hosts (CI, servers) and
                # renders deterministically; harmless on machines with a GPU.
                args=["--use-gl=angle", "--use-angle=swiftshader"],
            )
        except Exception as e:
            raise RuntimeError(
                f"Could not launch Chromium ({e}). Run: playwright install chromium"
            ) from e
        context = await self._browser.new_context(viewport={"width": 1280, "height": 960})
        self._page = await context.new_page()
        await self._page.goto(self.base_url + "/", wait_until="load")
        await self._page.wait_for_function("() => window.mvReady === true", timeout=30000)

    def register_local_file(self, file_path: Path) -> str:
        token = secrets.token_urlsafe(16) + file_path.suffix.lower()
        self.registered_models[token] = file_path
        return f"{self.base_url}/models/{token}"

    def download_to_temp(self, url: str) -> Path:
        """Server-side fetch for CORS-blocked URLs; size-capped, into the runtime tempdir."""
        suffix = Path(url.split("?", 1)[0]).suffix.lower() or ".glb"
        target = Path(self._tmpdir.name) / (secrets.token_hex(8) + suffix)
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
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()
        if self._httpd:
            self._httpd.shutdown()
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
        "MeshVault: a headless 3D model viewer you can drive entirely through JSON. "
        "Typical flow: load_model (URL or local path) → describe_scene (understand WHAT "
        "loaded, no vision needed) → viewer_execute for camera/render/transform commands "
        "(discover them with list_viewer_commands) → screenshot to SEE the result. "
        "Supports .obj .fbx .gltf .glb (incl. Draco/KTX2/Meshopt) .stl .ply .dae .3mf .usdz."
    ),
)


# Serializes load_model's load→describe pair. The page is one shared scene: two loads
# racing in a single session would otherwise return descriptions of the wrong model
# (found by the concurrency field test).
_load_lock = None


@mcp.tool()
async def load_model(source: str, name: str | None = None) -> dict:
    """Load a 3D model into the viewer from an http(s) URL or a LOCAL FILE PATH.

    Local paths are served to the sandboxed viewer over loopback; URLs are fetched by
    the browser first and, if blocked by CORS, downloaded server-side automatically.
    Returns the load result plus a structured scene description (same as describe_scene),
    so one call tells you what you loaded.

    Args:
        source: http(s) URL of a model, or an absolute/home-relative local file path.
        name: optional display name (defaults to the file name).
    """
    async with await _get_load_lock():
        result = await _load_source(source, name)
        if not result.get("ok"):
            return _truncate_strings(result)
        description = await _mv_execute("describe_scene", {})
        return _truncate_strings({"ok": True, "loaded": True,
                                  "description": description.get("result")})


async def _get_load_lock():
    import asyncio
    global _load_lock
    if _load_lock is None:
        _load_lock = asyncio.Lock()
    return _load_lock


async def _load_source(source: str, name: str | None = None) -> dict:
    """Shared load path: URL (browser-first, server-download CORS fallback) or local file.
    Callers must hold the load lock. Returns the raw viewer load result {ok, ...}."""
    is_url = source.startswith("http://") or source.startswith("https://")
    if is_url:
        display = name or source.rstrip("/").rsplit("/", 1)[-1]
        result = await _mv_execute("load", {"url": source, "name": display})
        if not result.get("ok"):
            # Browser-side fetch failed — typically CORS. Retry via server-side download.
            try:
                local = _runtime.download_to_temp(source)
            except Exception as e:
                return {"ok": False, "error": f"Browser load failed ({result.get('error')}); "
                                              f"server-side download also failed: {e}"}
            url = _runtime.register_local_file(local)
            result = await _mv_execute(
                "load", {"url": url, "extension": local.suffix, "name": display})
        return result
    path = Path(source).expanduser()
    if not path.is_absolute():
        return {"ok": False, "error": f"Local path must be absolute: {source}"}
    if path.is_dir():
        return {"ok": False, "error": f"Path is a directory, not a model file: {path}"}
    if not path.is_file():
        return {"ok": False, "error": f"File not found: {path}"}
    ext = path.suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        return {"ok": False, "error": f"Unsupported format '{ext}'. "
                                      f"Supported: {' '.join(sorted(SUPPORTED_EXTENSIONS))}"}
    await _runtime.page()  # ensure base_url exists before registering
    url = _runtime.register_local_file(path)
    return await _mv_execute(
        "load", {"url": url, "extension": ext, "name": name or path.name})


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


VIEW_PRESETS = {"front", "back", "left", "right", "top", "bottom", "iso"}


async def _shot(width, height, transparent, hide_ground) -> Image:
    result = await _mv_execute("screenshot", {
        "width": width, "height": height,
        "transparent": transparent, "hideGround": hide_ground,
    })
    if not result.get("ok"):
        raise RuntimeError(result.get("error", "screenshot failed"))
    png = base64.b64decode(result["result"].split(",", 1)[1])
    return Image(data=png, format="png")


@mcp.tool()
async def screenshot(
    width: Annotated[int, Field(ge=16, le=8192)] = 1024,
    height: Annotated[int, Field(ge=16, le=8192)] = 1024,
    transparent: bool = False,
    hide_ground: bool = False,
    best_view: bool = False,
    views: list[str] | None = None,
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
    """
    page = await _runtime.page()
    loaded = await page.evaluate("() => window.mv.getState().model.loaded")
    if not loaded:
        # Fail loudly instead of returning a wordless black frame.
        raise RuntimeError("No model is loaded — call load_model first.")

    meta: dict = {"width": width, "height": height}
    contents: list = []

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
                r = await _mv_execute("set_view", {"preset": spec})
            else:
                try:
                    az, el = (float(x) for x in spec.split(","))
                except ValueError:
                    raise RuntimeError(
                        f"Invalid view '{spec}'. Use a preset ({'/'.join(sorted(VIEW_PRESETS))}) "
                        f"or 'azimuth,elevation' degrees like '45,20'.")
                r = await _mv_execute("orbit", {"azimuth": az, "elevation": el})
            if not r.get("ok"):
                raise RuntimeError(f"View '{spec}' failed: {r.get('error')}")
            contents.append(await _shot(width, height, transparent, hide_ground))
            captured.append(spec)
        meta["views"] = captured
    else:
        if best_view:
            r = await _mv_execute("find_best_view", {"fill": 0.85})
            if not r.get("ok"):
                raise RuntimeError(f"find_best_view failed: {r.get('error')}")
            bv = r.get("result") or {}
            meta["best_view"] = {k: bv.get(k) for k in ("azimuth", "elevation", "score")}
        contents.append(await _shot(width, height, transparent, hide_ground))

    return [json.dumps(meta), *contents]


def main():
    """Entry point for the `meshvault-mcp` console script (stdio transport)."""
    mcp.run()


if __name__ == "__main__":
    main()
