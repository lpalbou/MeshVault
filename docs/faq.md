# FAQ

Frequently asked questions, troubleshooting tips, and common issues.

---

## General

### What 3D formats are supported?

Currently **`.obj`** (Wavefront OBJ) and **`.fbx`** (Autodesk FBX) are supported. OBJ files with accompanying `.mtl` material files and textures (`.png`, `.jpg`, `.tga`, etc.) are fully supported — materials and textures are loaded automatically.

Old FBX files (version < 7000, pre-2011) are automatically converted to OBJ by the backend's built-in binary parser before serving.

### What archive formats are supported?

- **`.zip`** — Fully supported out of the box (Python's built-in `zipfile` module)
- **`.rar`** — Supported via a multi-tool fallback chain. The application auto-detects and uses whichever of these is available: `bsdtar`, `unrar`, `7z`, `7za`, `unar`. It also searches common non-PATH locations (homebrew, anaconda).

### Can I browse any directory on my machine?

Yes. By default, the file browser starts at your home directory and you can navigate anywhere your user account has read access. Hidden files and directories (starting with `.`) are excluded from the listing for cleanliness.

### Is there network access or cloud functionality?

No. This is a **purely local tool**. The backend serves on `localhost` only for your browser. No data leaves your machine. No cloud services are used (except the Three.js CDN for the JavaScript library).

---

## Installation

### I don't have Poetry installed. What do I do?

Install Poetry with:

```bash
curl -sSL https://install.python-poetry.org | python3 -
```

Then restart your terminal and verify with `poetry --version`. See the [official Poetry docs](https://python-poetry.org/docs/#installation) for more options.

### The server starts but `.rar` files are not being scanned

You need at least one of these CLI tools installed:

| Tool | macOS | Linux |
|------|-------|-------|
| `bsdtar` | Often pre-installed (Xcode, Anaconda) | `sudo apt install libarchive-tools` |
| `unrar` | `brew install unrar` | `sudo apt install unrar` |
| `7z` | `brew install p7zip` | `sudo apt install p7zip-full` |
| `unar` | `brew install unar` | `sudo apt install unar` |

The application auto-detects which tool is available. Without any of them, `.rar` archives are simply skipped — everything else still works.

### I get "Module not found" errors when starting

Make sure you're running inside the Poetry virtualenv:

```bash
# Correct way to run
poetry run meshvault

# Or activate the virtualenv first
poetry shell
meshvault
```

---

## Usage

### The 3D model loads but looks dark / flat

This can happen with models that use very dark vertex colors or non-standard materials. The viewer automatically upgrades materials to PBR (`MeshStandardMaterial`), but some models may need different roughness/metalness values. The default values (roughness: 0.6, metalness: 0.1) work well for most models. You can also try adjusting the **light controls** (☀ icon) to increase light intensity or exposure.

### The model appears very small or very large

The viewer automatically **auto-frames** every model: it computes the bounding box and positions the camera to fit the entire model in view. If a model has outlier vertices far from the main geometry, the camera may appear too far away. You can scroll to zoom in, use WASD keys to fly closer, or press **Spacebar** to reset back to the framed view.

### OBJ file loads but has no textures

For textures to load, the `.mtl` file must be in the **same directory** as the `.obj` file and must share the **same stem name** (e.g., `model.obj` + `model.mtl`). The textures referenced in the `.mtl` must also be accessible. The viewer auto-detects and loads these related files.

### How do I navigate around the model?

The viewer has two distinct modes, toggled with the **🛤/✈ button** in the top-right toolbar:

- **Orbit mode** (default): Left-drag to orbit, scroll to zoom, right-drag to pan, right-click on model to set a new pivot point.
- **FPV mode** (drone): W/Shift fly forward, S/Ctrl fly backward along the camera's actual look direction, A/D yaw left/right, arrow keys for pitch/yaw, E/Q for altitude up/down, left-click drag for mouse look.

Press **Spacebar** to reset everything (camera position + orbit pivot) and switch back to Orbit mode.

### How do I adjust the lighting?

Click the **☀ sun icon** in the top-right corner of the viewer. A panel appears with sliders for:
- Key light direction (horizontal and vertical angles)
- Key light, fill light, and ambient intensity
- Overall exposure

Click **Reset** in the panel to restore defaults.

### I get "FBX version not supported"

This means the FBX file uses a version older than 7000 (pre-2011). MeshVault includes a built-in FBX binary parser that auto-converts these files to OBJ. If you see this error, make sure you're using the latest version — the auto-conversion should be seamless.

### Can I view animated FBX files?

Yes. If the `.fbx` file contains animations (version 7000+), the viewer will automatically play the first animation clip using a Three.js `AnimationMixer`. The animation loops continuously.

### What happens when I export an asset?

- The asset is **copied** (never moved or deleted) to the target directory
- If the asset has related files (`.mtl`, textures), they're all exported into a **subfolder** named after the asset
- If the asset is a single file with no related files, it's exported as a single renamed file
- The source files are never modified

### Can I export to a directory that doesn't exist?

Yes. The export manager automatically creates the target directory (and any necessary parent directories) if they don't exist.

---

## Troubleshooting

### Port 8420 is already in use

Set a custom port:

```bash
PORT=9000 poetry run meshvault
```

### "Access denied" error when browsing

You're trying to access a directory your user account doesn't have read permissions for. The tool can only access files and directories that your OS user can read.

### The browser shows a blank page

1. Check that the server is running (look for "Uvicorn running on..." in the terminal)
2. Make sure you're accessing `http://localhost:8420` (not `https`)
3. Open the browser's developer console (F12) to check for JavaScript errors
4. Ensure your browser supports ES module import maps (Chrome 89+, Firefox 108+, Safari 16.4+, Edge 89+)

### Model takes a long time to load

Large 3D files (>50MB) may take several seconds to transfer and parse. The loading spinner indicates progress. For archived assets, additional time is needed for extraction. Very complex models (>1M triangles) may also cause the SSAO postprocessing pass to slow down.

### "Failed to load" error for an OBJ file

Common causes:
1. The `.obj` file is malformed or corrupted
2. The `.mtl` file references textures that don't exist at the expected paths
3. The file uses unsupported OBJ features (rare)

Try checking the browser's developer console (F12 → Console tab) for more detailed error messages from the Three.js loaders.

---

## Development

### How do I run the tests?

```bash
poetry run pytest tests/ -v
```

### Where is the FastAPI auto-generated API documentation?

When the server is running:
- **Swagger UI**: http://localhost:8420/docs
- **ReDoc**: http://localhost:8420/redoc

### Can I modify the frontend without rebuilding?

Yes! The frontend uses **no build step**. Edit any file in `frontend/` and simply refresh the browser. Three.js is loaded directly from CDN via import maps.

### How do I add support for a new 3D format?

1. Add the extension to `SUPPORTED_3D_EXTENSIONS` in `backend/file_browser.py`
2. Add the same extension to `SUPPORTED_3D_EXTENSIONS` in `backend/archive_inspector.py`
3. Add a Three.js loader in `frontend/js/viewer_3d.js` (e.g., `GLTFLoader` for `.gltf`/`.glb`)
4. Add a loader method (e.g., `_loadGLTF()`) and wire it in the `loadModel()` switch
5. Register the MIME type in `backend/app.py`
