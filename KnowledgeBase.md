# Knowledge Base

This file captures critical implementation insights and design logics that are easy to forget and costly to rediscover.

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
  - Flip UV V component on export: $v \leftarrow 1 - v$
  - Force exported textures to `flipY = false`
- For `DataTexture`-style sources (`image.data`), convert to a canvas in **top-to-bottom** row order before export so the PNG bytes match the original image orientation.

This yields GLB textures that match the original images (no vertical flip), and a GLB that round-trips in MeshVault without UV/texture coordinate artifacts.

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
