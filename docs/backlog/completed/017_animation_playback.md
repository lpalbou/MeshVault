# 017 — Animation Playback UI for GLB/FBX

**Priority**: Medium
**Effort**: Medium
**Category**: Feature / Viewer
**Status**: Completed
**Created**: 2026-07-05

## Summary

GLB/FBX animations are auto-played via `AnimationMixer` but there is no user control: no
play/pause, no clip selector, no scrub timeline, no speed. Animated-asset review is a common
task and every serious glTF viewer (Don McCurdy's, Sketchfab, Babylon sandbox) exposes it.

## Reason

- Code review: animations auto-play with no UI (`viewer_3d.js` GLTF/FBX load paths use
  `AnimationMixer`).
- UX review: technical-artist persona flagged missing animation controls.

## Sketch of scope

- Detect available `AnimationClip`s; show a dropdown when >0.
- Transport controls: play/pause, loop toggle, speed, and a scrub slider bound to mixer time.
- Show current frame/time. Handle models with no animations gracefully (hide the panel).

## Dependencies

- None hard; pairs well with the viewer refactor (`022`).


---

## Completion

**Status**: Completed · **Completed**: 2026-07-05

Centralized `_setupAnimations` (single mixer per model) + transport bar (play/pause/scrub/speed/clip select) that auto-hides for non-animated models. `frontend/js/viewer_3d.js`, `app.js`.
