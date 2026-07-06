# 036 — Part-level scene exploration (`focus` + per-mesh placement)

**Priority**: Medium-High
**Effort**: Small-Medium
**Category**: Agent control API
**Status**: Done (2026-07-06)
**Created**: 2026-07-06

## Summary

After `describe_scene`, an agent knew a model HAD parts but not WHERE they were, and had
no way to point the camera at one. Two adversarial design agents evaluated the feature;
verdict: build a reduced version (per-mesh ids + world bounds exposed, plus a minimal
`focus` command), because the empirical study showed real-world mesh names are mostly
meaningless and small parts vanish behind the near plane even with DIY `set_camera` math.

## What shipped

- `describe_scene` / `get_scene_info` mesh items gain a stable traversal-order `id` and
  live world-space `center` + `size` (skinned meshes: bind pose, documented).
- `focus { id | name | point, radius?, fill? }`: keeps the current view direction,
  retargets the orbit controls to the part, and — the load-bearing part — rescales
  `camera.near/far` and the orbit distance clamps so a 1 cm part on a 10 m assembly
  frames correctly (verified: screw fills the frame; it is sub-pixel in the whole-model
  view). Name matching is tiered (exact > case-insensitive > substring over meshes AND
  named groups) and errors with a candidate list on ambiguity or miss. `reset_camera`
  restores the whole-model view and original clip planes; whole-model framing paths
  clear the focus state.
- Prerequisite bug fixed: `_bakeWorldTransforms` corrupted quantized GLBs
  (KHR_mesh_quantization Int16/Uint16 positions) by writing world floats back into
  integer arrays — `rotate` destroyed such models outright. Attributes are now
  dequantized to Float32 before baking (verified on the KTX2 model: bounds permute
  correctly after rotate, renders intact).

## Explicitly rejected (per the design review)

- Auto view-direction search / occlusion handling (no robust policy; every option has
  pathological cases — occlusion is delegated to `set_clip` + `wireframe`, documented).
- `isolate`/hide-others, `list_parts` as a separate command, highlight rendering,
  bone-level targeting, making `orbit`/`frame` focus-aware (documented instead:
  whole-model camera commands supersede focus).

## Known limits

- Skinned meshes report bind-pose bounds (three's cached bounds ignore animation).
- A focused interior part can still be occluded; `set_clip {axis:'camera'}` is the
  documented workaround.
