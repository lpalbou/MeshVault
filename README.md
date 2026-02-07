# MeshVault

A professional, local web-based tool for rapidly browsing, previewing, and managing 3D assets (`.obj`, `.fbx`) across your filesystem — including assets buried inside `.zip` and `.rar` archives.

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
| **Folder Browsing** | Navigate your filesystem with a clean sidebar tree. Go up, go home, double-click to enter. |
| **3D Asset Detection** | Automatically finds `.obj` and `.fbx` files in each folder. |
| **Archive Scanning** | Looks inside `.zip` and `.rar` archives to detect 3D assets without extracting. Uses a multi-tool fallback chain (`rarfile`, `bsdtar`, `unrar`, `7z`, `unar`). |
| **Interactive 3D Viewer** | Click an asset to load it in a high-quality Three.js viewer with orbit, FPV drone navigation, and pivot picking. |
| **High-Quality Rendering** | PBR materials, 5-light setup, soft shadows, SSAO ambient occlusion, ACES tone mapping. |
| **Light Controls** | Adjustable key/fill/ambient light intensity, directional orientation (azimuth/elevation), and exposure. |
| **Orbit / FPV Toggle** | Clear mode switch between Orbit (mouse orbit/zoom/pan) and FPV drone (WASD fly, A/D yaw, mouse look). |
| **FPV Navigation** | True drone controls: W/Shift forward, S/Ctrl backward along look direction, A/D yaw, E/Q altitude, mouse drag to look. |
| **Right-Click Pivot** | In Orbit mode, right-click on the model surface to set a new orbit center for detailed inspection. |
| **FBX Auto-Conversion** | Old FBX files (version < 7000) are automatically converted to OBJ via a built-in binary parser. |
| **Model Scaling** | Real-time scale slider (0.25×–2.0×) to resize the model in the viewer. |
| **Rename & Export** | Rename assets and export them (with all derivatives: `.mtl`, textures) to any folder. |
| **Related File Handling** | Automatically detects `.mtl` materials and texture files associated with each asset. |

## Quick Start

### Prerequisites

- **Python 3.10+**
- **Poetry** ([install guide](https://python-poetry.org/docs/#installation))
- For `.rar` support, one of: `bsdtar`, `unrar`, `7z`, or `unar` (the tool auto-detects what's available)

### Install & Run

```bash
# Clone the repository
git clone https://github.com/lpalbou/meshvault.git
cd meshvault

# Install dependencies
poetry install --no-root

# Start the server
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

### Custom Port

```bash
PORT=9000 poetry run meshvault
```

## Usage

1. **Browse**: The left sidebar shows your home directory. Double-click folders to navigate, use the ◀ and 🏠 buttons to go up or home.
2. **Preview**: Click any 3D asset (green = `.obj`, orange = `.fbx`, purple = archived) to load it in the viewer.
3. **Navigate**: Toggle Orbit ↔ FPV mode (top-right button). Orbit: mouse to orbit/zoom/pan, right-click to set pivot. FPV: W/Shift forward, S/Ctrl backward, A/D yaw, E/Q altitude, mouse drag to look. Spacebar resets view.
4. **Light**: Click the ☀ icon (top-right of viewer) to adjust light direction, intensity, and exposure.
5. **Export**: Edit the name in the top bar, set an export path, and click **Export**. Single assets export as a file; assets with derivatives (`.mtl`, textures) export as a folder.

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
│       ├── file_browser.js    # File browser component
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
