# 0050 — Texture restoration: symmetry-based healing (inpainting v0)

- **State**: planned
- **Created**: 2026-07-11
- **Origin**: the 047 forensic cycles' one honestly-open repair: the
  portrait's LEFT eye texture is corrupted at the source (specular streaks
  baked over the iris) — alignment tools relocate damage but cannot restore
  detail that never existed.

## Context

`clone_paint` heals within a ≤45° normal cone (same-orientation donors) and
`project_paint` moves content in screen space — neither can use the BEST donor
for face-class defects: the mirrored counterpart across the object's symmetry
plane (the clean right eye). The 047 cycle-2 agent's cross-cheek clone was
correctly refused by the normal guard; a symmetry-aware transfer is the
legitimate version of that move.

## Design sketch

1. `detect_symmetry` — find the dominant mirror plane (candidate axes through
   the bbox center scored by chamfer distance between sampled points and their
   reflections; `sample_points` machinery exists). Return {plane, score}.
2. `mirror_paint {center, radius, plane?}` — for each destination texel in the
   brush (existing rasterizer): reflect its world point across the plane,
   find the source triangle near the reflected point (clone_paint's
   world-correspondence machinery), sample through the source UVs from a
   snapshot, MIRROR-AWARE: flip the sampled patch horizontally relative to the
   plane. Blend with painter semantics + meanAlpha.
3. Guards: reflected point must land on the SAME object within a distance
   tolerance; symmetry score threshold with a teaching error ("object is not
   left/right symmetric — use clone_paint with a manual donor").
4. Optional v1.5: luminance-only transfer (keep destination chroma, heal
   structure) for lighting-asymmetric bakes.

## Non-goals (v0)

ML inpainting (a heavier dependency decision — candidate for the
blackpixel-side integration instead), multi-object symmetry, auto-defect
detection (the agent's eye + pick stays the detector).

## Acceptance

- The portrait's left iris healed from the right eye with before/after
  close-ups and meanAlpha evidence; no bleed outside the brush; exported GLB
  reload-verified. Proof pack per 047 conventions.
