# 0046 — Articulation, keyframe animation, adaptive repair & texture LoD

- **State**: completed (2026-07-11, v0.7.0, with 045)
- **Origin**: user mandate 2026-07-11 — five tracks: (i) agent scene composition
  (move/scale/reorient multiple objects), (ii) mesh+texture inspection & repair
  with ADAPTIVE resolution by agent judgment, (iii) texture LoD tiers
  (512/1024/2048/4096), (iv) sub-part identification/separation for articulated
  meshes (F-14 wings, robot arm, portrait face), (v) keyframe animation with a
  proper timeline. abstract3d outputs (t23d/i23d GLBs) as articulation inputs.
- **Method**: 3 adversarial design reviews (A: articulation/animation engine
  architecture; B: regional decimation + texture repair; C: agent workflow +
  cycle briefs), then 3 live agent gauntlets, each cycle fixing every track.

## What shipped (agent-facing)

- **(i) Composition**: `list_objects` world `bounds`, `clone_object` (deep
  geometry + cloned paint canvases), `ground_object`, `place_object`
  (world-axis face-to-face with gap/align/offset), `look_at` (returns quaternion
  AND Euler for keyframing), terse returns, wrong-active-object brush hints.
- **(ii) Repair**: `inspect_region` (probe + opportunity-sorted grid),
  `simplify_region` (boundary-locked constrained collapse; ring + seam welds
  locked; achievedRatio honesty; 50k-vertex cap), `fix_mesh` (degenerate/
  normals default, per-mesh flip opt-in, issue deltas), `inspect_texture`
  (area-weighted texel density + worst spots), `blur_paint` (masked Gaussian),
  `clone_paint` (world-space heal with 45° normal guard).
- **(iii) LoD**: texture tiers low/medium/high/xhigh via validator aliases,
  4096 max, 32M-texel budget (mipmaps off ≥2048), `resize_texture` for paint
  layers, `export_glb {texture_size}` for authored textures (non-destructive).
- **(iv) Articulation**: `detect_parts` (mesh → groups → welded components,
  honesty notes), `split_object` (partId+partitionId handshake, plane cuts,
  hollow-face disclosure, suggestedPivot at cut centroid, painted-material
  deep-copies), `set_pivot` (mathematical composition into wrapper TRS —
  sub-group design rejected: corrupts bakes), `set_parent` (world-preserving,
  cycle/non-uniform-scale refusal, parent-relative transforms with dual
  local+world returns), child re-parenting on removal.
- **(v) Animation**: scene timeline with `set_keyframe` (explicit/capture,
  channels filter, 5 easings), delete/get/clear/set/play/pause/seek; hand-rolled
  interpolator (deterministic seek→screenshot; per-key easing); logical-TRS keys
  (pivot arcs correct); short-arc AND 360°-identity teaching; basePlacement
  restore; edit refusal during playback; timeline UI bar; MCP motion contact
  sheet (`screenshot {times}` — auto-framed to the swept volume); animated GLB
  export (`export_model`, TRS nodes + node-relative baking + channel
  verification); manifest v2 (hierarchy/pivots/timeline, index refs, bounded).

## Resource negotiation (abstract3d)

abstract3d was mid-generation (hunyuan3d21 t23d on MPS) throughout — no new
generation jobs were launched; four finished bundles were staged from
/tmp/finals into ~/MeshVault_assets/abstract3d/ (starship, chair, sportscar,
portrait) and used as the generated-mesh gauntlet inputs.

## Cycle findings → fixes

1. **T1 (robot arm, 18 calls, zero failures)**: timeline survived scene replace
   with dangling tracks (FIXED: cleared in `_clearAllObjects`); capture keyed
   all channels (FIXED: `channels` filter); contact sheet could lose the subject
   (FIXED: auto-framed to the swept volume).
2. **T2 (starship 120k→88k + wing sweep; sportscar wheels; fender heal)**:
   full-turn keys silently collapsed to identity (FIXED: requested-angle
   tracking + warnings + get_timeline shows requested angles); `openEdges`
   meant three different things (FIXED: one welded whole-mesh definition
   everywhere); post-split active-object trap (FIXED: miss errors name the
   object the point sits on); `views` preset rendered inside the mesh (FIXED:
   scene-scoped framing); boilerplate reset-baseline note (FIXED: conditional);
   blur_paint lacked meanAlpha (FIXED).
3. **T3 (portrait gauntlet, 53 calls)**: all cycle-2 fixes validated PASS live;
   full pipeline completed (repair meanAlpha 0.678/0.696, 21.6% adaptive
   reduction with no visible change, neck articulation with raycast-probed
   pivot, 2.5 s eased nod, export→reload exact, handoff deep link). Verdict:
   PRODUCTION-READY, one silent-corruption path named — simplify_region after
   split_object cracked the cut rim (cost-deterrent ≠ lock). FIXED: open rims
   (global welded edge count 1) are now hard locks like seams; verified rim
   edge count bit-identical across a straddling decimation
   (locked.borders reported).

## Verification

- Browser suites: 35/35 (articulation/timeline/repair) + 33/33 (sculpt/paint
  regressions), rerun after every cycle.
- Backend: 105 passed, 1 skipped (scene-API tests extended with hostile-v2
  cases: timeline floods, bad channel names, self-parenting, malformed pivots).
- Live MCP: 12 tools; export→reload round-trip confirms clips; contact sheet
  verified visually.

## Deferred (deliberate, from the adversary lists)

- Morph targets / blend shapes / lip sync (v2 bridge: sculpt the pose, diff
  against the reset snapshot, capture as morph target).
- Cut-face capping (invents UVs), per-face flipped-normal repair (winding
  propagation), seam-aware interior decimation (wedge-UV quadrics), `feather`
  on simplify_region.
- GPU readback of compressed textures for repair (v1 refuses with the reason).
- Keyable pivots, easing beyond the 5 presets, multi-clip timelines, IK.
- Paint persistence in .mvscene (sidecar PNGs remain the v2 design).
