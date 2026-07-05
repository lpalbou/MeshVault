# 028 — Khronos "PBR Neutral" tone-mapping option

**Priority**: Medium
**Effort**: Small
**Status**: Proposed
**Created**: 2026-07-06

## Summary

Offer Khronos `NeutralToneMapping` as an alternative to the current ACES Filmic. ACES
over-saturates and shifts hue, which misrepresents material/albedo colors — a problem for
faithful product/asset review. PBR Neutral preserves color while taming highlights.

## Reason / evidence

- 2026 market research: PBR Neutral is now the recommended default for accurate
  material/color read in glTF viewers; three.js ships `THREE.NeutralToneMapping`.

## Current code reality

- `_initRenderer`: `renderer.toneMapping = THREE.ACESFilmicToneMapping`.

## Scope

- Expose tone mapping as a setting: `set_tone_mapping { mode: aces|neutral|linear }` (+ UI),
  reported in `getState().display`. Keep ACES as current default or switch default to neutral
  (decide after A/B on sample assets).

## Acceptance criteria

- Switching to neutral visibly reduces oversaturation on a colorful textured model;
  reported in state.
