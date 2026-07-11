# 0051 — Cap split-object cut faces (kill the black gashes)

- **State**: planned
- **Created**: 2026-07-11
- **Origin**: hollow cut faces are the most visible artifact in every 046/047
  articulation render (wing roots at sweep max, the nod's neck seam). 046
  deferred capping because naive caps invent WRONG UVs; the proof cycles
  showed the artifact is prominent enough to warrant the careful version.

## Context

`split_object` leaves both sides of a plane cut open (documented, with the
"sweeps ≲30°" workaround). The rim is already computed (openEdgesAdded counts
it; the boundary-rim lock in simplify_region identifies rim vertices).

## Design sketch

1. After a plane split, collect the cut rim loop(s) per side (welded edges
   with count 1 that lie on the cut plane within tolerance; order into loops
   by adjacency).
2. Triangulate each loop with a centroid fan (rims from plane cuts are
   near-planar; ear-clipping only if fan quality proves unacceptable).
3. UVs for cap triangles: allocate a small unused rect in the atlas (the
   islandOccupancy grid from 047 finds free space) and fill those texels with
   the MEAN COLOR of the rim ring's texels — a flat, plausible "interior"
   color instead of stretched garbage. On the paint layer when one exists;
   else create a layer (existing machinery).
4. `split_object {cap: true}` (default false in v0; flip the default once
   field-proven). Caps marked in userData so `fix_mesh` open-edge deltas can
   report them separately.
5. Normals face outward from each side (plane normal ± side).

## Risks to review adversarially before building

Multi-loop cuts (a cut through both wings of one mesh = several rims),
non-planar "rims" from parts-mode splits (cap only plane cuts in v0), paint
budget charge for the cap texels, exporter interaction (caps are ordinary
triangles — should be free).

## Acceptance

- Starship wing sweep at 45° with no visible void at the root (before/after
  proof pair); openEdgesAdded reports 0 with cap:true; GLB round-trip renders
  the caps correctly.
