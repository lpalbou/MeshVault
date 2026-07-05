# 015 — Recursive Library Index and Cross-Folder Search

**Priority**: High
**Effort**: Large
**Category**: Feature / Library at scale
**Status**: Proposed (built, then parked)
**Created**: 2026-07-05

## Summary

Today search is a per-folder filename filter only. Every asset-manager competitor lets users
search their entire library at once (by name, format, size, tag, poly count). Without a
recursive index, MeshVault cannot serve anyone with assets spread across many folders — the
exact user it targets.

## Reason

- Competitive review: "search across whole library" is table-stakes for Connecter/Eagle/Cargo.
- UX review: current filter box only matches within the open directory.

## Sketch of scope

- Background walk of the configured root(s), building a lightweight index (SQLite) of assets:
  path, format, size, mtime, and cheap metadata (vertex/face counts once parsed).
- Incremental updates via mtime; optionally a filesystem watcher.
- A global search UI (name + filters: format, size range, has-textures, in-archive).
- Must respect path confinement (`010`) and not block the event loop (index in a worker/thread).

## Decision boundaries

- Index store: SQLite (simple, local) vs in-memory (lost on restart). Lean SQLite.
- Metadata depth: filename-only first, geometry stats later (needs parsing/thumbnail pass).

## Dependencies

- `010` (confinement), benefits from `014` (thumbnails share a parse pass).

## Open questions

- How large a library must this scale to? Sets the indexing strategy.


---

## History — implemented then parked (2026-07-05)

Fully implemented (SQLite index, search, tags, collections) and reviewed, then **parked** as speculative: no proven large-library need, and the server-side state conflicts with the light/hybrid direction. The working code is preserved under `parked/` (not wired into the app). Re-promote to `planned/` only when a real cross-folder / thousands-of-assets pain shows up.


**Status**: Proposed (built, then parked) · **Completed**: 2026-07-05

SQLite catalog (`backend/library_index.py`) with incremental, batched, background reindex; cross-folder search UI (`frontend/js/library_search.js`). Endpoints `/api/library/{status,reindex,search}`. Validated: `tests/test_library_index.py` + runtime search.
