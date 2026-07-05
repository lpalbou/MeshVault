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

## Backend (15 API endpoints)

### `app.py` — Server
Browse, serve, prepare, export (original + modified + GLB), reveal, rename, duplicate, delete, scan textures. Auto-converts old `.fbx` (version < 7000) → `.obj`. Every filesystem endpoint routes through `security.py`'s `PathGuard`.

### `security.py` — Trust boundary
`SecurityConfig` (allowed roots, bind host, session token), `PathGuard` (path confinement + filename sanitization), and ASGI middleware for the Host allow-list and token auth. See [API Reference](api.md#security-model).

### `file_browser.py`
Lists directories + 3D assets (`.obj`, `.fbx`, `.gltf`, `.glb`, `.stl`). Detects related files. Optional root constraint.

### `archive_inspector.py`
ZIP (built-in), RAR (multi-tool fallback), `.unitypackage` (tar.gz with GUID structure). Extracts into a single server-controlled temp base directory.

### `fbx_converter.py`
Pure Python FBX binary parser (v5000–6100) → OBJ converter. Zero dependencies.

---

## Frontend

### `app.js` — Orchestrator
Wires everything: file browser, viewer, export panel. Toolbar toggles (screenshot, nav, grid, axes, wireframe, normals, textures, materials, lights). Model transforms (reload, reset, center, ground, orient, rotate, simplify, normals). Save As modal, texture folder picker, sort, filter, context menu.

### `file_browser.js`
List + grid view, sort (name/size/type), search filter, inline rename, right-click context menu (rename/duplicate/delete/reveal). Color-coded badges. Remember last directory.

### `viewer_3d.js`
- **Rendering**: PBR, 5-light, SSAO, ACES, shadows
- **Loaders**: OBJ+MTL, FBX, GLTF/GLB, STL (+ Blend/MAX handled by backend)
- **Navigation**: Orbit + FPV drone with race condition guard
- **Scene**: Grid (adaptive), axes (labeled), normals viz, wireframe
- **Transforms**: Center, ground, PCA orient, rotate ±90°, simplify (merge + edge collapse), smooth normals
- **Textures**: `applyTextureFolder()` with convention + fuzzy matching
- **Materials**: `getMaterialsInfo()` with live references
- **Export**: OBJExporter, screenshot (PNG)
- **Persistence**: Wireframe, grid, axes, normals, background across loads

### `export_panel.js`
Modified → `/api/export_modified` (OBJ). Original → `/api/export`. Auto-refreshes browser.

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
