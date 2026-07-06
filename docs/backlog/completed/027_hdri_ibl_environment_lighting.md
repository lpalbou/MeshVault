# 027 — HDRI / IBL environment lighting + presets

**Priority**: High
**Effort**: Medium
**Category**: Rendering
**Status**: Done (2026-07-06)
**Created**: 2026-07-06

## Implementation notes (done)

- `_initEnvironment()` builds a PMREM environment from `RoomEnvironment` (procedural — no
  HDRI asset shipped, stays offline/self-contained) and applies it via
  `scene.environment` + `scene.environmentIntensity`. On by default at intensity 1; the
  key/fill/ambient rig is kept as the baseline layer.
- CRITICAL (three r170): per-material `envMapIntensity` is IGNORED for materials without
  their own `envMap` — the renderer forces the uniform from `scene.environmentIntensity`.
  All control goes through the scene properties (see KnowledgeBase).
- `set_environment { enabled, intensity:0..5, asBackground }` + `get_environment` in the
  control API; state in `getState().display.environment`. Disabling IBL also clears an
  env background. The matte `solid` render mode suspends the env entirely so the clay
  look stays readable (adversarial review found IBL washed it to ~230/255 luminance).
- Adversarially verified: real IBL (model readable from env alone with all analytic
  lights at 0; view-dependent reflections), monotonic intensity (mean pixel diff 23/31/35
  at 1/2/3 vs off), off returns pixel-identical to pre-IBL, PMREM/RT disposed on
  destroy(), no leaks.

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
