# Knowledge Base

This file captures critical implementation insights and design logics that are easy to forget and costly to rediscover.

---

## GLB Export — UV origin vs `Texture.flipY` (Three.js / glTF 2.0)

### Problem
glTF 2.0 defines the texture coordinate origin $(0,0)$ at the **upper-left** of the image. Three.js (WebGL/OpenGL-style sampling) effectively treats UVs with $(0,0)$ at the **lower-left** for typical `TextureLoader` assets, and relies on `texture.flipY` (WebGL UNPACK flip) to reconcile image row order vs UV convention.

When exporting to GLB with Three.js `GLTFExporter`, a common failure mode is **vertically flipped textures** (and/or “UVs look wrong”) because `GLTFExporter` flips image pixel rows whenever `texture.flipY === true`.

### Key facts (verified against Three.js r170 source)
- `GLTFExporter` flips the **image pixels** (via a canvas transform) when `flipY === true` — it does **not** modify UV coordinates.
- `TGALoader` returns `DataTexture`-style images and sets `texture.flipY = true`.
- glTF 2.0 spec explicitly states the UV origin is **upper-left**.

### Robust export strategy (used in MeshVault)
- Export with **glTF convention**:
  - Flip UV V component on export: $v \leftarrow 1 - v$
  - Force exported textures to `flipY = false`
- For `DataTexture`-style sources (`image.data`), convert to a canvas in **top-to-bottom** row order before export so the PNG bytes match the original image orientation.

This yields GLB textures that match the original images (no vertical flip), and a GLB that round-trips in MeshVault without UV/texture coordinate artifacts.

---

## GLTFLoader — Derivative tangents and `normalScale.y` sign

When loading glTF without vertex tangents, Three.js `GLTFLoader` may clone materials for “derivative tangents” and flips `material.normalScale.y *= -1` as part of its internal tangent-space conventions. This is expected behavior and can affect “pixel-perfect” comparisons if one pipeline produces tangents while another doesn’t.

---

## `mergeVertices` and UV/normal/tangent preservation (smooth normals & simplify)

### Problem
"Recompute smooth normals" and "Simplify" both need to merge coincident vertices so shading/decimation operate on shared topology. The naive approach deletes the `uv` attribute before merging (so faces merge across UV seams). But `BufferGeometryUtils.mergeVertices` merges only vertices whose **entire attribute tuple** is equal — so deleting UVs and merging, then never restoring them, silently strips texture coordinates and leaves textured meshes untextured.

### Robust approach (used in MeshVault)
- Delete only the **per-face-derived** attributes before merging: `normal` AND `tangent`. Faceted duplicate vertices differ only by these, so removing them lets duplicates collapse; if either remains, the merge refuses and smoothing/decimation fails.
- **Keep `uv`.** `mergeVertices` then merges vertices sharing position+UV, so a genuine UV seam correctly stays split (two vertices) while non-seam edges smooth. Meshes without UVs merge purely by position — identical to the old behavior.
- `SimplifyModifier` (r170) carries `uv`/`normal`/`tangent`/`color` through decimation, so preserving UVs before `modify()` keeps textured meshes textured.
- Always `dispose()` the geometry you replace (`child.geometry = merged; oldGeo.dispose()`) — reassigning the reference alone leaks GPU buffers.

---

## Security model: one trust boundary, not per-endpoint checks (`backend/security.py`)

### Insight
The original arbitrary read/write/delete exposure came from each endpoint calling `Path(client_string)` directly. Patching endpoints one by one is fragile — the next endpoint forgets. The durable fix is a single `PathGuard.resolve()` that every filesystem endpoint funnels through, plus ASGI middleware for auth + Host allow-list. New features (thumbnails, index, tags) inherit confinement because they must call the same guard.

### Load-bearing details (each learned from an adversarial breakout)
- **Confinement rule is general:** resolve symlinks first (`Path.resolve(strict=False)`), then require the real path to be inside an allowed root. This blocks traversal, absolute-path injection, and symlink escapes with one invariant — not per-attack string matching.
- **The endpoint predicate MUST match the code path that actually runs.** `/api/export` was breakable because the endpoint branched on `is_in_archive && archive_path` while `ExportManager` only takes the archive path when `inner_path` is *also* set — so an archive request with no `inner_path` fell through to a filesystem copy of *unguarded* `related_files`. Guard for the branch that will execute, and guard **every** path a copy reads from (source AND related_files).
- **Canonicalize before persisting keys.** The index stores resolved paths; tags/collections stored under a non-canonical path (e.g. `/tmp` vs `/private/tmp` on macOS) succeed but become unfindable. Resolve to the canonical form on write.
- **Don't accept tokens via query param** (`?token=`): they leak into access logs, history, and `Referer`. Use an `HttpOnly`+`SameSite=Strict` cookie (set on the app shell) for the browser and headers for programmatic clients.
- **Host allow-list must fail closed:** an empty/missing Host must be rejected, not allowed through.
- **Disable `/docs`, `/redoc`, `/openapi.json`** for a local single-user tool — the schema is free reconnaissance.

---

## Blocking work belongs in the threadpool, not the event loop

FastAPI runs `async def` handlers on the event loop and `def` handlers in a threadpool. Endpoints that do blocking work — archive extraction (subprocess up to 120s), RAR inspection, FBX conversion, SQLite queries, `rglob` texture scans, large file copies — must be plain `def` so one slow request doesn't stall every other request. Only genuinely async work (`await file.read()`, spawning a background thread) stays `async def`. Long scans (library reindex) run in an explicit background thread and commit in small batches so writers (tag/collection edits) can interleave instead of waiting for the whole walk.

