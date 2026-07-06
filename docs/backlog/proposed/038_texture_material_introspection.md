# 038 — Texture & material introspection (authored-value fidelity)

**Priority**: High
**Effort**: Medium
**Category**: Agent control API / materials
**Status**: Partially done (2026-07-06); UV diagnostics + image statistics remain
**Created**: 2026-07-06

## Delivered 2026-07-06

- Texture facts per map slot in `describe_scene` materials: `{width, height, colorSpace}`
  (linear data textures report "linear", not null).
- Authored-vs-displayed PBR fidelity: original values stashed before the viewer's
  preview clamps (`authored` + `modifiedByViewer:true`, only present when something was
  changed). Viewer-created STL/PLY default materials are tagged `_mvViewerDefault` and
  correctly report NO authored data (review caught them masquerading as authored).
- Verified live: 2048×2048 srgb map on the face model; machine.glb clamp
  (authored metalness 1 → displayed 0.12) faithfully reported.

## Remaining

- UV diagnostics (stretch/overlap/coverage %) and a UV-checker render mode.
- Image statistics for `screenshot` (mean luminance, clipped %), so vision-less agents
  can judge exposure.
- Review note (separate, display-side): `_fixDarkColor` computes luminance in linear
  space, making the "slightly dark" boost fire on any color darker than ~67% sRGB —
  more aggressive than intended. Needs its own look; changing it alters every preview.

## Summary

The materials field-test agent could not answer basic texture questions through the
tools: texture resolution/format/color-space is unobtainable (`maps: ["map"]` is the
entire story — the agent had to parse the GLB offline to learn a bake was 2048²). Worse,
the viewer silently clamps authored PBR values (`_upgradeMaterial` rewrites
metalness/roughness) and `describe_scene` reports only the **clamped** values with no
flag — a materials audit through the API returns wrong data about the asset. That is a
fidelity bug for the "describe the ASSET" contract, not just a missing feature.

## Scope

- Per-material texture info: for each map slot, `{width, height, colorSpace, mimeType?}`
  (available on the three.js Texture image at no extra cost).
- Report AUTHORED PBR values alongside displayed ones: capture material params before
  `_upgradeMaterial` mutates them (e.g. `authored: {metalness: 1.0}` +
  `displayed: {metalness: 0.25}` + a `modifiedByViewer: true` flag).
- UV diagnostics (stretch/overlap/coverage %) and a UV-checker render mode for visual
  seam hunting — currently "blind screenshot roulette".
- Optional: basic image statistics for `screenshot` (mean luminance, clipped-pixel %) so
  vision-less agents can judge exposure; the lighting-sweep test needed offline PIL.

## Evidence

- Materials field test (2026-07-06): found unset `metallicFactor` (glTF default 1.0) and
  `baseColorFactor 0.4` authoring bugs in the test assets ONLY by offline GLB parsing —
  the tool reported the viewer's defensive clamp (0.25) as if it were the asset.
- Documented workflow trap to fix alongside: `set_lighting` sweeps are visually inert
  until `set_environment {enabled:false}`; the docs should say so (small doc fix).
