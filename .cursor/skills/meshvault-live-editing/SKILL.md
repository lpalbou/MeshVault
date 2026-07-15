---
name: meshvault-live-editing
description: >-
  Drive MeshVault over MCP to sculpt, paint, repair and reshape 3D objects,
  optionally performing live for human observers (observation seat). Use when
  an agent must edit meshes through the meshvault-mcp tools: sculpting brushes,
  texture painting/healing, refine/regularize/simplify regions, raycast-probe
  targeting, or staging a watchable live editing session.
---

# MeshVault Live Editing (agent over MCP)

Field-tested recipe for editing 3D objects through MeshVault's control
surface. Distilled from live sessions (tattoo painting, haircut resculpts on a
120k-face photogrammetry portrait, primitive-assembly character and vehicle
builds). Complements `examples/t23d_pipeline.md` (the generate → export
chain); this skill is about the interactive editing loop itself.

## Golden rules

1. **Never guess coordinates.** Every brush lands at world coords you must
   earn: `pick {x, y}` from a screenshot, `raycast {origin, direction}`, or
   `inspect_region`. A miss names the object actually hit — read the error.
0. **Never repeat a failing call verbatim.** An error is a verdict, not a
   flake: the same action + params returns the same error forever. Change the
   action or the params (the message usually names the fix), or report the
   blocker. A local pilot burned 60 steps ping-ponging two invented actions;
   colors are CSS hex STRINGS ("#ff0000"), never [1,0,0] arrays.
2. **Look after every meaningful mutation — with your eyes if you have
   them.** `screenshot` after each phase, not each stamp. If you are a
   vision model, actually LOOKING at the render is the highest-value action
   in this entire skill: judge shape, proportions, and paint contrast
   concretely, name what is wrong, fix, re-shoot. Multi-view
   `views:["front","top","iso"]` judges proportions like an artist turning
   the easel. Text-only agents must lean on quantified results instead —
   and should say so honestly in their report. A blind run declared a white
   blob "the Millennium Falcon, complete" (field lesson); eleven takes of
   looking made a portrait.
   - **Screenshot economics (measured)**: cost is SYNC-bound, not
     pixel-bound — 192² and 1024² take the same 0.6-5 s steady-state, but
     every NEW capture size pays a 2.4-28 s one-time warm. Pick ONE size
     per session (512² is the sweet spot: cheap tokens, enough to judge)
     and keep it. `ssao:false` does NOT make renders faster (measured;
     ignore older guidance) — its value is only the look. Between shots,
     verify with quantified reads (get_bounds, list_objects, painted/
     meanAlpha — 20-60 ms) instead of pixels.
   - **Batch your probes**: `batch {commands:[...]}` carries raycast and
     all reads — one 30-probe batch costs half the wall time of 30 calls
     through MCP (and probes are now BVH-accelerated engine-side: ~1 ms
     each even on 240k-triangle meshes). Probe-batch → compute → act-batch.
3. **Quantified results are the truth.** Trust `stretchedEdges`, `meanAlpha`,
   `painted`, `openEdges` deltas over your intention. If `meanAlpha` ≈ 0 the
   paint is invisible; if `painted` is tiny the brush missed.
4. **The sculpt loop is: probe → sculpt → regularize → paint.** Heavy grabs
   stretch facets into untexturable slivers — run `regularize_region` on the
   worked area before judging the shape or painting it.
5. **Announce destruction before you rely on it.** `refine_region`,
   `regularize_region`, `simplify_region`, `split_object` REPLACE geometry:
   the reset baseline moves and morphs drop loudly. Read the returned `note`.

## Session setup

- **The MCP server is the entry point**: spawn `meshvault-mcp` over stdio
  (any MCP client). The whole tool surface is: `load_model`, `describe_scene`,
  `viewer_execute {action, params}` (THE workhorse — every command below),
  `list_viewer_commands`, `get_state`, `screenshot`, `get_texture`,
  `export_model`, `save_scene`/`load_scene`, `compare_models`,
  `open_in_app`/`get_app_state`. Everything in this skill is reachable
  through these tools — verified by full MCP-client builds (X-Wing, Falcon).

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
server = StdioServerParameters(command="meshvault-mcp",
    env={**os.environ, "MESHVAULT_SESSION_LABEL": "LIVE: my build"})
