"""
Headless viewer runtime — shared Playwright machinery for driving the standalone
MeshVault viewer (window.mv) without a visible browser.

Two consumers, one lifecycle implementation:
- backend/mcp_server.py hosts the viewer on its OWN loopback file server (works
  without the app running) and marshals MCP tools through it.
- backend/screenshot_api.py hosts the viewer on the APP's origin (harness page +
  /api/asset/* with header auth) to serve `GET /api/screenshot`.

Also home to the pieces both sides need to render MULTI-FILE models correctly:
- companion_files(): discover a model's related files (OBJ→mtllib parse, FBX→sibling
  textures) as model-relative refs, so viewers can resolve MTL/textures instead of
  silently loading bare gray geometry (the confirmed untextured-over-MCP bug).
- RENDER_PRESETS / apply_render_preset(): fully-pinned lighting/background states so
  renders are comparable across sessions, tools, and machines.

Each process creates its OWN HeadlessViewer instance — async Playwright objects are
bound to the event loop that created them and must never be shared across processes.
"""

from __future__ import annotations

import asyncio
import base64
import http.server
import mimetypes
import secrets
import threading
import time
import urllib.parse
from pathlib import Path


# Formats the viewer can load (kept in sync with the frontend loaders).
SUPPORTED_EXTENSIONS = {
    ".obj", ".fbx", ".gltf", ".glb", ".stl", ".ply", ".dae", ".3mf", ".usdz",
}

# Refuse to feed pathologically large local models to the browser: a multi-GB file
# OOMs the shared Chromium page and takes every queued caller down with it.
MAX_MODEL_BYTES = 512 * 1024 * 1024

# Texture files worth advertising as FBX companions (the FBX loader resolves texture
# references by basename against this list, then falls back to name conventions).
_TEXTURE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tiff", ".tif",
    ".dds", ".exr", ".hdr", ".webp", ".gif",
}

# Bounds for companion discovery: enough for real asset packs, small enough that a
# model dropped into a huge directory doesn't turn discovery into a filesystem scan.
_MAX_COMPANION_FILES = 40
_MAX_SCAN_ENTRIES = 512
_MAX_COMPANION_DEPTH = 2  # model dir itself + e.g. "textures/" one level down

# Camera view presets shared by every screenshot surface.
VIEW_PRESETS = {"front", "back", "left", "right", "top", "bottom", "iso"}

# Render presets: named, fully-pinned lighting/background states so screenshots are
# comparable across sessions, machines, and agents. Each preset sets EVERY
# pixel-affecting lighting/background variable — a partial preset would silently
# inherit session state and break comparability.
RENDER_PRESETS: dict[str, list[tuple[str, dict]]] = {
    # The app's factory look, pinned: balanced key/fill studio + IBL.
    "studio": [
        ("set_environment", {"enabled": True, "intensity": 1.0, "asBackground": False}),
        ("set_lighting", {"azimuth": 45, "elevation": 60, "key_intensity": 1.2,
                          "fill_intensity": 0.5, "ambient": 0.3, "exposure": 1.2}),
        ("set_background", {"color": "#33373f"}),
    ],
    # Even, low-contrast lighting on mid-gray — for color/texture comparison.
    "neutral": [
        ("set_environment", {"enabled": True, "intensity": 1.0, "asBackground": False}),
        ("set_lighting", {"azimuth": 45, "elevation": 55, "key_intensity": 0.8,
                          "fill_intensity": 0.6, "ambient": 0.5, "exposure": 1.0}),
        ("set_background", {"color": "#808080"}),
    ],
    # Presentation hero look: stronger key, near-black backdrop.
    "dark": [
        ("set_environment", {"enabled": True, "intensity": 1.2, "asBackground": False}),
        ("set_lighting", {"azimuth": 45, "elevation": 60, "key_intensity": 1.5,
                          "fill_intensity": 0.4, "ambient": 0.2, "exposure": 1.1}),
        ("set_background", {"color": "#0d0d1a"}),
    ],
}


