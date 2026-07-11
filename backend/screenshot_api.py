"""
GET /api/screenshot — headless, browser-session-free renders over plain HTTP.

The missing piece for curl/non-MCP agents: one authenticated GET returns a PNG of a
local model from a chosen angle under a pinned lighting preset, so generate → inspect
→ critique loops need no browser session and no MCP client.

Design (from the adversarial review of the original feature request):
- The harness page runs on the APP's own origin and loads models through the guarded
  /api/asset/file + /api/asset/related endpoints (Playwright context sends the session
  token on every request). This inherits PathGuard confinement AND correct multi-file
  resolution (MTL/textures) — the MCP-style single-file registry would render
  untextured.
- Single-flight: one shared page, one render at a time. Callers queue briefly for the
  lock (429 beyond a bounded wait) and every request is wrapped in a hard timeout
  (504) — software-GL renders are slow, not unbounded.
- Deterministic per request: every request unloads, reloads, and applies a FULL render
  preset (default "studio"), so nothing bleeds between requests through the shared
  scene. `preset=none` opts out (documented as stateful).
- Fail early and specifically: PathGuard/size checks run BEFORE the browser starts;
  a missing playwright package and a missing Chromium binary return distinct 503s.

The router receives its dependencies from backend.app (dependency injection keeps
this module import-cycle-free and independently testable).
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.parse
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, Response

from backend.headless_viewer import (
    MAX_MODEL_BYTES,
    RENDER_PRESETS,
    VIEW_PRESETS,
    HeadlessViewer,
    companion_files,
)

# One render can take tens of seconds on software GL (SwiftShader); the timeout is a
# guard against hangs, not a performance target.
RENDER_TIMEOUT_S = float(os.environ.get("MESHVAULT_SCREENSHOT_TIMEOUT", "240"))

# How long a request may wait for the single render slot before 429.
BUSY_WAIT_S = 30.0

# Harness: the standalone viewer on the app origin. Relative resource refs (and the
# app-style absolute-path refs) route through the guarded related-file endpoint,
# scoped per load by window.__mvResourceDir — this is what keeps OBJ+MTL+textures
# working here while staying inside the PathGuard.
_HARNESS_HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MeshVault screenshot host</title>
<style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#33373f}</style>
</head><body><div id="app"></div>
<script type="module">
import { createViewer } from "/static/dist/meshvault-viewer.js";
window.mv = createViewer(document.getElementById("app"), {
    assetBaseUrl: "/static/",
    resolveResource: (ref) => {
        if (/^(https?:|data:|blob:)/i.test(ref)) return ref;
        const dir = window.__mvResourceDir || "";
        const path = ref.startsWith("/") ? ref : (dir ? dir + "/" + ref : ref);
        return "/api/asset/related?path=" + encodeURIComponent(path);
    },
});
window.mvReady = true;
</script></body></html>"""


class ScreenshotService:
    """Owns the app-origin HeadlessViewer and renders one screenshot per request."""

    def __init__(self, token_supplier: Callable[[], str]):
        self._token_supplier = token_supplier
        self._viewer: Optional[HeadlessViewer] = None
        self.lock = asyncio.Lock()

    def _get_viewer(self) -> HeadlessViewer:
        if self._viewer is None:
            # The token authenticates the harness page's /api/asset/* fetches.
            # idle_close_s: a one-shot screenshot must not pin ~0.8 GB of Chromium
            # forever — the browser closes after idle and restarts on demand.
            self._viewer = HeadlessViewer(
                extra_http_headers={"X-MeshVault-Token": self._token_supplier()},
                idle_close_s=float(os.environ.get("MESHVAULT_SCREENSHOT_IDLE_CLOSE", "300")),
            )
        return self._viewer

    async def render(self, harness_url: str, serve_path: Path, extension: str,
                     *, preset: str, view: Optional[str], azimuth: Optional[float],
                     elevation: Optional[float], best_view: bool, fill: Optional[float],
                     width: int, height: int, transparent: bool,
                     hide_ground: bool) -> tuple[bytes, dict]:
        """Load → pin preset → frame → capture. Returns (png, metadata)."""
        viewer = self._get_viewer()
        await viewer.ensure(harness_url)

        # Scope relative resource refs (MTL, textures) to the model's directory.
        await viewer.page.evaluate(
            "dir => { window.__mvResourceDir = dir; }", str(serve_path.parent))

        # Fresh scene per request: unload is cheap and makes state deterministic.
        await viewer.execute("unload", {})

        stat = serve_path.stat()
        model_url = (f"/api/asset/file?path={urllib.parse.quote(str(serve_path))}"
                     f"&v={stat.st_size}-{stat.st_mtime_ns}")
        load = await viewer.execute("load", {
            "url": model_url, "extension": extension, "name": serve_path.name,
            "relatedFiles": companion_files(serve_path),
        })
        if not load.get("ok"):
            raise HTTPException(status_code=422,
                                detail=f"Model failed to load: {load.get('error')}")

        meta: dict = {"path": str(serve_path), "width": width, "height": height,
                      "preset": preset}
        if preset != "none":
            await viewer.apply_render_preset(preset)

        if best_view:
            r = await viewer.execute("find_best_view", {"fill": fill or 0.85})
            if not r.get("ok"):
                raise HTTPException(status_code=500,
                                    detail=f"find_best_view failed: {r.get('error')}")
            bv = r.get("result") or {}
            meta["best_view"] = {k: bv.get(k) for k in ("azimuth", "elevation", "score")}
        elif view is not None:
            r = await viewer.execute("set_view", {"preset": view, **(
                {"fill": fill} if fill is not None else {})})
            if not r.get("ok"):
                raise HTTPException(status_code=500,
                                    detail=f"set_view failed: {r.get('error')}")
            meta["view"] = view
        elif azimuth is not None:
            params = {"azimuth": azimuth, "elevation": 15.0 if elevation is None else elevation}
            if fill is not None:
                params["fill"] = fill
            r = await viewer.execute("orbit", params)
            if not r.get("ok"):
                raise HTTPException(status_code=500,
                                    detail=f"orbit failed: {r.get('error')}")
            meta["view"] = f"{params['azimuth']},{params['elevation']}"
        # else: keep the framed default view the loader produced.

        png = await viewer.capture_png(width, height, transparent=transparent,
                                       hide_ground=hide_ground)

        # Free the model's geometry/texture memory NOW: the warm browser (kept
        # for fast follow-up requests) should idle at its floor, not pin the last
        # model until the idle reaper fires. The next request unloads anyway.
        await viewer.execute("unload", {})
        return png, meta

    async def close(self):
        if self._viewer is not None:
            await self._viewer.close()
            self._viewer = None


