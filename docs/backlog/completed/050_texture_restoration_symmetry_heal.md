# 0050 — Texture restoration: symmetry-based healing (inpainting v0)

- **State**: completed
- **Created**: 2026-07-11
- **Completed**: 2026-07-12 (v0.8.0)

## Completion

Shipped `frontend/js/viewer/symmetry.js` + two control-API commands
(`detect_symmetry`, `mirror_paint`) and the single-slot brush undo
(`undo_paint`, wired into ALL texture brushes), through 3 adversarial cycles
(design review → implementation → live field gauntlet → fixes → final audit).

- **Design review corrections** (pre-implementation): the sketched "flip the
  patch" step was a chirality bug — the per-texel reflected correspondence
  (det −1) mirrors content intrinsically; all reflection math moved to
  wrapper-LOCAL space (`W·R·W⁻¹`, valid under non-uniform scale); robust
  scoring = median + p90 reflected distance + normal agreement through the
  AREA centroid, BVH-backed (`three-mesh-bvh`), cached by `geometryRev`.
- **Field gauntlet** (live portrait repair): the corrupted iris was genuinely
  healed — anatomically mirrored (tear duct on the nose side), donor eye
  pixel-verified untouched. Four field bugs fixed: 6-minute silent scan →
  work budget + centroid prefilter (0.77 s teaching error); unreachable
  selfSourceFraction semantics (10%-of-radius capped it at ~0.06) → mirror-
  inside-brush with a >0.4 straddle note; the zero-heal hint naming the
  object's OWN mesh → destination-mesh excluded + sub-texel message;
  silent wrong-plane overrides → explicit planes are scored and warned.
  Plus: plane-origin refinement along the normal (seed changes moved it
  ~2.7 cm — a smear at iris scale).
- **Final audit**: 6/6 checks PASS (budget error 0.767 s; straddle 0.638 +
  note; weak-override warning; honest sub-texel error; undo pixel-identical
  0/630,000 px; the real iris heal still convincing post-refinement). SHIP.
- Regression net: 26-check symmetry smoke suite (chirality via green/blue
  feature transfer, determinism, staleness, tie-break stability, undo).

Deferred (with evidence): luminance-only transfer (the motivating defect had
corrupted chroma — full RGB was correct), cross-mesh donors (loud teaching
error names the counterpart mesh), non-planar symmetry. Documented limits:
geometric symmetry ≠ texture symmetry (verify with a render); baked
directional lighting transfers with the donor (blur_paint the boundary).
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
   snapshot. Blend with painter semantics + meanAlpha.
   CORRECTION (2026-07-11 adversarial review): the originally-sketched
   "flip the sampled patch horizontally" step is WRONG — the per-texel
   reflected correspondence has determinant −1 and delivers the patch
   intrinsically mirrored; adding a 2D flip would paste the donor
   un-mirrored (chirality bug). There is no flip step. All reflection math
   happens in wrapper-LOCAL space (valid under non-uniform scale).
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
