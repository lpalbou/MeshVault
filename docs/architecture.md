# Architecture

---

## High-Level

```
Frontend (Browser)                    Backend (FastAPI)
┌─────────────────────┐              ┌──────────────────────┐
│ FileBrowser (sidebar)│──── HTTP ───→│ app.py (routes)      │
│ Viewer3D (Three.js)  │   + token    │ security.py (guard)  │
│ App.js (orchestrator)│              │ file_browser.py      │
│ ExportPanel          │              │ archive_inspector.py │
└─────────────────────┘              │ export_manager.py    │
                                     │ fbx_converter.py     │
                                     └──────────────────────┘
```

All `/api/*` traffic passes through `security.py`: a Host allow-list, a session-token
gate, and a `PathGuard` that confines every filesystem access to the allowed root(s).

---

## Backend (17 API endpoints)

### `app.py` — Server
Browse, serve, prepare, export (original + modified + GLB), reveal, rename, duplicate, delete, scan textures, agent bridge (`POST /api/agent/open` + `GET /api/events`). Auto-converts old `.fbx` (version < 7000) → `.obj`. Every filesystem endpoint routes through `security.py`'s `PathGuard`.

### `agent_bridge.py` — Shared session with headless agents
Both halves of the agent↔app bridge (backlog 043): the app side (session file
`~/.meshvault/app_session.json` written at launch; `EventBroadcaster` fanning
`open_asset` messages to app tabs over SSE with bounded queues) and the agent side
(`discover_app_session()` + `push_open_to_app()`, stdlib-only, used by the MCP
`open_in_app` tool and any local script).

### `mesh_compare.py` — Shape registration
Registers two surface point sets (PCA-initialized trimmed ICP + Kabsch), returns
symmetric chamfer/Hausdorff distances (normalized, sampling-floor-corrected), a
similarity classification, and the alignment transform. Shared by the MCP
`compare_models` tool and the app's `POST /api/compare` endpoint — one algorithm, two
front-ends. numpy only.

