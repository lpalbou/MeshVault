# The abstract3d → MeshVault pipeline (agent recipe)

Text prompt → generated 3D object → inspected, repaired, adaptively optimized,
articulated, animated, exported as an animated GLB — using the 13 MeshVault
MCP tools. This is the agent-driven version of `examples/t23d_pipeline.py`
(the scripted, library-shaped variant); one documented run of the chain lives
in `examples/t23d_pipeline_report.md`.

**Prerequisites**: `pip install "meshvault[mcp]"` + `playwright install
chromium`; the `meshvault` MCP server configured in your client (no running
app needed). For generation: the `abstract3d` CLI in its own environment.

**The governing rule**: every stage ALWAYS inspects (cheap numbers) and
CONDITIONALLY mutates. Decisions come from tool returns — never from knowing
the asset. A clean input yields honest no-ops with evidence. Record
`{numbers_before, decision, action, numbers_after}` per stage; that record is
the deliverable, screenshots only illustrate it.

**Screenshot discipline**: numbers before pixels. Proof renders at ≤384 px
with `ssao:false`; `preset:"studio"` once for comparability; ONE
`screenshot {times:[...]}` contact sheet for motion instead of frame-by-frame
captures.

---

## Stage 0 — generate (abstract3d, outside MeshVault)

```bash
abstract3d t23d "<prompt>" --output-dir <run>/bundle \
  --backend abstract3d:triposr --device mps --format glb
```

- **Resource negotiation** (same machine): check for a running abstract3d GPU
  job first (`pgrep -fl "abstract3d|harness.py|hy3dgen"` — the broader
  `"harness"` pattern false-positives on shell wrappers). If busy: reuse an
  existing bundle or wait. Never launch heavy backends (hunyuan3d21/step1x) as
  part of this recipe; TripoSR is the validated light lane. Note the composed
  image stage (abstractvision/mlx-gen) also uses the GPU briefly.
- **Contract**: the bundle directory contains `scene.glb` + `metadata.json` —
  record `topology.is_watertight`, face counts, and `postprocess_warnings`
  from it (there is no `quality_verdict` key).
- **Prompt class**: object-centric, ONE subject (abstract3d constraint).
  Prompts with a plane-cuttable hinge line (chest lid, lamp arm, truck bed)
  make the articulation stage meaningful.

## Stage 1 — intake (never mutates)

```
load_model {source: "<abs path>/scene.glb"}       → over MCP this ALSO returns
                                                    the describe_scene report;
                                                    on the raw control surface
                                                    call describe_scene yourself
viewer_execute {action:"get_mesh_stats"}
screenshot {preset:"studio", width:384, height:384, ssao:false}
```

Record: triangles, meshCount, openEdges, degenerate, issues list, bounds.
`get_mesh_stats` self-skips above 300k triangles (`skipped:true`) — the
response is: survey with `inspect_region {grid:4}`, simplify (stage 3), then
re-run stats.

## Stage 2 — repair

`viewer_execute {action:"fix_mesh"}` — always run (default ops are cheap and
safe: degenerate-triangle drop + normal recompute). The returned
`issues {openEdges/degenerate: {before, after}}` deltas ARE the verdict —
zeros are the no-op proof, not a failure. Expected on TripoSR output: near
no-op (its `cleanup=presentation` already repaired). `openEdges > 0` is
*recorded, not fixed* — MeshVault has no hole-capping; say so in the record.

## Stage 3 — adaptive optimize

```
viewer_execute {action:"inspect_region", params:{grid:4}}
```

Mutate only when **all** gates pass (ratios/parameters, not asset constants):

| Gate | Default | Rationale |
|------|---------|-----------|
| triangles > budget | 150k | web-delivery class; a parameter, not a truth |
| ≥1 cell density ≥ 2× scene median | 2.0× | dense relative to itself |
| that cell's dihedralMeanDeg < 20° | 20° | flat = detail unjustified by curvature |

Then per qualifying cell (top ≤3, they arrive opportunity-sorted):
`viewer_execute {action:"simplify_region", params:{center, radius, ratio:0.4}}`
— read `achievedRatio` (seam-dense regions legitimately underachieve).

**The uniform-density branch**: marching-cubes outputs are uniformly dense, so
the RELATIVE gate finds nothing on them *by design* (every cell ≈ the median —
no region is more justified to decimate than another). Over budget + uniform =
GLOBAL `simplify {ratio: budget/triangles}`, not regional surgery. Only
differentially dense assets (photogrammetry seams, subdivision islands) take
the `simplify_region` path. Already-lean assets exit with the survey table as
no-op evidence.

**Verify by chamfer BEFORE articulation** (ordering trap: `compare_models`
refuses composed scenes): `sample_points {count:4096, seed:7}` before and
after, or `compare_models` against the pristine file while the scene is still
single-object.

## Stage 4 — texture (inspection-first)

