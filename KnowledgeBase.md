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

