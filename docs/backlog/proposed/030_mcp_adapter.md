# 030 — Thin MCP adapter over the control API

**Priority**: Medium
**Effort**: Medium
**Status**: Proposed
**Created**: 2026-07-06

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