```
viewer_execute {action:"inspect_texture"}
viewer_execute {action:"get_uv_islands"}
```

Record resolution, texel-density percentiles, island count (TripoSR
baked_basecolor is typically 2048² and heavily fragmented). Mutate ONLY
against a visually identified defect: fragmented atlas → `project_paint` /
`mirror_paint` (bilateral objects) / `clone_paint`, under `preset:"neutral"`
(shading bakes into copied texels otherwise). No defect seen = no-op with the
numbers recorded.

## Stage 5 — articulate

```
viewer_execute {action:"detect_parts"}
```

- **Parts found** (≥2, second ≥5% of triangles): `split_object {parts:[...],
  partitionId}` — partitionId is the staleness handshake.
- **One fused component** (the TripoSR norm — expected, not a failure):
  plane cut. THE judgment point: read the hinge line off a screenshot + `pick`.
  Pick usage: coordinates are NORMALIZED 0..1 with a TOP-LEFT origin, read off
  a screenshot whose `width`/`height` you pass along (aspect correction —
  without it edge picks land off-target). Probe the seam at 2-3 points along
  the front (e.g. the shadow groove under a lid's rim); the class prior
  "just below mid-height" is a starting guess, not a measurement — the
  evidence run measured the chest seam at 43% where the naive default said
  62%. Then `split_object {axis:"y", at:<world>, side:"+"}`.
  Cut faces are HOLLOW (documented) — keep sweeps ≤30° and orient cuts away
  from the hero camera.
- Then: `set_pivot {id:<part>, point:<suggestedPivot or hinge edge>}` →
  verify separation → `set_parent {id:<part>, parent_id:<base>}` (in that
  order — see next point).
- Verify separation numerically BEFORE `set_parent`: `explode_view
  {factor:1.6}` → `minGapWorld` (< 0 = parts still interpenetrate) →
  `explode_view {factor:0}` restores. On an already-parented pair the child
  is measured against the parent that carries it — unparent first (or verify
  before parenting, which is why the order above matters).
- **Traps**: the NEW part becomes ACTIVE after split (brushes now hit it —
  `set_active_object` back if needed); split parts are volatile in `.mvscene`
  (persist via `export_model` only).

## Stage 6 — animate

Part sweep (when split succeeded), amplitude ≤30° (hollow faces):

```
set_keyframe {id:<part>, time:0,   rotation:[0,0,0],   easing:"ease_in_out"}
set_keyframe {id:<part>, time:1.2, rotation:[-25,0,0], easing:"ease_in_out"}
set_keyframe {id:<part>, time:2.4, rotation:[0,0,0]}
```

Base turntable — **the 360° trap**: quaternions cannot encode full turns;
`rotation:[0,360,0]` collapses to identity silently. Key waypoints ≤120°
apart: 0/90/180/270/360. Then `set_timeline {duration:4}`.

Preview in ONE call: `screenshot {times:[0,1,2,3,4]}` (motion contact sheet,
auto-framed to the swept volume). Empty timeline + `times` errors — key first.

## Stage 7 — export + verify (LAST — reload replaces the scene)

```
export_model {path:"<out>/final_animated.glb"}    (animation auto-included)
load_model {source:"<out>/final_animated.glb"}    ← destroys the working scene
```

Verify on the reload: `get_state().animation.clips` length ≥1, triangle count
conserved. The reloaded clip AUTOPLAYS and is an IMPORTED animation — the
authoring timeline is empty, so `seek_timeline` does not drive it. For a
deterministic verification render: `pause_animation`, then
`set_animation_time {seconds:<t>}`, then screenshot. Object ids do NOT
survive the round-trip — verify by state, never by id.

---

## Trap list (all field-verified)

1. `load_model` without `add:true` REPLACES a composed scene.
2. `compare_models` refuses composed scenes — chamfer checks go BEFORE stage 5.
3. Post-split, the NEW part is active.
4. 360° keyframes collapse to identity; keep arcs ≤120°.
5. Cut faces are hollow; sweeps ≤30° or cut away from camera.
6. Split parts don't persist in `.mvscene`; `export_model` is the persistence path.
7. `get_mesh_stats`/QA self-skip above 300k triangles — simplify, then re-check.
8. `set_lighting` is visually subdued while IBL is on; presets pin everything.
9. Don't fetch `llms-full.txt` mid-run (~8.5k tokens); this recipe + 
   `list_viewer_commands` (once, if needed) suffice. On the raw `window.mv`
   surface the same discovery action is named `list_commands`.
10. GPU is shared with abstract3d — negotiate before generating (stage 0).
11. `explode_view` verdicts are only meaningful on UNPARENTED objects —
    separation checks go before `set_parent` (stage 5 ordering).
12. Reloaded exports autoplay an IMPORTED clip: verify via `pause_animation`
    + `set_animation_time {seconds}`, not `seek_timeline` (stage 7).
