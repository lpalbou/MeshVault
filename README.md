# MeshVault

A professional, local web-based tool for rapidly browsing, previewing, and managing 3D assets (`.obj`, `.fbx`, `.gltf`, `.glb`, `.stl`) across your filesystem — including assets buried inside `.zip` and `.rar` archives.

[![CI](https://github.com/lpalbou/meshvault/actions/workflows/ci.yml/badge.svg)](https://github.com/lpalbou/meshvault/actions)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)](https://python.org)
[![FastAPI](https://img.shields.io/badge/backend-FastAPI-009688)](https://fastapi.tiangolo.com)
[![Three.js](https://img.shields.io/badge/3D-Three.js%20r170-black)](https://threejs.org)
[![PyPI](https://img.shields.io/pypi/v/meshvault)](https://pypi.org/project/meshvault/)
[![npm](https://img.shields.io/npm/v/meshvault)](https://www.npmjs.com/package/meshvault)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

| Feature | Description |
|---------|-------------|
| **Folder Browsing** | Navigate with sidebar tree, list/grid view toggle, sort by name/size/type. |
| **Search & Filter** | Real-time filter by name across folders and assets. |
| **File Management** | Right-click context menu: rename (inline), duplicate, delete, show in file manager. |
| **3D Formats** | `.obj`, `.fbx`, `.gltf`, `.glb`, `.stl` — including inside `.zip`/`.rar` archives. |
| **Interactive Viewer** | PBR rendering, SSAO, soft shadows, ACES tone mapping. |
| **Orbit / FPV** | Orbit mode (mouse orbit/zoom/pan, pivot pick) and FPV drone (WASD/arrows, mouse look). |
| **Viewer Toolbar** | Toggle grid, XYZ axes, wireframe, normals visualization, material inspector, light controls. |
| **Light Controls** | Key/fill/ambient intensity, light direction, exposure. |
| **Background Presets** | 12 color swatches (neutral ramp + tinted) with adaptive grid colors. |
| **Model Transforms** | Reload, reset, center, ground, auto-orient (PCA), rotate ±90° per axis. |
| **Mesh Simplification** | LOD-style vertex reduction via edge collapse decimation. |
| **Recompute Normals** | Merge vertices + smooth normals to fix faceted shading. |
| **Material Inspector** | Draggable floating panel listing all materials with PBR properties. |
| **Model Scaling** | Scale slider 0.05×–5.0×. |
| **Save As** | Export dialog with folder browser, pre-filled filename. Modified models export as OBJ. |
| **FBX Auto-Conversion** | Old FBX (version < 7000) auto-converted to OBJ via built-in binary parser. |
| **Persistent Settings** | Wireframe, grid, axes, normals, background persist across model loads. |

## Quick Start

```bash
git clone https://github.com/lpalbou/meshvault.git
cd meshvault
poetry install --no-root
poetry run meshvault
```

Then open **http://localhost:8420** in your browser.

### Install from PyPI / NPM

```bash
pip install meshvault && meshvault    # PyPI
npx meshvault                         # NPM
```

## Usage

1. **Browse**: Navigate folders in the sidebar. Sort by name/size/type. Toggle list/grid view. Filter by name.
2. **Manage**: Right-click any file for rename, duplicate, delete, or show in file manager.
3. **Preview**: Click any 3D asset to load it (OBJ=green, FBX=orange, GLTF=cyan, STL=violet, archived=purple).
4. **Navigate**: Orbit mode or FPV drone mode (toggle in toolbar). Spacebar resets camera.
5. **Inspect**: Toggle grid, axes, wireframe, normals, or open the material inspector from the toolbar.
6. **Transform**: Reload, reset, center, ground, orient, rotate ±90°, simplify mesh, recompute normals.
7. **Export**: Click Export → Save As dialog with folder browser. Modified models are saved as OBJ.

## Documentation

- [Getting Started](docs/getting_started.md) — Installation, first run, complete usage guide
- [Architecture](docs/architecture.md) — System design, components, rendering pipeline
- [API Reference](docs/api.md) — REST API endpoints (12 endpoints)
- [FAQ](docs/faq.md) — Common questions and troubleshooting

## Tests

```bash
poetry run pytest tests/ -v
```

## Contributing

Contributions welcome — [open an issue](https://github.com/lpalbou/meshvault/issues) or submit a PR.

## License

MIT License — see [LICENSE](LICENSE) for details.

© 2026 Laurent-Philippe Albou — contact@abstractcore.ai
