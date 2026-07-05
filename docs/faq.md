# FAQ

---

## Formats

**Supported 3D**: `.obj`, `.fbx`, `.gltf`/`.glb`, `.stl` (older FBX auto-converted to OBJ)

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
- **Simplify**: Edge collapse LOD (merge vertices first for proper topology; UVs preserved)
- **Normals**: Merge vertices + recompute smooth normals (fixes faceted shading; UVs preserved, smoothing stops at genuine UV seams)

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

## Unity Packages

`.unitypackage` files are parsed natively (gzipped tar with GUID structure). 3D assets inside are listed and can be previewed/exported.

---

## Troubleshooting

- **Port in use**: `PORT=9000 poetry run meshvault`
- **Blank page**: Use `http`, check F12 console, needs Chrome 89+ / Firefox 108+
- **RAR not scanned**: Install `bsdtar`/`unrar`/`7z`/`unar`
- **`401 Unauthorized` / `403` on API**: The app authenticates automatically when opened on the same machine. From another device, append `?token=<TOKEN>` (printed in the launch banner) and set `MESHVAULT_HOST`. `403` means the path is outside the allowed root (`MESHVAULT_ROOT`).
- **Slow model**: Simplify first, SSAO is heavy on >1M triangles

---

## Development

```bash
poetry run pytest tests/ -v
# Swagger: http://localhost:8420/docs
```

Frontend build (esbuild): the UI ships as a self-contained offline bundle
(`frontend/dist/app.bundle.js`, Three.js included — no CDN). Rebuild after editing
`frontend/js/**`:

```bash
npm install      # once (installs esbuild + three as devDependencies)
npm run build    # produce frontend/dist/app.bundle.js
npm run watch    # rebuild on change during development
```

The committed bundle is what ships via `pip install` / `npx`, so end users need no
Node toolchain and the app works fully offline.
