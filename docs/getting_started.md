# Getting Started

This guide walks you through installing, running, and using MeshVault for the first time.

---

## Prerequisites

### Required

- **Python 3.10 or newer** — Check with `python3 --version`
- **Poetry** — Python dependency manager
  - Install: `curl -sSL https://install.python-poetry.org | python3 -`
  - Verify: `poetry --version`

### Optional (for RAR support)

RAR archive scanning requires one of the following CLI tools. The application auto-detects which is available:

| Tool | macOS | Linux |
|------|-------|-------|
| `bsdtar` | Often pre-installed (Xcode, Anaconda) | `sudo apt install libarchive-tools` |
| `unrar` | `brew install unrar` | `sudo apt install unrar` |
| `7z` | `brew install p7zip` | `sudo apt install p7zip-full` |
| `unar` | `brew install unar` | `sudo apt install unar` |

Without any of these, the tool still works for `.obj`, `.fbx`, `.gltf`, `.glb`, `.stl`, and `.zip` files. RAR archives will simply be skipped.

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/lpalbou/meshvault.git
cd meshvault

# 2. Install Python dependencies
poetry install --no-root

# 3. Verify installation
poetry run pytest tests/ -v
```

All 12 tests should pass. If they do, you're ready to go.

---

## Running the Application

```bash
poetry run meshvault
```

You'll see:

```
  🎨 MeshVault
  → Open http://localhost:8420 in your browser
```

Open that URL in any modern browser (Chrome, Firefox, Safari, Edge).

### Custom Port

```bash
PORT=9000 poetry run meshvault
```

---

## Using the Application

### The Interface

```
┌──────────────────────────────────────────────────────────────────────┐
│  [Logo]  [Reset] | [Center] [Ground] [Orient] | [Name] [Path] [Export] │  ← Top Bar
├──────────────┬───────────────────────────────────────────────────────┤
│  [List/Grid] │                                     [🛤][▦][⚐][◇][☀] │  ← Toolbar
│  [Filter...] │                                                       │
│              │              3D Viewer                                 │
│  File        │              (Three.js)                                │
│  Browser     │                                                       │
│  (sidebar)   │  [bg swatches]                              [scale]   │
│              │  [stats]                                              │
└──────────────┴───────────────────────────────────────────────────────┘
```

### Browsing Files

1. The sidebar starts at your **home directory**
2. **Double-click** a folder to navigate into it
3. Click the **◀** button to go up one level
4. Click the **🏠** button to return home
5. **Filter**: Type in the search box to filter folders and assets by name
6. **View mode**: Toggle between list and grid view (icons in the sidebar header)

### Asset Types

Assets are color-coded in the file list:

| Color | Meaning |
|-------|---------|
| 🟢 Green | `.obj` file |
| 🟠 Orange | `.fbx` file |
| 🔵 Cyan | `.gltf` / `.glb` file |
| 🟣 Purple (violet) | `.stl` file |
| 🟣 Purple (dark) | Asset inside a `.zip` or `.rar` archive |

### Viewing a 3D Model

1. Click on any asset in the file list
2. The model loads in the 3D viewer (a loading spinner appears)
3. Model info (vertices, faces, file size) appears in the bottom-left corner

> **Note:** Old FBX files (version < 7000, pre-2011) are automatically converted to OBJ by MeshVault before loading.

### Camera Controls

The viewer has two navigation modes, toggled via the **orbit/FPV button** in the top-right toolbar:

#### Orbit Mode (default)

| Input | Action |
|-------|--------|
| **Left-click drag** | Orbit / rotate around the pivot point |
| **Scroll wheel** | Zoom in / out |
| **Right-click drag** | Pan the view |
| **Right-click** (no drag) | Set a new orbit pivot on the model surface |
| **Spacebar** | Reset camera to default view |

#### FPV Mode (drone)

| Input | Action |
|-------|--------|
| **W / Shift** | Fly forward (camera's true look direction) |
| **S / Ctrl** | Fly backward |
| **A / ←** | Yaw left (rotate the drone) |
| **D / →** | Yaw right (rotate the drone) |
| **↑ / ↓** | Pitch up / down |
| **E** | Altitude up |
| **Q** | Altitude down |
| **Left-click drag** | Free look (mouse controls pitch and yaw) |
| **Spacebar** | Reset camera to default view (switches back to Orbit) |

### Viewer Toolbar (top-right)

| Button | What it toggles |
|--------|----------------|
| **Orbit/FPV** | Switch between Orbit and FPV navigation modes |
| **Grid** | Floor grid (scales to model, adapts colors to background) |
| **Axes** | XYZ axis helper (X=red, Y=green, Z=blue with labels) |
| **Wireframe** | Wireframe overlay on all meshes |
| **Light (☀)** | Collapsible lighting control panel |

These settings **persist across model loads** — switching to a new asset keeps your scene preferences.

### Model Transform Buttons (top bar)

| Button | Tooltip | What it does |
|--------|---------|-------------|
| **Reset** | *Reset model to original state* | Undo all Center/Ground/Orient/Scale transforms |
| **Center** | *Center bounding box at (0,0,0)* | Translate model so its center is at the origin |
| **Ground** | *Place model on ground (Y=0)* | Center X/Z, shift so lowest point touches Y=0 |
| **Orient** | *Auto-orient via PCA* | Rotate model so its up-direction aligns with Y |

These modify the **model geometry only** — the camera stays where it is.

### Background Colors

12 color swatches in the bottom-left of the viewer. Includes a neutral grayscale ramp (dark → white) plus tinted options (warm dark, dark red, dark green). The grid adapts its colors to contrast with the selected background.

### Model Scale

A **Scale** slider in the bottom-right (0.25×–2.0×). Resets to 1.0× on new model load.

### Light Controls

Click **☀** in the toolbar to open the light panel:

| Control | Range |
|---------|-------|
| **Direction H** | Key light azimuth (0°–360°) |
| **Direction V** | Key light elevation (5°–90°) |
| **Key Light** | Intensity (0–3) |
| **Fill Light** | Intensity (0–2) |
| **Ambient** | Intensity (0–2) |
| **Exposure** | Tone mapping (0.3–4) |

### Exporting

1. Select an asset to view it
2. The **top bar** shows name + path fields
3. Click **Export** (or press Enter)

**Export behavior:**
- **Unmodified model**: Copies the original file(s) with new name
- **Modified model** (after Center/Ground/Orient/Scale): Exports the transformed geometry as OBJ via Three.js OBJExporter — all transforms are baked into the vertices
- **With related files** (`.mtl`, textures): Exported into a subfolder

---

## Stopping the Server

Press `Ctrl+C` in the terminal. Temporary extraction files are cleaned up on shutdown.

---

## Next Steps

- [Architecture](architecture.md) — System design and components
- [API Reference](api.md) — Backend REST API
- [FAQ](faq.md) — Troubleshooting
