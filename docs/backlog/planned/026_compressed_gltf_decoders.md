# 026 — Compressed glTF decoders (Draco / KTX2 / Meshopt)

**Priority**: High
**Effort**: Medium
**Category**: Format support / correctness
**Status**: Proposed
**Created**: 2026-07-06

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
