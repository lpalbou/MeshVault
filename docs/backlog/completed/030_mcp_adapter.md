# 030 — Thin MCP adapter over the control API

**Priority**: Medium
**Effort**: Medium
**Status**: Done (2026-07-06)
**Created**: 2026-07-06

## Implementation notes (done)

- `backend/mcp_server.py` (~370 lines): FastMCP stdio server, `meshvault-mcp` console
  script, optional extra `pip install "meshvault[mcp]"` (mcp + playwright; fastapi floor
  raised to >=0.116 for starlette 1.x compatibility).
- Runtime: lazy loopback ThreadingHTTPServer (ephemeral port; path-confined via
  `is_relative_to` after a review-proven prefix-escape) serving the standalone bundle +
  vendor decoders + registered models under 128-bit tokens; headless Chromium
  (SwiftShader flags) hosting the harness page; clean shutdown via FastMCP lifespan
  (no orphans even on SIGKILL — verified).
- 6 tools (thin surface per the 2026 anti-pattern guidance): `load_model` (URL or
  absolute local path; browser-first, server-side download fallback for CORS with 512 MB
  cap; returns load + describe_scene in one call), `describe_scene`, `viewer_execute`
  (passthrough + >2KB string truncation + error-text adaptation), `list_viewer_commands`,
  `get_state`, `screenshot` (MCP image content; `best_view` option; clean error when no
  model).
- Viewer fix shipped with this item: `loadModel` now parses BEFORE swapping models, so a
  failed load keeps the current model (was: silent unload — Critical finding).
- Adversarially verified by 2 agents + self-test as a real MCP client: protocol-clean
  stdio, crash-free under 16 abuse cases, no orphan processes, naive-agent canonical flow
  succeeds first-try. Docs: `docs/mcp.md` + `llms.txt`/`llms-full.txt`.
- Known accepted limits: results are text JSON (no structuredContent schemas); CORS
  fallback is an SSRF shape acceptable only for local single-user use (documented).

## Summary

Expose MeshVault's viewer control API to MCP-speaking agents (Claude, Cursor, …) so they can
drive it directly. Per the 2026 agent research, do this as a THIN 4–6-tool adapter over the
existing `execute()` registry — NOT a wide 1-tool-per-command surface (wide tool surfaces are
a measured 2026 anti-pattern that degrades agent performance).

## Reason / evidence

- 2026 agent research: MCP adoption is worth it now, but keep the tool surface small; route
  through the existing self-describing `execute()`/`listCommands()`.

## Current code reality

- `frontend/js/viewer/control_api.js` already provides `execute({action,params})` +
  `listCommands()` + `getState()`/`getSceneInfo()`. This is the ideal single choke point.

## Scope

- A small MCP server (Node) exposing ~4–6 tools: `list_commands`, `execute` (action+params
  passthrough), `get_state`, `describe_scene` (see 029), `screenshot`/`capture` (returns
  image), and maybe `load`. It drives a headless browser instance hosting the standalone
  viewer, or a shared page.
- Decision boundaries: headless runtime (Puppeteer/Playwright) vs a persistent page; how
  images are returned to the agent (MCP image content).

## Non-goals

- One MCP tool per viewer command (anti-pattern). Keep it thin.

## Acceptance criteria

- An MCP client can list capabilities, load a model, find the best view, and get a
  screenshot back, through ≤6 tools.
