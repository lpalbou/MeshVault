# 0045 — AI dynamic sculpting, texture painting & performance diet

- **State**: completed (2026-07-11, v0.7.0)
- **Origin**: user mandate 2026-07-09 — "(a) speed and resource optimization; (b) AI
  dynamic sculpting: painting capabilities + 3D primitives so agents can sculpt and
  paint them, all controllable through MCP. Key goal: let agents observe, manipulate,
  repair, transform and CREATE 3D objects."
- **Method**: 3 adversarial design reviews (performance; sculpt/paint architecture;
  agent-API ergonomics) BEFORE/into implementation, then 3 live artist-agent cycles
  over a real MCP session — each cycle's friction report drove the next fix batch.

## What shipped

### Creation surface (control API commands, all agent-reachable via `viewer_execute`)

- `add_primitive` — box/sphere/cylinder/cone/torus/plane/capsule; sculpt-tuned segment
  defaults; non-overlapping paint-safe UV atlases (box 3×2 faces, cylinder/cone side
  band + cap islands — stock three.js UVs overlap ALL faces on [0,1]²); exact colors
  (`_fixDarkColor` bypass via `userData._mvKeepColor`); per-kind param whitelist
  (typos are errors); 256 seg/axis + 250k vertex caps; persists in `.mvscene` by
  parameters; manifest loaders rebuild through the same command (single validator) and
  `validate_manifest` bounds params server-side (segment-bomb defense).
- `sculpt` / `sculpt_stroke` (≤64 stamps) — draw/inflate/smooth/flatten/pinch/grab;
  world-space falloff (smooth/linear/sharp); welded canonical positions (seam-safe);
  shared-geometry dedup (glTF instancing); `radius` or `radius_rel` (bounding-sphere
  fraction); quantified returns `{affected, maxDisplacement, newSize}`; teaching
  errors on missed brushes; normals/bounds/stats finalized once per command; refuses
  skinned models; `reset` restores (lazy accessor-decoded snapshots).
- `paint` / `paint_stroke` / `fill_paint` / `clear_paint` — CanvasTexture layers over
  the existing texture (flipY-aware) or authored base color; triangle rasterization
  in UV space with per-texel world-space falloff; per-call MAX-alpha accumulation
  (painter opacity semantics — no plaid/double-blend); sRGB-correct blending;
  `meanAlpha` honesty metric + near-invisible warning; `shape:"square"` tangent-plane
  quads; `max_normal_angle` hard-edge clamping; clone-on-first-paint for shared
  materials; material-array refusal; ~16M-texel session budget (returned on
  disposal); `describe_scene` materials carry `painted:true`; `list_objects` carries
  `painted`/`modified` flags.
- `pick {x,y,width,height}` / `raycast {origin,direction}` — screenshot/world → surface
  point `{point, normal, objectId}`; pick aspect-corrects against the SCREENSHOT's
  dimensions (1024² vs the 4:3 live canvas mis-aimed ~15% at edges).
- `batch {commands ≤32, continue_on_error}` — one round-trip for stamp sequences; no
  nesting.
- Camera: `orbit`/`set_view` gained `scope:"scene"` (whole-tableau framing from any
  angle); `set_active_object` returns terse `{activeObjectId}`.
- Persistence honesty: `.mvscene` stores sources+placements, not deltas —
  `getSceneManifest` reports `unsavedPaint`/`unsavedEdits`, `save_scene` (MCP) warns
  and points at GLB export (which bakes sculpted geometry AND painted textures).
- MCP `screenshot` gained `ssao:false` (cheap proof renders) and hand-eye loop
  guidance in its docstring.

### Performance / resource diet

- **Demand-driven rendering**: rAF loop renders only on `_renderRequested`
  (input/damping/animation/FPV/invalidate) and parks after ~45 idle frames. Measured
  0.0% CPU (whole browser process tree) at idle vs a continuous 60 fps loop.
  Invalidation is centralized in the control API (every successful command) plus
  ~25 direct viewer hooks; captures invalidate after restore; shadow maps
  `autoUpdate=false`.
- **Idle browser shutdown** (screenshot service): Chromium closes after
  `MESHVAULT_SCREENSHOT_IDLE_CLOSE` (300 s default), restarts transparently;
  unload-after-response frees model memory while warm. MCP session: NO idle-close
  (stateful).
