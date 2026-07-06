# 037 — Mesh statistics + issue localization for agents

**Priority**: High (top-ranked gap from the 2026-07-06 MCP field test)
**Effort**: Medium
**Category**: Agent control API / geometry QA
**Status**: Done (2026-07-06) — `get_mesh_stats`; highlight-overlay render mode deferred
**Created**: 2026-07-06

## Implementation notes (done)

- `frontend/js/viewer/mesh_stats.js` → `get_mesh_stats` command: per-mesh + total
  surface area, volume (NULL for open meshes — signed-volume sums are origin-dependent
  when not closed; adversarially proven and fixed), edge-length min/median/p95/max,
  sliver %, dihedral roughness mean/p95, open/non-manifold/degenerate counts, and
  `issuePoints` (up to 5 greedily-spread world locations per defect kind → `focus{point}`).
  300k-triangle budget with `skipped:true`.
- Adversarially verified vs trimesh: area/volume/edge/dihedral/counts exact to the 4
  significant digits emitted (cube exact; helmet open-edge count 1820 exact; all 10
  issuePoints within 0.0007 units of true defect midpoints). Perf: 15k tris ≈ 70 ms,
  126k ≈ 780 ms synchronous.
- Honesty guards from the review: dihedral is documented as a RELATIVE indicator
  (a clean cube is 60° mean — absolute thresholds misclassify hard-edged models);
  multi-mesh totals flag `approx:true` on median/mean fields (triangle-weighted
  combinations, not global statistics).
- Deferred: a `highlight_issues` overlay render mode (issuePoints + focus cover the
  agent need); true global medians for multi-mesh totals; degenerate-triangle edges are
  excluded from open-edge counts (documented convention drift vs trimesh).

## Summary

Three agents field-tested the MCP on real reconstruction iterations. The geometry
analyst's central finding: `describe_scene`'s connectivity QA gives the **wrong verdict
if trusted blindly** — a topologically perfect mesh (closed, manifold, zero issues) was
perceptually garbage (a mass of view-aligned depth spikes), while the visually best
iteration had the most connectivity defects. Answering "did mesh quality improve between
v2 and v4?" took ~30 tool calls and the decisive evidence was visual, not numeric.

## Scope

- `mesh_statistics` command: edge-length distribution (min/median/p95), sliver-triangle
  percentage, dihedral-angle / normal-variation roughness (detects spike & banding
  artifacts numerically), per-axis extent histograms, surface area + approximate volume.
  One call should turn "looks shredded in screenshots" into a number.
- Issue localization: `describe_scene` reports "30 open edges" but not WHERE. Return
  cluster centroids for open/non-manifold/degenerate regions so an agent can
  `focus {point}` on them, and/or a `highlight_issues` overlay render mode.
- Keep it budget-bounded like the existing QA (skip + say so above a triangle cap).

## Evidence

- Geometry field test: v2 "no geometry issues" yet unusable; v4 "3 warnings" yet the
  first usable output. Euler characteristics computed manually from welded counts.
- Both other field agents independently requested numeric surface-quality measures.