def guess_mime(path: Path) -> str:
    """Content type for serving model/companion files (3D types + stdlib fallback)."""
    explicit = {
        ".js": "text/javascript", ".wasm": "application/wasm",
        ".html": "text/html", ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json", ".obj": "model/obj", ".mtl": "model/mtl",
        ".fbx": "model/fbx", ".bin": "application/octet-stream",
        ".tga": "image/x-tga", ".dds": "image/vnd-ms.dds",
    }
    ext = path.suffix.lower()
    if ext in explicit:
        return explicit[ext]
    return mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def parse_mtllib_refs(obj_path: Path, max_bytes: int = 512 * 1024) -> list[str]:
    """Material library references declared by an OBJ file (`mtllib <name>`).

    Reads at most `max_bytes` of the header region — mtllib lines conventionally
    appear near the top, and this keeps discovery O(1) for multi-hundred-MB scans.
    The rest of the line is ONE reference (names with spaces are common; multiple
    libraries on one line are rare enough that the same-stem fallback covers them).
    """
    refs: list[str] = []
    try:
        with open(obj_path, "r", encoding="utf-8", errors="ignore") as fh:
            text = fh.read(max_bytes)
    except OSError:
        return refs
    for line in text.splitlines():
        line = line.strip()
        if line.lower().startswith("mtllib "):
            ref = line[7:].strip().replace("\\", "/")
            if ref:
                refs.append(ref)
    return refs


def companion_files(model_path: Path) -> list[str]:
    """Discover a model's companion files as MODEL-RELATIVE POSIX refs.

    - .obj → its declared mtllib refs (existing files only, confined to the model's
      directory tree), falling back to a same-stem .mtl. Textures need no listing:
      the viewer resolves MTL-internal texture refs relative to the model URL.
    - .fbx → texture files near the model (bounded scan), because FBX texture
      references are resolved by basename against the advertised related files.
    - .gltf/.glb and single-file formats → nothing: their loaders resolve external
      buffers/textures relative to the model URL natively.

    Refs outside the model's directory tree are dropped on purpose: they are the
    serving boundary for the headless runtimes (and an `.mtl` reaching into ../
    would not be fetchable anyway).
    """
    base = model_path.parent.resolve()

    def within_base(ref: str) -> bool:
        try:
            return (base / ref).resolve().is_relative_to(base)
        except (OSError, ValueError):
            return False

    ext = model_path.suffix.lower()
    if ext == ".obj":
        refs = [r for r in parse_mtllib_refs(model_path)
                if within_base(r) and (base / r).resolve().is_file()]
        if not refs:
            fallback = model_path.with_suffix(".mtl")
            if fallback.is_file():
                refs = [fallback.name]
        return refs[:_MAX_COMPANION_FILES]

    if ext == ".fbx":
        refs: list[str] = []
        scanned = 0
        for entry in sorted(base.rglob("*")):
            scanned += 1
            if scanned > _MAX_SCAN_ENTRIES or len(refs) >= _MAX_COMPANION_FILES:
                break
            if not entry.is_file() or entry.suffix.lower() not in _TEXTURE_EXTENSIONS:
                continue
            rel = entry.relative_to(base)
            if len(rel.parts) > _MAX_COMPANION_DEPTH:
                continue
            refs.append(rel.as_posix())
        return refs

    return []


