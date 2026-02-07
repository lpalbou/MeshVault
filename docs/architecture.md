# Architecture

This document describes the system design, component breakdown, and key design decisions of MeshVault.

---

## High-Level Architecture

The application follows a **client-server architecture** with a clear separation between filesystem operations (backend) and visualization/interaction (frontend).

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
│  │        App.js (orchestrator) │ │
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

## Design Decisions

### Why Client-Server (not Electron or Desktop)?

1. **No build step required**: The frontend uses ES module import maps to load Three.js directly from CDN. No webpack, no bundler, no node_modules.
2. **Security**: The backend controls all filesystem access. The browser never touches the filesystem directly.
3. **Portability**: Works in any modern browser. No platform-specific code.
4. **Simplicity**: A single `poetry run meshvault` command starts everything.

### Why FastAPI?

- Async-ready for concurrent file operations
- Built-in OpenAPI docs (available at `/docs` when running)
- Pydantic models for request validation
- StaticFiles mounting for serving the frontend
- Clean Python with type hints throughout

### Why Three.js (not Babylon.js, model-viewer, etc.)?

- Most mature web 3D library with the largest ecosystem
- Best loader support for OBJ and FBX formats
- Full postprocessing pipeline (SSAO, tone mapping)
- OrbitControls for intuitive model inspection
- ES module support via CDN import maps (no bundler needed)

### Why No Build Step for Frontend?

- **Import maps** (`<script type="importmap">`) allow ES module imports directly from CDN
- All frontend JS uses native ES modules (`import`/`export`)
- CSS is vanilla — no preprocessor needed for a focused utility app
- Result: zero frontend build configuration, instant changes during development

---

## Backend Components

### `app.py` — FastAPI Server

The entry point and HTTP layer. Responsibilities:

- Define REST API routes
- Serve the frontend `index.html` and static files
- Auto-convert old FBX files (version < 7000) to OBJ before serving
- Manage application lifecycle (cleanup temp files on shutdown)
- Delegate all business logic to specialized components

**Key design**: Routes are thin — they parse requests, call the appropriate service, and format responses. No business logic in route handlers.

### `file_browser.py` — FileBrowser

Core filesystem navigation engine. Responsibilities:

- List directory contents (folders + 3D assets)
- Identify supported file formats (`.obj`, `.fbx`)
- Detect related files (`.mtl`, textures) for each asset
- Delegate archive inspection to `ArchiveInspector`
- Enforce optional root path constraint for security

**Key classes:**
- `FileBrowser` — Main class with `browse(directory)` method
- `AssetInfo` — Dataclass representing a discovered 3D asset
- `FolderInfo` — Dataclass representing a navigable folder
- `BrowseResult` — Container for a browse operation's results

### `archive_inspector.py` — ArchiveInspector

Handles ZIP and RAR archive inspection and extraction. Responsibilities:

- List 3D assets inside archives without full extraction
- Extract specific assets (+ related files) on demand for viewing
- Multi-tool RAR extraction: tries `rarfile` (Python), then falls back to CLI tools (`bsdtar`, `unrar`, `7z`, `unar`) with auto-detection and caching
- Resolve archive-internal paths to extracted temp filesystem paths
- Manage temporary extraction directories
- Clean up temp files on shutdown

**Key design**: Extraction is lazy — archives are only inspected (listing file names) during browsing. Full extraction only happens when a user clicks to view an asset. The CLI tool fallback chain makes RAR support work across systems without requiring a specific tool.

### `export_manager.py` — ExportManager

Handles asset export with renaming. Responsibilities:

- Copy filesystem assets with new names
- Extract and rename archived assets
- Handle single-file vs multi-file exports
- Preserve derivative files (`.mtl`, textures) during export

**Key design**: Single assets export as a single file. Assets with derivatives export into a named subfolder to keep everything organized.

### `fbx_converter.py` — FBX Converter

Native FBX binary parser that converts old FBX files (version < 7000) to OBJ format. Responsibilities:

- Parse the FBX binary format (header, node tree, typed properties)
- Handle both FBX 6100 (individual scalar properties) and FBX 7000+ (array properties)
- Support zlib-compressed property arrays
- Extract geometry data: vertices, polygon indices, normals, UVs
- Write Wavefront OBJ output with proper face winding

**Key design**: Three.js FBXLoader only supports FBX 7000+ (2011+). Rather than requiring external tools like Blender or the Autodesk SDK, this module provides a zero-dependency solution by parsing the binary format directly.

---

## Frontend Components

### `app.js` — Application Orchestrator

Wires together all frontend components and handles:

- Component initialization and lifecycle
- Inter-component communication (e.g., asset selected → load in viewer)
- Archive asset preparation (calls `/api/asset/prepare_archive` to resolve temp paths)
- Navigation button bindings (go up, go home)
- Light control panel initialization and slider wiring
- Sidebar resize drag behavior
- Toast notification system

### `file_browser.js` — FileBrowser UI

Renders the directory listing in the sidebar. Responsibilities:

