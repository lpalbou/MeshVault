# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [Unreleased]

### Fixed
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
- Zero frontend build step (ES modules, Three.js CDN)
- Poetry + PyPI + NPM packaging
- GitHub Actions CI (Python 3.10–3.13, Ubuntu + macOS)
- 12 unit tests, full documentation suite, backlog tracking

[0.1.0]: https://github.com/lpalbou/meshvault/releases/tag/v0.1.0
