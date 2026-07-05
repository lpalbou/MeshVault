# 018 — Format Expansion: PLY / DAE / 3MF / USDZ

**Priority**: Medium
**Effort**: Medium (per format)
**Category**: Feature / Format support
**Status**: Completed
**Created**: 2026-07-05

## Summary

Supported formats are OBJ/FBX/GLTF/GLB/STL. Competitors and adjacent workflows commonly need
PLY (scans/point clouds), DAE/Collada (legacy DCC), 3MF (3D printing), and USDZ (Apple/AR,
increasingly the interchange default — KitBash's Cargo standardized on USD in 2026).

## Reason

- Competitive review: PLY/DAE/3MF/USDZ are recurring table-stakes gaps; USD is the strategic one.

## Sketch of scope

- Three.js has loaders for PLY, Collada (DAE), 3MF, and a USDZ loader — wire them into the
  `loadModel()` switch and add file-browser icons/badges + `SUPPORTED_3D_EXTENSIONS`.
- USDZ import is straightforward via Three's `USDZLoader`; full USD authoring/export is out of
  scope. Prioritize USDZ + PLY first (highest demand), then 3MF, then DAE.

## Decision boundaries

- USDZ read-only import first; do not commit to USD export.

## Dependencies

- Touches `SUPPORTED_3D_EXTENSIONS` in `file_browser.py` + `archive_inspector.py`, viewer
  loaders, and badges — coordinate with `013` (keep docs honest per format actually shipped).


---

## Completion

**Status**: Completed · **Completed**: 2026-07-05

Added PLY, Collada (.dae), 3MF, USDZ (read-only) loaders wired into `loadModel`; extensions added to `SUPPORTED_3D_EXTENSIONS` + MIME types + icons.