- Fetch directory contents from `/api/browse`
- Render folder items (with double-click navigation)
- Render asset items (with click-to-load)
- Show section labels (Folders / 3D Assets)
- Format file sizes and metadata
- Manage selection state (active highlight)

### `viewer_3d.js` — Viewer3D

The Three.js-based 3D model viewer. This is the most complex frontend component. Responsibilities:

- **Scene setup**: Camera, fog, background color
- **Lighting**: 5-light setup (hemisphere + key directional + fill + rim + ambient) with runtime controls
- **Light controls API**: Public methods for azimuth, elevation, intensity, exposure adjustments
- **Shadow mapping**: PCFSoftShadowMap, 2048×2048 resolution
- **Ground plane**: Shadow-receiving plane + grid helper
- **Postprocessing**: SSAO (ambient occlusion) + OutputPass (color space)
- **Model loading**: OBJLoader (with MTLLoader for materials) + FBXLoader
- **Material upgrade**: Auto-upgrade basic materials to MeshStandardMaterial (PBR)
- **Auto-framing**: Compute bounding box, position camera to fit model
- **FPV keyboard navigation**: WASD/arrow/QE drone-style flying with per-frame movement
- **Right-click pivot picking**: Raycasts onto model surface to redefine orbit center
- **Model scaling**: Runtime uniform scale control (0.25×–2.0×) via public `setModelScale()` method
- **View reset**: Spacebar restores initial framed camera position and pivot
- **Animation**: FBX animation mixer support
- **Cleanup**: Proper disposal of geometries, materials, textures

### `export_panel.js` — ExportPanel

Manages the top-bar rename/export controls. Responsibilities:

- Populate name input with current asset name
- Set default export path to current browse directory
- Validate inputs before export
- Call `/api/export` API
- Show success/error toast notifications

---

## Rendering Pipeline

The viewer uses a multi-stage rendering pipeline for maximum visual quality:

```
Scene
  ├── Hemisphere Light (sky/ground ambient fill)         ← intensity adjustable
  ├── Key Directional Light (main, casts shadows)        ← direction + intensity adjustable
  ├── Fill Directional Light (softens shadow side)       ← intensity adjustable
  ├── Rim Directional Light (back edge definition)
  ├── Ambient Light (base fill)                          ← intensity adjustable
  ├── Ground Plane (receives shadows)
  ├── Grid Helper (spatial reference)
  └── Model (PBR materials, casts/receives shadows)
        │
        ▼
  WebGLRenderer (MSAA anti-aliasing, ACESFilmic tone mapping ← exposure adjustable)
        │
        ▼
  EffectComposer
  ├── RenderPass (standard render)
  ├── SSAOPass (screen-space ambient occlusion)
  └── OutputPass (correct color space output)
```

The key light direction uses spherical coordinates (azimuth + elevation) orbiting
around the model center, which is more intuitive than raw x/y/z positioning.

## Camera & Navigation

The viewer has two distinct modes, toggled via a toolbar button:

```
Orbit Mode (default)
  ├── OrbitControls (mouse)
  │     ├── Left-drag: orbit around pivot
  │     ├── Scroll: zoom in/out (range: 0.01–1000)
  │     └── Right-drag: pan
  └── Right-click pivot pick
        ├── Detects click vs drag (< 5px, < 300ms)
        ├── Raycasts onto model meshes
        └── Sets orbit target to hit point

FPV Mode (drone)
  ├── OrbitControls disabled
  ├── Keyboard movement
  │     ├── W/Shift: forward along camera's TRUE look direction
  │     ├── S/Ctrl: backward
  │     ├── A/D + ←/→: yaw (rotate the drone)
  │     ├── ↑/↓: pitch (tilt the drone)
  │     ├── E: altitude up, Q: altitude down
  │     └── Speed proportional to model size (maxDim * 1.5)
  └── Mouse look
        ├── Left-drag: yaw + pitch
        └── Pitch clamped to ±85° to prevent flipping

Mode switching
  ├── Toggle button (top-right toolbar)
  ├── FPV→Orbit: reconstructs orbit target from camera direction
  ├── Orbit→FPV: extracts yaw/pitch from current camera orientation
  └── Spacebar: resets view AND switches back to Orbit
```

---

## Data Model

### AssetInfo

The central data structure for a discovered 3D asset:

```python
@dataclass
class AssetInfo:
    name: str              # "spaceship" (no extension)
    path: str              # Full path to file or archive
    extension: str         # ".obj" or ".fbx"
    size: int              # File size in bytes
    is_in_archive: bool    # True if inside a ZIP/RAR
    archive_path: str?     # Path to archive (if applicable)
    inner_path: str?       # Path inside archive (if applicable)
    related_files: list    # Paths to .mtl, textures, etc.
```

This same structure flows from backend → API response → frontend, ensuring consistency across the entire stack.

---

## Security Considerations

- **Root path constraint**: `FileBrowser` accepts an optional `root_path` to restrict browsing scope
- **Path resolution**: All paths are resolved to absolute before serving, preventing path traversal attacks
- **No arbitrary execution**: The backend only reads and copies files; it never executes them
- **Temp file cleanup**: Extraction temp directories are cleaned up on application shutdown via the `lifespan` context manager
