# Getting Started

---

## Prerequisites

- **Python 3.10+** · **Poetry** (`curl -sSL https://install.python-poetry.org | python3 -`)
- Optional: `bsdtar`/`unrar`/`7z`/`unar` for RAR archive support

## Installation & Run

```bash
git clone https://github.com/lpalbou/meshvault.git && cd meshvault
poetry install --no-root
poetry run meshvault          # → http://localhost:8420
PORT=9000 poetry run meshvault  # Custom port
```

---

## Supported Formats

| Format | Badge | Notes |
|--------|-------|-------|
| `.obj` | 🟢 Green | + `.mtl` materials and textures |
| `.fbx` | 🟠 Orange | v7000+ native, older auto-converted to OBJ |
| `.gltf`/`.glb` | 🔵 Cyan | GL Transmission Format |
| `.stl` | 🟣 Violet | Stereolithography |
| `.zip`/`.rar` | 📦 | Archive scanning |
| `.unitypackage` | 📦 | Unity package parsing (GUID-based structure) |

---

## The Interface

```
┌────────────────────────────────────────────────────────────────────────┐
│ MeshVault  [🔄][↺] | [⊕][⏚][◇] | [X± Y± Z±] | [◆][⊛] | [Export]  │
├──────────────┬─────────────────────────────────────────────────────────┤
│ [Sort][≡][⊞] │                    [📷][👁][▦][⚐][◇][↕][🖼][⊙][☀]   │
│ [Filter...]  │                                                         │
│              │              3D Viewer                                   │
│  File        │                                                         │
│  Browser     │  [bg swatches]                              [scale]     │
│              │  [stats]                                                │
└──────────────┴─────────────────────────────────────────────────────────┘
```

---

## File Browser (sidebar)

- **Navigate**: Double-click folders, ◀ up, 🏠 home
- **Sort**: A–Z, Z–A, Size ↑/↓, Type (persisted)
- **View**: List or grid toggle (persisted)
- **Filter**: Type to filter by name
- **Right-click**: Rename (inline), Duplicate, Delete, Show in file manager
- **Remember**: Opens to last visited directory on restart

---

## Camera

| Orbit (default) | FPV Drone |
|-----------------|-----------|
| Left-drag: orbit | W/Shift: forward |
| Scroll: zoom | S/Ctrl: backward |
| Right-drag: pan | A/D, ←/→: yaw |
| Right-click: set pivot | ↑/↓: pitch, E/Q: altitude |
| | Left-drag: mouse look |

**Spacebar**: reset camera (model untouched)

---

## Viewer Toolbar (top-right)

| Button | Function |
|--------|----------|
| 📷 Screenshot | Save current view as PNG |
| Orbit/FPV | Toggle navigation mode |
| Grid | Floor grid (scales to model, adapts to background) |
| Axes | XYZ helper (X=red, Y=green, Z=blue + labels) |
| Wireframe | Wireframe overlay |
| Normals | Vertex normals visualization |
| 🖼 Textures | Load textures from external folder (smart matching) |
| Materials | Draggable panel — all PBR material properties |
| ☀ Lights | Direction, intensity, exposure |

All settings persist across model loads.

---

## Top Bar — Model Tools

| Button | Action |
|--------|--------|
| 🔄 Reload | Re-fetch from disk |
| ↺ Reset | Undo all transforms |
| ⊕ Center | Bbox center → (0,0,0) |
| ⏚ Ground | Center X/Z, bottom at Y=0 |
| ◇ Orient | PCA auto-orient |
| X±/Y±/Z± | Rotate ±90° |
| ◆ Simplify | Edge collapse LOD (percentage slider) |
| ⊛ Normals | Recompute smooth normals |
| ⬆ Export | Save As dialog |

---

## Texture Folder Picker

For models with textures in separate archives/folders:
1. Load the model
2. Click the **texture button** in the toolbar
3. Navigate to the folder with textures
4. Click **Apply textures**

Matching: convention-based (`{name}_diffuse.png`) + fuzzy name matching, case-insensitive.

---

## Mesh Simplification

Click **Simplify** → set target % → **Apply**. Merges vertices → edge collapse → recompute normals. Full-screen overlay during processing.

---

## Export (Save As)

Click **Export** → folder browser dialog → filename pre-filled → **Save**.
- Unmodified: copies original file(s)
- Modified (center/orient/rotate/simplify/scale): exports as `.obj` with baked transforms

---

## Driving MeshVault with AI agents

The viewer has a self-describing JSON control API (~100 commands) designed for agents:
`describe_scene` gives a structured text snapshot (no vision needed), `find_best_view`
finds a model's semantic front, `screenshot` captures hero shots — and agents can go far
beyond observation: compose multi-object scenes, add primitives, sculpt and paint,
inspect and repair meshes/textures, split parts, set pivots, and animate the scene on a
keyframe timeline. Agent-ready docs are served at `/llms.txt` and `/llms-full.txt`, and
the optional MCP server (`pip install "meshvault[mcp]"`) lets Claude/Cursor drive a
headless viewer directly — see [MCP Server](mcp.md).

## Next Steps

- [Architecture](architecture.md) · [API Reference](api.md) · [MCP Server](mcp.md) · [FAQ](faq.md)
