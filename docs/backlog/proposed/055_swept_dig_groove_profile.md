# 055 — Swept dig: continuous groove profile along a path

**Priority**: Medium-High
**Effort**: 2–3 days
**Category**: Sculpting / agent tools
**Status**: Proposed
**Created**: 2026-07-13 (Death Star field session)

## Problem (field evidence)

A dig `sculpt_stroke` is a chain of independent crater stamps at spacing
radius/2. Each stamp has its own plateau rim, so a carved trench reads as a
STRING OF BEADS instead of a clean groove (the Death Star's equatorial trench
rims needed explicit smooth passes, and still kept a scalloped edge). Worse,
overlapping stamps COMPOUND depth — the per-stamp clamp bounds one stamp, not
the union, so the trench floor landed ~3× deeper than `strength` and the
painting phase had to re-probe the floor radius before aiming
(`trench floor radius: 0.908` for a strength-0.028 dig on a unit sphere).

## Proposal

`sculpt_stroke {tool:"dig"}` with a `swept:true` mode (or a dedicated
`groove` tool): displacement is computed ONCE per weld from the distance to
the POLYLINE (capsule distance), not per stamp:

- profile: same plateau + C2 smootherstep shoulder, but parameterized on
  lateral distance to the path — one continuous rim, zero beads;
- depth: exactly `strength` everywhere along the path (no compounding);
- piercing guard: probes along the path at radius/2 spacing (union of the
  per-stamp probes), still refusing with the max-safe-strength error;
- remesh: one pre-split along the path band (radius/5) + one post
  regularize over the band, instead of per-stamp work.

## Acceptance

- A full equatorial trench on a 96×72 sphere: floor depth == strength ± 5%,
  rim bead amplitude < 0.1 × strength (measure via inspect_region p95 height
  variance along the shoulder), openEdges invariant, zero degenerates.
- The Death Star choreography's smooth de-bead passes become unnecessary.
