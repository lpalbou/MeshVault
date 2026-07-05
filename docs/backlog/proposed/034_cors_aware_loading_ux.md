# 034 — CORS-aware loading UX (public web viewer)

**Priority**: Medium
**Effort**: Small
**Status**: Proposed
**Created**: 2026-07-06

## Summary

When the public viewer loads a model from a pasted remote URL, cross-origin fetches often
fail (no CORS headers on the host). Today the failure is opaque. Detect it and show a clear,
actionable message ("this host blocks cross-origin loading; try a CORS-enabled URL or drop
the file"), distinct from a genuine 404/parse error.

## Reason / evidence

- 2026 web-deploy research: CORS is the most common failure mode for a paste-a-URL viewer;
  clear messaging is a top UX ask. (A CORS proxy was explicitly deemed NOT worth it.)

## Current code reality

- `web/index.html` `loadUrl` surfaces a generic error string.

## Scope

- Distinguish CORS/network failures from not-found/parse failures (best-effort via fetch
  probe / error classification) and present a specific hint + the drag-drop fallback.

## Non-goals

- Running a CORS proxy (security/abuse surface; avoid).

## Acceptance criteria

- Loading a known CORS-blocked URL shows the specific CORS hint, not a generic error.