class LocalModelServer:
    """Loopback HTTP server exposing a harness page, optional static assets, and
    registered local models (plus their directory companions) to a headless page.

    Model URLs are `/models/<token>/<name>`: the unguessable token maps to the
    registered file, and any RELATIVE ref resolves within that file's directory
    tree — which is what lets the browser fetch MTL/textures/.gltf buffers as
    sibling URLs (the untextured multi-file fix). Companions are confined to the
    model's directory: resolve first, then require the real path inside the
    registered base (symlink/`..` safe — same invariant as the PathGuard).
    """

    def __init__(self, harness_html: str, static_root: Path | None = None):
        self.registered_models: dict[str, Path] = {}
        self.base_url: str | None = None
        self._harness_html = harness_html
        self._static_root = static_root.resolve() if static_root else None
        self._httpd = None

    def start(self) -> str:
        """Bind loopback on an ephemeral port (never reachable off-host)."""
        if self._httpd:
            return self.base_url
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 (http.server API)
                server.handle_get(self)

            def log_message(self, *args):
                # stdio consumers (MCP) must keep stdout/stderr protocol-clean.
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = self._httpd.server_address[1]
        self.base_url = f"http://127.0.0.1:{port}"
        threading.Thread(target=self._httpd.serve_forever, daemon=True).start()
        return self.base_url

    def register(self, file_path: Path) -> str:
        """Expose a local model under an unguessable token; returns its URL.

        The URL ends with the (quoted) real filename under the token namespace so
        relative resource references get a valid base to resolve against. A bare
        `/models/<token>` URL gave relative refs no base and every companion
        fetch 404'd.
        """
        token = secrets.token_urlsafe(16)
        self.registered_models[token] = file_path
        return f"{self.base_url}/models/{token}/{urllib.parse.quote(file_path.name)}"

    def shutdown(self):
        if self._httpd:
            self._httpd.shutdown()
            self._httpd = None

    # -- request handling (called from the handler thread) --------------------

    def handle_get(self, request: http.server.BaseHTTPRequestHandler):
        path = request.path.split("?", 1)[0]
        if path == "/":
            return self._send(request, 200, self._harness_html.encode("utf-8"),
                              "text/html")
        if path.startswith("/models/"):
            return self._serve_model(request, path)
        if self._static_root is not None:
            # Static assets (viewer bundle, vendored decoders) — confined to the
            # static root. is_relative_to gives a real path-boundary check; a
            # string prefix compare would wrongly admit sibling dirs like
            # frontend_x/ (adversarial review finding).
            candidate = (self._static_root / path.lstrip("/")).resolve()
            if candidate.is_file() and candidate.is_relative_to(self._static_root):
                return self._send_file(request, candidate)
        return self._send(request, 404, b"not found", "text/plain")

    def _serve_model(self, request, path: str):
        parts = path.split("/", 3)  # ["", "models", token, rel?]
        token = parts[2] if len(parts) > 2 else ""
        model_file = self.registered_models.get(token)
        if not model_file:
            return self._send(request, 404, b"unknown model token", "text/plain")
        rel = urllib.parse.unquote(parts[3]) if len(parts) > 3 and parts[3] else ""
        if not rel or rel == model_file.name:
            return self._send_file(request, model_file)
        base = model_file.parent.resolve()
        try:
            target = (base / rel).resolve()
        except OSError:
            return self._send(request, 404, b"bad companion path", "text/plain")
        if not target.is_relative_to(base) or not target.is_file():
            return self._send(request, 404, b"companion not found", "text/plain")
        return self._send_file(request, target)

    def _send_file(self, request, file_path: Path):
        try:
            data = file_path.read_bytes()
        except OSError:
            return self._send(request, 404, b"unreadable", "text/plain")
        return self._send(request, 200, data, guess_mime(file_path))

    @staticmethod
    def _send(request, code: int, body: bytes, ctype: str):
        request.send_response(code)
        request.send_header("Content-Type", ctype)
        request.send_header("Content-Length", str(len(body)))
        request.end_headers()
        request.wfile.write(body)


