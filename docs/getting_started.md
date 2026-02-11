# Getting Started

This guide walks you through installing, running, and using MeshVault for the first time.

---

## Prerequisites

### Required

- **Python 3.10 or newer** — Check with `python3 --version`
- **Poetry** — `curl -sSL https://install.python-poetry.org | python3 -`

### Optional (for RAR support)

| Tool | macOS | Linux |
|------|-------|-------|
| `bsdtar` | Often pre-installed | `sudo apt install libarchive-tools` |
| `unrar` | `brew install unrar` | `sudo apt install unrar` |
| `7z` | `brew install p7zip` | `sudo apt install p7zip-full` |
| `unar` | `brew install unar` | `sudo apt install unar` |

---

## Installation

```bash
git clone https://github.com/lpalbou/meshvault.git
cd meshvault
poetry install --no-root
poetry run pytest tests/ -v   # All 12 tests should pass
```

---

## Running

```bash
poetry run meshvault
# Custom port:
PORT=9000 poetry run meshvault
```

Open **http://localhost:8420** in your browser.

---

## The Interface

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ MeshVault  [🔄][↺] | [⊕][⏚][◇] | [X± Y± Z±] | [◆ Simplify][⊛][✱] | [Export] │
├──────────────┬───────────────────────────────────────────────────────────────────┤
│ [Sort ▾]     │                                           [👁][▦][⚐][◇][↕][⊙][☀] │
│ [≡] [⊞]     │                                                                   │
│ [Filter...]  │              3D Viewer (Three.js)                                 │
│              │                                                                   │
│  File        │                                                                   │
│  Browser     │  [bg swatches]                                          [scale]   │
│  (sidebar)   │  [stats]                                                          │
└──────────────┴───────────────────────────────────────────────────────────────────┘
```

---

## Browsing Files

- **Navigate**: Double-click folders, ◀ to go up, 🏠 to go home
- **Sort**: Dropdown selector — A–Z, Z–A, Size ↑, Size ↓, Type
- **View**: Toggle between list and grid views
- **Filter**: Type to filter folders and assets by name
- **Right-click**: Context menu with Rename, Duplicate, Delete, Show in file manager

### Asset Types

| Badge | Format |
|-------|--------|
| 🟢 OBJ | Wavefront OBJ |
| 🟠 FBX | Autodesk FBX |
| 🔵 GLTF/GLB | GL Transmission Format |
| 🟣 STL | Stereolithography |
| 📦 Purple | Asset inside ZIP/RAR archive |

---

## Camera Controls

### Orbit Mode (default)

| Input | Action |
|-------|--------|
| Left-click drag | Orbit around pivot |
| Scroll | Zoom in/out |
| Right-click drag | Pan |
| Right-click (no drag) | Set new orbit pivot |
| Spacebar | Reset camera |

### FPV Mode (drone)

| Input | Action |
|-------|--------|
| W / Shift | Fly forward |
| S / Ctrl | Fly backward |
| A / ← | Yaw left |
| D / → | Yaw right |
| ↑ / ↓ | Pitch up/down |
| E / Q | Altitude up/down |
| Left-click drag | Mouse look |
| Spacebar | Reset camera (→ Orbit) |

---

## Viewer Toolbar (top-right)

| Button | Function |
|--------|----------|
| Orbit/FPV | Toggle navigation mode |
| Grid | Floor grid (scales to model, adapts to background) |
| Axes | XYZ axis helper (X=red, Y=green, Z=blue with labels) |
| Wireframe | Wireframe overlay |
| Normals | Vertex normals visualization (cyan lines) |
| Materials | Draggable floating panel — lists all materials with PBR properties |
| Light (☀) | Collapsible panel — direction, intensity, exposure |

Settings persist across model loads.

---

## Top Bar — Model Tools

| Button | Action |
|--------|--------|
| **Reload** (🔄) | Reload model from disk (discard all changes) |
| **Reset** (↺) | Undo all transforms (restore original geometry) |
| **Center** (⊕) | Move bounding box center to (0,0,0) |
| **Ground** (⏚) | Center X/Z, lowest point at Y=0 |
| **Orient** (◇) | PCA auto-orient (smallest axis → Y up) |
| **X± Y± Z±** | Rotate ±90° around each axis |
| **Simplify** (◆) | LOD — reduce vertex count via edge collapse |
| **Normals** (✱) | Recompute smooth vertex normals |
| **Export** (⬆) | Save As dialog with folder browser |

---

## Background & Scale

- **12 swatches** (bottom-left): neutral ramp + tinted options. Grid adapts.
- **Scale slider** (bottom-right): 0.05×–5.0× with 0.05 steps.

---

## Mesh Simplification

Click **Simplify** → set target percentage → **Apply**. Merges vertices first for proper edge collapse. Normals are recomputed automatically. Full-screen processing overlay during computation.

---

## Save As / Export

Click **Export** → **Save As dialog**:
- Folder browser to navigate directories
- Filename pre-filled (original name + extension)
- Modified models export as `.obj` with all transforms baked
- File browser auto-refreshes after save

---

## Stopping

Press `Ctrl+C` in terminal. Temp files cleaned up automatically.

---

## Next Steps

- [Architecture](architecture.md) — System design
- [API Reference](api.md) — Backend REST API
- [FAQ](faq.md) — Troubleshooting
