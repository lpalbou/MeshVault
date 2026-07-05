# 020 — Measurement / Dimensions Overlay

**Priority**: Medium
**Effort**: Medium
**Category**: Feature / Viewer
**Status**: Completed
**Created**: 2026-07-05

## Summary

Add bounding-box dimensions readout and point-to-point measurement. Essential for 3D-printing
and game-asset scale validation, and a common feature in F3D/MeshLab/print-focused viewers.

## Reason

- Competitive review: measurement/dimensions is a differentiator for the print + game-asset
  verticals MeshVault is closest to.

## Sketch of scope

- Always-available: show model bounding-box dimensions (X/Y/Z) and unit assumptions in stats.
- Interactive: click two points (raycast to surface) to measure distance; render a labeled line.
- Unit handling: display in model units; optional cm/mm/in presets (no unit conversion authority,
  just labeling).

## Dependencies

- Benefits from a raycast/selection primitive shared with `007` (component picker).


---

## Completion

**Status**: Completed · **Completed**: 2026-07-05

Point-to-point surface measurement (toolbar toggle → raycast two points → line+distance label) plus the existing bounding-box dimensions readout (flat-dim formatting fixed).
