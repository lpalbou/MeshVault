"""
Optional end-to-end GLB export regression test.

This test is intentionally **skipped by default** because it:
- Requires a running MeshVault server (WebGL + Playwright)
- Opens a real Chromium instance (macOS GPU path)
- Depends on a large local fixture archive in `untracked/`

Enable it locally with:
    MESHVAULT_VISUAL_TESTS=1 poetry run pytest -q -k glb_export_integration
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import httpx
import pytest


@pytest.mark.integration
def test_glb_export_integration() -> None:
    if os.environ.get("MESHVAULT_VISUAL_TESTS") != "1":
        pytest.skip("Set MESHVAULT_VISUAL_TESTS=1 to run Playwright/WebGL integration tests.")

    root = Path(__file__).resolve().parents[1]
    archive = root / "untracked" / "uploads_files_775776_asteroid_pack_2.zip"
    if not archive.exists():
        pytest.skip(f"Missing local fixture archive: {archive}")

    # Server must already be running (we avoid spawning long-running processes in unit tests).
    try:
        r = httpx.get("http://localhost:8420", timeout=2.0)
        if r.status_code != 200:
            pytest.skip("MeshVault server not reachable on http://localhost:8420")
    except Exception:
        pytest.skip("MeshVault server not reachable on http://localhost:8420")

    p = subprocess.run(
        ["node", "test_glb_export.mjs"],
        cwd=str(root),
        capture_output=True,
        text=True,
    )

    assert p.returncode == 0, (p.stdout + "\n" + p.stderr)

