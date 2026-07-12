# 0054 — Human UI for the agent tools (sculpt / paint / keyframe)

- **State**: completed
- **Created**: 2026-07-11
- **Completed**: 2026-07-12 (v0.8.0)

## Completion

Shipped `frontend/js/edit_panel.js` (tabbed Sculpt|Paint panel + tool
controller), the rewritten `timeline_panel.js` (keyframe authoring: ● button,
exact-time ticks with per-object delete menus, clamped duration, bar
stacking), and ONE `ViewerControlAPI` instance in the app — every mutation
routes through the exact commands agents use, so the E2E suites remain the
single behavioral truth. 3 adversarial cycles.

- **Design review shaped the architecture**: `viewer._toolMode` shared-flag
  arbitration (event propagation can't arbitrate across mouse- and
  pointer-event consumers); OrbitControls stays enabled and is disabled AFTER
  a synchronous active-object hit test (verified against the vendored source:
  rotation re-checks `enabled` per pointermove — misses orbit for free);
  pointer capture on the CANVAS; ≥16-points-or-100 ms flush cadence (never
  per-frame: normals recompute per command); hover via a local raycaster
  (`execute()` invalidates and would defeat demand rendering); per-gesture
  sculpt undo (the review called reset-as-only-undo a data-loss design).
- **Field gauntlet** (trusted pointer events, 80 screenshots): 9/10
  arbitration cells held; 9 bugs found, all fixed: `setNavMode` now owns
  `navmodechange` both directions (painting-while-flying + stale nav icon);
  edit panel docks top-left (sharing the lights anchor buried whichever
  opened second — and inside the toolbar it covered the button column);
  gesture-end feedback runs unconditionally; `undo_group` token makes a
  gesture ONE undo unit and ONE opacity unit (engine-side, public param —
  the per-texel gesture ledger stops slow strokes compounding 0.05 → ~0.44);
  Invert (dent) toggle + Alt-drag (carving was impossible); first key
  auto-sets a 5 s duration (the scrub thumb was a lying control); footer
  stats follow the active object; ring hides over the panel.
- **Also fixed en route**: the viewer placeholder ate every pointer event
  when objects arrived via the control API (registry `objectschange` now
  owns that chrome).
- **Final audit**: 6/6 checks PASS with measured numbers (FPV exclusion,
  0 px² panel overlap, dent −0.02 wu, gesture alpha 0.295 vs requested 0.3
  with the 4-gesture compounding control at ~0.76, whole-gesture undo,
  auto-duration). SHIP.
- Regression net: 20-check UI smoke + 9 cycle-2 regressions + 3 engine
  ledger checks.

Deferred (documented): grab brush (needs drag-vector mapping), multi-step
undo history, draggable panels (the panel still overlays ~19% of canvas
width — strokes under it are swallowed; audit UX note), pressure/touch.
Audit notes carried: `painted:true` after a full undo (layers exist,
transparent — matches documented semantics), ● keys placement only while an
imported clip plays (hint added to the toast).
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
