# 056 — Quality-trigger noise on intentional micro-detail + tolerant batch stamps

**Priority**: Medium
**Effort**: 1–2 days
**Category**: Agent ergonomics
**Status**: Proposed
**Created**: 2026-07-13 (Death Star field session)

## Problem A: meshQuality advisory noise (16× in one session)

Every sculpt result now carries `meshQuality {needsRemesh}` — correct for
degradation, but a FINE INTENTIONAL groove (ridge lines at radius 0.03,
strength 0.01) trips the same trigger on every stroke: 16 advisories in one
Death Star build, none of which the agent should act on mid-detail-work
(remesh:auto during micro-grooving would erase or budget-starve the detail;
the right move is one regularize at the END of the detail pass, which the
choreography did).

An agent monitoring its own results cannot distinguish "you are damaging the
mesh" from "you are carving detail finer than the local median" without
reading the numbers carefully.

Live-session confirmation (28 advisories, all benign): even SMOOTH strokes
near existing grooves trip the trigger (f_out 0.19–0.37) — the metric
measures the REGION's standing state, not this stroke's contribution, so any
brush passing over intentional detail re-reports it. This is the strongest
argument for the `trend` (per-stroke delta) form.

### Proposal

- Scale the trigger with the brush's DEPTH-TO-RADIUS ratio: shallow strokes
  (maxDisplacement < ~0.25 × radius) in a region whose out-of-band fraction
  was ALREADY high before the stroke should report `needsRemesh:false` with
  a `detailWork:true` hint instead.
- Alternatively (simpler): `meshQuality.trend` = delta of outOfBandFraction
  attributable to THIS stroke — agents gate on the trend, not the absolute.

## Problem B: batch stamp misses abort nothing but clutter (2× per session)

Decorative dot fields (window lights) place dozens of tiny stamps via
`batch`; 1-2 per batch land on unpaintable spots (normal-clamp rejection near
panel edges) and return "Brush touched no surface" errors inside the batch
result. The agent must scan sub-results to learn nothing actually failed.

### Proposal

`paint {miss:"skip"}` (or batch-level `tolerate_misses:true`): a missed
decorative stamp returns `{painted:0, missed:true}` instead of throwing —
opt-in, so the teaching error stays the default for aimed single stamps.

## Acceptance

- Death Star ridge pass produces 0 needsRemesh advisories (or trend ≈ 0)
  while a hard grab still trips the trigger.
- A 30-dot batch with 2 off-surface dots returns ok with 2 `missed:true`
  sub-results and no error entries.
