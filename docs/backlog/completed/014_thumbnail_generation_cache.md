# 014 — Thumbnail Generation and On-Disk Cache

**Priority**: High
**Effort**: Large
**Category**: Feature / Library at scale
**Target**: v0.2.0
**Created**: 2026-07-05

## Summary

The grid/list browser shows only format icons — no visual preview of the actual model. This is
the single biggest gap versus every category leader (Connecter, Eagle, Blender Asset Browser,
Sketchfab) and the top blocker for the "browse a large asset library" use case. Add rendered
thumbnails with a persistent on-disk cache.

## Reason / evidence (2026-07-05 review)

- UX review: grid view renders format badges only (`frontend/js/file_browser.js` `ICONS`);
  browsing hundreds of assets gives no visual differentiation. Large-library persona scored
  the app 3/10 largely because of this.
- Competitive analysis: thumbnail galleries are table-stakes for asset managers.

## Current code reality

- No thumbnail pipeline anywhere. Completed item `002` ("Thumbnail Grid View") only added a
  grid *layout* with format-colored SVG icons — **not** rendered previews. This item delivers
  the actual rendered thumbnails that `002`'s name implies but never provided.
- The viewer can already produce a PNG screenshot in-browser (`viewer_3d.js` screenshot path),
  which is a reusable rendering primitive.
- Backend has no headless render capability today.

## Scope

- Decide render strategy (decision boundary):
  - **Client-side**: reuse the existing Three.js pipeline to render offscreen thumbnails on
    demand as items scroll into view; cache resulting PNGs via a backend cache endpoint.
  - **Server-side**: headless render (heavier; needs GPU/software GL). Likely a later option.
  - Recommendation: start client-side, lazy, viewport-driven.
- Persistent cache keyed by file path + mtime + size; store under a cache dir; invalidate on
  change. Serve cached thumbnails through a confined endpoint (respect `010`).
- Lazy generation (only for visible items), with a placeholder while rendering.
- Handle archives: thumbnail inner assets where feasible (differentiator — see `proposed`).

## Non-goals

- Full batch pre-render CLI (tracked separately in `024`).

## Dependencies

- `010` path confinement (cache read/write must be confined).

## Acceptance criteria / validation

- Grid view shows a rendered preview for supported formats; icons only as fallback.
- Second visit to a folder loads thumbnails from cache (no re-render) unless files changed.
- Scrolling a 500-item folder stays responsive (generation is lazy + throttled).


---

## Completion

**Status**: Completed · **Completed**: 2026-07-05

Client-side lazy Three.js render (only cards in view), cached in the **browser** (IndexedDB, keyed by path+size+mtime) — `frontend/js/thumbnailer.js`. Backend stays stateless. Validated: UX passes (render, cache-on-revisit). Note: an earlier server-side cache (`/api/thumbnail` + `thumbnail_cache.py`) was replaced by the browser cache and moved to `parked/`.
