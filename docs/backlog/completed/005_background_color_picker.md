# 005 — Background Color Picker ✅

**Priority**: High
**Effort**: Trivial
**Category**: Viewer
**Status**: Completed

## Description

Added 5 preset background color swatches in the bottom-left of the viewer. Solves the visibility problem where light/white models are invisible against the dark default background.

## Changes

### HTML (`frontend/index.html`)
- Added `#bg-swatches` container with 5 `<button>` swatches:
  - `#0d0d1a` — Dark (default)
  - `#2a2a2a` — Charcoal
  - `#5a5a5a` — Gray
  - `#b0b0b0` — Light
  - `#ffffff` — White

### CSS (`frontend/css/styles.css`)
- Added `#bg-swatches` positioned absolute bottom-left, glassmorphic style
- Added `.bg-swatch` — 18×18 colored buttons with border highlight on active/hover

### JavaScript (`frontend/js/viewer_3d.js`)
- Added `setBackground(hex)` method — updates `scene.background` and `scene.fog.color` to the given color

### JavaScript (`frontend/js/app.js`)
- Added `_initBackgroundSwatches()` — click handler updates viewer background, manages active swatch state

## Technical Notes
- Fog color is updated alongside background to maintain visual consistency (objects fade into the background, not a mismatched color)
- The default dark background (`#0d0d1a`) is pre-selected on load
- Swatches are always visible (not hidden behind a toggle) since they're small and frequently useful
- The grid helper and ground plane remain functional on all backgrounds
