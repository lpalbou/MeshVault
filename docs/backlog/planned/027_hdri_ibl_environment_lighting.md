# 027 — HDRI / IBL environment lighting + presets

**Priority**: High
**Effort**: Medium
**Category**: Rendering
**Status**: Proposed
**Created**: 2026-07-06

## Summary

MeshVault lights the scene with a directional/hemisphere rig only. PBR materials
(metal/roughness) look flat and "wrong" without image-based lighting (IBL) from an
environment map. Adding HDRI/IBL with a few built-in environment presets is the single
biggest realism improvement per the feature research, and it makes metallic/reflective
models read correctly.

## Reason / evidence

- 2026 market research: IBL environment lighting is table-stakes in every reference PBR
  viewer; the top-ranked realism feature.

## Current code reality

- `_initLights` uses hemisphere + key/fill/rim directional lights. `scene.environment` is
  not set; no `PMREMGenerator` / env map.

## Scope

- Add a small set of bundled environment maps (or procedurally generated ones via
  `RoomEnvironment` + `PMREMGenerator` to avoid shipping large HDRIs) applied to
  `scene.environment`.
- Control API + UI: `set_environment { preset }`, environment intensity, and a toggle for
  showing the env as the background vs a solid color.
- Keep the existing key/fill lights as an additive layer (or let presets balance them).
- Must stay offline/self-contained (bundle any assets locally).

## Non-goals

- Arbitrary user HDRI upload (could be a follow-up).

## Acceptance criteria / validation

- A metallic model visibly gains correct reflections/shading with IBL on.
- Works offline and in the standalone/Pages bundle.
- `getState().display` reports the active environment.
