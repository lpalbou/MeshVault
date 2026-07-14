# 0049 — Morph targets via sculpt-pose capture (the talking face)

- **State**: completed
- **Created**: 2026-07-11
- **Completed**: 2026-07-12 (v0.9.0)
- **Origin**: deferred from 046 (articulation) with the design bridge already
  identified by the engine adversary; explicitly the missing piece of the
  user's face example (moving eyes/lips, deforming cheeks). Confirmed
  direction 2026-07-11.

## Completion

Shipped `frontend/js/viewer/morphs.js` + five commands (`begin_morph`,
`capture_morph`, `set_morph`, `delete_morph`, plus `set_keyframe {morphs}`)
through the adversarial loop (design review → implementation → live
talking-face field test → fixes → regression).

- **Design decisions that held** (from the review, verified against three
  r170 internals): real GPU morph targets (relative `morphAttributes`), NOT
  CPU adds; the morph base is its OWN snapshot (`begin_morph`) — not the
  reset snapshot (review caught the sketch's error: reset restores ORIGINAL
  geometry, but the artist may sculpt a base shape first); per-WELD sparse
  deltas (seams cannot tear); geometry DISPOSED after any morph content
  change (r170's DataArrayTexture rebuilds only on COUNT changes — in-place
  edits render stale forever); vertex bakes transform base by the full
  affine and deltas by its linear part; reset DROPS morphs loudly (the
  sketch's "morphs survive reset" was wrong — deltas reference the pre-op
  base). Export: named glTF targets, zeroed default weights, per-mesh
  interleaved weight tracks on uniquely-named nodes.
- **Field test verdict** (portrait): "the portrait talks — qualified yes."
  jaw_open + smile authored by sculpt (base-restore byte-identical to the
  pre-sculpt render), 12-key 4 s talk cycle with nod reads as speech at
  conversational amplitudes, GLB round-trip drives the deformation.
  Qualification is the asset class, not the system: photogrammetry has no
  mouth interior, so jaw_open 1.0 in close-up reads as stretched membrane.
- **Field bugs fixed** (4):
  1. Viewer WEDGED beyond recovery after 8 full-head captures (99k verts ×
     8 targets; every target shaded every frame; SwiftShader renders
     outlived the command timeout) → GPU render-cost budget in vertex-morphs
     sized to the measured renderer (~512k software / 8M hardware), refusing
     with the numbers and the fix.
  2. Reloaded GLB morphs were dead ends → imported glTF targets are
     drive-only first-class: `set_morph`/keyframes work by mesh dictionary
     (`source:"imported"`), capture/delete refuse honestly, `begin_morph`
     refuses so captures can't discard asset-authored targets; the sculpt
     guard now checks LIVE mesh influences (imported morphs, paused clip
     poses).
  3. Paint while morphed landed base-space (aim-what-you-see broke on the
     open mouth) → paint rasterizer + heal footprints test DISPLAYED
     positions (base + weighted deltas); blur/clone/mirror refuse while
     morphed (their donor correspondences are base-space).
  4. Baked rotates mid-session densified captures to ALL vertices (bake ops
     wrote vertices directly after `_bakeWorldTransforms`; the stored base
     never saw their matrix) → rotate/recenter/ground/auto-orient route
     through one morph-aware `_applyBakeMatrix` (which also preserves
     authored normals under rigid transforms).
- **The field's requested improvement, shipped**: the `hinge` pose brush —
  `sculpt {tool:"hinge", center, radius, pivot, axis, angle_deg}` rotates
  the brush region RIGIDLY about a pivot line with falloff (a jaw drop in
  ONE stamp where radial grabs translate a blob and smear the lips).

## Acceptance results

- Portrait smile/jaw-open captured from sculpted poses, keyed on the
  timeline, exported, reloaded playing (field artifacts: `/tmp/field049/`,
  43 renders + `talking_head.glb`; post-fix: `/tmp/field049fix/`).
- Regression: `tests/e2e/test_morphs.py` (2 tests — the authoring loop,
  blending, guards, timeline channels, GLB round-trip, and all four field
  fixes + hinge) green; full e2e battery green.
- The robot-face-from-primitives demo was superseded by the portrait field
  test (harder asset class, same mechanisms).
