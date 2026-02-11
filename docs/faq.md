# FAQ

---

## Formats

**Supported 3D**: `.obj`, `.fbx`, `.gltf`/`.glb`, `.stl`, `.blend`* (needs Blender), `.max`** (detection only)

**Archives**: `.zip`, `.rar` (needs CLI tool), `.unitypackage`

---

## Navigation

**Orbit**: Left-drag orbit, scroll zoom, right-drag pan, right-click set pivot.
**FPV**: W/Shift forward, S/Ctrl backward, A/D yaw, arrows pitch, E/Q altitude, left-drag look.
**Spacebar**: Reset camera only. **Toggle** in toolbar.

---

## Viewer Toolbar

Screenshot · Orbit/FPV · Grid · Axes · Wireframe · Normals · Texture folder · Materials · Lights. All persist across model loads.

---

## Model Tools

- **Reload**: Re-fetch from disk · **Reset**: Undo all transforms
- **Center/Ground/Orient**: Position model at origin, on ground, or auto-orient (PCA)
- **Rotate ±90°**: Per-axis rotation (X/Y/Z)
- **Simplify**: Edge collapse LOD (merge vertices first for proper topology)
- **Normals**: Merge vertices + recompute smooth normals (fixes faceted shading, loses UVs)

---

## Textures

**Separated texture packs**: Click the texture button in toolbar → browse to texture folder → Apply. Smart matching by naming convention (`{name}_diffuse.png`) + fuzzy name matching.

---

## File Management

**Right-click** any file in sidebar: Rename (inline), Duplicate, Delete, Show in file manager.

---

## Export

Click **Export** → Save As dialog with folder browser → filename pre-filled. Modified models (center/orient/rotate/simplify/scale) export as `.obj` with baked vertices. File browser auto-refreshes.

---

## Blend Files

Requires Blender installed and in PATH (or standard macOS/Windows locations). MeshVault auto-converts `.blend` → `.glb` via Blender CLI. Results cached as `.converted.glb`.

## MAX Files

`.max` files are shown in the browser but can't be opened (proprietary format). Convert to FBX/OBJ in 3ds Max.

## Unity Packages

`.unitypackage` files are parsed natively (gzipped tar with GUID structure). 3D assets inside are listed and can be previewed/exported.

---

## Troubleshooting

- **Port in use**: `PORT=9000 poetry run meshvault`
- **Blank page**: Use `http`, check F12 console, needs Chrome 89+ / Firefox 108+
- **RAR not scanned**: Install `bsdtar`/`unrar`/`7z`/`unar`
- **Blend won't load**: Install Blender, ensure `blender` is in PATH
- **Slow model**: Simplify first, SSAO is heavy on >1M triangles

---

## Development

```bash
poetry run pytest tests/ -v
# Swagger: http://localhost:8420/docs
```

No frontend build step. Edit `frontend/`, refresh browser.
