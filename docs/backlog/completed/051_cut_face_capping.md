# 0051 — Cap split-object cut faces (kill the black gashes)

- **State**: completed
- **Created**: 2026-07-11
- **Completed**: 2026-07-12 (v0.9.0)
- **Origin**: hollow cut faces are the most visible artifact in every 046/047
  articulation render (wing roots at sweep max, the nod's neck seam). 046
  deferred capping because naive caps invent WRONG UVs; the proof cycles
  showed the artifact is prominent enough to warrant the careful version.

## Completion

Shipped `frontend/js/viewer/capping.js` wired into `split_object` through the
full adversarial loop (design review → implementation → static audit → live
field gauntlet → fixes → regression), and **plane cuts now cap by default**
(`cap:false` opts out) — the field tester's exact ship condition.

- **Design review corrections** (pre-implementation): the sketch's "vertices
  near the plane within tolerance" rim definition was wrong (whole-triangle
  classification scatters rim vertices a full triangle off the plane; ANY
  tolerance both misses and over-collects) — the rim is the set of welded
  edges that BECAME open, computed by classifying the pre-split edge
  multiset per side, so pre-existing holes are never sealed by construction.
  The sketch's atlas-rect + mean-color texel WRITES were dropped for ONE
  anchor UV per loop (flat sample, no budget charge, no canvas mutation).
- **Static audit fixes** (4): cap UVs collapse to the loop anchor (per-vertex
  rim UVs interpolate across fragmented atlases as smeared streaks);
  ear-accept epsilon aligned to `fix_mesh`'s degenerate cutoff (caps in the
  gap were emitted then dropped, reopening pinholes); `uvMode` measured
  per cap instead of hard-coded; figure-8 walks rejected (later superseded
  by the angular walk below).
- **Field gauntlet** (textured chest + primitives; oblique cuts, grazing
  slivers, `side:"-"`, paint-across-seam, simplify-across-rim): headline
  before/after pair decisive; three field bugs fixed —
  1. Re-splitting a capped piece left the remainder's whole rim open
     (256 edges): rim membership is now the mod-2 boundary rule per side
     (odd side-count on an even-total edge — scanned doubled-shell edges
     have 3+ owners and broke the naive "exactly one owner"), and the loop
     walker resolves 4-degree junctions (a new cut crossing the old cap's
     welded rim ring) by leftmost-turn angular continuation in the cap
     plane instead of rejecting them as bowties.
  2. Caps rejected paint ("Brush touched no surface"): UV-degenerate
     triangles get a dedicated stamp path keyed on closest-point-on-triangle
     distance — painting a cap flatly recolors it.
  3. Cap color was a one-texel lottery (olive-gray cap on a wooden chest):
     the anchor is now the rim vertex whose texel is nearest the MEDIAN rim
     color (small readback canvas when the base texture is drawable).
  Plus: the split note stops attributing walker-skipped edges to
  "pre-existing boundaries" — it discloses the skipped count.

## Acceptance results

- Chest articulation pair (lid open 60°): capped reads as two solid objects,
  hollow as a black void — decisive. Cap colors match the wood after the
  median-anchor fix.
- `openEdges` 0 on both sides of every watertight cut, SURVIVING `fix_mesh`
  (epsilon alignment); positive signed volumes both sides (winding correct).
- Double-split through an existing cap: both pieces closed, volumes positive.
- Regression: `tests/e2e/test_capping.py` (3 tests — numeric closure gates,
  box-cut fan fallback, parts-mode refusal, pre-existing holes untouched,
  cap-by-default, the three field fixes) green; full e2e battery green.

## Evidence

`/tmp/field051/` (18 field renders + scripts), `/tmp/field051/recheck_*.png`
(post-fix chest verification), CHANGELOG v0.9.0 entry.
