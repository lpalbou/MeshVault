# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [0.6.0] — 2026-07-09

### Added
- **Scene composition — multi-object scenes (backlog 042, stages 1–4)**. MeshVault grows from "one model at a time" into a scene workbench, designed against two adversarial reviews (architecture + product/security) whose must-fix lists are all implemented:
  - **Object registry (viewer core)**: N objects, each wrapped in a placement `Group`; the `_currentModel` getter keeps all ~90 single-object code paths and helper modules working unchanged against the ACTIVE object (invariant: a non-empty scene always has one). Replace-vs-add load semantics with a scene-generation counter (in-flight adds can never resurrect a replaced scene, adds never cancel each other); per-entry animation (deactivated objects freeze and resume without reset), reset snapshots (retaken after simplify/recompute — fixes the long-standing "reset after simplify" crash), scale/modified flags, and texture-janitor membership checks (co-loaded objects keep their janitor pass).
  - **Placement vs geometry, kept honest**: `set_object_transform`/gizmo edits live ONLY on the wrapper (never baked, saved in manifests); vertex bakes (center/ground/rotate/auto-orient/simplify) operate wrapper-LOCALLY so a placed object's geometry never absorbs its scene position, and are refused for skinned models (they corrupt bind poses). The scene rig (lights, shadows, grid, fog, nav speed) re-sizes from the visible-union box on every composition change, so placed objects never lose shadows; clipping planes and measurement raycasts/markers are scene-wide; best-view/upright scoring hides non-active objects.
  - **App UX**: right-click → "Add to scene"; objects panel (select / show-hide / opacity / reset placement / remove) that auto-surfaces on composition; TransformControls gizmo (move/rotate/scale, T/R/S keys, screen-constant size, hidden in all captures); click-to-select in the viewport; dirty-scene confirm before any replace (sidebar click, drag-drop, scene open); scene save via `.mvscene` with overwrite protocol.
  - **Persistence**: version-1 `.mvscene` manifests (per-object source descriptor file/archive/url + TRS transform + visibility/opacity + scene lighting/environment/background). `POST /api/scene/save` follows the repo's safe-write contract (sanitized name, FORCED suffix, 409 without `overwrite`, only-scene-files overwritten, 128-object/2 MB caps); `GET /api/scene/load` validates and returns the manifest, objects re-resolve client-side through the guarded asset routes (per-object degradation, no server-side probe loop). Scene files list in the browser, load on click, and deep-link via `?scene=`. Volatile sources (drag-drops) are excluded from manifests and reported.
  - **Agent/MCP parity**: `load_model {add:true, transform}` composes headless; new `save_scene`/`load_scene` tools (11 total); new viewer commands `add_model`, `list_objects`, `set_active_object`, `set_object_transform/visible/opacity`, `get_object_transform`, `reset_object_transform`, `remove_object`, `frame_all`, `get_scene_manifest`; `describe_scene`/`get_state` gain additive `scene` sections with explicit active-object framing so agents never mistake one object's counts for the scene; `compare_models` refuses to destroy a composed scene (save first). GLB export includes every visible object with placements applied, reading AUTHORED materials (never clay/ghost viewer overrides).
  - E2E-verified in both front-ends: browser (compose → place → gizmo → save → `?scene=` reload → 2.6 MB composed GLB export) and MCP (compose with transforms → save → wipe → `load_scene` → placements exact to 4 decimals → framed scene render under a pinned preset).

### Fixed
- **Reset-after-simplify crash** ("offset is out of bounds", documented since 2026-07-06): reset snapshots are per-object and retaken after geometry-replacing operations; Reset now honestly undoes transform bakes since the last geometry-modifying op.
- **Exports no longer bake viewer display state into assets**: GLB export reads the stashed original materials (a clay-mode export previously shipped clay materials) and authored opacity (a ghosted object no longer exports as transparent).

## [0.5.0] — 2026-07-09

