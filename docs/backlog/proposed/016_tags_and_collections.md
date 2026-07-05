# 016 — Tags and Collections

**Priority**: Medium
**Effort**: Medium
**Category**: Feature / Library at scale
**Status**: Proposed (built, then parked)
**Created**: 2026-07-05

## Summary

Let users tag assets and group them into named collections independent of folder structure.
This is a core organizational feature of Connecter/Eagle and turns MeshVault from a viewer into
an asset *manager*.

## Reason

- Competitive review: tagging + collections are how artists organize kitbash/game-asset libraries.

## Sketch of scope

- Store tags/collections in the same local index as `015` (SQLite), keyed by asset path.
- UI: tag chips in the browser, a collections panel, filter/search by tag (ties into `015`).
- Sidecar export/import so tags survive moves and can be shared/version-controlled.

## Decision boundaries

- Store tags in a central DB vs per-folder sidecar files. Central is simpler; sidecars are
  portable. Consider both (DB primary, sidecar export).

## Dependencies

- Strongly benefits from `015` (index + search).


---

## History — implemented then parked (2026-07-05)

Fully implemented (SQLite index, search, tags, collections) and reviewed, then **parked** as speculative: no proven large-library need, and the server-side state conflicts with the light/hybrid direction. The working code is preserved under `parked/` (not wired into the app). Re-promote to `planned/` only when a real cross-folder / thousands-of-assets pain shows up.


**Status**: Proposed (built, then parked) · **Completed**: 2026-07-05

Tags + collections in the index (canonical-path keyed), searchable via `#tag`. Endpoints `/api/tags/*`, `/api/collections/*`. Validated: `tests/test_library_index.py` + runtime `#hero` roundtrip.
