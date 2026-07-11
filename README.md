# MeshVault

A professional, local web-based tool for rapidly browsing, previewing, and managing 3D assets across your filesystem — including assets inside archives.

**Three ways to use it:**

| | For humans | For AI agents |
|---|---|---|
| **Online, zero install** | [Open the live viewer](https://www.lpalbou.info/MeshVault/) — drag-drop a model or pass `?src=<url>`; nothing is uploaded | Drive `window.mv` on the live page via browser automation — see the site's [`llms.txt`](https://www.lpalbou.info/MeshVault/llms.txt) |
| **Local app** | `pip install meshvault` → `meshvault` → browse your filesystem at `http://localhost:8420` | Same server also serves the JSON control API docs at `/llms.txt` |
| **MCP server** | — | `pip install "meshvault[mcp]"` → `meshvault-mcp`: 11 tools (load by path/URL, describe, mesh stats, geometric compare, sculpt/paint/primitives, reproducible screenshots, scene persistence, two-way co-review with the app) for Claude/Cursor — [docs/mcp.md](docs/mcp.md) |

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
| **Browsing** | Sidebar tree, list/grid view with rendered thumbnails, sort, filter, remember last directory, shareable deep links (`?path=`/`?dir=`) |
| **Library** | Cross-folder search, tags & collections, recent files (all backed by a local index) |
| **File Management** | Right-click: rename (inline), duplicate, delete, show in file manager |
| **3D Viewer** | PBR rendering, SSAO, soft shadows, ACES tone mapping, orbit + FPV drone navigation |
| **Toolbar** | Screenshot, grid, axes (XYZ), wireframe, normals viz, texture folder picker, material inspector, lights, measure |
| **Animation** | Play/pause, scrub, speed, clip selector for animated GLB/FBX/Collada |
| **Scene composition** | Co-load multiple objects, place them with a gizmo (move/rotate/scale), objects panel, save/load `.mvscene` scenes, export the composition as one GLB |
| **Sculpt & paint (agents)** | 7 primitives with paint-safe UVs, 6 world-space sculpt brushes (seam-safe, quantified feedback), texture painting (round/square stamps, edge clamping, honest `meanAlpha`), screenshot-to-surface `pick` — the full create/observe/correct loop over MCP |
| **Transforms** | Reload, reset, center, ground, auto-orient (PCA), rotate ±90° per axis |
| **Mesh Ops** | Simplify (edge collapse LOD, UV-preserving), recompute smooth normals (UV-preserving) |
| **Textures** | Folder picker with smart matching (convention + fuzzy name) for separated texture packs |
| **Export** | Save As dialog, folder browser, modified models export as OBJ/GLB with baked transforms |
| **Extras** | Drag-and-drop load, measurement, 12 background presets, scale, persistent settings |
| **AI agents** | Self-describing JSON control API (`/llms.txt`), `describe_scene` text snapshots, and an MCP server (`meshvault-mcp`) for Claude/Cursor — see [docs/mcp.md](docs/mcp.md) |
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

## Control MeshVault with AI agents

MeshVault is built to be driven by agents, not just humans. Four entry points, from
lightest to most integrated:

1. **Self-describing JSON control API** — the viewer exposes one entry point,
   `execute({action, params})`, with ~70 discoverable commands (`listCommands()`), plus
   `describe_scene`: a structured text snapshot (inventory, size, materials, geometry-QA
   issues, current view) so a text-only agent can reason without screenshots. Agent-ready
   reference served at [`/llms.txt`](frontend/llms.txt) and
   [`/llms-full.txt`](frontend/llms-full.txt).
2. **MCP server** — `meshvault-mcp` lets Claude Desktop / Claude Code / Cursor drive a
   headless viewer natively through 11 tools: load a model by **URL or local file path**
   (multi-file OBJ/FBX assets load textured), compose multi-object scenes
   (`add: true` + placement commands, persisted as `.mvscene` via
   `save_scene`/`load_scene`), **create and modify content** — primitives, sculpting
   brushes, texture painting, screenshot-coordinate picking (the agent hand-eye
   loop) — describe it, run any viewer command, and get PNG
   screenshots back as image content (`best_view: true` gives a one-call hero shot;
   `preset: "studio"` pins lighting so renders are comparable across sessions).
   With the app running, co-review works both ways: `open_in_app` pushes the agent's
   model + camera into the human's browser tab, and `get_app_state` reads back what
   the human is looking at. Setup: [docs/mcp.md](docs/mcp.md).
3. **Headless REST screenshot** — `GET /api/screenshot?path=…&best_view=true` returns
   a PNG over plain authenticated HTTP (same reproducible presets) — agent loops with
   nothing but curl. Reference: [docs/api.md](docs/api.md#get-apiscreenshot).
4. **Embeddable standalone viewer** — `meshvault-viewer.js` is a server-less ES-module
   bundle (Three.js included, offline, compressed-glTF decoders bundled) exposing the
   same control API for your own pages or agent harnesses.

Typical agent flow: `load` → `describe_scene` → `find_best_view` (finds the model's
semantic front and uprights it) → `set_render_mode` / `set_clip` to inspect →
`screenshot`.

## Documentation

- [Getting Started](docs/getting_started.md) — Installation, UI overview, complete feature guide
- [Architecture](docs/architecture.md) — System design, components, rendering pipeline
- [API Reference](docs/api.md) — REST API (22 routes, incl. headless `GET /api/screenshot`)
- [MCP Server](docs/mcp.md) — Drive the viewer from Claude/Cursor via Model Context Protocol
- [FAQ](docs/faq.md) — Troubleshooting and tips

## License

MIT — © 2026 Laurent-Philippe Albou — contact@abstractcore.ai
