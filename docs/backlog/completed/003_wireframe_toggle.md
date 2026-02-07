# 003 — Wireframe Toggle ✅

**Priority**: High
**Effort**: Trivial
**Category**: Viewer
**Status**: Completed

## Description

Added a toggle button in the viewer toolbar to switch between solid and wireframe rendering. Essential for inspecting mesh topology.

## Changes

### HTML (`frontend/index.html`)
- Added wireframe toggle button in the viewer toolbar (between nav-mode and light toggles)
- Uses a mesh/layers SVG icon

### JavaScript (`frontend/js/viewer_3d.js`)
- Added `setWireframe(enabled)` method — traverses all meshes in the current model and sets `material.wireframe`
- Added `getWireframe()` getter
- Handles both single materials and material arrays
- Stores state in `_wireframeEnabled`

### JavaScript (`frontend/js/app.js`)
- Added `_initWireframeToggle()` — click handler toggles wireframe and updates button active state

## Technical Notes
- Wireframe mode works with all material types (Standard, Physical, Phong, etc.)
- The toggle applies to the current model immediately and persists until toggled off or a new model is loaded
- `_resetViewerState()` does not reset wireframe — this is intentional so the user can keep wireframe on while browsing multiple models
