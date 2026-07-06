# 029 — Structured `describe_scene` report for agents

**Priority**: High
**Effort**: Small–Medium
**Category**: Agent control API
**Status**: Done (2026-07-06) — includes the QA checks of 031
**Created**: 2026-07-06

## Implementation notes (done)

- New module `frontend/js/viewer/describe_scene.js` (~380 lines), registered as
  `describe_scene { maxItems:1..50=8, checks=true, views=false }` in the control API.
- Report: natural-language `summary` (assembled from the structured facts so it cannot
  disagree with them; info-severity issues are named, not hidden), live inventory
  (counts/dimensions recomputed from the current buffers — correct after simplify/rotate),
  bounds, format-aware size hint (glTF units are meters per spec), capped hierarchy
  outline (anonymous pass-through groups skipped and NOT counted as truncated), largest
  meshes, asset materials (reads `_mvOriginalMaterial` so solid/normals render-mode
  overrides don't lie about the asset), issues, current view (camera+fov, renderMode,
  environment, clip), optional top-3 ranked view angles.
- QA checks (031 folded in): missing normals/UVs, empty meshes, unindexed geometry, scale
  sanity, NaN positions, degenerate faces (relative sliver test on raw positions),
  watertightness + non-manifold edges on position-welded vertices (UV seams don't
  false-positive), flipped normals via **signed volume** (centroid heuristics fail on
  tori). Per-triangle checks are skipped above a 300k-triangle budget with an explicit
  `checks_skipped` issue (332k-tri model: 0.4 ms). Hot loops are allocation-light
  (scalar math, numeric edge keys) after a review-found ~0.9 s freeze.
- Adversarially verified by 3 agents: zero false positives vs trimesh ground truth on all
  test models; no state mutation (pixel-identical before/after, incl. `views:true`);
  token-bounded (~2 KB default); deterministic across 20 calls; docs field-for-field
  faithful. Known limits: flipped-normals only fires for closed meshes; sub-1e-6×bbox
  features can weld (quantization).

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
