# FAQ

---

## Formats

### What 3D formats are supported?

- **`.obj`** — with `.mtl` materials and textures
- **`.fbx`** — version 7000+ natively, < 7000 auto-converted to OBJ
- **`.gltf`** / **`.glb`** — GL Transmission Format
- **`.stl`** — Stereolithography (3D printing)

### What archives are supported?

- **`.zip`** — built-in
- **`.rar`** — via `bsdtar`, `unrar`, `7z`, or `unar` (auto-detected)

---

## Navigation

### How do I navigate around the model?

Two modes (toggle in toolbar):
- **Orbit**: Left-drag orbit, scroll zoom, right-drag pan, right-click set pivot
- **FPV**: W/Shift forward, S/Ctrl backward, A/D yaw, arrows pitch, E/Q altitude, left-drag mouse look

**Spacebar** resets camera. Does not affect model.

### How do I toggle grid / axes / wireframe / normals?

Toolbar buttons on the right side of the viewer. All settings persist when switching models.

---

## Model Operations

### How do I center or orient a model?

Use top bar buttons:
- **Reload** — re-fetch from disk
- **Reset** — undo all transforms
- **Center** — bbox center → (0,0,0)
- **Ground** — center X/Z, bottom at Y=0
- **Orient** — PCA auto-orient (Y = up)
- **X±/Y±/Z±** — rotate 90° per axis

These modify geometry only — camera stays put.

### How do I simplify a mesh?

Click **Simplify** (diamond icon) → set target percentage → **Apply**. The modifier merges vertices first (for proper topology), then applies edge collapse decimation. A full-screen overlay shows during processing.

### How do I fix faceted/flat shading?

Click the **Normals** button (starburst icon) in the toolbar. This merges vertices at the same position and recomputes smooth vertex normals. Note: UVs are lost (required for vertex merging across UV seams).

### What's the material inspector?

Click the sphere icon in the toolbar. A draggable floating panel shows all materials on the model: name, color, roughness, metalness, opacity, texture presence, and which meshes use each material.

---

## File Management

### How do I rename / duplicate / delete files?

**Right-click** any file or folder in the sidebar:
- **Show in file manager** — opens Finder/Explorer
- **Rename** — inline editing directly on the filename
- **Duplicate** — creates `name_copy.ext` in same folder
- **Delete** — confirmation dialog, then removes

### How do I sort files?

Use the sort dropdown at the top of the sidebar: A–Z, Z–A, Size ↑, Size ↓, Type. Persists across sessions.

---

## Export

### How does export work?

Click **Export** → **Save As** dialog opens:
- Browse folders to select destination
- Filename pre-filled with original name + extension
- Modified models (centered/oriented/rotated/simplified) export as `.obj`
- Unmodified models copy the original file(s)
- File browser auto-refreshes after export

### What gets exported when the model is modified?

All transforms (center, ground, orient, rotate, scale, simplify, normals) are baked into the vertex positions. The result is saved as a clean `.obj` file via Three.js OBJExporter.

---

## Lighting & Background

### How do I change the background?

Click any of the **12 color swatches** (bottom-left). Grid line colors adapt automatically.

### How do I adjust lighting?

Click **☀** in the toolbar. Sliders for key light direction (H/V), per-light intensity, and exposure.

---

## Troubleshooting

### Port already in use

```bash
PORT=9000 poetry run meshvault
```

### Blank page

Check server is running, use `http` (not `https`), check F12 console, requires ES module import maps (Chrome 89+, Firefox 108+, Safari 16.4+).

### Model loads slowly

Large files (>50MB) need time. SSAO slows on >1M triangles. Simplify first.

---

## Development

```bash
poetry run pytest tests/ -v        # Run tests
# Swagger UI: http://localhost:8420/docs
# ReDoc: http://localhost:8420/redoc
```

Frontend: no build step. Edit `frontend/` files, refresh browser.
