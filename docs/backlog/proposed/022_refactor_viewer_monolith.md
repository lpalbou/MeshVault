# 022 — Refactor `viewer_3d.js` Monolith

**Priority**: Medium
**Effort**: Large
**Category**: Architecture / Maintainability
**Status**: Proposed
**Created**: 2026-07-05

## Summary

`viewer_3d.js` is 3,046 lines doing scene setup, five loaders, texture-matching heuristics,
transforms, PCA, and export in a single class — ~5× the project's own 600-line guideline. With
no state management, this blocks the material-editor / component-picker / undo-redo items
(`006`, `007`) and makes every viewer change risky.

## Reason

- Code review: 3,046-line class; state scattered across the class and the DOM; project rule is
  ~600 lines/file, 1 file = 1 task.

## Sketch of scope

- Split by responsibility, e.g.: `scene_setup` (lights/renderer/composer), `loaders/*` (per
  format), `texture_matcher`, `transforms` (center/ground/PCA/rotate/simplify/normals),
  `exporter`, and a thin `viewer` orchestrator.
- Introduce an explicit viewer state object (single source of truth) instead of DOM-derived
  state, enabling undo/redo (`006`).
- Do it incrementally, extracting one cohesive module at a time; keep behavior identical.

## Dependencies

- Enables `006`, `007`; eased by `021` (build/vendoring) and `023` (tests as a safety net).

## Risk

- High-churn refactor with no current test coverage → do `023` first (or in lockstep) so
  behavior is guarded.
