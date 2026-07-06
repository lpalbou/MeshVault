# 026 — Compressed glTF decoders (Draco / KTX2 / Meshopt)

**Priority**: High
**Effort**: Medium
**Category**: Format support / correctness
**Status**: Done (2026-07-06)
**Created**: 2026-07-06

## Implementation notes (done)

- `_makeGLTFLoader()` in `frontend/js/viewer_3d.js` wires `DRACOLoader`, `KTX2Loader`
  (with `detectSupport(renderer)`), and `MeshoptDecoder`. Draco/KTX2 loaders are created
  once per viewer and reused (bounded worker pools); `destroy()` disposes them.
- Decoder assets vendored at `frontend/vendor/{draco/gltf,basis}` (~1.3 MB, from the
  matching `three` release — re-sync when bumping three). Served at `/static/vendor/` in
  the app; `scripts/build.mjs` copies them to `web/vendor/` and the Pages workflow ships
  `site/vendor/`. `assetBaseUrl` option: `/static/` (app) or relative (standalone/Pages).
- Thumbnailer (`frontend/js/thumbnailer.js`) shares the same decoders, so compressed
  models get grid thumbnails too.
- Adversarially verified: Draco + KTX2 + Meshopt load in app, standalone, and a `/repo/`
  Pages simulation with ALL external requests blocked (fully offline, zero CDN); worker
  counts bounded at 8 across 10 loads and drop to 0 on destroy; corrupt files reject with
  readable errors (`describeLoadError`).

## Summary

A large share of real-world `.glb`/`.gltf` in 2026 ship with Draco (geometry), KTX2/Basis
(textures), or Meshopt compression. MeshVault's `GLTFLoader` has no decoders wired, so those
models **fail to load or load without geometry/textures**. This is the highest-value gap
found by the feature research: it is about models that don't open today, and it matters
doubly for the public web viewer where users paste arbitrary URLs.

## Reason / evidence

- 2026 feature research (market + web-deploy passes): compressed glTF is baseline in every
  reference viewer (`<model-viewer>`, three-gltf-viewer, Babylon sandbox, Sketchfab).
- Current code: `frontend/js/viewer_3d.js` `_loadGLTF` uses a bare `GLTFLoader` with no
  `DRACOLoader` / `KTX2Loader` / `MeshoptDecoder` set.

## Current code reality

- `_loadGLTF(url)` → `new GLTFLoader().load(...)`. No decoders. No decoder assets bundled.

## Scope

- Wire `DRACOLoader`, `KTX2Loader` (needs renderer for transcoder support detection), and
  `MeshoptDecoder` into `GLTFLoader` in `_loadGLTF`.
- **Vendor the decoder assets locally** (Draco wasm/js, Basis transcoder) under
  `frontend/vendor/` (or bundle) so the offline + standalone + GitHub-Pages builds keep
  working with NO CDN dependency. This is the load-bearing constraint.
- Ensure both the full app and the standalone/Pages bundle resolve the decoder paths
  correctly (relative, base-path safe).

## Non-goals

- Compressing/exporting to Draco/KTX2 (import only for now).

## Acceptance criteria / validation

- A Draco-compressed and a KTX2-compressed sample GLB load and render in both the app and
  the standalone viewer, offline (no network), and on a `/repo/` Pages base path.
- Bundle/site still works with all non-localhost requests blocked.
