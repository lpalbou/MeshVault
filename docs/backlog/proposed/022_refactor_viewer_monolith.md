# 022 — Refactor `viewer_3d.js` Monolith

**Priority**: Medium
**Effort**: Large
**Category**: Architecture / Maintainability
**Status**: Proposed (partially addressed by 025)
**Created**: 2026-07-05

> Update 2026-07-05: `025` extracted the engine into a decoupled, embeddable core with a
> control API + standalone bundle (backend coupling removed via an injected resolver), and
> added a headless harness (`viewer.html`) that guards behavior. What REMAINS for `022` is
> the physical split of the still-large `viewer_3d.js` (~3.6k lines) into cohesive modules
> (scene / loaders / texture-matching / transforms / measure / animation / export). The
> decoupling + harness now make that split much lower-risk.
>
> Update 2026-07-11: urgency raised. 045–047 grew `viewer_3d.js` to ~6.4k lines even
> though the NEW capability code landed in focused modules (`viewer/sculpt.js`,
> `viewer/timeline.js`, `viewer/articulation.js`, `viewer/repair.js`, `viewer/control_api.js`
> — that pattern works and is the template). The remaining monolith mass is the object
> registry + placement/pivot composition, camera/framing, lighting/environment, the five
> loaders, bake transforms, and the export builder. Extraction candidates in order of
> cohesion: `viewer/registry.js` (entries, logical placement, hierarchy),
> `viewer/exporter.js` (`_appendExportMesh` + animated-GLB builder), `viewer/loaders/*`.
> Precondition: commit the E2E suites first (`0048`) — they are the behavior guard the
> 2026-07-05 note asked for.

## Summary

`viewer_3d.js` is 3,046 lines doing scene setup, five loaders, texture-matching heuristics,
transforms, PCA, and export in a single class — ~5× the project's own 600-line guideline. With
no state management, this blocks the material-editor / component-picker / undo-redo items
(`006`, `007`) and makes every viewer change risky.

## Reason

- Code review: 3,046-line class; state scattered across the class and the DOM; project rule is
  ~600 lines/file, 1 file = 1 task.

## Sketch of scope

- Split by responsibility, e.g.: `scene_setup` (lights/renderer/composer), `loaders/*` (per
  format), `texture_matcher`, `transforms` (center/ground/PCA/rotate/simplify/normals),
  `exporter`, and a thin `viewer` orchestrator.
- Introduce an explicit viewer state object (single source of truth) instead of DOM-derived
  state, enabling undo/redo (`006`).
- Do it incrementally, extracting one cohesive module at a time; keep behavior identical.

## Dependencies

- Enables `006`, `007`; eased by `021` (build/vendoring) and `023` (tests as a safety net).

## Risk

- High-churn refactor with no current test coverage → do `023` first (or in lockstep) so
  behavior is guarded.
