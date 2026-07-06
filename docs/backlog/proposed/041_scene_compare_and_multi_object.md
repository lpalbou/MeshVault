# 041 — Surfacing shape comparison in the app (compare layer → multi-object scene)

**Priority**: Medium-High
**Effort**: Staged (3–5 days for v1; 10–15 days for the full multi-object vision)
**Category**: App UX / viewer architecture
**Status**: v1 DONE (2026-07-06); v2 (co-loaded multi-object scene) + v3 remain proposed
**Created**: 2026-07-06

## v1 shipped (2026-07-06)

Single-slot compare + deviation heatmap, no multi-object refactor (per the user's scope
choice and the scope critic's recommendation):
- `POST /api/compare` (backend/app.py) — pure point-set math, shares
  `backend/mesh_compare.py` with the MCP tool; `mesh_compare` now also returns
  `rotationMatrix` + `matrix4`.
- `frontend/js/compare.js` (ModelComparer): right-click any asset → "Compare to loaded
  model". Samples both surfaces (the candidate in a short-lived offscreen viewer),
  registers via the backend, paints a **deviation heatmap** on the displayed reference
  and shows a verdict panel (classification, shape-difference %, scale, rotation,
  asymmetry, borderline/mirror warnings). One model displayed at a time.
- `frontend/js/viewer/heatmap.js` (three-mesh-bvh, app bundle only): per-vertex
  closest-distance to the registered candidate surface → unlit colour ramp
  (blue=match … red≥ramp), floored at 1% of the diagonal so compression/sampling noise
  reads as "matches". Reads positions via the accessor (handles quantized/interleaved).
- Verified live: Draco copy → uniformly cool; different object → hot; clears cleanly;
  selecting a new model ends the comparison. Failure paths surface a verdict-only panel.

Remaining below is v2/v3 (true co-loaded, registered overlay + object-list UI).

## Problem

The geometric shape-comparison engine (`backend/mesh_compare.py` + MCP `compare_models`)
exists only for agents and only offline (models loaded sequentially, compared as point
clouds — nothing co-displayed). A human using the full app cannot compare two models or
see how they align. The user asked for "a scene in which multiple objects are loaded and
can be registered to one another."

## What the three design agents concluded

- **Scope critic:** defer a full multi-object scene. The viewer is single-object with 94
  `_currentModel` references; the repo already chose the numeric tool over a second
  viewer slot (039) and parked A/B visuals (035); the near-term goals are agent-first
  and remote/headless. The real face-iteration data was **texture-only** changes where a
  geometric overlay shows nothing. The one thing genuinely worth building for human eyes
  now is a **difference heatmap on the single loaded model** — no scene-graph change.
- **UX designer:** a "Comparison Set / Compare Tray" — pin a reference, add candidates,
  auto-register, read results via a clay-vs-ghost overlay + A/B flip + a
  progressive-disclosure verdict card. V1 ruthlessly scoped to two models via one new
  `POST /api/compare` endpoint; heatmap / N-candidate / aligned export in v2.
- **Architect:** feasible and cheaper than it looks IF you use a registry-with-active-
  object (`get _currentModel()` getter keeps all 94 refs + 3 helper modules working) and
  keep registration in Python. Full job (registry + app registration + heatmap + UI) is
  10–15 days. Registration seam: `sample_points` (JS, exists) → `POST /api/compare`
  (new, pure point-set math, no PathGuard surface) → `set_object_transform` (JS, new).
  Heatmap via `three-mesh-bvh` closest-point, painted as a per-object render mode.

## Convergence (what all three agree on)

- Registration stays in **Python** (the calibrated ICP/mirror/floor logic must not be
  re-implemented in JS); the app reaches it via a new `POST /api/compare` that takes
  point sets and returns the existing `compare_point_sets` result. MCP keeps using the
  engine directly → one algorithm, two front-ends.
- `mesh_compare.py` must additionally return the **rotation matrix / matrix4** (today it
  returns only the angle) so an overlay can apply the alignment. Additive.
- The genuinely valuable human-facing artifact is a **deviation heatmap** (per-vertex
  distance to the other surface, colour-ramped) — it answers "did my remesh/decimation
  change the shape, and WHERE", which counts/screenshots cannot.

## Recommended plan (staged; each stage independently shippable)

### v1 — Single-slot compare + heatmap (RECOMMENDED FIRST; ~3–5 days, no scene-graph risk)
- `POST /api/compare {reference:[pts], candidate:[pts], reference_alt?, align}` →
  `compare_point_sets(...)` verbatim. `mesh_compare.py` gains `rotationMatrix`/`matrix4`.
- App "Compare" affordance: with a model loaded (the reference), pick a candidate from
  the browser; the app loads the candidate offscreen just long enough to `sample_points`
  it, calls `/api/compare`, then **paints a deviation heatmap on the displayed reference**
  (`three-mesh-bvh` closest-point to the candidate's registered samples) + shows a
  verdict card (classification, scale, rotation, chamfer, asymmetry).
- MUST surface the engine's honesty signals or it misleads: `borderline`, mirror
  `warnings`, partial-overlap/scale caveats.
- Delivers the headline value (see the difference, quantified) with ZERO multi-object
  refactor — only one model is ever displayed.

### v2 — True co-loaded, registered overlay (the user's literal request; ~1 week on top)
- Registry-with-active-object (architect's design): `this._objects[]` + `_activeId`,
  `ObjectEntry` (wrapper group holding the alignment transform, per-object
  visible/opacity/state, exact disposal), `get _currentModel()` getter for backward
  compat. New additive commands: `add_model`, `list_objects`, `set_active_object`,
  `remove_object`, `set_object_visible/opacity`, `set_object_transform`, `frame_all`.
  `getState`/`describe_scene` gain an additive `objects`/`coLoaded` section.
- Overlay UX: reference as solid clay, candidate as coloured ghost, aligned via the
  returned matrix; A/B flip; the heatmap from v1 now on the co-displayed pair.
- `compare_models` MCP tool gains `co_load:true` returning the applied matrix (parity).

### v3 — Polish
- Object-list panel, per-object colour, N-candidate ranking in the UI, aligned export.

## Failure modes that MUST be handled (or the feature misleads)

- Partial-overlap registration is unreliable (documented) → show asymmetry + a warning,
  never a confident transform.
- Near-symmetric shapes → ambiguous rotation; classification still valid.
- Scale/unit mismatch → surface as `scaleRatio`, not as "different".
- Auto-alignment wrong → offer a manual nudge / "compare in place (align:false)" and
  always let the user see the un-aligned state.

## Top technical risks (architect)

Camera/environment framing for mismatched-scale objects (`_frameModel` → `_frameToBox`
on the visible union, clamp near/far); disposal leaks at N objects (replicate the
`_mvOriginalMaterial`-restore-before-dispose invariant per entry); global vs per-object
render mode/opacity; observation-command scope ambiguity (state "active object" in every
description); transform-baking vs alignment collision (alignment lives ONLY on the
wrapper group, never traversed by `_bakeWorldTransforms`).

## Open questions for the user (drive the scope)

1. Is the near-term need "see/quantify how two models differ" (→ v1 is enough) or
   literally "compose a scene of several objects" (→ v2)?
2. Does this wait for abstract3d (compare generated candidate vs target — a concrete
   driver for v2), or is there a present need?
3. Is a heatmap on one model acceptable as the first deliverable, or is the co-loaded
   overlay the actual ask?
