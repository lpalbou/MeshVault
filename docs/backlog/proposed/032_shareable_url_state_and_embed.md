# 032 — Shareable URL view-state + iframe embed snippet

**Priority**: Medium
**Effort**: Small
**Status**: Proposed
**Created**: 2026-07-06

## Summary

For the public/embeddable web viewer: encode the current view (model `src`, camera or preset,
render mode, background, environment) in the URL so a link reproduces the exact view, and
provide a copy-paste iframe embed snippet. Standard for public 3D viewers.

## Reason / evidence

- 2026 web-deploy research: shareable camera state and iframe embed are top asks for a public
  viewer. `?src=` deep-link + drag-drop already shipped in `web/index.html`.

## Current code reality

- `web/index.html` supports `?src=<url>` and drag-drop. No camera/mode/bg in the URL, no
  embed snippet UI.

## Scope

- Serialize view state to compact URL params (e.g. `?src=&view=iso&mode=solid&bg=...` or an
  encoded blob); on load, apply them. A "Copy link" and "Copy embed" button in `web/`.
- Keep it base-path safe for `/repo/` Pages hosting.

## Acceptance criteria

- Opening a shared link reproduces model + camera + render mode + background. Embed snippet
  renders in an `<iframe>`.
