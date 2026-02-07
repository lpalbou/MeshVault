# FAQ

Frequently asked questions, troubleshooting tips, and common issues.

---

## General

### What 3D formats are supported?

- **`.obj`** (Wavefront OBJ) — with `.mtl` materials and textures
- **`.fbx`** (Autodesk FBX) — version 7000+ natively, version < 7000 auto-converted to OBJ
- **`.gltf`** / **`.glb`** (GL Transmission Format) — the modern standard

### What archive formats are supported?

- **`.zip`** — Built-in support (Python `zipfile`)
- **`.rar`** — Via multi-tool fallback: `bsdtar`, `unrar`, `7z`, `7za`, `unar` (auto-detected)

### Can I browse any directory on my machine?

Yes. The file browser starts at your home directory and can navigate anywhere your user has read access. Hidden files (starting with `.`) are excluded.

### Is there network access or cloud functionality?

No. MeshVault is a **purely local tool**. The backend serves on `localhost` only. No data leaves your machine (except Three.js loaded from CDN).

---

## Installation

### I don't have Poetry installed

```bash
curl -sSL https://install.python-poetry.org | python3 -
```

Restart your terminal and verify with `poetry --version`.

### RAR files are not being scanned

Install at least one of: `bsdtar`, `unrar`, `7z`, or `unar`. See the [Getting Started](getting_started.md) guide for install commands per platform.

### "Module not found" errors when starting

Run inside the Poetry virtualenv:

```bash
poetry run meshvault
# or
poetry shell
meshvault
```

---

## Usage

### How do I navigate around the model?

Two modes, toggled with the **orbit/FPV button** (top-right toolbar):

- **Orbit mode**: Left-drag to orbit, scroll to zoom, right-drag to pan. Right-click on model to set a new orbit pivot.
- **FPV mode**: W/Shift forward, S/Ctrl backward, A/D yaw, arrows for pitch/yaw, E/Q altitude, left-drag for mouse look.

**Spacebar** resets the camera to the initial auto-framed position. It does NOT affect the model.

### How do I center or reorient a model?

Use the **transform buttons** in the top bar:

| Button | Effect |
|--------|--------|
| **Reset** | Undo all transforms (restore original geometry) |
| **Center** | Move model center to (0, 0, 0) |
| **Ground** | Center X/Z, place lowest point at Y=0 |
| **Orient** | PCA auto-orient (smallest variance axis → Y) |

These modify the **model only** — the camera stays where it is.

### How do I toggle the grid / axes / wireframe?

Use the **viewer toolbar** buttons (top-right, vertical stack):

1. Orbit/FPV toggle
2. **Grid** — floor grid that scales to model and adapts colors to background
3. **Axes** — XYZ axis helper (X=red, Y=green, Z=blue) with labels
4. **Wireframe** — toggle wireframe rendering on all meshes
5. **Light (☀)** — collapsible lighting panel

These settings **persist across model loads**.

### How do I adjust the lighting?

Click the **☀** button to open the light panel with sliders for key light direction, fill/ambient intensity, and exposure. Click **Reset** in the panel to restore defaults.

### How do I change the background color?

Click any of the **12 color swatches** in the bottom-left of the viewer. Includes dark, gray, light, white, and tinted options. The grid adapts its colors to contrast with the background.

### The model looks dark or flat

Try increasing the **Key Light** or **Exposure** in the light panel. Some models with dark vertex colors may need higher intensity. You can also try a lighter background.

### OBJ file loads but has no textures

The `.mtl` file must be in the same directory as the `.obj` and share the same stem name (e.g., `model.obj` + `model.mtl`).

### I get "FBX version not supported"

MeshVault auto-converts old FBX (version < 7000) to OBJ. If you see this error, make sure you're on the latest version.

### Can I view animated FBX / GLTF files?

Yes. Animations are auto-played via Three.js `AnimationMixer`.

### What happens when I export?

- **Unmodified model**: Copies the original file(s) with the new name
- **Modified model** (after Center/Ground/Orient/Scale): Exports as OBJ with all transforms baked into the vertices
- **With related files**: Exported into a subfolder
- Source files are **never modified or deleted**

### Can I export to a directory that doesn't exist?

Yes. MeshVault auto-creates the target directory.

---

## Troubleshooting

### Port 8420 is already in use

```bash
PORT=9000 poetry run meshvault
```

### "Access denied" error when browsing

Your user doesn't have read permissions for that directory.

### The browser shows a blank page

1. Check the server is running ("Uvicorn running on..." in terminal)
2. Use `http://localhost:8420` (not `https`)
3. Check browser console (F12) for JS errors
4. Requires ES module import maps: Chrome 89+, Firefox 108+, Safari 16.4+, Edge 89+

### Model takes a long time to load

Large files (>50MB) may take seconds to transfer and parse. SSAO postprocessing can slow down on very complex models (>1M triangles).

---

## Development

### Running tests

```bash
poetry run pytest tests/ -v
```

### Auto-generated API docs

- **Swagger UI**: http://localhost:8420/docs
- **ReDoc**: http://localhost:8420/redoc

### Frontend changes — no build step needed

Edit any file in `frontend/` and refresh the browser. Three.js is loaded from CDN via import maps.

### Adding a new 3D format

1. Add extension to `SUPPORTED_3D_EXTENSIONS` in `file_browser.py` and `archive_inspector.py`
2. Add a Three.js loader + method in `viewer_3d.js`
3. Wire it in the `loadModel()` switch
4. Register the MIME type in `app.py`
5. Add badge color in CSS and icon in `file_browser.js`