def create_router(
    *,
    guarded_path: Callable[..., Path],
    maybe_convert_asset: Callable[[Path], tuple[Path, str]],
    token_supplier: Callable[[], str],
) -> tuple[APIRouter, ScreenshotService]:
    """Build the screenshot router with its app dependencies injected.

    guarded_path / maybe_convert_asset are backend.app's own helpers, so this
    endpoint enforces the exact same trust boundary and FBX auto-conversion as
    every other asset route.
    """
    router = APIRouter()
    service = ScreenshotService(token_supplier)

    @router.get("/api/screenshot/harness", response_class=HTMLResponse)
    async def screenshot_harness():
        """Viewer page the headless browser drives (auth: token header)."""
        return HTMLResponse(content=_HARNESS_HTML)

    @router.get("/api/screenshot")
    async def screenshot(
        request: Request,
        path: str = Query(..., description="Absolute path of the model file"),
        view: Optional[str] = Query(default=None,
                                    description="Camera preset (front/back/left/right/top/bottom/iso)"),
        azimuth: Optional[float] = Query(default=None, description="Camera azimuth in degrees"),
        elevation: Optional[float] = Query(default=None, description="Camera elevation in degrees"),
        best_view: bool = Query(default=False,
                                description="Frame the model's most detailed angle first"),
        preset: str = Query(default="studio",
                            description="Render preset: studio|neutral|dark|none"),
        fill: Optional[float] = Query(default=None, ge=0.1, le=1.0),
        width: int = Query(default=1024, ge=16, le=8192),
        height: int = Query(default=1024, ge=16, le=8192),
        transparent: bool = Query(default=False),
        hide_ground: bool = Query(default=False),
    ):
        """
        Render a local model to PNG, headless — no browser session, no MCP client.

        Response: image/png bytes; render facts (chosen view, preset) in the
        X-MeshVault-Screenshot header as compact JSON.
        """
        if view is not None and view not in VIEW_PRESETS:
            raise HTTPException(status_code=422,
                                detail=f"Unknown view '{view}'. "
                                       f"Presets: {'/'.join(sorted(VIEW_PRESETS))}")
        if preset != "none" and preset not in RENDER_PRESETS:
            raise HTTPException(status_code=422,
                                detail=f"Unknown preset '{preset}'. Available: "
                                       f"{', '.join(sorted(RENDER_PRESETS))}, none")

        # Trust boundary + size sanity BEFORE any browser work.
        file_path = guarded_path(path, require_file=True)
        if file_path.stat().st_size > MAX_MODEL_BYTES:
            raise HTTPException(status_code=413,
                                detail=f"Model exceeds {MAX_MODEL_BYTES // (1 << 20)} MB")
        serve_path, actual_ext = maybe_convert_asset(file_path)

        harness_url = str(request.base_url) + "api/screenshot/harness"

        # Single-flight with a bounded wait; long renders time out rather than hang.
        try:
            await asyncio.wait_for(service.lock.acquire(), timeout=BUSY_WAIT_S)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=429,
                                detail="Screenshot renderer is busy; retry shortly")
        try:
            png, meta = await asyncio.wait_for(
                service.render(
                    harness_url, serve_path, actual_ext,
                    preset=preset, view=view, azimuth=azimuth, elevation=elevation,
                    best_view=best_view, fill=fill, width=width, height=height,
                    transparent=transparent, hide_ground=hide_ground,
                ),
                timeout=RENDER_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504,
                                detail=f"Render exceeded {RENDER_TIMEOUT_S:.0f}s")
        except RuntimeError as e:
            # HeadlessViewer.ensure raises RuntimeError for BOTH missing playwright
            # and missing Chromium, with distinct actionable messages.
            raise HTTPException(status_code=503, detail=str(e))
        finally:
            service.lock.release()

        return Response(
            content=png,
            media_type="image/png",
            headers={
                "Cache-Control": "no-store",
                "X-MeshVault-Screenshot": json.dumps(meta, ensure_ascii=True),
            },
        )

    return router, service
