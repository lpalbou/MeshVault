# 0054 — Human UI for the agent tools (sculpt / paint / keyframe)

- **State**: planned
- **Created**: 2026-07-11
- **Origin**: user-confirmed direction (2026-07-11): "sculpt/paint/keyframe
  authoring is currently agent-only; even minimal brush and keyframe buttons
  would make the app a real editor for people, not just a review surface."

## Context

The entire editing engine is UI-agnostic by construction (control-API commands
over viewer methods) — the human UI is a THIN new caller, not new capability.
The timeline bar (046) already proved the pattern: panel → same commands →
same state. Long-term context: these authoring surfaces are candidates for
integration into blackpixel, so the panels should stay thin and the command
layer authoritative.

## Scope (deliberately minimal v0)

1. **Sculpt panel**: tool picker (draw/inflate/smooth/flatten/pinch/grab),
   radius + strength sliders, falloff select. Pointer drag on the model =
   `pick` per pointermove → `sculpt` stamps (the parametric-stroke spacing
   logic already exists server-side; reuse it for stamp thinning). Esc/toggle
   returns to orbit mode — mode exclusivity with OrbitControls is THE design
   risk; prototype the input arbitration first.
2. **Paint panel**: color swatch + radius/strength/hardness + texture-size
   tier select; same pointer flow driving `paint`; `clear_paint` button;
   painted-layer indicator per object (data exists in list_objects).
3. **Keyframe bar extension**: "key" button keys the ACTIVE object's TRS at
   the playhead (`set_keyframe {capture:true}`); tick context menu → delete
   key; duration field; easing select on the last-added key.
4. **Undo**: single-step per-panel undo is acceptable for v0 (sculpt already
   has reset; paint has clear_paint; keyframe has delete_keyframe) — a real
   history stack is explicitly out of scope.

## Non-goals (v0)

Splitting/parenting UI (scene panel context menu already covers pivots via
gizmo), UV/repair tooling for humans, multi-touch, pressure curves.

## Acceptance

- A human (no DevTools) sculpts a bump, paints a mark, keys a two-pose
  animation, plays it, saves the scene, exports the GLB — all from panels.
  Agent parity regression: the E2E suites (0048) stay green, proving the UI
  added no behavioral fork.