### Fixed
- **Multi-file models now load TEXTURED in the headless/MCP runtimes** (confirmed defect from the adversarial review). Three coordinated root-cause fixes, none of them MCP-specific hacks: (1) the MCP loopback server now serves a registered model's **directory companions** under its unguessable token (`/models/<token>/<name>` — relative MTL/texture/`.bin` refs resolve like normal sibling URLs; confined to the model's directory, traversal-checked); (2) the standalone viewer's default resolver resolves relative resource refs against the **model's own URL directory** (the platform behavior) instead of the host page, and the control-API `load` command accepts `relatedFiles`; (3) `load_model` discovers companions server-side (OBJ→`mtllib` parsing with same-stem fallback, FBX→bounded texture scan). E2E-proven with a real MCP client: textured OBJ+MTL+PNG renders red (pixel-verified), external-buffer `.gltf`+`.bin` loads.
- **Texture race stripped in-flight textures in ALL runtimes** (root cause of the above, and a live race in the app for small models): `_isUsableTexture` treated *still-loading* http(s) textures as unusable, so `_enhanceModel` dropped them whenever the mesh parsed before its textures decoded — always the case over loopback. Textures are now classified pending vs **definitively broken** (completed with zero natural size), pending ones are preserved, and a one-shot janitor pass after load settles clears only genuinely failed slots (404/decode) so those materials fall back to base color.

