# 023 — Test Coverage for API Endpoints and FBX Parser

**Priority**: Medium
**Effort**: Medium
**Category**: Testing / Quality
**Status**: Proposed
**Created**: 2026-07-05

## Summary

Tests execute ~180 lines against ~10,000 lines of source. The only real suite covers
`FileBrowser` — and specifically the `root_path` confinement that isn't even wired into
production (`010`). Every API endpoint and the 672-line hand-rolled FBX binary parser are
untested. This blocks the security fixes (no regression guard) and the viewer refactor (`022`).

## Reason

- Code review: `poetry run pytest` → 12 passed, 1 skipped; FBX parser and all endpoints untested;
  stray root scripts (`test_compare.py`, `verify_glb.py`, `test_glb_export.mjs`) live outside
  `tests/` and never run in CI.

## Sketch of scope

- Endpoint tests via FastAPI `TestClient`: happy paths + the security assertions from `009`/`010`
  (arbitrary read/delete/write must be rejected; `default_path` returns 200 per `011`).
- FBX parser tests: small fixture FBX files → assert vertex/face/UV output; guard the UV-indexing
  logic flagged as fragile (`fbx_converter.py:499-504`).
- Move or delete stray root scripts so CI reflects reality (`pyproject testpaths=tests`).

## Dependencies

- Precondition (or lockstep partner) for `009`, `010`, `022`.
