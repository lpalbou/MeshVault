# 029 — Structured `describe_scene` report for agents

**Priority**: High
**Effort**: Small–Medium
**Category**: Agent control API
**Status**: Proposed
**Created**: 2026-07-06

## Summary

The AI-agent feature research identified this as the highest leverage-to-effort item:
give agents a compact, structured TEXT description of the loaded scene so they can reason
without screenshotting/vision. Modeled on Playwright-MCP's "snapshot over screenshot"
design — agents act far more reliably on structured text than pixels.

## Reason / evidence

- 2026 agent research: text-first structured snapshots outperform pixel-based interaction
  for tool-using agents; the pattern is proven in Playwright MCP.
- We already have `getSceneInfo`/`getState`; this consolidates and enriches them into one
  agent-facing report.

## Current code reality

- `getState()` (model/camera/display/animation) and `getSceneInfo()` (per-mesh/material)
  exist. There is no single consolidated, token-efficient "here is what you're looking at".

## Scope

- Add a `describe_scene` command returning a compact, JSON + short natural-language summary:
  node hierarchy (names, depth), mesh/material counts, total tris, world bounds + real-world
  size hint, whether textured/animated, detected issues (see 031), and the current camera/
  render state. Keep it token-bounded (summarize large trees).
- Optionally include the ranked `score_views` top angles so an agent knows candidate fronts.

## Acceptance criteria / validation

- For both sample models, `describe_scene` returns a JSON-serializable, human-readable
  structure an agent can act on (choose framing, count parts, know if animated) WITHOUT a
  screenshot. Bounded size for large scenes.