### Added
- **`GET /api/screenshot` — headless renders over plain HTTP** (the external FR's third ask). One authenticated GET returns a PNG of a local model: `view`/`azimuth`+`elevation`/`best_view` camera control, `preset=studio|neutral|dark|none` (full lighting/background pinning, shared with MCP), `width/height/transparent/hide_ground/fill`. Render metadata in the `X-MeshVault-Screenshot` header. Implementation per the adversarial review: harness on the app's own origin (PathGuard + multi-file resolution inherited from `/api/asset/*`), guard + 512 MB size cap BEFORE any browser work, single-flight lock (429 when busy), hard timeout (504, `MESHVAULT_SCREENSHOT_TIMEOUT`), per-request unload+reload+preset re-pin (no state bleed), distinct 503s for missing playwright vs missing Chromium, browser closed in app lifespan. Measured 8–17 s per call on software GL. New modules: `backend/headless_viewer.py` (shared Playwright runtime + `LocalModelServer` + presets + companion discovery — also the seam for a future batch-render CLI, backlog 024) and `backend/screenshot_api.py`; the MCP server now composes the same runtime.
- **`get_app_state` MCP tool + `GET/POST /api/agent/state` — the reverse co-review bridge.** App tabs report what the human is looking at (asset path, name, camera; ~2 s cadence, deduplicated); an agent joining the session reads it back and continues headless (`load_model` the path, `set_camera` the pose). E2E-verified live: tab camera moves were reflected within one reporting tick, and a real MCP client reproduced the human's exact view.

## [0.4.0] — 2026-07-08

### Added
- **Shared session between headless agents and the app (agent bridge)** — the MCP server and the browser app are separate processes; agents could inspect a model that the human co-reviewer couldn't see. Now: the app publishes `{url, token}` to `~/.meshvault/app_session.json` (0600, pid-checked cleanup) at launch; the new MCP tool **`open_in_app`** discovers it and POSTs the agent's current model path + camera pose to the new **`POST /api/agent/open`** endpoint (PathGuard-confined, token-authenticated, camera payload validated at the boundary), which fans out to every open app tab over the new **`GET /api/events`** SSE stream (session-cookie auth — `EventSource` can't set headers; bounded per-client queues so a wedged tab can't grow server memory). The tab loads the same file through the normal asset flow (related files, recents, export state intact) and applies the agent's exact camera; if the model is already on screen, only the camera moves. Returns `{clients, deep_link}` — when no tab is connected, the deep link reproduces the push. E2E-verified: real MCP client → real server → real browser tab, camera position matching to the millimeter. Example: `examples/mcp/co_review.py`.
- **URL deep links in the local app (`?path=` / `?dir=`)** — URL parameters now win over the localStorage "last directory" default: `/?dir=/abs/folder` opens a folder; `/?path=/abs/model.glb` opens the parent folder, highlights the asset in the sidebar, and loads it; `/?path=/abs/pack.zip!inner/model.obj` does the same for archive members (the app's composite asset key). The URL stays in sync while browsing (`replaceState`), so the address bar is always a shareable link to the current view. Paths are matched exactly first, then by basename within the browsed directory (the server canonicalizes paths — `/tmp` vs `/private/tmp` on macOS would otherwise break caller-spelled links). Invalid links toast an error and fall back to the normal start. New frontend module `frontend/js/agent_link.js`; `FileBrowser` gained `findAsset`/`highlightAsset`/`setNavigateListener` and the shared `assetKey()` helper (now also used by recents).
- **Reproducible screenshot presets over MCP (`screenshot { preset }`)** — `"studio"` / `"neutral"` / `"dark"` pin **every** pixel-affecting lighting/background variable (IBL enabled+intensity, key/fill/ambient intensities, key direction, exposure, background) to documented values before capture, so renders are comparable across sessions, machines, and agents even when a session tweaked its lights first. Measured cross-session reproducibility on SwiftShader: mean per-channel diff 0.03/255 after deliberately sabotaging the second session's lighting. Preset values documented in `docs/mcp.md`.
- **`set_camera` viewer command (via `viewer_execute`) now accepts `fov`** (degrees, 1–179) so a camera pose captured with `get_camera` in one session can be reproduced exactly in another (used by the agent bridge).
- **Real CLI for the `meshvault` entry point** — `--help` prints usage + the environment-variable reference instead of starting the server (external tester finding), `--version` prints the version, `--port` overrides `$PORT`.

### Fixed
- **Stale session file after an unclean death (external tester finding)** — a SIGKILLed app can't remove `~/.meshvault/app_session.json`, and the leftover file pointed agents at a port where an older instance answered (404 chase). Two-sided fix: (1) the file is now published only **after** the server has actually bound its port (a launch that fails to bind publishes nothing and can't clobber the live instance's file), and (2) `open_in_app` discovery pid-probes the file's publisher (`os.kill(pid, 0)`, POSIX) — a dead publisher is reported as `stale session file (pid N dead)`, the file is cleaned up, and the tool tells the human to restart the app. Pushes that reach an older MeshVault without the bridge now get a specific "older MeshVault (< 0.4) still running — restart it" error instead of a bare 404.
- **Graceful shutdown with open SSE tabs** — uvicorn's default shutdown waits for active connections indefinitely, so Ctrl-C hung while an app tab was connected to `/api/events`; bounded with `timeout_graceful_shutdown=3` (verified live).
- **`docs/api.md` drift**: removed the stale claims that `/docs` Swagger UI is available (it is deliberately disabled, along with `/openapi.json` — now stated explicitly for script agents) and that `?token=` query auth is accepted (deliberately rejected; use headers).

## [0.3.1] — 2026-07-07

### Fixed
- **MCP extra installs a working server**: the optional `mcp` dependency floor is now `>=1.28` — older SDK versions (e.g. 1.12) that pip could previously resolve crash on import with `TypeError: issubclass() arg 1 must be a class` when registering tools with `dict | None` parameters. Found by verifying `pip install "meshvault[mcp]"` from PyPI in a clean environment.

## [0.3.0] — 2026-07-06

### Added
- **MCP server (`meshvault-mcp`)** — agents on Claude/Cursor/any MCP client can now drive the viewer natively. A thin 6-tool surface (`load_model`, `describe_scene`, `viewer_execute`, `list_viewer_commands`, `get_state`, `screenshot`) routed through the existing control API, hosted in a headless Chromium page behind a loopback file server. `load_model` accepts an http(s) URL **or an absolute local file path** (local files are served under unguessable tokens; CORS-blocked URLs fall back to a size-capped server-side download) and returns the load result plus a full scene description in one call. Screenshots come back as real MCP image content, with a `best_view` option for one-call hero shots. Optional install: `pip install "meshvault[mcp]"` + `playwright install chromium`; docs in `docs/mcp.md`. Adversarially reviewed (protocol-clean stdio, crash-free under abuse, no orphan processes, path-confined loopback server).

- **Part-level exploration (`focus`)** — `describe_scene`/`get_scene_info` now give every mesh a stable `id` plus its world-space `center`/`size`, and the new `focus { id | name | point }` command frames that part: it keeps the current view direction, retargets the orbit controls, and rescales the clip planes/zoom limits so even a 1 cm part on a 10 m assembly is visible (previously it vanished behind the near plane — verified pixel-counted). Name matching is tiered (exact > case-insensitive > substring, meshes + groups) with candidate-listing errors; `reset_camera` returns to the whole-model view. Designed down from two adversarial reviews: ids over names (real-world mesh names are mostly meaningless), no auto view-direction/occlusion magic (delegated to `set_clip`/`wireframe`, documented).

- **Shape comparison in the app — deviation heatmap** (backlog 041 v1) — right-click any asset → "Compare to loaded model": MeshVault registers the two shapes (reusing the same Python engine as the MCP `compare_models` tool, via a new `POST /api/compare`) and paints a per-vertex **deviation heatmap** on the loaded model (blue = matches, red = differs), with a verdict panel (identical/near-identical/modified/different, shape-difference %, scale, rotation, missing-region and borderline/mirror warnings). The candidate is sampled in a short-lived offscreen viewer — only one model is displayed. Heatmap uses `three-mesh-bvh` (app bundle only; the standalone/agent bundle is unaffected). The multi-object co-loaded scene (v2) remains proposed.
- **`compare_models` — geometric 1-vs-N model comparison via shape registration** — compares one reference against up to 8 candidates by REGISTERING their surfaces (deterministic area-weighted sampling → PCA-initialized trimmed ICP → symmetric chamfer/Hausdorff normalized by the reference bbox diagonal, floor-corrected for sampling noise), not by screenshots. Reports per candidate: alignment (scale ratio — catches unit mismatches, rotation, translation), distances (+ asymmetry flagging missing/extra regions), a classification (identical / near_identical / same_shape_modified / different) with a `borderline` flag and `warnings` (mirror detection, near-boundary, partial-overlap), structural deltas, and a similarity ranking. Backed by the new `sample_points` viewer command and `backend/mesh_compare.py` (numpy only). Adversarially reviewed by 4 agents (18/18 correct on real assets; transform recovery exact) with found issues fixed: floor-input validation, p95-tail classification for local edits, trimmed ICP for partial overlap, ICP off the event loop, mirror flagging. Unit-tested in `tests/test_mesh_compare.py`; example in `examples/mcp/compare_shapes.py`.
- **`get_mesh_stats` — numeric surface-quality statistics** — per-mesh + total surface area, volume (null for open meshes, where signed-volume sums are origin-dependent), edge-length distribution, sliver %, dihedral roughness, defect counts, and `issuePoints`: world-space defect locations an agent can `focus` on. Verified against trimesh ground truth (exact to the emitted precision on closed meshes). Budget-bounded at 300k triangles.
- **Material truth for agents** — `describe_scene` materials now report per-slot texture facts ({width, height, colorSpace}) and, whenever the viewer's preview clamps altered PBR values, the asset's ORIGINAL values (`authored` + `modifiedByViewer`). Viewer-created STL/PLY default materials are excluded (they have no authored data). Material names now survive the upgrade path.
- **MCP multi-view capture** — `screenshot` accepts `views: ["front","left","45,20", ...]` (max 12/call) and returns the images in order behind a JSON metadata block; `best_view: true` now returns the chosen azimuth/elevation/score instead of discarding them.
- **MCP usage examples** — `examples/mcp/`: four runnable agent workflows (inspect, compare iterations, explore parts, hero shots) plus the shared 40-line client helper, with a README documenting a real multi-model investigation session.

### Fixed
- **MCP: concurrent `load_model` calls no longer cross-contaminate** — the load→describe pair is serialized per session, so parallel loads each return the description of their own model (found by the multi-agent field test).
- **Measurement overlay is now clearable** — new `clear_measurement` command, and `set_measure_mode {enabled:false}` always removes the markers/line/label (a programmatic `measure` previously polluted every subsequent screenshot).
- **A failed load no longer discards the current model** — `loadModel` now fetches and parses the new file first and only then swaps models, so a bad URL/path leaves the loaded scene intact (previously the viewer cleared immediately and a failed load ended in an empty scene).
- **Transforms no longer corrupt quantized glTF** — `rotate`/`center`/`ground` bake world transforms into vertex buffers; on KHR_mesh_quantization models (normalized Int16/Uint16 positions, common with KTX2/Meshopt assets) that wrote world-scale floats into integer arrays and destroyed the geometry. Attributes are now dequantized to Float32 before baking.
- **`describe_scene` — structured scene snapshot for AI agents** — one command returns everything a text-only agent needs to reason about the loaded model without screenshots: a plain-language summary, live inventory (meshes/materials/textures/triangles — recomputed from the current buffers, so correct after simplify/rotate), world bounds + a format-aware size hint (glTF units are meters per spec), a capped hierarchy outline, the largest meshes, asset materials (accurate even while a solid/normals render-mode override is active), and the current camera/render state. Includes geometry QA (backlog 031 folded in): missing normals/UVs, degenerate faces (relative sliver test), watertightness and non-manifold edges computed on position-welded vertices (UV seams don't false-positive), flipped normals via signed volume, NaN positions, and scale sanity — skipped with an explicit `checks_skipped` note above a 300k-triangle budget so the call stays sub-millisecond on huge scenes. Verified against trimesh ground truth (zero false positives), token-bounded (~2 KB), deterministic, and mutation-free (pixel-identical viewer state before/after).
- **Compressed glTF support (Draco / KTX2-Basis / Meshopt)** — `GLTFLoader` now runs with all three decoders wired, so compressed `.glb`/`.gltf` (a large share of real-world models, especially pasted-URL loads in the web viewer) open correctly instead of failing. Decoder assets are **vendored locally** (`frontend/vendor/`, ~1.3 MB, served at `/static/vendor/`, copied into the Pages site) — no CDN, verified fully offline in the app, the standalone bundle, and a `/repo/` base-path simulation. Decoders are created once per viewer (bounded worker pools, disposed on `destroy()`), and grid thumbnails share them so compressed models get previews too. Loader failures now produce readable messages (no more `[object Object]`).
- **Image-based lighting (IBL)** — a procedural studio environment (`RoomEnvironment` → PMREM, no HDRI asset to ship) lights PBR materials with real reflections; metallic models no longer read flat. On by default at intensity 1 with the existing key/fill/ambient rig kept as the baseline; turning it off restores the exact pre-IBL look. Agent-controllable via `set_environment { enabled, intensity: 0..5, asBackground }` / `get_environment`, reported in `getState().display.environment`. The matte **solid** render mode suspends the environment so the clay view stays readable, and disabling IBL also clears an environment background. Adversarially verified: monotonic intensity response, model readable from the environment alone with all analytic lights at zero, PMREM resources freed on `destroy()`.
- **Light static web viewer + GitHub Pages CI/CD** — `web/index.html` is a client-only landing page (drag-drop / file-open / `?src=<url>`) that loads the self-contained `meshvault-viewer.js` bundle and exposes the control API on `window.mv`. `.github/workflows/pages.yml` builds the bundle and publishes `web/` to the `gh-pages` branch (also deployable to a separate repo — see `web/README.md`).
- **Render modes clarified to three first-class views** — `set_render_mode { textured | solid | wireframe }` (+ `normals`); the viewer toolbar button now cycles mesh+texture → mesh → wireframe with a T/M/W badge.
- **Standalone embeddable viewer + control API for AI agents** — the rendering core is now decoupled from the backend (a single injected `resolveResource()` seam) and shipped as a second, server-less bundle (`frontend/dist/meshvault-viewer.js`, demo at `/static/viewer.html`). `createViewer(container)` returns a `ViewerControlAPI` with one JSON entry point `execute({action, params}) → {ok, result|error}`, self-describing `listCommands()`, observable `getState()` / `getSceneInfo()` / `get_bounds` (world bounding box), and events (`loaded`, `error`, `animations`, `measurement`). Commands that need a model return `{ok:false}` when none is loaded; unknown params are rejected; every error is structured (never throws). `window.MeshVaultViewer.createViewer` is exposed for agent bridges.
- **Hero-shot / capture toolkit** (driven headlessly by an agent to produce front/left/right/back shots): `screenshot {width, height, transparent, fog, hideGround, ssao}` (explicit resolution, alpha cutouts, fog suppressed by default, renders through the SSAO/tone-mapping composer for quality); `capture_views` (presets and/or `{azimuth,elevation}`, auto-hides grid/axes+fog); `turntable {frames, elevation}`; `orbit {azimuth, elevation, fill}`; `set_view`/`frame` gained a `fill` tightness control and `frame` now keeps the current view direction; `set_lighting {azimuth, elevation, key_intensity, fill_intensity, ambient, exposure}`. Captures fully restore the interactive view (size, aspect, SSAO resolution, background, fog, ground).
- **Robust teardown** — `destroy()` now removes the canvas, force-loses the WebGL context, disposes controls/SSAO/composer, and detaches all container listeners (verified: 18 create/destroy cycles leave 0 leaked canvases/contexts).
- **Mesh ops fixed for interleaved geometry** — simplify and recompute-normals now clone/de-interleave before merging, so GLBs with interleaved buffers no longer crash or render black; the operation is atomic (a failure leaves the mesh unchanged).
- **Offline, self-contained frontend bundle** — Three.js is now bundled locally via esbuild (`npm run build` → `frontend/dist/app.bundle.js`) instead of loaded from jsdelivr. The app works fully offline, has no CDN/importmap dependency, and needs no Subresource Integrity. Verified: with all non-localhost requests blocked, the app boots and the viewer initializes with zero external requests.
- **Grid thumbnails** — grid view now renders real previews of each asset (client-side Three.js render), cached in the **browser** (IndexedDB, keyed by path+size+mtime). Lazy: only cards scrolled into view render; second visits load from the browser cache. No server-side state.
- **Animation playback** — GLB/FBX/Collada animation clips get a transport bar (play/pause, scrub, speed, clip selector); the bar auto-hides for non-animated models.
- **More formats** — added `.ply`, `.dae` (Collada), `.3mf`, and `.usdz` (read-only) loaders.
- **Drag-and-drop & recent files** — drop a model onto the viewer to preview it (in-memory, no filesystem write); a Recent list gives one-click reload of the last 12 assets.
- **Measurement** — point-to-point distance on the model surface (toolbar toggle), plus the existing bounding-box dimensions readout.

### Deferred (built, then parked)
- **Cross-folder library index / search / tags / collections** were implemented (SQLite) and reviewed, then parked as speculative (no proven large-library need; server-side state conflicts with the light/hybrid direction). Working code preserved under `parked/`; tracked as `docs/backlog/proposed/015`, `016`.

### Security
- **Trust boundary (`backend/security.py`)**: introduced a single `PathGuard` that confines every filesystem endpoint to an allowed root, closing the previous arbitrary file read/delete/write and path-traversal exposure. Added session-token auth on all `/api/*` routes and a Host allow-list (DNS-rebinding protection).
- **Loopback by default**: the server now binds `127.0.0.1` instead of `0.0.0.0`. Non-loopback binds are opt-in via `MESHVAULT_HOST` and print a warning. Configurable via `MESHVAULT_ROOT`, `MESHVAULT_HOST`, `MESHVAULT_TOKEN`, `MESHVAULT_ALLOWED_HOSTS`, `MESHVAULT_NO_AUTH`.
- **File access default preserves the original "browse anywhere" behavior**: the whole filesystem is reachable (browser opens at home); `MESHVAULT_ROOT` now *restricts* access rather than being required. The real privacy guarantee is loopback + token + Host allow-list; path confinement is opt-in hardening.

### Fixed
- **`/api/default_path`**: fixed a stacked-decorator bug that made the route return `422`; it now returns the default browse path.
- **Mesh ops preserve UVs**: "recompute smooth normals" and "simplify" no longer discard texture coordinates. Vertices are merged by position **and** UV, so textured meshes stay textured and smoothing correctly stops at genuine UV seams.
- **Docs reconciled with code**: removed advertised `.blend`/`.max` support and the non-existent `blend_converter.py` (never implemented). Corrected the endpoint count (15) and documented `/api/export_glb`.
- **GLB export**: Corrected texture coordinate convention to match glTF spec (upper-left UV origin) by flipping $v \rightarrow 1-v$ for exported UVs and exporting textures with `flipY=false`. This fixes vertically flipped textures and restores texture fidelity on round-trip export (e.g., `Asteroid_1.fbx` from `uploads_files_775776_asteroid_pack_2.zip`).
- **GLB export**: Fixed AO UV set export (`uv2` / `TEXCOORD_1`) — previously attempted to use a non-standard `uv1` attribute.
- **Dev**: Repaired the GLB visual regression harness (`test_glb_export.mjs` + `test_compare.py`) and added an optional pytest integration test (skipped by default).

## [0.1.0] — 2026-02-11

Initial public release of MeshVault.

### What is this project?

MeshVault is a local tool for 3D artists and game developers to browse, preview, transform, and export 3D models. Runs in your browser, stays on your machine.

### Formats
- **3D**: `.obj` (+MTL/textures), `.fbx` (v7000+ native, older auto-converted), `.gltf`/`.glb`, `.stl`, `.blend` (via Blender CLI), `.max` (detection only)
- **Archives**: `.zip`, `.rar` (multi-tool fallback), `.unitypackage` (native parser)

### File Browsing
- Sidebar tree with list/grid view, sort (name/size/type), search filter
- Right-click context menu: inline rename, duplicate, delete, show in file manager
- Remember last directory across sessions (localStorage)
- Color-coded badges per format

### 3D Viewer
- PBR rendering: 5-light setup, SSAO, ACES tone mapping, soft shadows
- Orbit + FPV drone navigation with smooth mode transitions
- 8-button viewer toolbar: screenshot, grid (adaptive), XYZ axes (labeled), wireframe, normals viz, texture folder picker, material inspector (draggable), light panel
- All scene settings persist across model loads
- Race condition guard for rapid asset switching
- FBX preview stabilization: normalize near-black textured multipliers, clamp extreme metalness without IBL, and sanitize accidental ultra-low opacity materials
- FBX fallback texture binding: when FBX files omit texture links, MeshVault now auto-binds related extracted textures by naming conventions (`_d`, `_n`, `_ao`, etc.)
- Robust texture fallback upgraded: per-material scoring, numeric token matching (`01` ↔ `1`), OpenGL-vs-DirectX normal preference, and native TGA loading support
- FBX resource resolver now maps relative/absolute texture references to `/api/asset/related` using source file path, fixing wrong requests like `/api/asset/*.jpg`
- Missing/broken texture references are now sanitized before shading fallback so dark materials are still made readable
- Fixed FBX regression: internal model URL (`/api/asset/file?...`) is no longer rewritten to `/api/asset/related`, preventing load failures
- FBX fallback now detects likely non-color diffuse assignments (e.g. gloss/spec `_g`) and can rebind to better color maps when available
- Emissive textures are now classified/bound in fallback and preserved during legacy material → PBR upgrade
- Rotation robustness improved for multi-part models: rotate now applies one world-pivot transform to the whole object, preventing per-part origin drift
- Bake-world-transform now safely clones shared geometries before baking to avoid double-transform corruption on reused mesh buffers
- Recenter/ground/auto-orient/reset now re-sync spatial state (axis anchor, ground plane, grid, light target, stats) after transforms without changing camera pose
- Recenter now aligns model center-of-gravity (vertex centroid) to world origin; ground now shifts only vertically so lowest point sits on Y=0
- Scale now counts as a model modification for Save/Export decisions, so scaled models export through modified OBJ flow correctly
- Filesystem export now gracefully handles source==destination paths (no SameFile copy error on Save to same file)
- Scale slider upgraded to 0.05×–10× with improved visual styling and filled-progress track

### Model Transforms
- Reload, reset (geometry snapshot restore), center, ground, PCA auto-orient, rotate ±90° per axis
- Mesh simplification: merge vertices → edge collapse (SimplifyModifier) → recompute normals
- Recompute smooth normals (merge + computeVertexNormals)
- Processing overlay for heavy operations

### Textures
- Texture folder picker: scan folder recursively, match by convention (`{name}_diffuse.png`) + fuzzy name matching (case-insensitive)

### Material Inspector
- Draggable floating panel listing all PBR materials
- Live material references (foundation for future material editor)

### Export
- Save As dialog with folder browser, filename pre-filled with original name + extension
- **GLB export (new)**: single self-contained file with geometry, PBR materials, and textures embedded — powered by Three.js GLTFExporter
- Format selector in Save dialog: **Original** (copy source), **OBJ** (geometry only), **GLB** (full scene)
- "Original" option auto-disabled when model has been modified (transforms/simplification/normals)
- Modified models also exportable as OBJ (transforms baked via Three.js OBJExporter)
- File browser auto-refreshes after save

### UI/UX
- Professional dark theme, glassmorphic panels, favicon
- Screenshot button (PNG download)
- 12 background presets (neutral + tinted), adaptive grid colors
- Scale slider 0.05×–5.0×
- Resizable sidebar, GitHub link, author credit
- Material inspector now closes on outside click (while remaining draggable)
- Save shortcut: `Ctrl+S` / `Cmd+S` opens Save dialog (or confirms save if already open), exporting modified geometry when applicable

### Backend
- FastAPI with 14 REST endpoints
- Blender CLI integration with auto-detection (macOS/Windows/Linux paths)
- Unity package parser (GUID-based tar.gz structure)
- FBX 6100 binary parser (zero-dependency OBJ converter)
- Temp file management with auto-cleanup
- RAR extraction self-heals 0-byte stale files and falls back cleanly to CLI extraction
- Archive-served assets now use no-cache headers and versioned file URLs to prevent stale browser payloads
- Archive related-file matching now uses strict stem token matching (avoids false links like `asteroid_1` → `asteroid_10`)
- Archive related-file discovery now includes robust fallback to shared texture directories (`images/`, `sourceimages/`, etc.) for packs that separate scenes and textures
- Direct FBX browse now includes nearby texture candidates (same folder + common texture subfolders) to recover broken absolute texture links via basename matching

### Developer Experience
- Frontend bundled with esbuild into a self-contained offline bundle (Three.js vendored, no CDN)
- Poetry + PyPI + NPM packaging
- GitHub Actions CI (Python 3.10–3.13, Ubuntu + macOS)
- 12 unit tests, full documentation suite, backlog tracking

[0.1.0]: https://github.com/lpalbou/meshvault/releases/tag/v0.1.0
