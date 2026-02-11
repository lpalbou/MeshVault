# Architecture

System design, component breakdown, and key design decisions of MeshVault.

---

## High-Level Architecture

```
┌──────────────────────────────────┐
│          Frontend (Browser)       │
│  ┌───────────┐  ┌──────────────┐ │
│  │ File      │  │ Viewer3D     │ │
│  │ Browser   │  │ (Three.js)   │ │
│  └─────┬─────┘  └──────┬───────┘ │
│  ┌─────┴───────────────┴───────┐ │
│  │       App.js (orchestrator) │ │
│  └──────────────┬──────────────┘ │
│  ┌──────────────┴──────────────┐ │
│  │     ExportPanel             │ │
│  └─────────────────────────────┘ │
└────────────────┬─────────────────┘
                 │ HTTP (REST API)
┌────────────────┴─────────────────┐
│          Backend (FastAPI)        │
│  ┌───────────┐  ┌──────────────┐ │
│  │ File      │  │ Archive      │ │
│  │ Browser   │  │ Inspector    │ │
│  └───────────┘  └──────────────┘ │
│  ┌───────────┐  ┌──────────────┐ │
│  │ Export    │  │ FBX          │ │
│  │ Manager   │  │ Converter    │ │
│  └───────────┘  └──────────────┘ │
└──────────────────────────────────┘
```

---

## Backend Components

### `app.py` — FastAPI Server (12 endpoints)

- Browse, serve files, prepare archives, export (original + modified)
- Reveal in file manager, rename, delete, duplicate
- Auto-convert old FBX (< 7000) to OBJ

### `file_browser.py` — FileBrowser

- List directories + 3D assets (`.obj`, `.fbx`, `.gltf`, `.glb`, `.stl`)
- Detect related files (`.mtl`, textures)
- Optional root path constraint

### `archive_inspector.py` — ArchiveInspector

- ZIP/RAR inspection + multi-tool extraction fallback
- `rarfile` → `bsdtar` → `unrar` → `7z` → `unar`

### `export_manager.py` — ExportManager

- Copy/rename assets (single file or folder with derivatives)

### `fbx_converter.py` — FBX Converter

- Parse FBX binary (v5000–6100), extract geometry, convert to OBJ

---

## Frontend Components

### `app.js` — Orchestrator

- Wire all components: file browser, viewer, export panel
- Toolbar: nav mode, grid, axes, wireframe, normals, materials, lights
- Model transforms: reload, reset, center, ground, orient, rotate, simplify, normals
- Save As modal with folder browser
- Sort selector, search filter, grid/list toggle
- Context menu (rename, duplicate, delete, reveal)
- Processing overlay for heavy operations

### `file_browser.js` — FileBrowser UI

- List + grid view with localStorage persistence
- Real-time search/filter (case-insensitive, client-side)
- Sort: name (A–Z/Z–A), size (↑/↓), type — persisted
- Inline rename, right-click context menu
- Color-coded badges: OBJ (green), FBX (orange), GLTF (cyan), STL (violet), archived (purple)

### `viewer_3d.js` — Viewer3D

- **Rendering**: PBR materials, 5-light setup, SSAO, ACES tone mapping
- **Loaders**: OBJ+MTL, FBX, GLTF/GLB, STL
- **Navigation**: Orbit (OrbitControls) + FPV drone (keyboard + mouse look)
- **Scene helpers**: Grid (scales to model, adapts to bg), XYZ axes with labels, normals visualization (VertexNormalsHelper)
- **Model transforms**: Center, ground, PCA orient, rotate ±90°, reset (geometry snapshot restore)
- **Mesh operations**: Simplify (SimplifyModifier with vertex merging), recompute normals (merge + smooth)
- **Material inspector**: `getMaterialsInfo()` with live material references
- **Export**: OBJExporter for modified geometry
- **Persistence**: Wireframe, grid, axes, normals, background survive model loads
- **Race guard**: `_loadId` prevents stale async loads from corrupting scene

### `export_panel.js` — ExportPanel

- Detects modified models → `/api/export_modified` (OBJ text)
- Unmodified → `/api/export` (copies source)
- Refreshes file browser after successful export

---

## Rendering Pipeline

```
Scene
  ├── Hemisphere Light           ← intensity adjustable
  ├── Key Directional Light      ← direction + intensity
  ├── Fill Directional Light     ← intensity
  ├── Rim Directional Light
  ├── Ambient Light              ← intensity
  ├── Ground Plane (shadows)
  ├── Grid Helper (toggleable, adaptive colors)
  ├── Axis Helper (toggleable, XYZ + labels)
  ├── Normals Helper (toggleable, cyan lines)
  └── Model (PBR, wireframe toggleable)
        │
        ▼
  WebGLRenderer (MSAA, ACES tone mapping ← exposure)
        │
        ▼
  EffectComposer → RenderPass → SSAOPass → OutputPass
```

---

## Camera & Navigation

```
Orbit Mode (default)
  ├── Left-drag: orbit    ├── Scroll: zoom (0.01–1000)
  ├── Right-drag: pan     └── Right-click: set pivot (raycast)

FPV Mode (drone)
  ├── W/Shift: forward    ├── A/D + ←/→: yaw
  ├── S/Ctrl: backward    ├── ↑/↓: pitch
  ├── E/Q: altitude       └── Left-drag: mouse look

Spacebar: reset camera only (model untouched)
```

---

## Model Transform Pipeline

```
Reload   → Re-fetch from disk (full reset)
Reset    → Restore geometry snapshot (saved on load)
Center   → Bake transforms → shift bbox center to (0,0,0)
Ground   → Bake transforms → center X/Z → min.Y to 0
Orient   → Bake transforms → PCA → rotate smallest variance → Y
Rotate   → Bake transforms → ±90° around X/Y/Z
Simplify → Merge vertices → SimplifyModifier (edge collapse) → recompute normals
Normals  → Delete normals + UVs → merge vertices → computeVertexNormals (smooth)
Export   → If modified: OBJExporter → POST /api/export_modified
           If original: POST /api/export
```

---

## File Management

```
Right-click context menu:
  ├── Show in file manager (macOS/Windows/Linux)
  ├── Rename (inline editing in sidebar)
  ├── Duplicate (creates _copy suffix)
  └── Delete (confirmation dialog)
```

---

## State Persistence on Model Load

| Resets (new object) | Preserves (user settings) |
|---------------------|--------------------------|
| Camera + orbit target | Wireframe |
| FPV mode → Orbit | Grid visibility |
| Scale → 1.0× | Axis visibility |
| Model transforms | Normals visibility |
| Modified flag | Background color |
| | Light settings |

---

## Security

- Optional `root_path` on FileBrowser
- Paths resolved to absolute before serving
- Only reads/copies — never executes
- Temp dirs cleaned on shutdown
