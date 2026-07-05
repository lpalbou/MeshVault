# 019 — Drag-and-Drop Load and Recent Files

**Priority**: Low
**Effort**: Small
**Category**: Feature / UX
**Status**: Completed
**Created**: 2026-07-05

## Summary

Two low-cost quality-of-life affordances users expect from modern viewers: drag a file onto the
viewport to load it, and a "recent files" list for fast re-access.

## Reason

- UX review: no drag-and-drop load, no recent files; naive users struggle to find a starting point.

## Sketch of scope

- Drag-and-drop: accept dropped files/paths onto the viewer canvas and route through the normal
  load path (must resolve within confined roots per `010`; dropped out-of-root paths rejected).
- Recent files: persist last N loaded assets in localStorage; surface in an empty-state panel
  and a small menu. Improves first-run experience (currently a weak empty state).

## Dependencies

- `010` for confinement of dropped paths.


---

## Completion

**Status**: Completed · **Completed**: 2026-07-05

Drag-a-file-onto-viewer preview via in-memory object URL (no filesystem write, respects sandbox); Recent list (last 12) in the sidebar with size persisted.