### `security.py` — Trust boundary
`SecurityConfig` (allowed roots, bind host, session token), `PathGuard` (path confinement + filename sanitization), and ASGI middleware for the Host allow-list and token auth. See [API Reference](api.md#security-model).

### `file_browser.py`
Lists directories + 3D assets (`.obj`, `.fbx`, `.gltf`, `.glb`, `.stl`). Detects related files. Optional root constraint.

### `archive_inspector.py`
ZIP (built-in), RAR (multi-tool fallback), `.unitypackage` (tar.gz with GUID structure). Extracts into a single server-controlled temp base directory.

### `fbx_converter.py`
Pure Python FBX binary parser (v5000–6100) → OBJ converter. Zero dependencies.

### `mcp_server.py` — MCP adapter (optional)
`meshvault-mcp` exposes the viewer to MCP clients (Claude, Cursor) as 8 tools routed
through the control API: `load_model` (URL or local path), `describe_scene`,
`viewer_execute`, `list_viewer_commands`, `get_state`, `compare_models`, `screenshot`
(MCP image content; render presets for cross-session comparability), `open_in_app`
(push model + camera into the running app). Runs the standalone viewer in headless
Chromium behind a loopback, path-confined file server. Optional deps:
`pip install "meshvault[mcp]"`. See [MCP Server](mcp.md).

---

## Frontend

### `app.js` — Orchestrator
Wires everything: file browser, viewer, export panel, agent link. Toolbar toggles (screenshot, nav, grid, axes, wireframe, normals, textures, materials, lights). Model transforms (reload, reset, center, ground, orient, rotate, simplify, normals). Save As modal, texture folder picker, sort, filter, context menu.

### `agent_link.js`
Deep links + live agent push (backlog 043): honors `?path=`/`?dir=` URL params over the
localStorage default (archive members via the `archive!inner` composite key), keeps the
URL in sync while browsing (`replaceState`), and subscribes to `/api/events` (SSE) so
`open_asset` pushes from headless agents load the same file with the agent's camera.

### `file_browser.js`
List + grid view, sort (name/size/type), search filter, inline rename, right-click context menu (rename/duplicate/delete/reveal). Color-coded badges. Remember last directory. Programmatic selection (`findAsset`/`highlightAsset`) and the app-wide `assetKey()` convention.

### `viewer_3d.js`
- **Rendering**: PBR, 5-light + IBL (procedural environment via PMREM), SSAO, ACES, shadows
- **Loaders**: OBJ+MTL, FBX, GLTF/GLB (incl. Draco / KTX2-Basis / Meshopt — decoders vendored locally), STL, PLY, DAE, 3MF, USDZ
- **Navigation**: Orbit + FPV drone with race condition guard
- **Scene**: Grid (adaptive), axes (labeled), normals viz, wireframe
- **Transforms**: Center, ground, PCA orient, rotate ±90°, simplify (merge + edge collapse), smooth normals
- **Textures**: `applyTextureFolder()` with convention + fuzzy matching
- **Materials**: `getMaterialsInfo()` with live references
- **Export**: OBJExporter, screenshot (PNG)
- **Persistence**: Wireframe, grid, axes, normals, background across loads

### `export_panel.js`
Modified → `/api/export_modified` (OBJ). Original → `/api/export`. Auto-refreshes browser.

### `compare.js` + `viewer/heatmap.js`
Shape comparison in the app (backlog 041): right-click an asset → "Compare to loaded
model" samples both surfaces (candidate in a short-lived offscreen viewer), registers
them via `POST /api/compare`, and paints a per-vertex deviation heatmap
(`three-mesh-bvh` closest-distance, unlit colour ramp) on the loaded model + a verdict
panel. One model displayed at a time; the co-loaded multi-object scene is future work.

---

## Viewer core: standalone + control API

The rendering engine (`viewer_3d.js`) is **backend-agnostic**: its only coupling to a server
is an injected `resolveResource(ref) => url` callback (the full app points it at
`/api/asset/related`; a standalone embed returns the ref as-is). This lets the same engine
ship two ways, both built by esbuild (`scripts/build.mjs`):

```
frontend/dist/app.bundle.js        → full MeshVault app (backend-connected)
frontend/dist/meshvault-viewer.js  → standalone, server-less, embeddable viewer
```

### `viewer/control_api.js` — `ViewerControlAPI`
A single, self-describing command surface designed to be driven by AI agents or embedders:

- `execute({action, params})` → `{ok, result|error}` — one JSON entry point; never throws.
- `listCommands()` — every action with its parameter schema (discoverable with no prior knowledge).
- `getState()` / `getSceneInfo()` — JSON snapshots (model, camera+fov+presets, display, animation; per-mesh/material).
- `on(event, cb)` — `loaded`, `error`, `animations`, `measurement`, `executed`.
- Commands: `load`/`unload`, `get_camera`/`set_camera`/`set_view`/`orbit`/`frame`/`reset_camera`/`set_nav_mode`,
  `score_views`/`find_best_view`/`auto_upright` (semantic-front discovery + camera uprighting),
  `focus` (frame a part by stable mesh id / name / world point — rescales clip planes so tiny parts stay visible),
  `set_render_mode` (textured/solid/wireframe/normals)/`set_wireframe`/`set_grid`/`set_axes`/`set_normals`/`set_clip`/`set_fog`/`set_background`/`set_scale`/`set_lighting`/`set_environment`/`get_environment` (IBL),
  `center`/`ground`/`auto_orient`/`rotate`/`simplify`/`recompute_normals`/`reset`,
  `play_animation`/`pause_animation`/`set_animation_time`/`set_animation_speed`,
  `measure`/`set_measure_mode`, `export_obj`/`export_glb`,
  `screenshot`/`capture_views`/`turntable` (hero shots: resolution, transparency, fog/ground/SSAO control),
  `get_state`/`get_scene_info`/`get_bounds`/`describe_scene` (structured text snapshot + geometry QA for text-only agents).
  Model-dependent commands return `{ok:false}` when no model is loaded; unknown params are rejected.
- Agent docs are served at `/llms.txt` (index) and `/llms-full.txt` (full command reference);
  MCP access is documented in [MCP Server](mcp.md).

### `viewer/standalone.js` — `createViewer(container, options)`
Instantiates the engine + control API with a client-only resolver and exposes
`window.MeshVaultViewer.createViewer`. Includes `loadFile(File)` for local drag-drop/file-input
(object URL, no server) and a `destroy()` that fully releases the WebGL context.
Demo/harness: `frontend/viewer.html`.

---

## Rendering Pipeline

```
Scene → Lights (5) → Ground → Grid → Axes → Normals → Model
  → WebGLRenderer (MSAA, ACES, preserveDrawingBuffer)
  → EffectComposer → RenderPass → SSAOPass → OutputPass
```

---

## Model Transform Pipeline

```
Reload   → Re-fetch from disk
Reset    → Restore geometry snapshot
Center   → Bake transforms → bbox center to (0,0,0)
Ground   → Bake → center X/Z → min.Y to 0
Orient   → Bake → PCA eigenvectors → rotate smallest → Y
Rotate   → Bake → ±90° around X/Y/Z
Simplify → Merge vertices → SimplifyModifier → recompute normals
Normals  → Delete normals/UVs → merge → computeVertexNormals
Export   → Modified: OBJExporter → POST /api/export_modified
           Original: POST /api/export
```

---

## State on Model Load

| Resets | Preserves |
|--------|-----------|
| Camera, FPV→Orbit, Scale→1× | Wireframe, Grid, Axes, Normals |
| Transforms, Modified flag | Background, Lights |