async with stdio_client(server) as (r, w):
    async with ClientSession(r, w) as s:
        await s.initialize()
        await s.call_tool("viewer_execute", {"action": "add_primitive",
                          "params": {"kind": "sphere"}})
```

- Load with `load_model` / `add_primitive`, then ALWAYS `describe_scene` and
  `get_bounds` first — sizes drive every radius you will pick.
- Radii are world units. `radius_rel` (fraction of bounding sphere) is safer
  across differently sized models.
- App discovery (seat polling, REST endpoints): read
  `~/.meshvault/app_session.json` → `{url, token}`; send the token as
  `X-MeshVault-Token`. The MCP server does this automatically for its own
  publishing — you only need it for the observer-count etiquette below.

## Probe-based targeting (the core trick)

Features you cannot click, you find with ray grids. Pattern from the haircut
(find hair hanging below a hem line):

```python
hits = []
y = ymin + 0.06 * ysz
while y < y_hem:                        # scan a horizontal band
    for x in (-0.4, -0.2, 0.0, 0.2, 0.4):
        h = ray([x, y, -3], [0, 0, 1])  # from behind, toward the face
        if h and h[2] < neck_guard_z:   # GUARD: hair only, never skin
            hits.append(h)
    y += 0.09 * ysz
```

- Add up-rays from below for thin downward spikes; side rays for silhouettes.
- Always pair probes with a **guard plane** (e.g. `neck_guard_z`) so cleanup
  brushes cannot touch protected surfaces (skin, face).
- Convergence loop: re-probe after each batch, act on the worst few, stop
  when the detector returns empty or a pass cap hits.
- **Coarse detectors converge; fine detectors stall.** A 5-column scan fixed
  in 14 passes what an 11-column scan diluted across 26 (too many weak
  targets splits your strength). Scan coarse, sort by severity, act on ≤8.
- **The plateau rule (live-session lesson).** Track your progress metric
  every pass. If it has not improved in 3 passes, STOP repeating — switch
  tools or accept the result. A live run spent 4+ passes burying the same 17
  strands with zero progress; each ineffective grab still stretched facets,
  and the final regularize inherited 2400+ stretched edges it could no
  longer clean within budget.
- **Interleave regularize_region into long sculpt campaigns** (every ~30-50
  grabs), never save it for one pass at the end: stretch compounds, later
  brushes (flatten/smooth) re-stretch what was cleaned, and a late equalize
  can even measure WORSE than before it started.

## Sculpting SHAPES from stock (the shark playbook)

Organic forms come from ONE primitive + brushwork, not assembly. Validated
by sculpting a recognizable shark from a single capsule (fins, tail, mouth,
gills all brushed) — five takes distilled into these rules:

1. **Work like a sculptor: proportions → features → detail → paint.** Judge
   each stage from silhouette renders (`views:["left","front","top"]`)
   before moving on. The first take read as a beluga because the head stayed
   a capsule ball — one slimming pass fixed what no amount of fin detail
   could.
2. **Brush centers live ON the surface.** `pinch` at the medial axis touches
   nothing (its gather radius never reaches the skin). To TAPER a body:
   symmetric surface grabs pulling toward the axis — flanks with
   `symmetry:"x"`, top and bottom as separate pulls.
3. **`symmetry:"x"` on sculpt/sculpt_stroke/paint/paint_stroke** mirrors
   every stamp across the object's local plane: direction/pivot/axis are
   reflected, hinge angles negated, exactness guaranteed. Bilateral anatomy
   (fins, ears, eyes, gills) in half the calls with zero drift. Keep the
   DENSITY symmetric too: refine both sides (or one centered region) before
   a symmetric pull, or the mirrored stamp lands on coarser facets.
4. **Extrusions (fins, ears, limbs) = repeated soft pulls at descending
   radius, re-probing the crest between pulls.** Each pull MOVES the crest;
   sculpting the old coordinates sculpts air. Guard the re-probe (reject
   hits that jumped away). Refine the region first (target ≈ pull radius/8).
5. **Pull SOFT, then sharpen.** `falloff:"sharp"` pulls crumple thin
   membranes into accordion folds (dorsal-fin take 2). Pull with the default
   smooth falloff, then `pinch` (mirrored) to thin the blade, then a smooth
   stroke along the base to blend it into the body.
6. **Regularize the WHOLE body after proportion work** (default target, 2
   iterations), features after their own passes. Fine grooves (mouth, gill
   slits) still follow the groove recipe: refine to radius/3 → dig gently →
   re-probe before inking.
7. **Counter-shading paint**: spine stroke down the top, flank rows probed
   with SIDE rays at descending heights (top-down probes fall off the curve),
   `symmetry:"x"`, then `blur_paint` along the transition to melt banding
   into an airbrush gradient.
7b. **Parametric circle paths are PLANAR** — they ride the surface only
   where the surface still matches the circle. Dig/paint rings BEFORE doming
   or displacing the area (owl eye discs: rings dug after doming floated and
   missed); afterwards, build ring strokes from re-probed points instead.
8. **Analytic coordinates die at the first sculpt.** Any formula-derived
   surface point (sphere/ellipsoid math) is a lie once proportions were
   sculpted — a whole 70-stamp paint batch missed on the owl because the
   crown had been flattened 0.05 lower. After EVERY sculpt phase, re-probe
   before painting or digging: batch the raycasts (32 per call) so a full
   re-probe of 70 points costs two round trips. Order the build
   proportions → features → relief → paint so each phase probes once.

## Fusion: from assembly to ONE sculptable skin (merge_objects)

Primitives are the FIRST DRAFT, never the result. The advanced-sculpting
loop: assemble the draft → FUSE it → sculpt the fused skin → texture.

- `merge_objects {ids: [a, b, ...], mode?: "union", blend?: 0.05, name?}` —
  true CSG union: overlapping volumes fuse where they intersect, interior
  shells disappear, and the result is ONE welded surface where brushes,
  digs and refines work ACROSS the old part boundaries (separate objects
  can never blend at their joints — each mesh welds only to itself).
- **Overlap the parts deliberately** (10-20% embedment): union fuses
  VOLUMES; surfaces that merely kiss produce degenerate seams.
- **`blend` (world units) is the joint fillet**: seam vertices on the
  intersection curves get deterministic Laplacian rounding with smooth
  falloff — an organic neck/shoulder/wing-root in one parameter (≈ the
  fillet radius you want). Follow with a smooth stroke along the joint for
  extra softness, or `regularize_region` over the seam area before fine
  sculpting.
- **Union needs CLOSED sources** (open rims refuse with counts — fix_mesh
  or `mode:"concat"`, which concatenates + position-welds and never
  refuses, but keeps interior walls). Planes/shells → concat.
- Source paint/textures are DROPPED and UVs re-atlas per source (no paint
  cross-talk): texture AFTER fusion — which is the right order anyway.
- The fused object is a NEW id at identity placement; sources are gone;
  manifests can't rebuild it — `export_glb` persists. Budget: ≤400k
  combined source triangles.
- Order matters: get placements right FIRST (set_object_transform on the
  draft parts), because after fusion placement is baked.
- **NEVER run `fix_mesh {degenerate}` on a fused mesh**: CSG seams carry
  legitimate sliver triangles; dropping them OPENS the seam (field run:
  2006 triangles dropped, open edges 51 → 570 — the "repair" punched holes
  in finished work). Multi-part unions also keep ~50-90 trace open edges —
  that is normal and harmless (sculpt/dig/paint all tolerate it).
- **Refine budgets on freshly fused meshes run ~3× the formula** (the union
  output is coarse and conformality cascades dominate) — take the
  `nextPassNeeds` number from the refusal instead of guessing upward.

## Building FROM primitives (hard-surface and character assembly)

Composed models (a spaceship, a cartoon character) are ASSEMBLIES: one
primitive per part, placed with `transform` at creation. Lessons from the
Mickey and X-Wing builds:

- `add_primitive {kind, params, name, transform: {position, rotation, scale},
  frame: false}` places the part in one command. `frame: false` keeps the
  camera yours. NAME every part; keep an id map — `set_active_object` before
  every per-part fill/paint/sculpt (paint always lands on the ACTIVE object).
- **`set_object_transform`'s `scale` is a NUMBER (uniform); per-axis arrays
  go in `scale_xyz`.** An array passed to `scale` fails validation loudly —
  but the `transform` option of add_primitive routes through the viewer and
  takes either. Prefer placing at creation.
- Symmetric parts (4 wings, 4 engines, limb pairs): loop over sign products
  `for sx in (-1,1): for sy in (-1,1)` and derive positions/rotations from
  the signs. One code path = no left/right drift.
- **Raycast-probe every paint center on placed primitives** — never trust
  parametric math (sphere/cone formulas) after transforms: a scaled sphere
  is an ellipsoid, and a silently wrong assumed radius paints air ("Brush
  touched no surface"). Probe from outside toward the part, REQUIRE the hit
  object id to match the part you mean.
- Per-part texture tiers: 2048 for the hero part (head, fuselage), 1024 for
  mid parts, 256-512 for small trim. Fill each part's base coat at creation
  so later strokes need no layer setup.
- Detail passes that read at a distance: panel seams as `paint_stroke`
  `path:{type:"line"}`, low-opacity (0.12-0.2) `shape:"square"` plates for
  panel variation, weathering smudges at opacity ≈ 0.2 with hardness ≈ 0.3.
- **Brush centers on curved shells: compute the surface point analytically or
  probe it** — a stamp centered far off the surface ("Brush touched no
  surface") or a circle path floating above a dome paints NOTHING. For an
  ellipsoid saucer: y = cy + b·√(1−(x/a)²−(z/c)²); for everything else,
  raycast. Batches of 30 stamps with ~60% misses (Falcon take 1) all traced
  back to centers hovering off the hull.
- **Circle/line paths clamp at 64 samples**: a full 360° dig ring at fine
  spacing exceeds it and scallops into dotted craters; a LONG thin paint line
  (1.7 units at radius 0.006) renders as perforation dots for the same
  reason. Split rings into arc segments (`start_deg`/`sweep_deg`, e.g. 6 ×
  60°) and long lines into segments of length ≤ 60 × radius/2 each.
- **Trench walls need edges ≈ brush radius / 3 BEFORE digging** (refine the
  annulus/strip first, then dig gently — several shallow passes beat one
  clamp-depth stamp). Digging 0.022 facets with a 0.03 brush at clamp depth
  tears the shoulders into crumble that no amount of smoothing tidies.
- **Realism at flat-shaded scale is carried by PAINT MOSAIC + grime, not
  micro-geometry**: mismatched grey plates (5-8 tones, opacity 0.35-0.75),
  radial rust streaks, scorch blooms, one glow accent. Greebles help at rim
  scale; dig trenches read only if refined first (target ≈ radius/5).

## Grooves + inked lines (order matters)

- **Ink BEFORE dig** when a painted line must follow a groove (a smile, a
  panel line): paint the stroke on clean texels first, then dig along the
  same path — the paint rides the surface down. Digging first stretches the
  wall texels and the ink lands dotted ("teeth").
- **Refine BEFORE dig on coarse meshes**: `refine_region` to ≈ groove
  radius/5, then dig with remesh OFF. Digging coarse facets with
  `remesh:"auto"` leaves crumbly shoulders and texel drift that a re-fill
  cannot hide (it is shading, not texture).
- Prefer parametric `path {type:"line"|"circle"}` over hand-sampled point
  lists for BOTH paint_stroke and sculpt_stroke: server-side auto-spacing.
  Sparse explicit points render as dots/scallops; a circle path needs its
  center + axis + the SURFACE radius at that cross-section.

## Adaptive resolution (adjust density on the fly)

Mesh density is a budget you spend where the shape needs it. Three ops, one
loop:

1. **Survey**: `inspect_region {grid: 3}` maps density (triangles, edgeLength
   median/p95) across the object, sorted by simplification opportunity;
   `inspect_region {center, radius}` probes one spot.
2. **Densify before detail**: `refine_region {center, radius, target_edge}`
   with target ≈ brush radius / 5. React to `budgetHit` by re-issuing with the
   returned `nextPassNeeds`.
   - **Budget sanity BEFORE you refine**: triangles needed ≈
     `2.5 × π·r² / (0.43 × target_edge²)`. If that number is over ~20k,
     your radius or target is wrong for the feature — refine the BRUSH
     footprint (radius = stamp radius), not the neighborhood.
   - **Grade the density**: one fine ring is rarely needed everywhere.
     Nested rings — fine at the feature center, 2-3× coarser one radius
     out — sculpt identically at ~13% of the triangles (measured on
     identical fin pulls; the rim never carries brush-scale detail).
   - **A refusal quoting a huge `nextPassNeeds` is a diagnosis, not a
     dare.** If the error notes that marked edges dwarf the over-target
     ones, the MESH QUALITY (slivers) is forcing cascades: run
     `regularize_region` with an explicit `target_edge` over the area
     first, then refine. Never reflexively raise `max_triangles`.
   - **You should never need 100k triangles in one refine.** A fin, an
     eye socket, a groove — thousands, not hundreds of thousands. Counts
     beyond that mean the request shape is wrong (radius too big, target
     too fine, or sliver stock underneath).
3. **Equalize after deformation**: `regularize_region` is a FULL remesher —
   splits over-long edges, collapses needles (link-condition safe), flips
   edges toward valence 6, then relaxes. Read `stretchedEdges {before,
   after}` (after ≈ 0) and `valence567Share` (≥ 0.9 = regular graph). On
   mixed regions pass an explicit `target_edge` (a blended median lies).
4. **Coarsen what no longer earns its facets**: `simplify_region {center,
   radius, ratio}` (ratio = fraction kept); check `achievedRatio` — seam-dense
   regions decimate less and the result says why.

Sculpt results now carry an under-sampling advisory: if a stamp moved fewer
than ~6 vertices, the result `note` says the mesh is coarser than the brush
(a "success" that reads as a spike, not a shape) and names the refine
parameters. React to notes, not just errors.

## Material response (the realism lever paint alone cannot reach)

Albedo-only paint shades as matte clay. Surfaces read REAL through their
light response — paint it per texel:

- `paint`/`paint_stroke`/`fill_paint` with `channel:"roughness"` or
  `"metalness"` + `value: 0..1` (0 = polished/dielectric, 1 = rough/metal);
  `channel:"emissive"` + color (glows — engine exhausts, eyes, screens);
  `channel:"height"` + value (data layer for relief workflows).
- Recipes that carry: worn metal = fill metalness 1 + `paint_pattern
  {type:"grunge", channel:"roughness", value:0.2, value2:0.9}`; glazed
  ceramic/varnish = roughness 0.08 wash over the lit areas; oiled wood =
  roughness gradient 0.3→0.7 along the grain; scorch = albedo smudge PLUS
  roughness 0.9 (burnt = matte).
- roughness+metalness share ONE packed canvas (glTF native) — exports to
  GLB losslessly and reloads identically (round-trip verified). clear_paint
  restores the original material response.
- Verify gloss under `set_lighting {exposure ~1.0}` and a specular angle —
  flat presets can mute highlights and you'd paint roughness blind.

## Procedural patterns (one command, not 160 stamps)

`paint_pattern {type, seed, scale, ...}` fills the object (or a
`region:{center, radius}`) with a WORLD-SPACE pattern — continuous across
UV seams, scale-consistent, bit-deterministic per {seed, scale}:

- `noise` (fBm color blend) — mottle, camouflage, organic tone variation.
- `grunge` (ridged fBm + contrast) — wear streaks; best on `channel:
  "roughness"`.
- `cells` (Worley) — cracks, scales, dry earth.
- `speckle {density}` — dots, rivets-ish, stone grain.
- `stripes {direction, density}` / `gradient {direction}` — bands and ramps.
  ANTI-PATTERN (owl v3): stripes on ORGANIC surfaces — geometrically
  perfect world-space bands read mechanical on plumage/fur/skin. Organic
  banding wants hand `paint_stroke` paths with wobble (probe the surface,
  vary spacing); save stripes for hulls, decks, awnings.
- Combine: albedo noise + roughness grunge + a sparse speckle = a hull that
  reads weathered in three calls. `scale` = world units per feature
  (default object/12); same seed replays identically.

## Noise sculpting (micro-relief the brush domes cannot make)

`sculpt {tool:"noise", wavelength, octaves, seed, ridged, bias}` displaces
along weld normals by seeded fBm — feathers, bark, rock, fabric:

- `wavelength` = feature size in world units (default radius/2);
  `refine_region` the patch to ≈ wavelength/4 FIRST or the noise aliases.
- `octaves` 2-4 for natural surfaces; `ridged:true` for crests/bark;
  `bias`>0 grows more than it cuts (plumage), <0 pits (corrosion).
- Sampled at object-LOCAL coordinates: the pattern sticks to the object and
  repeated stamps re-evaluate the same field. Same seed = same relief.
- Pair with a matching `paint_pattern` at the same scale so color follows
  relief (noise albedo over noise geometry reads as one material).

## Region deformers (one call, not a grab salvo)

`deform_region {kind, axis: {from, to}, ...}` applies a closed-form
deformation along a spine — `from` is ANCHORED, the effect eases
(smoothstep) to full at `to`:

- `taper {factor}` — cross-sections scale to `factor` at the tip. A
  mandible/tail/limb taper is ONE call (the shark tail took 9 grabs and
  terraced). factor 0.35 = tip a third as wide.
- `bend {angle_deg, direction}` — progressive rotation about `direction`
  (must be perpendicular to the spine): curved necks, drooping wings.
- `twist {angle_deg}` — cross-sections rotate about the spine.
- `stretch {factor}` — elongate by a fraction (0.3 = 30% longer).
- Welded (seams never tear), deterministic, honest refusals (parallel bend
  axis, zero-touch). `regularize_region` after strong tapers/bends —
  compressed cross-sections need re-equalizing.

## Swept strokes (panel lines that don't bead)

`sculpt_sweep {points|path, radius, strength, profile}` computes ONE
distance-to-curve weight field — the cross-section is constant along the
path, so grooves and ridges come out clean where stamp chains scallop:

- `profile:"crease"` = sharp V center — THE panel-line profile. strength
  NEGATIVE cuts (panel lines, seams, mouth lines); positive raises (welts,
  cables, raised trim). `"round"` = soft dome; `"flat"` = plateau trench.
- Majority-side guard: welds facing away from the stroke's mean normal are
  skipped — a top-skin panel line won't groove the wing's bottom skin even
  when both are within radius. Force `direction:[x,y,z]` to override.
- `symmetry:"x"` sweeps the mirrored curve as a SEPARATE polyline (verified
  bit-symmetric crests). `remesh:"auto"` and meshQuality work like sculpt.
- Resolution rule unchanged: refine along the curve to ≈ radius/4 first, or
  the profile can't form (the result warns below ~4 verts/segment).
- **Line-campaign budget (x-wing v3 blowup: 225k → 1.48M triangles)**: the
  refine formula is per-REGION and a panel-line campaign multiplies it by
  every strip. Keep refine strips NARROW (strip radius ≈ 1.2× sweep radius,
  not 2-3×), refine ONE strip covering several parallel lines when they sit
  within a few radii, and CHECK the triangle count between lines
  (describe_scene). Recovery is brutal at scale: whole-model `simplify` on
  ~1.5M tris runs ~20 minutes with no progress output, and
  `simplify_region` refuses above its 50k-vertex cap — prevention is the
  only cheap path.
- Crease DEPTH must match viewing distance: ~0.2-0.5% of hull size reads
  at close range only; features meant to read in a full-body shot need
  ~1-2% (the owl's facial disc carried at 1.5%; its 0.4% wing arcs
  vanished). `bake_ao` roughly doubles perceived depth for free.
- Sweep beats a dig-stroke for LINES: dig makes craters (flat floor, per-
  stamp), sweep makes constant profiles (per-curve). Use dig for pockets.

## Cavity grounding (paint that sits IN the surface)

`bake_ao {strength, highlight, contrast}` darkens concavities and
optionally lightens convex rims, baked into the albedo:

- The single cheapest "painted-on → carved-in" fix: run it ONCE after
  sculpting is final (later sculpts won't move the shading).
- `strength 0.5-0.8` pools shadow/dirt in seams, folds, nostrils, panel
  lines; `highlight 0.2-0.4` = worn edges (metal, stone). `contrast` lower
  on soft organic curvature, higher to pick faint detail.
- Honest method note: Laplacian curvature (local crevices), NOT ray-traced
  occlusion — it won't shade one part's shadow onto another. Refuses when
  curvature is uniform (perfect sphere) instead of pretending.
- Order matters: albedo/patterns → bake_ao → roughness/metalness channels
  (AO multiplies albedo only). undo_paint reverts a bad bake.

## Height → normal baking (relief that costs no triangles)

Paint relief into the HEIGHT channel, then bake it to a normal map:

1. `paint`/`paint_pattern {channel:"height", value/value2}` — 0.5 = flat,
   above raises, below recesses. cells at height = hammered metal; noise =
   rough stone; stripes = corrugation; brush strokes = carved lines.
2. `bake_normals {strength}` (1 subtle, 3-5 pronounced) — Sobel-derives a
   tangent-space normal map, wired to the material and exported as a
   standard glTF normalMap. Re-run after further height painting.
3. Shading-only relief: survives simplify_region, costs zero triangles,
   reads at grazing light. Honest limit: height features crossing UV island
   borders can seam. For relief the SILHOUETTE must show, use real
   geometry (`tool:"noise"` sculpt) — bakes never change the outline.

## Texture resolution (choose per quality need)

- The layer size is fixed at creation: `fill_paint {color, texture_size}` —
  tiers low=512, medium=1024, high=2048, xhigh=4096.
- Pick the tier from the feature size: `inspect_texture` gives texel density
  (texels per world unit); a brush of radius r paints ~(r × density) texels —
  if that is under ~8 texels the stamp is a blur, go up a tier or paint wider.
- 512 for blockouts and flat fills, 1024 for general work, 2048 for close-up
  detail, 4096 only when a hero close-up demands it (memory: a 4096 RGBA
  layer is 64 MB; the scene texel budget refuses beyond 32M texels).

## Sculpting

- Tools: `draw`, `inflate`, `smooth`, `flatten`, `pinch`, `grab`, `hinge`,
  `dig`. `sculpt_stroke` takes a `path` (line/circle) with server-side spacing.
- **`dig` removes material** (crater/groove): fixed inward axis, flat plateau
  (`flat_fraction`, default 0.5) with a smooth shoulder; depth clamps per
  stamp to `(1−flat_fraction)×radius` (read `appliedDepth`, re-issue for
  deeper); a 13-ray probe REFUSES stamps that would pierce a thin shell and
  names the max safe strength — through-cuts are `split_object` territory.
  Prefer one stamp at the clamp over many repeats; tidy a rough rim with a
  smooth ring + `regularize_region`.
- **Dig STROKES scallop and compound** (Death Star trench lessons): a dig
  stroke is a chain of crater stamps — rims bead at stamp spacing (de-bead
  with smooth strokes along both shoulders), and overlapping stamps compound
  depth well past `strength`, so RE-PROBE the groove floor (raycast) before
  painting it — the surface you dug is not where it was. Grooves crossing an
  existing groove are safe (the piercing guard only counts true back-facing
  far walls).
- **Fine intentional grooves trip `needsRemesh` on every stroke** — that is
  the trigger seeing detail finer than the local median, not damage. It
  measures the region's STANDING state, so even smooth strokes passing over
  intentional detail re-flag it (28 benign advisories in one live build).
  Keep remesh OFF during a micro-detail pass, ignore advisories whose
  region you deliberately detailed, and run ONE `regularize_region` per
  worked band at the end; save `remesh:"auto"` for shape-changing pulls.
- **Every sculpt result carries `meshQuality`** ({outOfBandFraction,
  maxOverMedian, needsRemesh}) — the facet-degradation trigger. Pass
  `remesh: "auto"` to run the full remesher automatically when it fires
  (geometry is REPLACED: reset baseline moves; morphs suppress it loudly).
  Explicit `regularize_region` remains for manual control.
- `grab` displaces along `direction` — it moves surface, it cannot delete it.
  Pulling a curtain of geometry "away" only relocates it. To bury residue:
  pull toward the volume interior **with an upward bias**; downward or purely
  inward pulls re-bunch mass that pierces back out as spikes.
- Thin spikes: small radius (≈0.15 of the feature), `falloff: "sharp"`,
  moderate strength — big soft brushes smear instead of removing.
- "Brush touched no vertices" → the mesh is too coarse there:
  `refine_region {center, radius, detail_rel}` first (target ≈ brush
  radius / 5).
- After heavy displacement: `regularize_region {center, radius}` — check
  `stretchedEdges.before/after` reaches ≈ 0. On mixed-density regions pass an
  explicit `target_edge` (the region median lies when dense and stretched
  areas share the brush).
- **Honest limit:** reshaping a photogrammetry shell (hair, cloth) with
  displacement brushes has a ceiling. `dig` carves into thick volumes but
  REFUSES on thin shells (piercing guard); "cut off" needs geometry removal
  (`split_object` + delete part) — plan choreography around what each tool
  class can actually do.

## Verifying with pixels, not hope (portrait-repaint lessons)

When painting features onto a blanked model, measure — never guess:

1. Render the ORIGINAL first; pixel-analyze it for anchors (darkest clusters
   constrained to the inner face = pupils; reddest inner-face cluster =
   mouth; large-region medians = skin/hair tones). Gate detections with
   anthropometry (inter-pupil / face width ≈ 0.35–0.55) and RETRY with wider
   scans instead of proceeding on a failed gate.
2. Derive the palette from the model's own sampled tones, warmed toward a
   canonical skin anchor — dead-even color reads unnatural; warm shadows and
   subtle blush washes are what read as skin.
3. After each phase, render and VERIFY against the measurements (painted
   pupil positions, mouth centroid, cheek tone distance) and only continue on
   OK. A screen-fraction guess that drifts 0.05 puts eyes on temples.
4. Dark facial features pass any "dark = hair" test — fence eyes/mouth/chin
   geometrically before classifying hair pixels by chroma distance.

## Painting and texture healing

- Paint needs a layer: `fill_paint {color, texture_size}` on unpainted
  models; tiers low/medium/high/xhigh = 512/1024/2048/4096.
- **Blanking / repainting from scratch**: `fill_paint` floods the whole
  atlas with one color — it IS the eraser. Fill with a neutral base
  (`#b0b0b0` or a skin base tone) at the tier you intend to paint at, then
  rebuild the texture with paint/paint_stroke layers coarse-to-fine.
  `clear_paint` is the opposite move: it restores the ORIGINAL texture.
