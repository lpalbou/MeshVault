# MeshVault

A professional, local web-based tool for rapidly browsing, previewing, and managing 3D assets across your filesystem — including assets inside archives.

[![CI](https://github.com/lpalbou/meshvault/actions/workflows/ci.yml/badge.svg)](https://github.com/lpalbou/meshvault/actions)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)](https://python.org)
[![FastAPI](https://img.shields.io/badge/backend-FastAPI-009688)](https://fastapi.tiangolo.com)
[![Three.js](https://img.shields.io/badge/3D-Three.js%20r170-black)](https://threejs.org)
[![PyPI](https://img.shields.io/pypi/v/meshvault)](https://pypi.org/project/meshvault/)
[![npm](https://img.shields.io/npm/v/meshvault)](https://www.npmjs.com/package/meshvault)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Supported Formats

| 3D Models | Archives |
|-----------|----------|
| `.obj`, `.fbx`, `.gltf`, `.glb`, `.stl`, `.blend`*, `.max`** | `.zip`, `.rar`, `.unitypackage` |

\* Requires Blender installed · \*\* Detection only (convert to FBX/OBJ in 3ds Max)

## Features

| Category | Features |
|----------|----------|
| **Browsing** | Sidebar tree, list/grid view, sort (name/size/type), search filter, remember last directory |
| **File Management** | Right-click: rename (inline), duplicate, delete, show in file manager |
| **3D Viewer** | PBR rendering, SSAO, soft shadows, ACES tone mapping, orbit + FPV drone navigation |
| **Toolbar** | Screenshot, grid, axes (XYZ), wireframe, normals viz, texture folder picker, material inspector, lights |
| **Transforms** | Reload, reset, center, ground, auto-orient (PCA), rotate ±90° per axis |
| **Mesh Ops** | Simplify (edge collapse LOD), recompute smooth normals |
| **Textures** | Folder picker with smart matching (convention + fuzzy name) for separated texture packs |
| **Export** | Save As dialog, folder browser, modified models export as OBJ with baked transforms |
| **Extras** | 12 background presets, scale 0.05×–5.0×, persistent settings, FBX/Blend auto-conversion |

## Quick Start

```bash
git clone https://github.com/lpalbou/meshvault.git
cd meshvault
poetry install --no-root
poetry run meshvault
```

Open **http://localhost:8420** · Also: `pip install meshvault` or `npx meshvault`

## Documentation

- [Getting Started](docs/getting_started.md) — Installation, UI overview, complete feature guide
- [Architecture](docs/architecture.md) — System design, components, rendering pipeline
- [API Reference](docs/api.md) — REST API (14 endpoints)
- [FAQ](docs/faq.md) — Troubleshooting and tips

## License

MIT — © 2026 Laurent-Philippe Albou — contact@abstractcore.ai
