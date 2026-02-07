# Architecture

This document describes the system design, component breakdown, and key design decisions of MeshVault.

---

## High-Level Architecture

```
┌──────────────────────────────────┐
│          Frontend (Browser)       │
│                                   │
│  ┌───────────┐  ┌──────────────┐ │
│  │ File      │  │ Viewer3D     │ │
│  │ Browser   │  │ (Three.js)   │ │
│  └─────┬─────┘  └──────┬───────┘ │
│        │               │         │
│  ┌─────┴───────────────┴───────┐ │
│  │       App.js (orchestrator) │ │
│  └──────────────┬──────────────┘ │
│                 │                 │
│  ┌──────────────┴──────────────┐ │
│  │     ExportPanel             │ │
│  └─────────────────────────────┘ │
└────────────────┬─────────────────┘
                 │ HTTP (REST API)
┌────────────────┴─────────────────┐
│          Backend (FastAPI)        │
│                                   │
│  ┌───────────┐  ┌──────────────┐ │
│  │ File      │  │ Archive      │ │
│  │ Browser   │  │ Inspector    │ │
│  └───────────┘  └──────────────┘ │
│                                   │
│  ┌───────────┐  ┌──────────────┐ │
│  │ Export    │  │ FBX          │ │
│  │ Manager   │  │ Converter    │ │
│  └───────────┘  └──────────────┘ │
└──────────────────────────────────┘
```

---

## Backend Components

### `app.py` — FastAPI Server

- REST API routes (browse, serve, prepare, export, export_modified)
- Auto-convert old FBX (version < 7000) to OBJ before serving
- Serve frontend static files and `index.html`
- Application lifecycle (temp file cleanup on shutdown)

### `file_browser.py` — FileBrowser

- List directory contents (folders + 3D assets: `.obj`, `.fbx`, `.gltf`, `.glb`)
- Detect related files (`.mtl`, textures) for each asset
- Delegate archive inspection to `ArchiveInspector`
- Optional root path constraint for security

### `archive_inspector.py` — ArchiveInspector

- Inspect ZIP/RAR archives for 3D assets without full extraction
- Multi-tool RAR fallback: `rarfile` → `bsdtar` → `unrar` → `7z` → `unar`
- Extract on demand with temp directory management
- Resolve archive-internal paths to extracted filesystem paths

### `export_manager.py` — ExportManager

- Copy/rename filesystem assets (single file or folder with derivatives)
- Extract and rename archived assets

### `fbx_converter.py` — FBX Converter

- Parse FBX binary format (version 5000–6100)
- Handle scalar properties (v6100) and array properties (v7000+)
- Extract geometry (vertices, indices, normals, UVs) + convert to OBJ

---

## Frontend Components

### `app.js` — Application Orchestrator

- Wire all components together (file browser, viewer, export panel)
- Archive asset preparation (`/api/asset/prepare_archive`)
- Toolbar: nav mode, grid, axes, wireframe, light panel, scale, background
- Model transform buttons: reset, center, ground, orient
- Search filter + grid/list view toggle

### `file_browser.js` — FileBrowser UI

- Fetch and render directory contents (list view + grid view)
- Real-time search/filter (case-insensitive, client-side)
- Color-coded badges: OBJ (green), FBX (orange), GLTF/GLB (cyan), archived (purple)
- View mode persistence via `localStorage`

### `viewer_3d.js` — Viewer3D

The most complex frontend component:

- **Rendering**: PBR materials, 5-light setup, SSAO, ACES tone mapping, soft shadows
- **Loaders**: OBJLoader + MTLLoader, FBXLoader, GLTFLoader
- **Navigation**: Orbit mode (OrbitControls) and FPV drone mode (keyboard + mouse look)
- **Scene helpers**: Toggleable grid (scales to model, adapts to background), XYZ axes with labels
- **Model transforms**: Center at origin, ground on Y=0, PCA auto-orient, reset to original
- **Export**: OBJExporter for modified model export with baked transforms
- **Persistence**: Wireframe, grid, axes, background survive across model loads

### `export_panel.js` — ExportPanel

- Name + path inputs with Enter-to-export
- Detects modified models → exports via `/api/export_modified` (OBJ text)
- Unmodified models → exports via `/api/export` (copies source files)

---

## Rendering Pipeline

```
Scene
  ├── Hemisphere Light (ambient fill)          ← intensity adjustable
  ├── Key Directional Light (shadows)          ← direction + intensity adjustable
  ├── Fill Directional Light                   ← intensity adjustable
  ├── Rim Directional Light
  ├── Ambient Light                            ← intensity adjustable
  ├── Ground Plane (shadow receiver)
  ├── Grid Helper (toggleable, scales to model, adapts to background)
  ├── Axis Helper (toggleable, X=red Y=green Z=blue + labels)
  └── Model (PBR materials, wireframe toggleable)
        │
        ▼
  WebGLRenderer (MSAA, ACESFilmic tone mapping ← exposure adjustable)
        │
        ▼
  EffectComposer → RenderPass → SSAOPass → OutputPass
```

---

## Camera & Navigation

```
Orbit Mode (default)
  ├── Left-drag: orbit around pivot
  ├── Scroll: zoom (0.01–1000)
  ├── Right-drag: pan
  └── Right-click (no drag): set pivot via raycast

FPV Mode (drone)
  ├── W/Shift: forward along TRUE look direction
  ├── S/Ctrl: backward
  ├── A/D + ←/→: yaw
  ├── ↑/↓: pitch
  ├── E/Q: altitude up/down
  └── Left-drag: mouse look (pitch + yaw)

Spacebar: reset camera only (does not affect model)
```

---

## Model Transform Pipeline

```
Reset  → Restore original geometry snapshot (saved on load)
Center → Bake world transforms → shift bbox center to (0,0,0)
Ground → Bake world transforms → center X/Z → shift min.Y to 0
Orient → Bake world transforms → PCA eigenvectors → rotate so smallest variance = Y
Export → If modified: OBJExporter.parse() → POST /api/export_modified
         If original: POST /api/export (copies source files)
```

All transform operations modify geometry vertices only — camera is never touched.
Original geometry is saved as a snapshot on load for Reset.

---

## State Persistence on Model Load

When loading a new model:

| Resets (new object) | Preserves (user settings) |
|---------------------|--------------------------|
| Camera position + orbit target | Wireframe on/off |
| FPV mode → back to Orbit | Grid visibility |
| Scale → 1.0× | Axis visibility |
| Model transforms (modified flag) | Background color |
| FPV yaw/pitch angles | Light settings |

---

## Security

- Optional `root_path` constraint on `FileBrowser`
- All paths resolved to absolute before serving
- Backend only reads/copies files — never executes them
- Temp directories cleaned up on shutdown
