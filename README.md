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
| `.obj`, `.fbx`, `.gltf`, `.glb`, `.stl`, `.ply`, `.dae`, `.3mf`, `.usdz` | `.zip`, `.rar`, `.unitypackage` |

Older FBX files (version < 7000) are auto-converted to OBJ by a built-in zero-dependency parser. `.usdz` is import-only.

## Features

| Category | Features |
|----------|----------|
| **Browsing** | Sidebar tree, list/grid view with rendered thumbnails, sort, filter, remember last directory |
| **Library** | Cross-folder search, tags & collections, recent files (all backed by a local index) |
| **File Management** | Right-click: rename (inline), duplicate, delete, show in file manager |
| **3D Viewer** | PBR rendering, SSAO, soft shadows, ACES tone mapping, orbit + FPV drone navigation |
| **Toolbar** | Screenshot, grid, axes (XYZ), wireframe, normals viz, texture folder picker, material inspector, lights, measure |
| **Animation** | Play/pause, scrub, speed, clip selector for animated GLB/FBX/Collada |
| **Transforms** | Reload, reset, center, ground, auto-orient (PCA), rotate ±90° per axis |
| **Mesh Ops** | Simplify (edge collapse LOD, UV-preserving), recompute smooth normals (UV-preserving) |
| **Textures** | Folder picker with smart matching (convention + fuzzy name) for separated texture packs |
| **Export** | Save As dialog, folder browser, modified models export as OBJ/GLB with baked transforms |
| **Extras** | Drag-and-drop load, measurement, 12 background presets, scale, persistent settings |
| **Security** | Loopback bind, session-token auth, path confinement to an allowed root (see below) |

## Quick Start

```bash
git clone https://github.com/lpalbou/meshvault.git
cd meshvault
poetry install --no-root
poetry run meshvault
```

Open **http://localhost:8420** · Also: `pip install meshvault` or `npx meshvault`

MeshVault binds to `127.0.0.1` and requires a session token on every `/api/*` request.
By default it can browse your whole filesystem (opening at your home directory) — the
network protections (loopback + token + Host allow-list) are what keep it private.
Set `MESHVAULT_ROOT=/path[:/path2]` to **restrict** file access to specific directories.
Configure `MESHVAULT_HOST` (bind host) and `MESHVAULT_TOKEN` as needed. Opening the URL on
the same machine authenticates automatically; other devices need the token from the launch
banner. See [API Reference](docs/api.md#security-model).

## Documentation

- [Getting Started](docs/getting_started.md) — Installation, UI overview, complete feature guide
- [Architecture](docs/architecture.md) — System design, components, rendering pipeline
- [API Reference](docs/api.md) — REST API (14 endpoints)
- [FAQ](docs/faq.md) — Troubleshooting and tips

## License

MIT — © 2026 Laurent-Philippe Albou — contact@abstractcore.ai
