# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [Unreleased]

### Added
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