- `paint`/`paint_stroke` with `color`, `opacity`, `hardness`; results carry
  `painted` + `meanAlpha` — verify both.
- Healing: `clone_paint` (donor → target, world-space), `blur_paint`
  (masked blur), `mirror_paint` after `detect_symmetry`. Donors: pick clean
  skin/material from the symmetric or adjacent region.
- `undo_paint` reverts the last brush; group multi-call gestures with
  `undo_group` tokens.
- **Decorative fields (panel plates, window dots): use `batch`** — hard cap
  32 commands per call, PROBES INCLUDED (a 60-raycast batch refuses; split
  probe batteries into ≤32 chunks). Deterministic pseudo-random layouts
  (seeded LCG — replays stay identical). Expect 1-2 misses per batch near
  clamped edges ("Brush touched no surface" in sub-results) — scan
  sub-results rather than treating the batch as failed. Judge paint
  contrast under neutral lighting: `set_lighting {exposure, ambient}` has
  NO preset param — lighting presets live on `screenshot {preset:
  "neutral"}` — and the studio look washes out light grays.
- After `regularize_region`, texture in the region drifts slightly
  (vertices slide within the surface) — `blur_paint` or repaint to tidy.

## Performing for humans (observation seat)

- Checkpoints are AUTOMATIC: the publisher snapshots scene state after any
  >2 s command and at session end, so humans join/scrub your session in
  seconds even when your build contains monster remeshes. You owe them
  nothing extra — but a `simplify` on a 1.5M-tri mesh still takes ITS OWN
  20 minutes live; prevention (refine budgets) beats any replay machinery.

