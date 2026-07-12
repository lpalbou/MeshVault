"""
Shared fixture for the browser E2E suites (backlog 048).

These suites drive the REAL viewer (WebGL in headless Chromium via Playwright)
through the same `window.mv` control API agents use — they are the regression
net for sculpting/painting, articulation/timeline, symmetry healing, the human
edit UI, and the GLB round-trip.

Opt-in (they need Playwright + a built frontend and take minutes):

    MESHVAULT_E2E=1 poetry run pytest -m e2e -q          # own server
    MESHVAULT_E2E_URL=http://127.0.0.1:8442 \
    MESHVAULT_E2E_TOKEN=smoke-42 poetry run pytest -m e2e # running app

or simply `scripts/e2e.sh`. Without either env var every e2e test SKIPS (so
plain `pytest tests/` stays green in CI, where chromium is not installed).

The owned server serves models from /tmp (`serve_dir` is a fresh tmpdir under
it) so tests can write GLBs to disk and reload them through the guarded
`/api/asset/file` route.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from collections import namedtuple
from pathlib import Path

import pytest

MvApp = namedtuple("MvApp", ["base_url", "token", "serve_dir"])

REPO_ROOT = Path(__file__).resolve().parents[2]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_ready(url: str, timeout_s: float = 25.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


@pytest.fixture(scope="session")
def mv_app():
    external = os.environ.get("MESHVAULT_E2E_URL")
    if not external and os.environ.get("MESHVAULT_E2E") != "1":
        pytest.skip(
            "E2E suites are opt-in: set MESHVAULT_E2E=1 (own server) or "
            "MESHVAULT_E2E_URL=<running app> (see scripts/e2e.sh).")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        pytest.skip("playwright not installed — pip install 'meshvault[mcp]' "
                    "&& playwright install chromium")

    # Chromium probe: a clear skip beats 6 suites failing with launch errors.
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader"])
            b.close()
    except Exception as e:  # noqa: BLE001 — any launch failure means "not available"
        pytest.skip(f"Chromium not launchable ({e}). Run: playwright install chromium")

    serve_dir = Path(tempfile.mkdtemp(prefix="mv_e2e_", dir="/tmp"))

    if external:
        yield MvApp(external.rstrip("/"),
                    os.environ.get("MESHVAULT_E2E_TOKEN", "smoke-42"),
                    serve_dir)
        return

    bundle = REPO_ROOT / "frontend" / "dist" / "meshvault-viewer.js"
    if not bundle.is_file():
        pytest.skip("Frontend bundle missing — run `npm ci && npm run build` first.")

    port = _free_port()
    token = "e2e-token"
    env = {**os.environ,
           "MESHVAULT_TOKEN": token,
           "MESHVAULT_ROOT": "/tmp"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.app:app",
         "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=str(REPO_ROOT), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    try:
        if not _wait_ready(base + "/llms.txt"):
            proc.terminate()
            pytest.skip("Owned MeshVault server did not become ready in 25 s.")
        yield MvApp(base, token, serve_dir)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
