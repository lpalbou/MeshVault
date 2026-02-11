# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [0.1.0] — 2026-02-10

Initial public release of MeshVault.

### What is this project?

MeshVault is a lightweight local tool for 3D artists, game developers, and anyone managing large collections of 3D models. Browse your filesystem, preview models with high-quality rendering, transform/simplify/export them — all from your browser. No cloud, no accounts, no uploads.

### Added

#### File Browsing & Management
- Sidebar file browser with folder navigation (go up, go home, double-click enter)
- **List / grid view** toggle with localStorage persistence
- **Real-time search/filter** by name
- **Sort options**: name (A–Z/Z–A), size (↑/↓), type — persisted
- **Right-click context menu**: rename (inline), duplicate, delete, show in file manager
- Color-coded badges: OBJ (green), FBX (orange), GLTF/GLB (cyan), STL (violet), archived (purple)
- Format support: `.obj`, `.fbx`, `.gltf`, `.glb`, `.stl`
- Archive scanning: `.zip` and `.rar` with multi-tool fallback (`rarfile`, `bsdtar`, `unrar`, `7z`, `unar`)

#### 3D Viewer
- PBR rendering: 5-light setup, soft shadows, SSAO, ACES filmic tone mapping
- OBJ + MTL material/texture loading, FBX (7000+) with animations, GLTF/GLB, STL
- Built-in FBX 6100 binary parser for auto-conversion of old FBX to OBJ
- Auto-framing: camera positions to fit any model size
- Material auto-upgrade to MeshStandardMaterial
- **Unique vertex counting** (deduplicates unrolled geometry for accurate stats)

#### Navigation
- **Orbit mode**: mouse orbit/zoom/pan, right-click pivot pick (raycast)
- **FPV drone mode**: W/Shift forward, S/Ctrl backward, A/D yaw, arrows pitch, E/Q altitude, mouse look
- Smooth mode transitions, spacebar camera reset
- Extended zoom range (0.01–1000)
- **Race condition guard** (`_loadId`) prevents stale async loads

#### Viewer Toolbar (7 toggles)
- **Grid**: floor grid scaled to model (8× footprint), colors adapt to background
- **XYZ Axes**: colored lines + text labels, scales to model
- **Wireframe**: overlay on all meshes
- **Normals visualization**: vertex normals as cyan lines (VertexNormalsHelper)
- **Material inspector**: draggable floating panel with all PBR properties per material, live references for future editing
- **Light panel**: key light azimuth/elevation, per-light intensity, exposure
- All settings **persist across model loads**

#### Model Transforms (top bar)
- **Reload**: re-fetch from disk (full reset including normals)
- **Reset**: restore original geometry snapshot
- **Center**: bake transforms → bbox center to (0,0,0)
- **Ground**: center X/Z, lowest point at Y=0
- **Orient**: PCA auto-orient (smallest variance axis → Y)
- **Rotate ±90°**: per-axis rotation (X=pitch, Y=yaw, Z=roll)
- **Simplify mesh**: merge vertices → SimplifyModifier edge collapse → recompute normals
- **Recompute normals**: merge vertices → smooth normals (fixes faceted shading)
- **Processing overlay**: full-screen spinner for heavy operations

#### Background & Scale
- **12 background presets**: neutral grayscale ramp + tinted (warm, red, green)
- Grid adapts colors to contrast with background
- **Scale slider**: 0.05×–5.0× with 0.05 steps

#### Export (Save As)
- **Save As dialog**: folder browser with navigation, filename pre-filled
- **Modified export**: OBJExporter with all transforms baked into vertices
- **Unmodified export**: copies original file(s) with rename
- File browser auto-refreshes after save

#### Backend (13 API endpoints)
- Browse, serve, prepare, export, export_modified
- Reveal in file manager, rename, duplicate, delete
- Lazy archive inspection, temp file management, auto-cleanup

#### UI / UX
- Professional dark theme, glassmorphic panels
- Resizable sidebar, favicon, GitHub link + author credit
- Toast notifications, loading overlay, processing overlay

#### Developer Experience
- Zero frontend build step (ES module import maps, Three.js via CDN)
- Poetry + PyPI + NPM packaging
- GitHub Actions CI (Python 3.10–3.13, Ubuntu + macOS)
- 12 backend unit tests
- Full documentation suite + backlog tracking

[0.1.0]: https://github.com/lpalbou/meshvault/releases/tag/v0.1.0
