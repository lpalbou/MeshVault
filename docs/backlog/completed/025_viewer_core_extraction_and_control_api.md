# 025 — Viewer Core Extraction + AI-Agent Control API

**Priority**: High
**Effort**: Large
**Category**: Architecture / Embeddable core
**Status**: Completed
**Created**: 2026-07-05
**Completed**: 2026-07-05

## Summary

Extract the rendering engine into an embeddable, server-less viewer with a proper control
API that AI agents (and third-party embedders) can drive, while keeping the full MeshVault
app working. Delivers the "light web-only viewer that reads files given to it" and the
"full app that runs locally" from the same code.

## What landed

- **Backend decoupling**: `viewer_3d.js` gained a `resolveResource(ref) => url` seam (the
  single texture/MTL URL choke point). The full app injects the `/api/asset/related`
  resolver (byte-identical to prior behavior); the standalone injects a client-only one.
- **Control API** (`frontend/js/viewer/control_api.js`, `ViewerControlAPI`): one JSON entry
  point `execute({action, params}) → {ok, result|error}` (never throws), self-describing
  `listCommands()` (33 commands), observable `getState()` / `getSceneInfo()`, and events
  (`loaded`, `error`, `animations`, `measurement`, `executed`). Model-dependent commands
  return `{ok:false}` when no model is loaded.
- **Standalone bundle** (`frontend/js/viewer/standalone.js` → `frontend/dist/meshvault-viewer.js`,
  demo `frontend/viewer.html`): `createViewer(container)` + `window.MeshVaultViewer`, with
  `loadFile(File)` for local files and a full `destroy()`.
- **Engine additions**: `setCameraView` presets, `setCamera`/`get_camera` (position+target+fov),
  `getState`, `getSceneInfo`, `captureImage`, `measureBetween`, `unload`, `frameModel`,
  `resetView`.

## Fixes found by the 3-agent adversarial review and applied

- `destroy()` now removes the canvas, force-loses the GL context, disposes controls/SSAO/
  composer, and detaches container listeners (+ `ViewerControlAPI.destroy()`). Verified:
  18 create/destroy cycles → 0 leaked canvases/contexts.
- Simplify / recompute-normals clone + de-interleave geometry before merging (fixes crash +
  black model on interleaved GLBs) and are atomic (failure leaves the mesh unchanged).
- `getState()` no longer reports stale scale/name/stats after a reload or failed load; added
  the `error` event and no-model guards.

## Validation

- Headless (Playwright): standalone is server-less (0 `/api` calls with all API routes
  blocked); all command categories exercised; error handling returns structured `{ok:false}`;
  full-app regression passes; backend suite 28 passed / 1 skipped.

## Not in scope (remains open)

- Physically splitting the ~3.6k-line `viewer_3d.js` into cohesive modules — see `022`
  (the decoupling makes that safe to do next; behavior is now guarded by the standalone
  harness). Frontend automated tests still absent (see `023`).
