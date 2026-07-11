# 0049 — Morph targets via sculpt-pose capture (the talking face)

- **State**: planned
- **Created**: 2026-07-11
- **Origin**: deferred from 046 (articulation) with the design bridge already
  identified by the engine adversary; explicitly the missing piece of the
  user's face example (moving eyes/lips, deforming cheeks). Confirmed
  direction 2026-07-11.

## Context

Rigid articulation cannot make a fused head talk: a jaw plane-cut produces a
hollow slice (proven in the 046 gauntlet — the portrait "talks" as a
neck-pivot nod). The correct mechanism is morph targets (blend shapes), and
the sculpting stack already contains the hard parts:

- The per-entry reset snapshot is exactly a BASE-POSE position array
  (accessor-decoded, layout-independent).
- Sculpt brushes produce the DEFORMED pose in place.
- The timeline interpolates scalars deterministically; glTF morph weights are
  standard `NumberKeyframeTrack` targets that GLTFExporter already supports.

## Design sketch (validate with an adversarial review before building)

1. `capture_morph {name}` — diff current positions against the reset snapshot
   → sparse delta (only moved vertices) stored per entry as a named morph;
   RESTORE the base pose after capture (sculpt → capture → sculpt next pose).
2. `set_morph {name, weight: 0..1}` — apply blended deltas (CPU add into the
   position attribute, or wire real three.js morphAttributes + morphInfluences
   — decide in review; morphAttributes is the export-correct path).
3. Timeline channel `morph:<name>` — keyframes on weights; `set_keyframe
   {id, time, morphs: {smile: 0.8}}`.
4. Export: morphAttributes + weight tracks → glTF morph targets/weights
   animation (GLTFExporter supports both; the 046 export architecture already
   preserves per-object nodes for animated exports).
5. Proofs: base/pose contact sheet, weight sweep sheet (0 → 1), exported GLB
   reload with morphs playing, in-app playback.

## Constraints from the KnowledgeBase (non-negotiable)

- Deltas computed/applied through ACCESSOR reads + `setXYZ` (quantized/
  interleaved safety); welded-duplicate consistency (a seam vertex's delta
  applies to all duplicates); budget morphs (e.g. ≤8 per object, sparse
  storage); `reset` semantics decided explicitly (reset clears sculpt — does
  it clear morphs? Recommend: morphs are AUTHORED data like pivots, surviving
  reset; `delete_morph` removes).

## Acceptance

- Robot-face demo from primitives + a portrait smile/jaw-open captured from
  sculpted poses, keyed on the timeline, exported, reloaded playing, in-app
  playable. Proof pack per 047 conventions (renders + GLBs + INDEX entry).
