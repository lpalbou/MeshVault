# 031 — Model QA / validation command

**Priority**: Medium
**Effort**: Medium
**Status**: Proposed
**Created**: 2026-07-06

## Summary

A `validate_model` command returning a structured QA report: non-manifold edges, flipped/
inconsistent normals, degenerate faces, scale sanity (real-world size plausibility), missing
/unresolved textures, poly budget, watertightness, and multi-material/UV issues. Agents care
about automated model QA; it's a strong "semantic" use case for the control API.

## Reason / evidence

- 2026 agent research: automated model QA (Khronos-validator style) is a high-value agent
  workflow; returns a machine-actionable report.

## Current code reality

- No geometry validation exists. `getSceneInfo` gives counts only.

## Scope

- Geometry checks on the loaded buffers (client-side): normals present/consistent, degenerate
  triangles, rough manifold/watertight heuristic, bbox/size sanity, texture-slot resolution.
- Return `{ ok, issues:[{severity, code, message, meshes?}], stats }`.

## Acceptance criteria

- Running on a known-bad and known-good model produces a correct, structured, JSON report.
