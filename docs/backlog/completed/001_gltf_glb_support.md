# 001 — GLTF/GLB Format Support ✅

**Priority**: High
**Effort**: Small
**Category**: Format support
**Status**: Completed

## Description

Added support for `.gltf` and `.glb` (GL Transmission Format) files — the most widely used modern 3D interchange format.

## Changes

### Backend
- **`backend/file_browser.py`**: Added `.gltf` and `.glb` to `SUPPORTED_3D_EXTENSIONS`
- **`backend/archive_inspector.py`**: Added `.gltf` and `.glb` to `SUPPORTED_3D_EXTENSIONS`
- **`backend/app.py`**: Registered MIME types `model/gltf+json` (`.gltf`) and `model/gltf-binary` (`.glb`)

### Frontend
- **`frontend/js/viewer_3d.js`**: Added `GLTFLoader` import, `_loadGLTF()` method with animation support, wired in `loadModel()` switch
- **`frontend/js/file_browser.js`**: Added globe-style SVG icons for `gltf` and `glb` formats
- **`frontend/css/styles.css`**: Added cyan color scheme (`.asset-gltf`, `.asset-glb`, `.badge-gltf`, `.badge-glb`) using `#26c6da`

## Technical Notes
- GLTF files may embed or reference textures via relative paths — these work through the existing `/api/asset/related` endpoint for filesystem files. For archived GLTF, the prepare_archive endpoint handles extraction.
- GLTF animations are auto-played via `AnimationMixer`, same as FBX.
- GLTF materials are PBR by definition, so the material upgrade step in `_enhanceModel` is a no-op (materials are already `MeshStandardMaterial`).
