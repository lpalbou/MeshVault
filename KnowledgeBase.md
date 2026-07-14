# Knowledge Base

This file captures critical implementation insights and design logics that are easy to forget and costly to rediscover.

---

## Mesh fusion: CSG union ships with T-junction stitching or it ships broken

### Problem
"Merge sphere1 with box1 so I can sculpt across them" sounds like one library call (three-bvh-csg union). The naive integration measured 918 open edges on a two-sphere union — the library clips each brush against the other INDEPENDENTLY, so along the intersection curve side A subdivides at A's edge crossings and side B at B's: mutual T-junctions by construction. Consequences: `get_mesh_stats` reports a torn mesh, dig's piercing guard mistrusts the shell, and a fused object can never be union-merged AGAIN (the closed-source pre-check refuses it).

### Fix chain (each step necessary, measured on the two-sphere case)
1. three's `mergeVertices` CANNOT stitch it — it hashes ALL attributes, and the per-source UV atlas cells deliberately differ at the seam. Weld by POSITION only: snap every vertex in a quantization cell (5× the issue-counter quantum) to the cell's first-seen representative.
2. Stitch the T-junctions: detect open (use-count-1) canonical edges → find seam vertices lying ON them (parametric projection, perpendicular tolerance) → re-fan the owning triangle through the seam points (positions = the seam vertex's canonical position EXACTLY; UVs/normals interpolated along the OWNING side). Deterministic: fixed iteration order, parametric sort, canonical-id tie-break. 918 → 2 open edges.
3. Tolerate trace residuals in the union pre-check (≤ max(8, 0.2%)) so fusion composes with itself.
4. Skipping zero-area fan slivers is a false economy: it reopened 6 edges to remove 1 non-manifold edge. Keep the slivers; the sculpt engine's position-keyed weld is indifferent to them.

### Field gauntlet addenda (three fusion builds, 2026-07-14)
- **Union dirtiness scales with INTERSECTION COMPLEXITY, not source count**: 2 spheres → clean; 13 sources → 43 open edges; 18 sources with tangent overlaps → 313 open + 2,770 non-manifold. Tangent/kissing contacts are the poison — the skill's "overlap deliberately 10-20%" rule is load-bearing.
- **`fix_mesh {degenerate}` on fused meshes PUNCHES HOLES** (2006 dropped triangles → open edges 51→570; independently reproduced 1163 → 43→887). CSG seam slivers are legitimate geometry. Warned in the merge note + skill.
- **Tangent-face unions can silently inflate triangle counts ~×480** (X-Wing builder: coplanar box faces fused into confetti). Same root: don't union kissing faces, embed them.
- **Refine budgets on fresh CSG output run ~3× the formula** (coarse union mesh + conformality cascades) — take `nextPassNeeds` from the refusal.
- **Multi-candidate `compare_models` crashed the MCP server** ("Connection closed" after 152 s, 2 candidates); single-candidate runs took 320-687 s. compare_models is the new slowest tool in the box — investigate its registration loop before recommending it in-loop.
- Outcome evidence the workflow works: owl chamferMeanNormalized 0.0255 → **0.0172 (−33%)** with fusion; the falcon's mandibles finally GROW from the hull; the fillet `blend` was cited by every builder as the single best parameter.

### Design decisions that held
- Seam FILLETS (`blend`) = Laplacian relaxation of the intersection-curve neighborhood with smooth falloff, seam vertices found via per-source BVH distance (< eps of ≥2 sources). Plain Laplacian is CORRECT here — a fillet wants volume rounding at the crease.
- UV re-atlas into per-source grid cells before union: CSG interpolates UVs within each brush, so cells survive, and post-fusion painting never cross-talks between what used to be different objects.
- Drop source paint loudly. Fusion is for the DRAFT stage; texture after fusing is the right order anyway (the field workflow: assemble → fuse → sculpt → texture).
- Union refuses OPEN sources with a teaching error (CSG classification on open shells is silent garbage); `concat` mode (concatenate + position-weld) is the never-refusing fallback — the engine's position-keyed weld already makes coincident boundary vertices sculpt together.

---

## The five-agent performance gauntlet (2026-07-14) — measured causes only

A five-front adversarial investigation (refine over-generation, sculpt hotspots, paint hotspots, replay residuals, probe/transport costs) after the field verdict "you should never have to add 100k triangles in a single sequence". Every fix below shipped with before/after numbers; scratch reports in /tmp/perf_agent_[1-5].md.

1. **Refine flooding was mesh-quality-driven, not parameter-driven.** A r=0.3 refine on the shark capsule added 198k triangles — 93% OUTSIDE the requested ball — then deadlocked on an impossible budget refusal. Cause chain: capsule stock ships ~50:1 sliver side-quads (single-segment lathe body) → the ABSOLUTE 12° quality gate red-marked every sliver → red children of slivers are similar to their parents (re-trigger each pass) → the 2-marked closure transported marks region-blind. Fixes: cascade marks clamped to 1.5×r (beyond it, 2-marked triangles emit a conformal 1→3 split), the gate became RELATIVE (a green split not meaningfully worse than its parent stays green), capsule bodies get square quads by construction, and budget refusals diagnose flooding (marked ≫ over-target ⇒ "regularize first"). Shark scenario after: **416 triangles added, no refusal** (was 198k + deadlock). Uniform density was also refuted empirically: graded nested rings sculpt identically at 13% of the triangles.
2. **Live sculpt time was 75-80% advisory surveys** (three full-mesh edge scans per command feeding `meshQuality`). Fixed: one f64 world-position cache + stamp-AABB box cull per survey, and the third scan derives from the post-survey's own lengths. The advisory feeds the remesh:auto trigger, so everything stays bit-identical (multiset-equal lengths verified).
3. **Paint's candidate scan re-transformed every triangle per stamp** (46M reads for a 64-stamp stroke on 240k). A per-command Float64 centroid cache keeps candidate selection bit-identical at ~20× less cost. clone_paint gained mirror_paint's 600M correspondence budget + per-texel centroid prefilter (a r=0.4 heal ran 119 s with no way to know it wasn't hung).
4. **SwiftShader canvas readback sync: 23.5 SECONDS.** A 2048² paint layer created without `willReadFrequently` stays GPU-backed; the first getImageData after any draw forces a multi-second sync (measured 23.5 s for a 64×64 read; 2 ms with the flag). Every canvas that BECOMES a paint layer now passes `{willReadFrequently: true}`. This single flag was most of the "first paint is frozen" pain.
5. **Raycast/pick were linear scans while a BVH library sat in the bundle.** three-mesh-bvh was already a dependency (symmetry, heatmap) but never wired into `castInto`. Now: lazy `computeBoundsTree({indirect: true})` per geometry keyed on geometryRev. `indirect` is LOAD-BEARING — the default build reorders the geometry index, and several algorithms break ties by triangle iteration order (determinism). Morphed/skinned meshes skip acceleration (the BVH indexes BASE positions; three's default raycast handles displaced surfaces — caught by the morph suite). 25.9 → ~0.9 ms/ray measured.
6. **Replay divergence P0: object ids survived unload.** `_clearAllObjects` never reset `_nextObjectId`, so any replica rebuild after an unload (backward seeks, re-joins) addressed objects by ids that no longer matched — 438/510 commands silently failed. One line: ids restart at 1 on clear.
7. **Transport was innocent**: MCP protocol tax ~20-52 ms/call (batch amortizes it), SSE streaming ~1% of replay, telemetry microseconds. Screenshots are sync-bound, not pixel-bound (192²≈1024² cost; each NEW size pays a 2.4-28 s warm; `ssao:false` is NOT faster — docstring claim refuted and removed from guidance).

### Rule
Profile before optimizing, and profile the EPILOGUE (finalization, advisories, readbacks, syncs) before the algorithm. Four of the seven findings were per-command bookkeeping, not the core math. And when a budget refusal quotes an absurd number, treat it as a diagnosis of the INPUT (mesh quality, region shape), never as a dare to raise the budget.

---

## Replay speed lives in per-command finalization, not command count

### Problem
Observation-seat catch-up and recording replay of sculpt-heavy sessions were reported "extremely slow" (2026-07-14). The command COUNT was not the issue — the per-command finalization was: `computeVertexNormals()` over the whole geometry after EVERY replayed stamp (O(V) each, ~200 ms on a 60k-vert mesh), plus three full-mesh edge surveys per sculpt that only feed a returned advisory nobody reads during fast-forward.

### Fix pattern (deferral with read-through freshness)
Mark normals dirty during bulk replay instead of recomputing; EVERY reader calls `ensureFreshNormals()` first (sculpt direction defaults, inflate per-weld normals, refine/simplify/split attribute copies). Any command that needs normals sees exactly the values eager recompute would have produced — determinism verified by bit-identical position AND normal hashes across live vs bulk paths on a mixed sequence including a topology op. Settle all dirty geometries once in `endBulkReplay` BEFORE the first visible frame. Result: 8.6× on the sculpt benchmark.

### The perceptual half
Microtask-chained replay never yields a frame: progress banners UPDATE but never PAINT, so even a fast catch-up reads as a frozen tab. Yield (`setTimeout 0`) every N commands and move the progress UI — perceived speed is part of speed.

### Rule
When replay is slow, profile the per-command epilogue before touching the pipeline. Deferral is only legal with read-through freshness at every consumer — a deferred cache with even one stale reader silently diverges replicas, which is worse than slow.

---

## Sculpting is a probe-pull-reprobe loop, not coordinate playback

### Problem
Agent builds kept defaulting to primitive assembly + paint because sculpting "didn't work": pulls landed in air, fins came out as accordion folds, tapers touched nothing, and each bilateral feature cost double commands that drifted apart.

### Root causes (shark experiment, 2026-07-14)
1. **Brushes select by surface proximity** — a `pinch` centered on the medial axis of a 0.32-radius body gathers nothing. Every shaping brush must be CENTERED ON THE SURFACE (raycast-probed), pulling toward/away from the axis.
2. **Pulls move the surface** — the second pull at the same coordinates sculpts where the crest WAS. Extrusions (fins/ears/limbs) only work as probe → pull → RE-PROBE loops with guarded acceptance (reject re-probe hits that jumped to another feature).
3. **Sharp falloff on thin features crumples them** — a membrane pulled with `falloff:"sharp"` folds like an accordion because the falloff cliff shears adjacent rings. Pull with smooth falloff at descending radii, THEN `pinch` to thin the blade, then smooth the base seam.
4. **Hand-mirrored bilateral calls drift and double cost** — fixed in the engine: `symmetry:"x"|"y"|"z"` mirrors stamps across the object's local plane with direction/pivot/axis reflected and hinge angles negated (reflection conjugates rotations). Refinement density must be mirrored too, or the reflected stamp lands on coarser facets and the sides diverge.

### Rule
The sculpt loop for SHAPES (not just detail) is: silhouette render → probe → soft pull → re-probe → … → pinch/sharpen → regularize → next feature. Assembly is for machines; stock + brushes is for anything alive. Both are legitimate; the skill's shark playbook carries the transferable sequence.

---

## The product is the MCP + skill — dogfood through them, not around them

### Problem
For weeks, live demos and performances (portrait repaint, Death Star, Mickey) drove the viewer's control API **directly in a headless page** — same commands, same observe hub, but not the MCP protocol path. Those runs proved the *engine*; they proved nothing about the *product*, which is "any external agent can build/edit 3D scenes through `meshvault-mcp` + the AI skill".

### What only the true path found (2026-07-13, Falcon experiment)
Running the same class of builds through the real stack — a stdio MCP client (X-Wing, Falcon agency) and a *genuinely foreign* agent (LM Studio pilot, qwen3-next-80b) — surfaced failure modes the expert-driven direct-page sessions could never hit:
- **Colors as `[1,0,0]` arrays painted WHITE while returning ok:true** (String() coercion → THREE.Color fallback). An expert never passes arrays; a local LLM did immediately. Fixed: string params refuse arrays/objects with a teaching error.
- **Invented actions caused 60-step retry ping-pong** (`set_object_color` ↔ `list_commands`). Fixed three ways: intent-keyword suggestions in the unknown-action error, a loop breaker in the agent runner, skill golden rule #0 (never repeat a failing call verbatim).
- **`set_active_object` needed a `name` path** — conversational agents think in names, not ids.
- **Prompt size is a latency budget on local models**: embedding the full skill cost 60–140 s *per turn* on an 80B; golden-rules-only cut a smoke task from 17 min to 2.6 min.
- Protocol-level constraints (MCP result truncation, image content blocks, JIT model loading) that page.evaluate scripts bypass entirely.

### Rule
1. Every demo/performance/experiment script goes through `meshvault-mcp` (the stdio scaffold in the skill's Session setup). Driving the page directly is allowed only for *engine* debugging, never as evidence a capability "works for agents".
2. Keep BOTH kinds of field runs: scripted expert runs validate the surface's ceiling; foreign-agent runs (local pilot) find the failure modes experts never trigger. The second kind is where the teaching-error work comes from.
3. A capability does not exist until it has been exercised end-to-end through the MCP by something that is not its author.

---

## GLB Export — UV origin vs `Texture.flipY` (Three.js / glTF 2.0)

### Problem
glTF 2.0 defines the texture coordinate origin $(0,0)$ at the **upper-left** of the image. Three.js (WebGL/OpenGL-style sampling) effectively treats UVs with $(0,0)$ at the **lower-left** for typical `TextureLoader` assets, and relies on `texture.flipY` (WebGL UNPACK flip) to reconcile image row order vs UV convention.

When exporting to GLB with Three.js `GLTFExporter`, a common failure mode is **vertically flipped textures** (and/or “UVs look wrong”) because `GLTFExporter` flips image pixel rows whenever `texture.flipY === true`.

### Key facts (verified against Three.js r170 source)
- `GLTFExporter` flips the **image pixels** (via a canvas transform) when `flipY === true` — it does **not** modify UV coordinates.
- `TGALoader` returns `DataTexture`-style images and sets `texture.flipY = true`.
- glTF 2.0 spec explicitly states the UV origin is **upper-left**.

### Robust export strategy (used in MeshVault)
- Export with **glTF convention**:
  - Flip UV V component on export ($v \leftarrow 1 - v$) **ONLY when the UVs are
    in GL convention** — announced by the material's texture `flipY`:
    loader-sourced textures (OBJ/FBX/TextureLoader/paint layers) are
    `flipY = true` = GL convention → flip; **GLB-sourced textures are
    `flipY = false` = ALREADY glTF convention → do NOT flip** (an
    unconditional flip double-converts and scrambles every glTF→GLB
    round-trip into a mosaic — found by a cycle-4 agent's reload proof,
    2026-07-11; tangent-handedness negation follows the same condition).
  - Force exported textures to `flipY = false`
- For `DataTexture`-style sources (`image.data`), convert to a canvas in **top-to-bottom** row order before export so the PNG bytes match the original image orientation.

This yields GLB textures that match the original images (no vertical flip), and a GLB that round-trips in MeshVault without UV/texture coordinate artifacts. Regression guard: a round-trip test compares the exported TEXCOORD_0 min/max V against the source's.

---

## GLTFLoader — Derivative tangents and `normalScale.y` sign

When loading glTF without vertex tangents, Three.js `GLTFLoader` may clone materials for “derivative tangents” and flips `material.normalScale.y *= -1` as part of its internal tangent-space conventions. This is expected behavior and can affect “pixel-perfect” comparisons if one pipeline produces tangents while another doesn’t.

---

## `mergeVertices` and UV/normal/tangent preservation (smooth normals & simplify)

### Problem
"Recompute smooth normals" and "Simplify" both need to merge coincident vertices so shading/decimation operate on shared topology. The naive approach deletes the `uv` attribute before merging (so faces merge across UV seams). But `BufferGeometryUtils.mergeVertices` merges only vertices whose **entire attribute tuple** is equal — so deleting UVs and merging, then never restoring them, silently strips texture coordinates and leaves textured meshes untextured.

### Robust approach (used in MeshVault)
- Delete only the **per-face-derived** attributes before merging: `normal` AND `tangent`. Faceted duplicate vertices differ only by these, so removing them lets duplicates collapse; if either remains, the merge refuses and smoothing/decimation fails.
- **Keep `uv`.** `mergeVertices` then merges vertices sharing position+UV, so a genuine UV seam correctly stays split (two vertices) while non-seam edges smooth. Meshes without UVs merge purely by position — identical to the old behavior.
- `SimplifyModifier` (r170) carries `uv`/`normal`/`tangent`/`color` through decimation, so preserving UVs before `modify()` keeps textured meshes textured.
- Always `dispose()` the geometry you replace (`child.geometry = merged; oldGeo.dispose()`) — reassigning the reference alone leaks GPU buffers.

---

## Security model: one trust boundary, not per-endpoint checks (`backend/security.py`)

### Insight
The original arbitrary read/write/delete exposure came from each endpoint calling `Path(client_string)` directly. Patching endpoints one by one is fragile — the next endpoint forgets. The durable fix is a single `PathGuard.resolve()` that every filesystem endpoint funnels through, plus ASGI middleware for auth + Host allow-list. New features (thumbnails, index, tags) inherit confinement because they must call the same guard.

### Load-bearing details (each learned from an adversarial breakout)
- **Confinement rule is general:** resolve symlinks first (`Path.resolve(strict=False)`), then require the real path to be inside an allowed root. This blocks traversal, absolute-path injection, and symlink escapes with one invariant — not per-attack string matching.
- **The endpoint predicate MUST match the code path that actually runs.** `/api/export` was breakable because the endpoint branched on `is_in_archive && archive_path` while `ExportManager` only takes the archive path when `inner_path` is *also* set — so an archive request with no `inner_path` fell through to a filesystem copy of *unguarded* `related_files`. Guard for the branch that will execute, and guard **every** path a copy reads from (source AND related_files).
- **Canonicalize before persisting keys.** The index stores resolved paths; tags/collections stored under a non-canonical path (e.g. `/tmp` vs `/private/tmp` on macOS) succeed but become unfindable. Resolve to the canonical form on write.
- **Don't accept tokens via query param** (`?token=`): they leak into access logs, history, and `Referer`. Use an `HttpOnly`+`SameSite=Strict` cookie (set on the app shell) for the browser and headers for programmatic clients.
- **Host allow-list must fail closed:** an empty/missing Host must be rejected, not allowed through.
- **Disable `/docs`, `/redoc`, `/openapi.json`** for a local single-user tool — the schema is free reconnaissance.

---

## Blocking work belongs in the threadpool, not the event loop

FastAPI runs `async def` handlers on the event loop and `def` handlers in a threadpool. Endpoints that do blocking work — archive extraction (subprocess up to 120s), RAR inspection, FBX conversion, SQLite queries, `rglob` texture scans, large file copies — must be plain `def` so one slow request doesn't stall every other request. Only genuinely async work (`await file.read()`, spawning a background thread) stays `async def`. Long scans (library reindex) run in an explicit background thread and commit in small batches so writers (tag/collection edits) can interleave instead of waiting for the whole walk.


---

## IBL in three r170: control it via `scene.environmentIntensity`, NOT `material.envMapIntensity`

### Insight (measured, adversarially verified)
For materials that get their environment from `scene.environment` (i.e. no own `envMap` —
the normal case for loaded glTF), the r170 renderer **overrides** the material's
`envMapIntensity` uniform with `scene.environmentIntensity` every frame:
`WebGLMaterials.refreshMaterialUniforms` → `if (material.isMeshStandardMaterial &&
material.envMap === null && scene.environment !== null) envMapIntensity.value =
scene.environmentIntensity`. Setting `material.envMapIntensity` in this case is a
**silent no-op** (measured: 0.0 mean pixel diff). `material.envMapIntensity` only applies
when the material has its **own** `envMap`.

### Consequences
- All IBL enable/intensity control must go through `scene.environment` (null to disable)
  and `scene.environmentIntensity` — one place, applied in `_applyEnvironment()`.
- Never zero `envMapIntensity` across a model's materials to "disable IBL": it does
  nothing for scene-env materials, and it would wrongly kill reflections for assets that
  ship their own baked `envMap`.
- A procedural `RoomEnvironment` → `PMREMGenerator.fromScene()` gives credible studio IBL
  with zero shipped assets (offline/Pages-safe). Dispose the temp room scene, the PMREM
  generator, and the render target (`destroy()`).
- The matte "solid" (clay) inspection mode must suspend the environment: full-strength
  IBL washes a matte white override to ~230/255 mean luminance and destroys form reading.

## Vendored decoder binaries (Draco/Basis) are version-coupled to `three`

`frontend/vendor/{draco/gltf,basis}` are copied from
`node_modules/three/examples/jsm/libs/` and must be **re-synced whenever `three` is
bumped** — loader JS and decoder wasm are a matched pair. They are committed (source of
truth), served at `/static/vendor/` by the app, copied to `web/vendor/` by
`scripts/build.mjs` for local static serving, and shipped as `site/vendor/` by the Pages
workflow. Decoder paths resolve via the viewer's `assetBaseUrl` option (`/static/` in the
app, page-relative in the standalone bundle), so embedders hosting the bundle elsewhere
must pass their own `assetBaseUrl`. DRACOLoader/KTX2Loader spawn worker pools: create
them once per viewer, reuse across loads, and `dispose()` them in `destroy()` (verified:
workers bounded at 8 across 10 loads, 0 after destroy).

---

## Geometry QA heuristics that survive real-world meshes (`describe_scene`)

Adversarially validated against trimesh ground truth; each rule below replaced a naive
version that produced false positives or missed real defects:

- **Watertight/manifold topology must be computed on position-welded vertices** (quantize
  at 1e-6 × bbox diagonal, canonical id per position). Raw indices report every UV/normal
  seam as a boundary edge — a textured cube would look "full of holes".
- **Degeneracy must be judged on RAW positions with a RELATIVE sliver test**
  (|cross|² < 1e-12 × |ab|²|ac|², i.e. sin²θ): an absolute area epsilon flags legitimately
  small triangles in fine-detail meshes, and using welded ids flags genuinely tiny-but-valid
  triangles whose corners quantize together.
- **Flipped normals: use the SIGNED VOLUME of the winding, not a centroid test.** A
  centroid ray test fails on tori and other shapes whose faces legitimately point "toward
  the centroid". Signed volume (Σ a·(b×c)/6, translation-invariant for closed surfaces) is
  reliable — and only meaningful when the mesh is closed (boundaryEdges === 0).
- **Budget-gate per-triangle work BEFORE doing it** and say so in the output
  (`checks_skipped` issue) — an agent must never mistake "skipped" for "clean".
- **Main-thread hot loops must be allocation-light**: a `new Vector3` per vertex plus
  string Map keys per edge cost ~0.9 s and ~30 MB of garbage at 292k triangles; scalar
  math + numeric edge keys (u·nVerts+v) removed the freeze.
- **Report LIVE numbers, not cached loader stats**: `_lastStats` goes stale after
  simplify/rotate and the report would contradict its own mesh list. Recompute counts and
  bounds from the current buffers at call time.
- **Describe the ASSET, not the display override**: render modes swap `child.material`
  and stash the original on `_mvOriginalMaterial`; an inventory that reads the override
  claims a textured model is untextured.

---

## Never bake matrices into quantized (integer) vertex attributes

KHR_mesh_quantization stores positions/normals as normalized Int16/Uint16 with the
dequantization scale in the NODE transform (common in KTX2/Meshopt pipelines).
`geometry.applyMatrix4(matrixWorld)` reads through the accessor (denormalizes) but
writes world-scale floats back into the integer array — overflow garbage that destroys
the model (live-verified: after `rotate`, bounds exploded to the uint16 range and the
render went blank). Any in-place bake must first convert affected attributes to plain
`Float32Array` (read via `getX/getY/getZ`, which decode normalization). MeshVault does
this in `_dequantizeVectorAttributes()` before `_bakeWorldTransforms()`. The skinned
sibling of this trap (baking geometry while bones keep transforming it) is still open —
see backlog follow-ups.

## Part-level camera work needs a clip-plane story, not just coordinates

Exposing per-mesh centers is NOT enough for agents to inspect parts: `camera.near` is
sized once per model (`0.001 × whole-model frame distance`) and OrbitControls'
`min/maxDistance` are absolute constants, so framing a part smaller than ~1/800 of the
model renders ZERO pixels even with mathematically correct `set_camera` values
(live-verified: 1 cm screw on a 10 m housing). `focus` therefore rescales near/far and
the distance clamps to the part, and restores them on `reset_camera`/whole-model
framing. Also: address parts by stable traversal-order id, not name — empirical dump of
real models showed names are mostly loader garbage ("mesh_0", UUIDs, "(unnamed)").

---

## Shape comparison / registration lives in one place, two front-ends

`backend/mesh_compare.py` (numpy-only ICP+Kabsch with PCA init, trimmed correspondences,
mirror probe, sampling-noise floor) is the single registration algorithm. It is reached
by the MCP `compare_models` tool (calls the function directly) and by the app's
`POST /api/compare` endpoint (pure point-set math — no filesystem, so no PathGuard). The
frontend samples both models it has loaded (`sample_points`, deterministic area-weighted)
and posts the point arrays. Do NOT port ICP to JS — one algorithm, no drift; the ~1-2 s
round trip is fine for a click-driven op. `compare_point_sets` returns `matrix4`
(column-major) so the app can apply the alignment to a three.js group directly.

## In-app deviation heatmap: read positions via the accessor; make it UNLIT

`frontend/js/viewer/heatmap.js` paints each vertex of the displayed model by its
closest-distance to another (registered) model's surface, via a `three-mesh-bvh` BVH
(app bundle only — not the standalone/agent bundle). Two load-bearing lessons:
- Build the BVH by reading the OTHER model's positions through `fromBufferAttribute`
  (accessor), NOT `geometry.applyMatrix4`/raw `.array`: quantized/interleaved attributes
  (KHR_mesh_quantization Int16) overflow otherwise ("offset is out of bounds"). Same trap
  as `_bakeWorldTransforms` — see the quantization entry above.
- Use `MeshBasicMaterial` (unlit) for the ramp, not a lit material: a deviation colour
  must read identically regardless of scene lighting, or a shadowed red patch looks like
  a lit blue one. Ramp floor at ~1% of the bbox diagonal so compression/sampling noise
  reads as "matches" (cool) and only genuine edits light up.

---

## Agent bridge (process-to-app push): discovery file + SSE, and the traps

The MCP server and the app are separate processes; the "shared session" feature
(backlog 043) bridges them with a session file + one POST endpoint + SSE fan-out.
Load-bearing details:

- **Discovery via a 0600 session file** (`~/.meshvault/app_session.json`, {url, token,
  pid}) — same sensitivity as the launch banner that already prints the token; readable
  only by the OS user who already owns the server. Removal is **pid-checked** (lifespan
  + atexit) so an old instance's exit never deletes a newer instance's file.
- **EventSource cannot set headers** — the SSE endpoint must live under `/api/*` and be
  authenticated by the session COOKIE (sent automatically same-origin). Same-origin
  policy: the cookie is HttpOnly+SameSite=Strict, but `GET /` re-issues it on every
  shell load, so cross-site deep-link navigations still authenticate the SPA's fetches.
- **Starlette's TestClient cannot consume an infinite StreamingResponse through
  BaseHTTPMiddleware** — iterating the stream deadlocks the test (observed: full-suite
  hang). Test streaming endpoints against a REAL uvicorn server in a thread
  (`tests/test_agent_bridge.py::test_events_stream_delivers_push_real_server`); keep
  TestClient for the non-streaming routes.
- **Bounded per-client queues, drop on overflow** — a wedged tab must not grow server
  memory; the SSE generator (not the publisher) owns disconnect cleanup, and 15 s
  heartbeats guarantee a dead connection surfaces as a send error.
- **Validate the camera payload at the boundary (422 on malformed)** — the message is
  relayed verbatim to app tabs; a silently-partial camera apply would leave human and
  agent looking at DIFFERENT views, which is the exact failure the feature exists to
  remove.
- **Server paths are canonicalized** (`/tmp` → `/private/tmp` on macOS, symlinks): a
  deep link's caller-spelled path can differ from the browse response's canonical path
  for the same file. `findAsset` matches exact key first, then basename within the
  browsed directory (still exact — one directory cannot contain two entries with the
  same basename).

---

## Textures load ASYNCHRONOUSLY: pending is not broken (`_isBrokenTexture`)

### The bug this encodes (untextured multi-file models, 0.4.x)
Loaders resolve when the GEOMETRY parses; MTL/FBX texture fetches keep running after.
`_enhanceModel` runs immediately on the parsed object, and the old `_isUsableTexture`
returned false for any texture whose `image` hadn't arrived — so every in-flight
http(s) texture was silently stripped. Over loopback (MCP/headless) the mesh ALWAYS
wins that race → every OBJ+MTL/FBX model rendered untextured; in the app it was a
real race for small models. An earlier fix had already special-cased blob:/data:
images (FBX embedded textures) — the general rule was hiding in that special case.

### The rule
- A texture with no image yet is **pending** — keep it; its onLoad flags the upload.
- Broken is only knowable as: image COMPLETED with zero natural size (decode/404 on
  an attached element), or still image-less after the load has settled.
- Cleanup of genuinely failed slots happens in ONE place: a janitor pass ~8 s after
  the model is added (`_sanitizeObjectTextures(object, settled=true)`), guarded by
  `this._currentModel === object` so a replaced model is never touched. Falling back
  to base color beats sampling an unbound texture (renders black).

### Multi-file over headless runtimes: serve the DIRECTORY, resolve against the MODEL
- MCP/loopback: `/models/<token>/<name>` — the token maps to the file, siblings are
  served from its directory (resolve + `is_relative_to` confinement). A bare
  `/models/<token>` URL gives relative refs no base; everything companion 404s.
- Standalone viewer default resolver: relative refs resolve against
  `viewer.getModelBaseUrl()` (the model URL's directory), not the host page — that is
  what the platform loaders do natively for `.gltf`→`.bin`.
- Companion discovery is format-aware and bounded: OBJ declares its libraries
  (`mtllib` — parse it, don't glob), FBX doesn't (bounded texture scan, basename
  matching), glTF needs nothing (loader-relative).
- **SSE breaks uvicorn's default graceful shutdown** — an `EventSource` connection
  never closes on its own, and uvicorn waits for active connections indefinitely, so
  Ctrl-C/SIGTERM hung while any app tab was open (live-verified). Fix:
  `timeout_graceful_shutdown=3` in the uvicorn config — linger briefly, then
  force-close stragglers. Any future long-lived endpoint inherits this protection.
- **Publish discovery state only after the bind succeeds, and pid-probe on read**
  (external tester finding, 0.4.0). Writing the session file before `uvicorn` bound
  the port meant a launch that failed to bind (port taken, reaped by a supervisor)
  left a file pointing agents at a port owned by a DIFFERENT (older) instance —
  hours of 404 chasing. Fix pair: a watcher thread polls `uvicorn.Server.started`
  and writes the file only then; `discover_app_session()` probes the publisher pid
  and raises `StaleSessionError(pid)` (removing the file) when it is dead. SIGKILL
  cannot run cleanup — only read-side probing covers it.
- **`os.kill(pid, 0)` is a liveness probe ONLY on POSIX.** On Windows, Python
  implements non-CTRL signals via `TerminateProcess` — a "probe" would KILL the
  target. `_pid_alive()` therefore probes only when `os.name == "posix"` and trusts
  the file elsewhere (worst case: the connection error surfaces the problem, as
  before). `PermissionError` from the probe means "exists, other user" → alive.

---

## Scene composition: the registry invariants that keep 90 single-object paths alive

Backlog 042 turned the single-model viewer into an N-object registry without touching
~90 existing `_currentModel` references. The load-bearing rules (each one broke in
design review before it could break in production):

- **`_currentModel` is a DERIVED getter over the registry** (active entry's model);
  there is deliberately no setter — every mutation goes through
  load/add/remove/clear. The one write site everyone forgets is the CONSTRUCTOR
  (`this._currentModel = null` throws on a getter-only accessor in strict mode).
  Identity checks change meaning under a getter: the texture janitor's
  `_currentModel === object` became a registry-membership test, or co-loaded
  objects lose their texture cleanup.
- **Placement lives on a wrapper `Group` OUTSIDE the model subtree; vertex bakes are
  wrapper-RELATIVE** (`wrapperInv × child.matrixWorld`) and all their box/pivot math
  must be wrapper-LOCAL (post-bake, subtree transforms are identity ⇒ geometry
  bounding boxes ARE local coords). `Box3.setFromObject` is world-space and folds
  the wrapper back in — under a rotated/scaled wrapper, ground/center would shift
  along wrong axes by wrong amounts. Bakes REFUSE skinned models (zeroing bone
  nodes corrupts the bind pose — pre-existing documented corruption, now blocked).
- **One monotonic load id cannot express add-vs-replace.** Replaces race replaces
  (newest wins, `_loadId`); adds race the SCENE (generation counter bumped only by
  clear-all: an in-flight add discards itself if the scene was replaced, and adds
  never cancel each other).
- **Per-entry state or stale-state bugs multiply by N**: animation ({mixer, actions,
  clips} per entry; only the ACTIVE entry's mixer advances → others freeze and
  resume without reset), reset snapshots (retaken after geometry-REPLACING ops —
  restoring an old positions array into a new differently-sized geometry was the
  "offset is out of bounds" crash), modelScale/modified as derived getters.
- **Exports read the material STASH, never the live material** (`_mvOriginalMaterial
  || material`) and authored opacity (per-object ghosting records a backup in
  `userData._mvViewerOpacityBackup`): a clay-render export was shipping clay
  materials into GLB assets — viewer display state must never enter asset data.
- **Everything sized "to the model" must size to the visible-UNION box** (lights,
  shadow camera, grid, fog, nav speed, clip planes, measure markers/raycasts), and
  it must refresh on composition changes (add/remove/transform/visibility), not just
  on framing — or placed objects silently lose shadows. Offscreen SCORING passes
  (best view, auto-upright) must hide non-active wrappers or neighbors contaminate
  the edge-energy scores.

---

## Sculpting & texture painting for agents (backlog 045, v0.7.0)

Built against three adversarial design reviews and three live artist-agent
sessions. The rules below each prevented (or fixed) a real, observed failure.

### Geometry snapshots must be ACCESSOR-DECODED, never raw array copies
`new Float32Array(posAttr.array)` snapshots raw storage: for KHR_mesh_quantization
attributes that's Int16 integers, for interleaved attributes it's the whole
stride-packed buffer. Any later layout conversion (dequantize/de-interleave — which
sculpt and bakes do) makes the restore write ±32767-range garbage into decoded
float buffers (model destroyed), or silently no-op. Snapshot through
`getX/getY/getZ` and restore via `setXYZ` — decoded floats are layout-independent.
The same rule as the heatmap lesson: *never read or write `attribute.array`
directly when the attribute could be quantized or interleaved.*

### Sculpting rules (frontend/js/viewer/sculpt.js)
- **Weld before displacing.** UV/normal seams duplicate vertices at identical
  positions; per-vertex normals differ across the duplicates, so inflate/smooth on
  raw vertices TEARS every textured mesh at its seams. Quantize positions
  (1e-6 × bbox diagonal), compute one displacement per canonical position, write it
  to all duplicates. This also gives non-indexed (STL) meshes adjacency for free.
- **Dedup shared geometries per stamp.** GLTFLoader instancing shares one
  BufferGeometry across meshes — a traverse-per-mesh stamp displaces the shared
  buffer once per instance (2× displacement), not "each instance once".
- **World-space brushes, position-space transforms back.** Falloff on world
  positions (correct under non-uniform wrapper scale); map the DISPLACED WORLD
  POSITION back through the mesh's inverse matrixWorld. Never
  `transformDirection()` for displacement vectors — it normalizes and destroys
  magnitude.
- **Finalize once per COMMAND, not per stamp**: computeVertexNormals + bounds +
  stats after the last stamp of a stroke. Recompute `boundingSphere` or the next
  `pick`/raycast misses the sculpted region (Raycaster culls by it).
- **Missed brushes are ERRORS that teach** ("check center — use pick/get_bounds"),
  and mutation returns carry quantified feedback ({affected, maxDisplacement,
  newSize}) — a SwiftShader verification render costs 10-60 s; numbers are free.

### Texture painting rules (the paint layer pipeline)
- **Blend in sRGB bytes.** `THREE.Color` components are LINEAR working space
  (r152+ color management): blending `color.r*255` into a canvas paints darker than
  requested (#00aa00 → rgb(0,103,0)). Convert via `getHexString()` first.
- **Per-call MAX-alpha accumulation, single blend pass.** Rasterizing per-triangle
  directly double-blends texels straddling shared edges (the barycentric edge
  tolerance overlaps them) → plaid/moiré at low opacity; overlapping stroke stamps
  compound the same way. Accumulate texel→max(alpha) across the whole call, apply
  once: painter's per-stroke opacity semantics (`opacity` = the call's alpha cap).
- **Triangle rasterization in UV space with WORLD-space falloff** — continuous
  coverage at any mesh density (vertex-splatting gaps on sparse meshes) and each
  triangle owns its UV island pixels.
- **Stock primitive UVs are not paintable.** three.js BoxGeometry maps ALL SIX
  faces to the full [0,1]² square (cylinder/cone caps overlap the side band):
  painting one face paints all six. Remap per-group UV atlases at creation
  (box 3×2, cylinder/cone side band + cap islands), then `clearGroups()` for
  single-material rendering.
- **The paint layer inherits the replaced map's `flipY`** (GLB textures false,
  loader textures true) and the splat row is `flipY ? (1-v)·H : v·H` — wrong
  orientation V-flips the base layer. CanvasTexture colorSpace = SRGBColorSpace.
- **Clone-on-first-paint for shared materials** (across ALL scene objects, not just
  the active one) or painting one mesh repaints its siblings; keep the pre-paint
  map/color for `clear_paint` (paint must have an undo path); budget painted texels
  per session (~16M) and return the budget on object disposal.
- **`meanAlpha` in every paint result**: `painted` (texel count) alone reports
  success for visually-null paint (low opacity × soft falloff); the mean applied
  alpha catches it numerically before the agent wastes a render (observed: the T1
  artist burned ~8 calls diagnosing invisible paint).
- **Square stamps need an anchor frame**: nearest-triangle normal → tangent plane →
  Chebyshev distance = crisp axis-aligned quads; `max_normal_angle` (dot of face
  normal vs anchor normal) stops paint wrapping around hard edges — both came from
  an artist session hand-building a checkerboard out of 36 round stamps per cell.

### The agent hand-eye loop (pick) needs the SCREENSHOT's aspect
Screenshots default 1024² but the live canvas is 4:3 — unprojecting screenshot
coordinates through the live camera lands up to ~15% off near edges. `pick` takes
the screenshot's width/height, temporarily sets `camera.aspect`, and restores.
Picks are only valid until the camera moves (re-pick after orbit).

### Demand-driven rendering (perf, backlog 043)
The rAF loop renders only when `_renderRequested` (input/damping/animation/FPV) and
parks after ~45 idle frames — measured 0.0% CPU for the whole browser tree at idle.
Load-bearing details: reset `clock.getDelta()` on loop resume (or animation jumps),
`invalidate()` from OrbitControls "change" (damping settle frames), every mutating
control-API command invalidates once (the API layer does it centrally), captures
invalidate afterward (the canvas holds a capture-sized frame while the loop is
parked), shadow maps `autoUpdate=false` + `needsUpdate` on invalidate. Sculpt
strokes must NOT invalidate per stamp — a SwiftShader composer render is
~100-300 ms and a 64-stamp stroke would turn into a 20 s op.

### Memory rules learned the hard way
- Reset snapshots are LAZY (taken at first mutation via `_ensureResetSnapshot`) —
  an unmodified model never pays the ~35-40% geometry-RAM duplicate; geometry-
  REPLACING ops (simplify/recompute) DROP the snapshot (new baseline) instead of
  eagerly retaking it.
- Timer closures must not capture models: the 8 s texture-janitor timeout held the
  full model (geometry + textures) even after removal — capture the entry ID and
  look it up at fire time.
- Never build per-vertex STRING keys for dedup (`${x},${y},${z}` ≈ 60 B + rope
  churn each): nested numeric Maps (x→y→Set(z)) are exact and allocation-free per
  vertex. Multi-million-vertex models turned hundreds of MB of transient garbage
  into ~nothing.
- Idle-close headless browsers that serve ONE-SHOT requests (screenshot API: unload
  after each response + close after 5 min idle); NEVER idle-close a STATEFUL
  session (MCP: the scene IS the session).

---

## Articulation, timeline animation & regional repair (backlog 046, v0.7.0)

Built against a 3-adversary design review and 3 live agent gauntlets. Each rule
below prevented (or fixed) an observed failure.

### Pivots are MATH, never scene-graph nodes
The wrapper TRS is always the composition `T(p)·T(pivot)·R·S·T(−pivot)` folded
to plain TRS (`position = p + pivot − R·S·pivot`); the LOGICAL placement
{p,q,s} + pivot live on the registry entry. A pivot sub-group between wrapper
and model CORRUPTS `_bakeWorldTransforms` (the group's transform bakes into
vertices but never zeroes — double application) and splits the pose across two
nodes (screenshot shows a rotated wing, get_object_transform says identity).
Anything that writes RAW wrapper TRS (the gizmo) must re-derive the logical
placement afterwards (`_syncLogicalFromWrapper`).

### Keyframes store LOGICAL local TRS, playback is hand-rolled
- Interpolate {p,q,s} then compose the pivot per frame → a keyed wing sweeps a
  true ARC about its root; interpolating composed wrapper values cuts chords.
- `AnimationMixer.setTime(t)` multiplies by timeScale — seek(5) at speed 2
  lands at t=10, corrupting seek→screenshot determinism. A pure
  `sampleTimeline(t)` + synchronous capture is exact by construction.
- Playback writes wrapper TRS DIRECTLY — `setObjectTransform` per frame would
  rebuild the grid/axis helpers at 60 Hz (GC storm). Size the rig ONCE at play
  from the swept keyframe volume.
- QUATERNIONS CANNOT ENCODE FULL TURNS: rotation[360,0,0] round-trips to
  identity and the segment silently plays NO motion — the >120° quaternion-
  delta check mathematically cannot catch exact 360° multiples. Track the
  REQUESTED Euler angles per key (`k.e`), warn on ≥90° requests that collapse
  (and on >120° steps), and show requested angles in get_timeline. Advise
  ≤120° steps (0/90/180/... for spins) — 180° steps are direction-ambiguous.
- basePlacement snapshot when an object gains its first track; stop/clear
  restore it — otherwise transient animation poses leak into manifests.
  Timeline must be CLEARED on scene replace (dangling "(removed)" tracks leak
  into exports).

### Animated GLB export: TRS nodes + node-relative geometry baking
GLTFExporter FORCES `trs:true` when clips are present, then reads node
position/quaternion/scale — the static path's matrix-only flat meshes export
collapsed at the origin. The animated path builds `objNode(TRS) → mesh(identity,
geometry baked by nodeInv × meshWorld)`, names nodes uniquely (`mv_obj_<id>` —
PropertyBinding resolves BY NAME, first match wins, and silently DROPS
unresolvable tracks), resamples at 30 fps with pivots composed into every
sample, and VERIFIES the emitted channel count from the GLB's JSON chunk.

### Region simplification: locked vertices, or nothing
r170 SimplifyModifier has NO boundary locking — its border "preservation" is a
soft cost that erodes under averaged-cost vertex selection. A crack-free
regional decimation needs a constrained collapse where locked vertices (region
ring + mesh borders + ALL multi-member welds = UV seams/normal creases) never
move or disappear; a Melax collapse u→v never moves v, so the output vertex set
is a strict subset — paint layers stay aligned with zero touch-up (texels don't
move, only interpolation across bigger triangles). Report achievedRatio +
locked counts: seam-dense regions legitimately decimate less than requested.
LESSON (T3 gauntlet): a cost-function deterrent is NOT a lock. Open-boundary
rims (split-cut edges) carried curvature=1 cost but were still collapsible —
decimating both sides of a cut independently made the rims DIVERGE into
visible gashes with no warning. Open edges (global welded count 1) must be
HARD locks like seams; verified: rim edge count bit-identical across a
straddling regional decimation.

### One metric, one meaning ("three truths" trap)
The same `openEdges` read 0 / hundreds / 439 across three tools on one mesh:
stats counted welded cracks, inspect_region counted region-truncated perimeter
edges, fix_mesh excluded degenerate triangles from edge multiplicity. Any
metric reported by multiple tools MUST share one definition (welded, whole-mesh
topology; degenerates count toward edge multiplicity until actually dropped) —
or agents cannot detect regressions across operations.

### The post-split active-object trap
`split_object` makes the NEW part active (insert semantics), so the next brush
targets the wrong mesh with a generic miss error. Miss errors now raycast the
brush point against ALL objects and NAME the owner ("the point sits on object 3
('body') but the ACTIVE object is 4 ('wing') — set_active_object first").
Camera `views` batches must frame the SCENE for the same reason (framing a tiny
active part puts preset cameras inside the parent mesh).

## Texture forensics & persistence proofs (backlog 047, v0.7.0)

Built through a 5-cycle adversarial program (repair quality, proofs, animation
persistence). The durable lessons:

### Diagnose the ATLAS before choosing the repair class
A texture "misalignment" has two entirely different repair classes and the
atlas topology decides between them. Coherent atlases (few semantic charts —
one island ≈ one feature) are repairable in UV space: `transform_uv` with
`island_of` scoping + `preview_uv_transform` bleed dry-runs. Fragmented
photogrammetry-style atlases are NOT: the portrait measured 4,424 non-semantic
Voronoi-like islands with the eye and mouth sharing one chart — no affine UV
transform can move the eye without dragging the mouth, and both UV-surgery
attempts were falsified by honest before/after renders. The correct class
there is SCREEN-space: `project_paint` re-samples the current render at
(screen + offset) for every texel in a world brush, so texel↔feature
correspondence is taken from the SURFACE where it actually exists.
`get_uv_islands` first; its island count IS the classifier.

### Proof-pack discipline: numbers first, then pixels
Every capability claim in 047 carries a machine-checkable number before any
render: explode_view returns `minGapWorld` (negative = overlapping pairs — a
separation verdict with no vision pass), transform_uv previews return bleed
fractions, texture-LoD ladders report per-tier texel densities halving, and
animated round-trips verify the emitted channel count from the GLB JSON chunk.
Renders illustrate; numbers decide. Proof packs live outside the repo
(~/MeshVault_assets/proofs/ + INDEX.md) because GLBs and screenshots are
artifacts, not source.

## Cut-face capping (backlog 051, v0.9.0)

### The rim is a topology diff, not a geometric neighborhood
Plane cuts classify WHOLE triangles by centroid: no vertex lies on the plane,
and rim vertices scatter up to a full triangle's extent off it. Any
"vertices within tolerance of the plane" rim definition is therefore wrong
twice — it misses real rim vertices AND catches pre-existing open boundaries
the plane grazes (sealing holes the user didn't cut). The correct rim is the
set of edges that BECAME open: welded edges with multiplicity 1 on one side
and >0 on the other, from the pre-split classification. Pre-open edges never
qualify by construction.

### Duplicate cap vertices; the rim then locks itself
Caps that reuse rim indices inherit side-wall normals (shading garbage) and
side-wall UVs (stretched garbage), and writing cap UVs onto shared vertices
corrupts the walls. Duplicated rim vertices (same position, cap normal, cap
UV) fix all three — and as a free consequence the rim positions become
multi-member welds, which simplify_region already hard-locks as seams: no new
lock category needed after capping.

### Ear-clip for quality, fan for closure — and RECOUNT
Ear clipping with strictly-convex ears produces quality caps but legitimately
fails on staircase rims with collinear runs (axis-aligned cuts through boxes);
zero-area ears would emit degenerate triangles that fix_mesh later drops,
REOPENING pinholes. A centroid fan closes every rim edge exactly once by
construction (possibly self-intersecting on non-convex loops — cosmetic, not
topological). Ship ear-clip → fan fallback, and report the MEASURED post-cap
openEdges (shared welded semantics), never the assumption. Winding: orient
each loop by projected signed area against the signed classification normal,
in MESH-LOCAL space — closing a mesh ARMS fix_mesh's flipped_faces gate, so an
inverted cap would flip the whole mesh's winding downstream.
Two audit corrections that shipped before the field test:
- EMIT thresholds must EQUAL downstream DROP thresholds: the ear-accept
  epsilon originally sat ~3 orders of magnitude below fix_mesh's degenerate
  cutoff (diag × 1e-7) — caps in the gap would be emitted here and dropped
  there, silently reopening pinholes. Any producer/consumer pair around a
  degeneracy threshold must share ONE rule.
- Cap UVs collapse to ONE loop-anchor UV. Copying each cap vertex's own rim
  UV makes cap triangles INTERPOLATE across the atlas — on fragmented
  photogrammetry atlases that renders as smeared multi-island streaks, the
  exact "stretched garbage" capping exists to kill. One anchor = one flat
  sample of the adjacent surface.

### Field corrections (051 live gauntlet): rims are mod-2, junctions are angular
- **Rim membership is the mod-2 (Z₂) boundary rule, not "exactly one owner".**
  Scanned doubled-shell geometry has cut edges owned by 3+ triangles; the
  naive `sideCount === 1` rule left degree-1 dead ends no loop walk can close
  (a 256-edge permanent hole on the chest re-split). A side's edge BECAME
  boundary iff its side-count is ODD and the pre-split total was EVEN (odd
  totals are pre-existing boundaries — still never sealed). Mod-2 boundaries
  are cycles, so every rim vertex has even degree and a closed-loop
  decomposition always exists.
- **Loop walks continue by ANGLE at junctions.** Re-cutting through an
  existing cap crosses the previous rim's welded ring at 4-degree junctions
  (cap duplicates weld with wall vertices). Rejecting branches as bowties
  skips whole rims; the planar boundary-tracing rule — leftmost turn in the
  cap plane from the incoming direction — decomposes tangent/crossing
  boundaries into simple non-crossing loops. Vertex revisits at junctions are
  legitimate (each occurrence gets its own cap duplicate).
- **Anchor color: median of the rim, not vertex[0].** A fragmented atlas
  makes the arbitrary first rim vertex a color lottery (an olive-gray cap on
  a wooden chest when its texel lands off-island). Sample all rim vertices'
  texels through a small readback canvas (when the base texture is drawable)
  and anchor at the vertex nearest the component-wise MEDIAN — deterministic
  and plausible; unreadable textures (KTX2/GPU-only, tainted) fall back to
  vertex[0].
- **UV-degenerate triangles need their own paint path.** A cap's collapsed
  UVs give zero UV-space area: the barycentric rasterizer emits no texels, so
  caps rejected paint with "Brush touched no surface". Stamp such triangles'
  single texel directly when the brush touches them in WORLD space (closest
  point on triangle, not centroid — cap fans are huge and their centroids sit
  outside small brushes). Painting a cap = flatly recoloring it, honestly
  reflecting its one-texel nature.

## Morph targets via sculpt-pose capture (backlog 049, v0.9.0)

### r170's morph texture rebuilds on COUNT change only
Texture-based morphs cache a DataArrayTexture keyed by morph count —
re-capturing an existing morph (same count, new content) renders the OLD
deltas forever. After any content change: `geometry.dispose()` (its dispose
listener evicts the texture; three re-uploads next frame). Cheap at capture
cadence.

### applyMatrix4 never touches morphAttributes
Vertex bakes (center/ground/rotate/orient) and export-time node-relative
baking transform position/normal/tangent only. Morph deltas are position
DIFFERENCES: the affine part cancels, so they transform by the bake matrix's
linear 3×3 (exact under non-uniform scale; transformDirection would normalize
and destroy magnitudes). The morph BASE transforms by the full matrix.

### The base is its own snapshot, and reset must drop morphs
Deltas are relative to an explicit sculpted base (entry.morphBase) — not the
reset snapshot (the artist sculpts a base first) and not the UI undo slot
(overwritten every gesture). Consequently `reset` (which restores ORIGINAL
positions) must DROP morphs loudly: `original + (pose − sculptedBase)` is a
shape nobody authored. Same for geometry-replacing ops (vertex indexing
changes). "Morphs survive like pivots" is wrong — pivots don't reference
geometry that reset changes.

### Scalar timeline channels: flat keys, and audit every serializer
Morph weights ride the existing per-object track as flat `morph:<name>` keys
(nested objects break every Object.values consumer: durations, ticks, export
scans). Flat is necessary but not sufficient — `k.v.map(...)` crashes on
scalars in get_timeline/serializeTimeline, and delete-all-channels paths that
hard-code ["position","rotation","scale"] leave morph-only tracks undeletable.
When adding a channel KIND, grep every consumer of the channel dictionary.

### Field corrections (049 live gauntlet): budgets, imports, and two spaces
- **Morph GPU cost is per-FRAME, and unbudgeted it wedges the viewer.**
  three's texture-based morph path shades EVERY target on EVERY vertex each
  frame, independent of weights. 8 full-head morphs on 99k vertices made
  each SwiftShader render outlive the command timeout — no rejection, no
  recovery, session dead. Budget vertex×morph products at capture time,
  sized to the MEASURED renderer (UNMASKED_RENDERER_WEBGL: ~512k software /
  8M hardware) with a teaching error (delete poses / simplify BEFORE
  begin_morph). Sparse-delta budgets don't catch this: the cost is dense.
- **Imported glTF morphs are a second morph class: drive-only.** Reloaded
  exports carry dense morphAttributes + mesh dictionaries but no sparse
  masters — set_morph/keyframes must drive them by dictionary (they did not:
  the field's "dead end" bug); capture/delete must refuse honestly; and
  begin_morph must refuse while they exist (rebuildMorphAttributes
  materializes OUR morphs only — capturing would silently discard the
  asset's). Guards must check LIVE mesh influences, not just the session
  weight ledger (paused clips and imported morphs displace the surface
  outside it). Corollary: updateMorphTargets() no-ops on morph-FREE
  geometry — clear dictionaries explicitly when dropping morphs, or deleted
  names stay addressable as ghosts.
- **Brushes must aim at DISPLAYED positions under active morphs.** pick and
  raycast are morph-aware (three applies influences on CPU); the paint
  rasterizer read BASE positions — aim-what-you-see broke exactly on the
  open mouth (96 texels "painted", nothing visible where aimed). Compute
  displayed positions (base + Σ weight × delta, relative AND absolute
  conventions) for paint/heal footprints; refuse base-space donor brushes
  (blur/clone/mirror) while morphed instead of silently mis-sourcing.
- **Every vertex-writing bake must transform the morph base too.** rotate/
  recenter/ground/auto-orient wrote vertices AFTER _bakeWorldTransforms with
  their own matrices — the stored base never saw them, so the next capture
  diffed ALL vertices against a stale base, silently encoding the rotation
  into the morph. One shared morph-aware matrix-application path for all
  bakes; as a bonus applyMatrix4 rotates authored normals exactly instead of
  recomputing (and discarding) them.
- **The pose brush the field asked for is a rotation, not a translation.**
  Radial grabs translate a blob — chins drop but lips smear. `hinge`
  {pivot, axis, angle_deg} rotates the brush region rigidly about a line
  with falloff: selection (center+radius) and transform (pivot+axis+angle)
  are DIFFERENT anatomy (chin vs jaw hinge under the ears). One stamp = a
  believable jaw drop.

## Symmetry healing (backlog 050, v0.8.0)

### Reflected correspondence mirrors content BY ITSELF — a flip step is a bug
`mirror_paint` maps every destination texel to its reflected world position and
samples the source surface there. That map has determinant −1: it reverses
orientation, so a right eye sampled this way arrives as a LEFT eye (tear duct
on the nose side) with zero explicit image math. Composing an additional 2D
"flip the patch" step — which the original design sketch called for — yields
det +1, an orientation-PRESERVING copy: the donor pasted un-mirrored. Flip
steps belong only to sample-rect-then-stamp architectures; per-texel
correspondence has no rect. (Adversarial review caught this before a naive
implementation shipped it.)

### Reflection math lives in wrapper-LOCAL space, or non-uniform scale corrupts it
Reflecting world points across a world-transformed plane normal is only valid
under rotation + uniform scale. The correct world-side map is `W · R · W⁻¹`
(W = wrapper matrixWorld, R = local Householder), and normals go through the
composite's normal matrix `(A⁻¹)ᵀ`. "Local" means WRAPPER-local — meshes
inside the model carry their own node transforms.

### Brush metrics must be reachable, budgets must be loud (050 field lessons)
- A metric whose documented trigger is mathematically unreachable is worse
  than no metric: `selfSourceFraction` counted mirrors within 10% of the
  radius, capping it at ~0.06 for an on-plane disc (expected 4ε/π), so the
  promised "≈1 + note" could never fire. Derive thresholds from the geometry
  of the definition (mirror lands INSIDE the brush → up to ~0.6 on-plane).
- O(texels × candidates) loops need work budgets: a half-head brush ran 6
  silent minutes — indistinguishable from a hang, and agents with timeouts
  kill the session and lose paint state. Budget in naive pair-tests + a
  centroid prefilter (nearest-conceivable-point rejection) for the real cost.
- Zero-result diagnostics must exclude the thing that just failed: the
  cross-mesh hint named the object's OWN single mesh and detoured the agent
  to clone_paint — which refuses mirrored donors by design.
- Detection origins wander with the sample seed (~cm on a head — a smear at
  iris scale): refine the plane offset along its normal with a 1D
  median-distance scan; both seeds then converge to the true plane.

### Geometry-only symmetry detection: score distance AND normal agreement
Median + p90 reflected-point-to-surface distance (BVH; normalized by the local
bbox diagonal) through the AREA CENTROID (bbox centers are biased by one-sided
features like pedestals), plus mean dot(reflected source normal, hit normal) —
positional scores alone accept planes that map surface onto surface with the
wrong orientation (thin plates). On near-perfect shapes every centroid plane
ties (a sphere mirrors across ALL of them): prefer canonical axis planes over
PCA on ties or the choice is float-noise-random. And geometric symmetry never
guarantees TEXTURE symmetry — verify heals with a render. The BVH cache keys
on `geometryRev`; MeshBVH construction REORDERS the geometry index, so
triangle lookups by `faceIndex` must go through the index, never by `f*3`
position order (a sphere scored normalAgreement ≈ −0.29 until fixed).

## Human editing UI over the agent surface (backlog 054, v0.8.0)

### One command surface, two drivers — mutations only
The panels instantiate the app's single `ViewerControlAPI` and route every
MUTATION through it (the E2E suites test `execute()`, so UI edits are covered
transitively). READS must NOT go through it: every successful `execute()`
invalidates the renderer, so a per-pointermove hover pick would force
continuous rendering and defeat the parked 0%-idle-CPU loop. Hover and stroke
sampling use a local `THREE.Raycaster`.

### Input arbitration is a shared flag, not event propagation
Canvas input consumers are split across MOUSE events (click-select, measure)
and POINTER events (OrbitControls, TransformControls) — `stopPropagation` on
pointerdown never reaches the derived mouse listeners. A `viewer._toolMode`
flag consulted by every consumer (precedent: `_measureMode`) is the only
arbitration that works. OrbitControls can stay ENABLED and be disabled AFTER
a synchronous hit-test: rotation happens in pointermove, which re-checks
`enabled` per event — nothing leaks, and misses orbit for free. Capture the
pointer on the CANVAS (capturing an overlay starves OrbitControls' dynamically
bound pointerup and corrupts its tracking). The gizmo is guarded by its
hover-set `axis` property — checkable BEFORE its own pointerdown runs.

### Mode transitions notify from the OWNER, both directions
`navmodechange` was dispatched at →orbit call sites only; nothing announced
→fpv, so tool modes never learned about it and a human could paint while
flying (gauntlet). Per-call-site notification IS the bug class ("some caller
forgot"); the state owner (`setNavMode`) must dispatch on every transition.
The same event then keeps the toolbar icon honest for free when other code
forces a mode.

### Gestures are the human unit; commands are the agent unit — bridge explicitly
The UI slices one drag into many stroke COMMANDS (flush cadence). Anything
with per-command semantics silently degrades to per-slice for humans: undo
undid the last 100 ms slice, painter opacity compounded across slices
(0.05 → ~0.44 over a slow wiggle), and gesture-end feedback starved when the
flush timer drained the buffer before pointer-up. The bridge is an explicit
`undo_group` token on the brush commands: same token = one undo unit AND one
alpha-composition unit (per-texel gesture ledger: `eff = (α−prev)/(1−prev)`
tops each texel up to the target instead of compounding). Public param —
agents batching a logical stroke across ≤64-point calls get the same
semantics. And run gesture-end feedback at gesture end, unconditionally.

### Registry events are the source of truth for chrome
The app's placeholder hid only in file-load flows; objects created through
the control API (agent pushes, primitives) left it covering the canvas — where
it silently ate every pointer event. UI chrome that depends on "is anything
loaded" must track `objectschange`, not load call sites.

### Stroke flush cadence: points-or-time, never per-frame
The engine recomputes whole-geometry normals per COMMAND (~5–15 ms at 120k
triangles). Flushing per animation frame means 60 recomputes/s — 30–90% of
the frame budget, jank exactly while dragging. Buffer radius/2-thinned points
and flush at ≥16 points or 100 ms; fidelity is unchanged (stamp density is
bounded by the thinning, not the flush rate).

### Manifest v2: index-based references, two-pass application
Hierarchy (`parent`), pivots and timeline tracks persist by OBJECT INDEX in
the manifest's objects array, never by live registry id (ids are
session-local) and never positionally against the loaded result (partial loads
shift positions). Application is two-pass: create everything first, then wire
parents/pivots/timeline through the index→id map, so forward references and
per-object load failures degrade without corrupting the rest.

## Adaptive resolution & the observation seat (v0.9.0)

### The resolution trio: refine densifies, simplify coarsens, regularize equalizes
`refine_region` (conformal red-green splits: 2-marked triangles close to red,
thin 1-marked children upgrade to red under a ~12° floor) adds facets where
detail is needed; `simplify_region` removes them where it is not; both lock
seams, open rims and the boundary ring. The third failure class appeared in
the field: heavy grab pulls neither add nor remove facets — they STRETCH them
into long slivers that shade as streaks and smear later paint.
`regularize_region` closes the trio: 4/3-target conformal splits (reusing the
refine pass, so no new crack class) + Jacobi tangential relaxation (move each
interior weld toward its neighbor average, subtract the normal component —
shape preserved to first order, triangle shapes equalized). Relaxation moves
vertices, so normals recompute on commit (the sculpt rule), and texture
drifts slightly where vertices slid within the surface — disclosed in the
result note, tidied with blur_paint/repaint.

### The median of a mixed region lies
Zero-config regularize targets the region's CURRENT median edge — correct on
a homogeneous region ("equalize at the density you have"). But a brush that
covers both a dense crop and a stretched curtain gets a blended median that
marks tens of thousands of edges "stretched"; the split budget dies before
the relaxation matters (field numbers: 36,303 → 35,659 after a full budget).
Same region with an explicit coarse `target_edge`: 430 → 8. Statistics
computed over deliberately mixed populations are not defaults, they are
traps; the command description now teaches the explicit-target escape.

### Command replication is the observation mechanism
The observation seat replays the performer's top-level mutating commands
through the observer's own deterministic engine (per-session ring log,
cursor-based SSE, contiguous seqs, lossy honesty, fingerprint divergence
checks). Native rendering quality for free; the cost is strict determinism —
`capture:true` keyframes canonicalize to explicit values at publish,
`project_paint` carries a camera envelope, and `auto_orient`'s power
iteration needed fixed seeds (Math.random() was genuinely non-replayable).

### Tool visibility: the ring is the tool; words belong in the panel
The first ghost-brush design spawned a fading ring per stamp with a floating
label sprite — reviewers could not tell WHAT tool was active (labels blinked
away with the stamps) and the text cluttered the scene. The shipped model:
ONE persistent cursor (ring + additive falloff disc, scaled to the resolved
world-space radius = the actual area of influence) that GLIDES through the
stroke's stamp points, faint per-stamp trail behind it, and the tool identity
(name, radius, strength/opacity, color swatch) in a dedicated panel readout.
Rule of thumb: geometry communicates WHERE and HOW BIG; the panel
communicates WHAT and HOW STRONG. Text in the 3D scene serves neither.

### Sync Playwright starves callbacks unless the main thread pumps
`expose_function` callbacks (the observe publish relay, including liveness
pings) are dispatched ONLY while the Python main thread is inside a Playwright
call. A performer that waits by `time.sleep()` looks alive to itself while the
hub sees its pings stop and honestly declares the session dead. Any wait loop
in a sync-Playwright process must pump (`page.evaluate("1")`) each iteration.
Async Playwright does not have this failure mode.

### Session lists must never bury the live show
The seat panel rendered every session the hub remembered, dead rehearsals
included, each with an enabled Watch button — the one joinable session sat
below the fold and the user "couldn't join" (their words, with screenshot).
Liveness is part of joinability (a corpse session replays a prefix then hangs
forever: the killed performer never publishes `end`), watchable rows sort
first, dead history collapses to a count, and the list refreshes itself while
open. A list UI whose primary row is findable only by scrolling past garbage
is a broken UI regardless of how correct the data is.

### Local-model pilots: serialize the tools, advise mid-loop
Two field captures from the LM Studio pilot (Qwen 3.6-35B over LangGraph +
MCP): (1) the model batched `describe_scene` alongside `add_primitive` in one
turn — with parallel execution the describe raced ahead and answered from the
PRE-add scene; MeshVault is stateful, so the pilot serializes all tool calls
through one lock (read-after-write order is part of the API contract even if
the transport allows concurrency). (2) A sculpt stamp on a deliberately
coarse sphere "succeeded" with `affected: 1` — a spike, not a shape — and the
model sailed on happily; quantified SUCCESS is not enough when the number is
quietly pathological. Results now carry advisory `note`s (under-sampled brush
→ the exact refine_region fix), and the pilot's prompt says "react to notes,
not just errors". With the note in place the same model self-corrected:
refine → re-pick → re-sculpt (1 → 25 vertices) → regularize (59 → 0
stretched), no human help.

### Brushes are metric maps on frozen topology — remeshing is not optional
The three-adversary review's central finding: every sculpt tool only MOVES
vertices, so triangle quality decays monotonically with editing — grab/hinge
impose linear signed strain, flatten folds, pinch compresses into the weld
quantum, smooth amplifies anisotropy. Splitting alone (the first
regularize_region) cannot recover: needles need COLLAPSE, poles need FLIPS.
The full Botsch–Kobbelt loop (split 4/3 → collapse 4/5 → flip to valence
6/4 → tangential relax) with the no-new-long-edge collapse predicate (without
it split and collapse ping-pong forever) is what "regular coherent graph"
means operationally: stretchedEdges → 0 and valence567Share ≥ 0.9.

### Remesh defaults are a replay-compatibility decision, not a UX one
The observe fingerprint compares EXACT triangle counts. Making sculpt remesh
by default would banner-diverge every existing recording replayed through a
new engine. New geometry-changing behavior must arrive as an explicit
parameter or command (replays carry it byte-for-byte), never as a changed
default — and budgets must be counts, never wall-clock, and decision paths
must avoid transcendentals (compare squared lengths/signed areas; acos is
for reporting) or replays drift by ULPs. A double-replay position-HASH test
now guards this (count fingerprints cannot see position drift).

### Dig is a graph deformation along one fixed axis — every deviation bit us
Four proof-run findings in one evening: (1) profile distance must be LATERAL
(cylindrical) — with 3D distance, dug welds sit "far" and repeated stamps
asymptote instead of deepening; (2) gathering at exactly R sawtooths the rim
on curved domes (rim verts alternately miss) — gather 1.15R; (3) gathering
WIDE (1.5R) reaches the receding flank of a closed surface — verts whose
lateral distance is small only because the cylinder re-enters the dome — and
tears it; (4) the back-sheet filter threshold matters: dot > 0 excluded the
crater's own WALLS (normals hover near perpendicular) and left un-moved
teeth; a true back sheet faces along the axis (dot ≈ +1), so 0.5 separates.
And piercing probes must intersect DOUBLE-SIDED: the far wall of a shell
faces away from the ray, so front-face-only raycasts report infinite
headroom on every shell.

### Displacement brushes have an honest ceiling on photogrammetry shells
The haircut fields: grab can shorten, compact, bury and tidy a hair shell,
but it RELOCATES surface — it cannot delete it. A hanging curtain pulled
"away" reappears elsewhere (downward/inward pulls re-bunch into spikes; the
working direction is toward the volume interior with an upward bias, sharp
small brushes for thin fins). A true "cut everything below this line" needs
geometry REMOVAL (split_object + discard), not displacement. Choreograph
within the tool class or reach for the right one. Related field lesson:
coarse probe detectors converge where fine ones stall — an 11-column ray scan
found 123 targets and diluted 26 passes across them; the 5-column scan found
the 42 worst and finished in 14.
