# Architecture

---

## High-Level

```
Frontend (Browser)                    Backend (FastAPI)
┌─────────────────────┐              ┌──────────────────────┐
│ FileBrowser (sidebar)│──── HTTP ───→│ file_browser.py      │
│ Viewer3D (Three.js)  │              │ archive_inspector.py │
│ App.js (orchestrator)│              │ export_manager.py    │
│ ExportPanel          │              │ fbx_converter.py     │
└─────────────────────┘              │ blend_converter.py   │
                                     └──────────────────────┘
```

---

## Backend (14 API endpoints)

### `app.py` — Server
Browse, serve, prepare, export (original + modified), reveal, rename, duplicate, delete, scan textures. Auto-converts `.blend` → `.glb` (Blender CLI) and old `.fbx` → `.obj`.

### `file_browser.py`
Lists directories + 3D assets (`.obj`, `.fbx`, `.gltf`, `.glb`, `.stl`, `.blend`, `.max`). Detects related files. Optional root constraint.

### `archive_inspector.py`
ZIP (built-in), RAR (multi-tool fallback), `.unitypackage` (tar.gz with GUID structure).

### `blend_converter.py`
Finds Blender CLI (PATH, macOS app bundle, Windows Program Files). Runs `blender --background --python export.py` to convert `.blend` → `.glb`. Caches results.

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