- **Lazy reset snapshots** (`_ensureResetSnapshot` at every mutation entry point:
  bakes, setModelScale, sculpt): unmodified models never pay the geometry duplicate;
  geometry-replacing ops DROP the snapshot (new baseline).
- **Accessor-decoded snapshots** (correctness + the pre-existing quantized-bake-reset
  corruption): snapshot via getX/getY/getZ, restore via setXYZ, shared geometries
  restored once.
- **Leak fixes**: janitor timer captures entry id (not the model); `_computeStats`
  nested numeric maps (no per-vertex strings); paint budget released on disposal;
  resting headless viewport 1024×768.

## Adversarial review outcomes

- **Perf adversary**: validated demand rendering as the dominant win; killed the
  Chromium flag-diet ideas (no-ops/hazards); flagged the MCP idle-close hazard, the
  janitor closure pin, and the stats string-Sets — all implemented.
- **Architecture adversary** (10 failure modes): reset corruption (quantized/
  interleaved), shared-geometry double-displacement, pick aspect, seam tearing,
  fill_paint memory bomb, primitive color lies, paint V-flip, box UV overlap,
  crafted-manifest segment bombs, per-stamp finalize cost — all implemented; deferred
  per its list: symmetry param (frame ambiguity), per-op undo (reset semantics
  documented), UV generation for STL/PLY, paint persistence in manifests (loud
  warning instead), multi-material paint (clear refusal), Taubin smoothing.
- **Agent-API adversary**: pick image-dimension correction, quantified mutation
  returns, teaching errors, batch, radius_rel, flat-params concern resolved via
  handler whitelisting, proof-render tier, export_glb positioned as the save path.

## Artist-agent validation cycles (real MCP session via HTTP bridge)

1. **T1 (desert planet + moon)**: created successfully; found invisible-soft-paint
   (opacity×falloff collapse reported as success) and the plaid/moiré overlap
   artifact; asked for scene-scoped orbit. → Fixes: `meanAlpha` + warning, per-call
   max-alpha accumulation, `scope:"scene"`, terse `set_active_object`.
2. **T2 (chess pawn on checkered plinth)**: validated both fixes PASS (meanAlpha
   0.032 + warning / 0.606 no warning; overlap band uniform); found square-pattern
   pain (36 round stamps per checker cell), hard-edge paint bleed, verbose batch
   payloads. → Fixes: `shape:"square"`, `max_normal_angle`, painted/modified flags;
   plus the sRGB blending bug caught by the regression harness while validating.
3. **T3 (snowman gauntlet)**: all four cycle-3 fixes validated PASS with matched
   controls (edge clamp: 10,472 clamped vs 20,354 unclamped texels — identical
   top-face footprints); built the full snowman in ~27 calls with two render-driven
   corrections. **Verdict: production-ready.** Its two asks were implemented as the
   closing polish: parametric stroke paths (`path: {type:"circle"|"line"}` on both
   strokes, server-side auto-spacing — eliminates external circle math AND the
   under-sampling scalloping trap) and the `sculpted` audit flag (paint no longer
   dilutes the geometry-edit signal; `modified` stays the export-dirty union;
   `clear_paint` on a never-sculpted object clears `modified`).

## Verification

- Browser smoke harness: 33/33 (primitives, whitelist, sculpt tools, reset,
  radius_rel, batch, teaching errors, UV-atlas isolation, meanAlpha, plaid
  regression, square+clamp isolation, sRGB fidelity, painted/sculpted/modified
  flags, parametric circle/line paths, pick/raycast, manifest metadata).
- Backend: 105 passed, 1 skipped (unchanged suite — no backend regressions).
- Perf: idle CPU 0.0% (loop parked, measured over 6 s across the process tree);
  lazy snapshot verified (absent before first mutation, present after).

## Deferred (recorded, deliberate)

- Sculpt `symmetry` (mirror-frame semantics unresolved for placed objects).
- Paint persistence in `.mvscene` (sidecar PNGs are the v2 design; loud warnings ship).
- Multi-material (array) mesh painting; KHR_texture_transform rotation; KTX2 base
  decode; Taubin volume-preserving smoothing; per-op undo; STL/PLY UV unwrapping.
