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

Without any of these, the tool still works perfectly for `.obj`, `.fbx`, and `.zip` files. RAR archives will simply be skipped during browsing.

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

To run on a different port:

```bash
PORT=9000 poetry run meshvault
```

---

## Using the Application

### The Interface

The UI has three main areas:

```
┌─────────────────────────────────────────────────────┐
│  [Logo]  [Name input]  [Export path]  [Export btn]  │  ← Top Bar
├──────────────┬──────────────────────────────────────┤
│              │                              [☀]     │
│  File        │         3D Viewer                    │
│  Browser     │         (Three.js)                   │
│  (sidebar)   │                                      │
│              │                            [stats]   │
└──────────────┴──────────────────────────────────────┘
```

### Browsing Files

1. The sidebar starts at your **home directory**
2. **Double-click** a folder to navigate into it
3. Click the **◀** button to go up one level
4. Click the **🏠** button to return home
5. The current path is shown at the top of the sidebar

### Asset Types

Assets are color-coded in the file list:

| Color | Meaning |
|-------|---------|
| 🟢 Green badge | `.obj` file on disk |
| 🟠 Orange badge | `.fbx` file on disk |
| 🟣 Purple badge | Asset inside a `.zip` or `.rar` archive |

### Viewing a 3D Model

1. Click on any asset in the file list
2. The model loads in the 3D viewer (a loading spinner appears)
3. Model info (vertices, faces, file size) appears in the bottom-left corner

> **Note:** Old FBX files (version < 7000, pre-2011) are automatically converted to OBJ by MeshVault before loading. This is seamless — you just click and view.

### Camera Controls

The viewer has two navigation modes, toggled via the **🛤/✈ button** in the top-right toolbar:

#### Orbit Mode (default)

| Input | Action |
|-------|--------|
| **Left-click drag** | Orbit / rotate around the pivot point |
| **Scroll wheel** | Zoom in / out |
| **Right-click drag** | Pan the view |
| **Right-click** (no drag) | Set a new orbit pivot on the model surface |
| **Spacebar** | Reset to default view |

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
| **Spacebar** | Reset to default view (also switches back to Orbit) |

In FPV mode, all movement is relative to the drone itself — forward/backward follows where the camera is actually pointing, and A/D rotate the view rather than strafing. Movement speed adapts automatically to the model size.

### Model Scale

A **Scale** slider appears in the bottom-right corner of the viewer when a model is loaded. Drag it to rescale the model from **0.25×** to **2.0×** in 0.25 increments. The slider snaps to standard values. Scale resets to 1.0× each time a new model is loaded.

### Light Controls

Click the **☀ sun icon** in the top-right corner of the viewer to open the light panel:

| Control | What it adjusts |
|---------|----------------|
| **Direction H** | Key light horizontal angle (azimuth, 0°–360°) |
| **Direction V** | Key light vertical angle (elevation, 5°–90°) |
| **Key Light** | Main directional light intensity (0–3) |
| **Fill Light** | Opposite-side fill light intensity (0–2) |
| **Ambient** | Base ambient lighting intensity (0–2) |
| **Exposure** | Overall tone mapping exposure (0.3–4) |
| **Reset** | Restore all light settings to defaults |

### Exporting / Renaming an Asset

1. Select an asset to view it
2. The **top bar** shows two input fields:
   - **Name**: The desired output name (pre-filled with original name)
   - **Export to**: Target directory path
3. Edit either field as needed
4. Click **Export** (or press Enter in either field)
5. A toast notification confirms success or reports errors

**Export behavior:**
- **Single file** (e.g., a standalone `.fbx`): Exported as a single renamed file
- **Multiple files** (e.g., `.obj` + `.mtl` + textures): Exported into a subfolder named after the asset

---

## Stopping the Server

Press `Ctrl+C` in the terminal where the server is running. Temporary extraction files (from archive viewing) are automatically cleaned up on shutdown.

---

## Next Steps

- Read [Architecture](architecture.md) to understand how the system is designed
- Check [API Reference](api.md) if you want to integrate with the backend
- See [FAQ](faq.md) for troubleshooting common issues