- Publish a session (the MCP runtime does this automatically when the app is
  running); the app's eye icon lists joinable sessions.
- **Wait for your audience.** Poll `/api/observe/sessions` for
  `observers > 0` before the first stroke — a performance nobody saw did not
  happen:

```python
while time.time() < deadline:
    if observers() > 0: break
    time.sleep(2)
else:
    end_session(); return          # never perform to an empty room
```

- Pace for watchers: `orbit` the camera between phases, sleep 0.3–0.5s
  between stamps (`pump`), keep a narrative arc (reveal → work → inspect →
  finale). Observers see your persistent brush ring (radius = area of
  influence) and the panel tool readout automatically.
- End with verification screenshots at canonical angles, plus a close-up of
  the riskiest region (e.g. the nape after a haircut).

## Verification battery (end of any editing session)

1. `screenshot` front/side/back + close-up of the worked region.
2. `get_mesh_stats` — `openEdges` unchanged unless you split something.
3. `fix_mesh {operations: ["degenerate"]}` — expect `trianglesDropped: 0`
   after a clean sculpt/regularize loop.
4. `export_model` round-trips paint and geometry; check the file size is sane.

## Traps

- Radii in screen pixels or normalized units — they are world units.
- Sculpting while a morph influence is active is refused; `set_morph` to 0 or
  `delete_morph` first.
- Painting right after refine on pole-cap fans can leave hairlines — known,
  disclosed in the `refine_region` description; paint slightly wider.
- `simplify_region` after refine is safe (guards added), but expect the
  reset baseline to move; take a fresh `screenshot` as your new reference.
- A stroke over a UV seam heals per-island; use `mirror_paint` or
  `project_paint` for cross-seam fixes.
