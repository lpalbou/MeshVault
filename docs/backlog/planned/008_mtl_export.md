# 008 — MTL Export with Modified Materials

**Priority**: Medium
**Effort**: Small
**Category**: Export
**Target**: v0.2.0

## Description

When exporting a model with modified/created materials, generate a Wavefront .mtl file alongside the .obj. The OBJ references the MTL, and the MTL defines all material properties.

## Tasks

- [ ] Generate MTL text from the model's material list
- [ ] Map PBR properties to MTL keywords (Kd, Ks, Ns, d, map_Kd, etc.)
- [ ] Add `mtllib` reference to the exported OBJ header
- [ ] Save both files via the export_modified endpoint
- [ ] Handle texture file references (copy textures to export folder)
