#!/usr/bin/env bash
# Run the browser E2E suites (backlog 048): ~140 checks driving the real
# viewer through the agent control API + the human edit UI.
#
# Usage:
#   scripts/e2e.sh                       # spin up an own server (fresh state)
#   MESHVAULT_E2E_URL=http://127.0.0.1:8442 \
#   MESHVAULT_E2E_TOKEN=smoke-42 scripts/e2e.sh   # against a running app
#
# Prereqs: poetry install (or the mcp extra) + `playwright install chromium`,
# and a built frontend (`npm ci && npm run build`).
set -euo pipefail
cd "$(dirname "$0")/.."
MESHVAULT_E2E=1 exec poetry run pytest -m e2e tests/e2e -q -s "$@"
