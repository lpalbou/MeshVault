# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-02-07

Initial public release of MeshVault — a professional, local web-based tool for rapidly browsing, previewing, and managing 3D assets.

### What is this project?

MeshVault is a lightweight local tool designed for 3D artists, game developers, and anyone who accumulates large collections of 3D model files. It provides a fast way to navigate your filesystem, visually preview `.obj`, `.fbx`, `.gltf`, and `.glb` models with high-quality rendering, transform and export them with a single click. It runs entirely on your machine — no cloud, no accounts, no uploads.

### Added

#### Core Browsing
- Filesystem navigation with a clean sidebar tree (go up, go home, double-click to enter folders)
- **List / grid view** toggle with `localStorage` persistence
- **Real-time search/filter** by name across folders and assets
- Automatic detection of `.obj`, `.fbx`, `.gltf`, `.glb` files with related file discovery (`.mtl`, textures)
- Color-coded badges: OBJ (green), FBX (orange), GLTF/GLB (cyan), archived (purple)
- Archive scanning: inspect `.zip` and `.rar` archives for 3D assets without manual extraction
- Multi-tool RAR extraction fallback chain (`rarfile`, `bsdtar`, `unrar`, `7z`, `unar`) with auto-detection

#### 3D Viewer
- High-quality Three.js-based rendering with PBR materials, 5-light setup, soft shadows, SSAO ambient occlusion, and ACES filmic tone mapping
- OBJ loading with full MTL material and texture support
- FBX loading (version 7000+) with animation playback
- **GLTF / GLB loading** with animation support
- Built-in FBX 6100 binary parser for automatic conversion of old FBX files to OBJ
- Auto-framing: camera automatically positions to fit any model size
- Material auto-upgrade: basic materials converted to `MeshStandardMaterial` for PBR rendering

#### Navigation & Controls
- **Two distinct navigation modes** with clear toggle button
- **Orbit mode** (default): mouse orbit, zoom, pan; right-click on model surface to set orbit pivot
- **FPV mode** (drone): W/Shift forward, S/Ctrl backward, A/D yaw, arrows pitch/yaw, E/Q altitude, mouse drag for free look
- Smooth mode transitions: FPV→Orbit reconstructs orbit target, Orbit→FPV extracts yaw/pitch
- **Spacebar** resets camera only (does not affect model transforms)
- Extended zoom range (0.01–1000)

#### Viewer Toolbar
- **Grid toggle**: floor grid that scales to model (8× footprint), adapts colors to background
- **Axis toggle**: XYZ axis helper (X=red, Y=green, Z=blue) with floating text labels, scales to model
- **Wireframe toggle**: wireframe overlay on all meshes
- **Light panel** (☀): collapsible panel with key light azimuth/elevation, per-light intensity, exposure
- All scene settings **persist across model loads**

#### Model Transforms
- **Reset**: restore original geometry (saved as snapshot on load)
- **Center**: move bounding box center to (0, 0, 0)
- **Ground**: center X/Z, place lowest point at Y=0 (model sits on surface)
- **Orient**: PCA-based auto-orientation (smallest variance axis → Y up)
- All transforms modify **model geometry only** — camera is never touched

#### Background & Scale
- **12 background color presets**: neutral grayscale ramp (dark → white) + tinted options
- Grid adapts line colors to contrast with selected background
- **Scale slider** (0.25×–2.0×), resets on new model load

#### Export
- Top-bar controls for renaming and exporting assets
- **Unmodified export**: copies original file(s) with new name
- **Modified export**: uses Three.js OBJExporter to serialize transformed geometry (Center/Ground/Orient/Scale baked into vertices)
- Multi-file export: assets with derivatives (`.mtl`, textures) exported into a subfolder
- Auto-creates target directories

#### Backend
- FastAPI REST API with 9 endpoints (browse, serve, prepare, export, export_modified, default_path, related)
- Lazy archive inspection (headers only during browsing, full extraction on demand)
- Temporary file management with automatic cleanup on shutdown
- Swagger UI and ReDoc auto-generated API documentation

#### UI / UX
- Professional dark theme with glassmorphic floating panels
- Resizable sidebar with drag handle
- Toast notifications for all user actions
- Loading spinner overlay during model loading
- Model statistics bar (vertices, faces, file size)

#### Developer Experience
- Zero frontend build step (ES module import maps, Three.js via CDN)
- Poetry for Python dependency management + PyPI packaging
- NPM wrapper (`bin/meshvault.js`) for `npx meshvault`
- 12 unit tests for backend file browsing logic
- Full documentation suite: getting started, architecture, API reference, FAQ
- Backlog tracking (`docs/backlog/completed/`)

[0.1.0]: https://github.com/lpalbou/meshvault/releases/tag/v0.1.0