class HeadlessViewer:
    """One headless Chromium page hosting the standalone viewer (window.mv).

    Lazy: nothing starts until ensure() is first awaited. All methods must be
    called from the event loop that first called ensure().
    """

    # Captures resize the canvas per request, so the resting viewport only sets
    # the idle framebuffer footprint (renderer + composer + SSAO buffers in
    # SwiftShader RAM) — keep it modest.
    def __init__(self, *, viewport: tuple[int, int] = (1024, 768),
                 extra_http_headers: dict | None = None,
                 idle_close_s: float | None = None):
        self._viewport = viewport
        self._extra_http_headers = extra_http_headers
        self._playwright = None
        self._browser = None
        self._page = None
        self._lock: asyncio.Lock | None = None
        # Optional resource control: close the browser after this many seconds
        # without a command; the next ensure() restarts it (~2-4 s). Chromium
        # holds ~0.6-0.9 GB RSS — a one-shot screenshot must not pin that forever.
        self._idle_close_s = idle_close_s
        self._last_used = 0.0
        self._idle_task = None
        self._start_url: str | None = None

    @property
    def page(self):
        """The Playwright page, or None before ensure()."""
        return self._page

    async def ensure(self, url: str,
                     ready_js: str = "() => window.mvReady === true",
                     timeout_ms: int = 30000):
        """Start (once) and return the viewer page, navigated to `url` and ready.

        With idle_close_s set, a reaper task closes the browser after inactivity
        and this method transparently restarts it on the next call.
        """
        if self._lock is None:
            self._lock = asyncio.Lock()
        self._last_used = time.monotonic()
        self._start_url = url
        async with self._lock:
            if self._page is not None:
                return self._page
            try:
                from playwright.async_api import async_playwright
            except ImportError as e:
                raise RuntimeError(
                    "playwright is required: pip install 'meshvault[mcp]' && "
                    "playwright install chromium") from e
            self._playwright = await async_playwright().start()
            try:
                self._browser = await self._playwright.chromium.launch(
                    headless=True,
                    # SwiftShader keeps WebGL working on GPU-less hosts (CI, servers)
                    # and renders deterministically; harmless on machines with a GPU.
                    args=["--use-gl=angle", "--use-angle=swiftshader"],
                )
            except Exception as e:
                raise RuntimeError(
                    f"Could not launch Chromium ({e}). Run: playwright install chromium"
                ) from e
            context = await self._browser.new_context(
                viewport={"width": self._viewport[0], "height": self._viewport[1]},
                extra_http_headers=self._extra_http_headers,
            )
            self._page = await context.new_page()
            await self._page.goto(url, wait_until="load")
            await self._page.wait_for_function(ready_js, timeout=timeout_ms)
            if self._idle_close_s and self._idle_task is None:
                self._idle_task = asyncio.create_task(self._idle_reaper())
            return self._page

    async def _idle_reaper(self):
        """Close the browser after idle_close_s without use (memory back to ~0)."""
        try:
            while True:
                await asyncio.sleep(max(5.0, self._idle_close_s / 4))
                if self._page is None:
                    continue
                if time.monotonic() - self._last_used >= self._idle_close_s:
                    async with self._lock:
                        # Re-check under the lock (a request may have just landed).
                        if time.monotonic() - self._last_used >= self._idle_close_s:
                            await self._close_browser_only()
        except asyncio.CancelledError:
            pass

    async def _close_browser_only(self):
        if self._browser:
            await self._browser.close()
            self._browser = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None
        self._page = None

    async def execute(self, action: str, params: dict | None = None) -> dict:
        """Run one control-API command; returns the structured {ok, ...} result."""
        self._last_used = time.monotonic()
        if self._page is None and self._start_url:
            await self.ensure(self._start_url)
        return await self._page.evaluate(
            "([action, params]) => window.mv.execute({ action, params: params || {} })",
            [action, params or {}],
        )

    async def apply_render_preset(self, name: str) -> None:
        """Apply a named render preset (raises on unknown name or command failure)."""
        steps = RENDER_PRESETS.get(name)
        if steps is None:
            raise RuntimeError(
                f"Unknown preset '{name}'. Available: {', '.join(sorted(RENDER_PRESETS))}.")
        for action, params in steps:
            r = await self.execute(action, params)
            if not r.get("ok"):
                raise RuntimeError(f"Preset '{name}' failed at {action}: {r.get('error')}")

    async def capture_png(self, width: int, height: int,
                          transparent: bool = False, hide_ground: bool = False,
                          ssao: bool = True) -> bytes:
        """Render the current view and return PNG bytes (raises on failure).

        ssao=False skips the SSAO/tone-mapping composer — noticeably faster on
        SwiftShader, right for small proof renders where fidelity is not the point.
        """
        result = await self.execute("screenshot", {
            "width": width, "height": height,
            "transparent": transparent, "hideGround": hide_ground,
            "ssao": ssao,
        })
        if not result.get("ok"):
            raise RuntimeError(result.get("error", "screenshot failed"))
        return base64.b64decode(result["result"].split(",", 1)[1])

    async def close(self):
        if self._idle_task:
            self._idle_task.cancel()
            self._idle_task = None
        await self._close_browser_only()
