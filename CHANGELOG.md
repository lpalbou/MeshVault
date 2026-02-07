# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-02-07

Initial public release of MeshVault — a professional, local web-based tool for rapidly browsing, previewing, and managing 3D assets.

### What is this project?

MeshVault is a lightweight local tool designed for 3D artists, game developers, and anyone who accumulates large collections of 3D model files. It provides a fast way to navigate your filesystem, visually preview `.obj` and `.fbx` models with high-quality rendering, and export/rename assets with a single click. It runs entirely on your machine — no cloud, no accounts, no uploads.

### Added

#### Core Browsing
- Filesystem navigation with a clean sidebar tree (go up, go home, double-click to enter folders)
- Automatic detection of `.obj` and `.fbx` files with related file discovery (`.mtl`, textures)
- Archive scanning: inspect `.zip` and `.rar` archives for 3D assets without manual extraction
- Multi-tool RAR extraction fallback chain (`rarfile`, `bsdtar`, `unrar`, `7z`, `unar`) with auto-detection

#### 3D Viewer
- High-quality Three.js-based rendering with PBR materials, 5-light setup, soft shadows, SSAO ambient occlusion, and ACES filmic tone mapping
- OBJ loading with full MTL material and texture support
- FBX loading (version 7000+) with animation playback
- Built-in FBX 6100 binary parser for automatic conversion of old FBX files to OBJ
- Auto-framing: camera automatically positions to fit any model size
- Material auto-upgrade: basic materials are converted to `MeshStandardMaterial` for PBR rendering
- Shadow-receiving ground plane with grid helper for spatial reference

#### Navigation & Controls
- Two distinct navigation modes with clear toggle button (top-right toolbar)
- **Orbit mode** (default): mouse orbit, zoom, pan via OrbitControls; right-click on model surface to set a new orbit pivot point
- **FPV mode** (drone): true drone controls — W/S forward/backward along camera's actual look direction, A/D and arrows to yaw/pitch, Shift/Ctrl for altitude, mouse drag for free look
- Smooth mode transitions: FPV→Orbit reconstructs orbit target, Orbit→FPV extracts yaw/pitch from camera orientation
- Spacebar to reset camera position, pivot, and switch back to Orbit mode
- Extended zoom range (0.01–1000) for both macro and overview inspection

#### Light Controls
- Collapsible lighting panel (☀ toggle in top-right corner)
- Key light direction: azimuth (0°–360°) and elevation (5°–90°) sliders
- Per-light intensity: key light (0–3), fill light (0–2), ambient (0–2)
- Exposure control (0.3–4) for overall tone mapping
- One-click reset to default lighting

#### Model Scaling
- Real-time scale slider (0.25×–2.0×) with 0.25 step increments
- Positioned in the bottom-right of the viewer for quick access
- Automatically resets to 1.0× when loading a new model

#### Export & Rename
- Top-bar controls for renaming and exporting assets
- Single-file export (renamed file) or multi-file export (subfolder with derivatives)
- Works with both filesystem files and archived assets
- Auto-creates target directories

#### Backend
- FastAPI REST API with 8 endpoints for browsing, serving, preparing, and exporting assets
- Lazy archive inspection (headers only during browsing, full extraction on demand)
- Temporary file management with automatic cleanup on shutdown
- Swagger UI and ReDoc auto-generated API documentation

#### UI / UX
- Professional dark theme with glassmorphic floating panels
- Resizable sidebar with drag handle
- Color-coded asset badges (green=OBJ, orange=FBX, purple=archived)
- Toast notifications for export success/error feedback
- Loading spinner overlay during model loading
- Model statistics bar (vertices, faces, file size)

#### Developer Experience
- Zero frontend build step (ES module import maps, Three.js via CDN)
- Poetry for Python dependency management
- 12 unit tests for backend file browsing logic
- Full documentation suite (getting started, architecture, API reference, FAQ)

[0.1.0]: https://github.com/lpalbou/meshvault/releases/tag/v0.1.0
