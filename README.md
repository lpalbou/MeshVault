# MeshVault

A professional, local web-based tool for rapidly browsing, previewing, and managing 3D assets (`.obj`, `.fbx`, `.gltf`, `.glb`) across your filesystem — including assets buried inside `.zip` and `.rar` archives.

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
| **Folder Browsing** | Navigate your filesystem with a clean sidebar tree. Go up, go home, double-click to enter. List/grid view toggle. |
| **Search & Filter** | Real-time search input to filter folders and assets in the current directory. |
| **3D Asset Detection** | Finds `.obj`, `.fbx`, `.gltf`, `.glb` files — including inside `.zip` and `.rar` archives. |
| **Interactive 3D Viewer** | Click an asset to load it with high-quality PBR rendering, SSAO, soft shadows, tone mapping. |
| **Orbit / FPV Toggle** | Orbit mode (mouse orbit/zoom/pan, right-click pivot) and FPV drone mode (WASD fly, A/D yaw, mouse look). |
| **Viewer Toolbar** | Toggle grid, XYZ axes (colored + labeled), wireframe, and light controls from the top-right toolbar. |
| **Light Controls** | Adjustable key/fill/ambient intensity, light direction (azimuth/elevation), and exposure. |
| **Background Presets** | 12 background color swatches (dark, gray, light, tinted) for evaluating models on any backdrop. |
| **Model Transforms** | Center at origin, ground on Y=0, auto-orient via PCA, reset to original. All without moving the camera. |
| **Model Scaling** | Real-time scale slider (0.25×–2.0×). |
| **Modified Export** | Export applies all transforms (center, ground, orient, scale) — saves modified OBJ via Three.js OBJExporter. |
| **FBX Auto-Conversion** | Old FBX files (version < 7000) are auto-converted to OBJ via a built-in binary parser. |
| **Persistent Settings** | Scene settings (wireframe, grid, axes, background) persist across model loads. |

## Quick Start

### Prerequisites

- **Python 3.10+**
- **Poetry** ([install guide](https://python-poetry.org/docs/#installation))
- For `.rar` support, one of: `bsdtar`, `unrar`, `7z`, or `unar` (auto-detected)

### Install & Run

```bash
git clone https://github.com/lpalbou/meshvault.git
cd meshvault
poetry install --no-root
poetry run meshvault
```

Then open **http://localhost:8420** in your browser.

### Install from PyPI

```bash
pip install meshvault
meshvault
```

### Install from NPM

```bash
npx meshvault
```

## Usage

1. **Browse**: Navigate folders in the sidebar. Toggle list/grid view. Filter by name.
2. **Preview**: Click any 3D asset to load it in the viewer (green=OBJ, orange=FBX, cyan=GLTF, purple=archived).
3. **Navigate**: Orbit mode (left-drag orbit, scroll zoom, right-drag pan, right-click pivot) or FPV drone mode (W/Shift forward, S/Ctrl backward, A/D yaw, E/Q altitude). Spacebar resets camera.
4. **Scene tools**: Toggle grid, axes (XYZ), wireframe, and lighting from the toolbar. Pick background color from swatches.
5. **Transform**: Center model at origin, ground it on Y=0, or auto-orient via PCA. Reset undoes all transforms.
6. **Export**: Set name and path in the top bar, click Export. Modified models (centered/oriented/scaled) are exported as OBJ with baked transforms.

## Project Structure

```
meshvault/
├── backend/
│   ├── app.py                 # FastAPI server + routes
│   ├── file_browser.py        # Filesystem navigation + asset discovery
│   ├── archive_inspector.py   # ZIP/RAR inspection + multi-tool extraction
│   ├── export_manager.py      # Asset export with renaming
│   └── fbx_converter.py       # FBX 6100 binary parser + OBJ converter
├── frontend/
│   ├── index.html             # Main HTML page
│   ├── css/styles.css         # Dark professional theme
│   └── js/
│       ├── app.js             # Main orchestrator
│       ├── file_browser.js    # File browser + search + grid/list
│       ├── viewer_3d.js       # Three.js 3D viewer
│       └── export_panel.js    # Rename/export controls
├── tests/
│   └── test_file_browser.py   # Backend unit tests
├── docs/                      # Full documentation
├── pyproject.toml             # Poetry / PyPI configuration
├── package.json               # NPM configuration
└── poetry.lock
```

## Documentation

- [Getting Started](docs/getting_started.md) — Installation, first run, basic usage
- [Architecture](docs/architecture.md) — System design, components, design decisions
- [API Reference](docs/api.md) — REST API endpoints, request/response schemas
- [FAQ](docs/faq.md) — Common questions and troubleshooting

## Tests

```bash
poetry run pytest tests/ -v
```

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on [GitHub](https://github.com/lpalbou/meshvault).

## License

MIT License — see [LICENSE](LICENSE) for details.

© 2026 Laurent-Philippe Albou — contact@abstractcore.ai
