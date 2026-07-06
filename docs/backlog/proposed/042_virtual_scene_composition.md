# 042 — Virtual scene composition (multi-object scenes, positioning, persistence)

**Priority**: Medium (rises to High when abstract3d lands)
**Effort**: Large, staged (~2–3 weeks total; stage 1 shared with 041 v2)
**Category**: Viewer architecture / app UX / agent workflows
**Status**: Proposed
**Created**: 2026-07-06

## Summary

Evolve MeshVault from "one model at a time" to a scene workbench: co-load multiple
objects, position them (move/rotate/scale each independently), save/load the composed
scene, and export it as one model. This subsumes the 041 v2 "registered overlay"
(registration becomes one placement tool: "align B onto A") and is the natural
integration point for abstract3d — generate objects, compose them into a scene, capture
or export the result, all drivable by agents through the same control API/MCP.

## Why not yet (honest framing)

This is the first feature that changes MeshVault's identity (browser/viewer/analyzer →
workbench). Its strongest justification is generative composition, which doesn't exist
yet. The foundation (stage 1) is justified today by two consumers (scene composition +
041 v2 overlay); the rest should be pulled by the concrete abstract3d need.

## Staged plan

### Stage 1 — Multi-object foundation (~1 week; same as 041 v2 stage 1)
The architecture is fully specced in `041_scene_compare_and_multi_object.md` (registry
`_objects[]` + active object, `ObjectEntry` with wrapper `Group` — placement transforms
must live on the wrapper, NEVER visible to `_bakeWorldTransforms`, or center/ground
bakes the placement into vertices — `get _currentModel()` getter for backward compat
with the ~50 single-object commands and 94 references, additive commands `add_model` /
`list_objects` / `set_active_object` / `remove_object` / `set_object_visible/opacity` /
`set_object_transform` / `frame_all`, union framing via `_frameToBox`, per-entry
disposal replicating the `_mvOriginalMaterial` restore-then-dispose invariant).

### Stage 2 — Positioning UX (~3–5 days)
- three.js `TransformControls` gizmo on the selected object (translate/rotate/scale
  modes, keyboard toggle), object-list panel (select/show/hide/opacity/remove),
  click-to-select in the viewport (raycast → entry), ground-snap and duplicate.
- Selection outline; active object drives the existing single-object toolbar.

### Stage 3 — Scene persistence + export (~2–4 days)
- Scene manifest: JSON `{objects:[{source path, transform, visible, opacity}],
  lighting, environment, background}` saved/loaded via new guarded backend endpoints
  (`POST /api/scene/save`, `GET /api/scene/load`) — paths re-resolve through PathGuard.
- Export composed scene as ONE merged GLB (GLTFExporter already in use; apply wrapper
  transforms at export).

### Stage 4 — Agent/MCP parity (~2–3 days)
- Control-API + MCP: compose scenes programmatically (`add_model {source, transform}`),
  `describe_scene` covering all objects (additive `objects`/`coLoaded` keys — existing
  consumers unaffected), scene manifest save/load as MCP tools.
- This closes the abstract3d loop: generate → place → describe/QA → capture/export.

## Dependencies / interactions

- 041 v2 (registered overlay) rides on stage 1 + `set_object_transform`; the deviation
  heatmap (shipped in 041 v1) works per-object once co-loading exists.
- Known risks and mitigations (framing across mismatched scales, disposal leaks,
  render-mode/opacity interaction, bake-vs-placement collision, observation-command
  scope) are documented in 041; they apply unchanged.
- Standalone/agent bundle: co-display works everywhere; registration still requires the
  backend (documented limitation).
