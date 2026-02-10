# 006 — Material Editor

**Priority**: High
**Effort**: Large
**Category**: Viewer / Editor
**Target**: v0.2.0

## Description

Evolve the read-only material inspector (v0.1.0) into a full material editor. Allow users to create, edit, and assign PBR materials to model components, with real-time preview and MTL export.

## Architecture (already in place from v0.1.0)

The material inspector stores live `THREE.Material` references and mesh mappings. Each property row has `data-prop` attributes. To enable editing:
- Swap `<span class="mat-prop-value">` with `<input>` or `<input type="range">`
- On change: `card._materialRef[prop] = newValue; card._materialRef.needsUpdate = true;`
- No data model changes needed — the foundation is there.

## Tasks

- [ ] Color picker: replace color swatch with clickable color input
- [ ] PBR sliders: roughness, metalness, opacity as range inputs
- [ ] Wireframe toggle per material
- [ ] Transparency toggle
- [ ] "New Material" button to create a default MeshStandardMaterial
- [ ] Assign material to selected mesh (requires component picker — see 007)
- [ ] MTL generation on export (see 008)
- [ ] Undo/redo for material changes

## Dependencies

- 007: Component picker (click mesh to select)
- 008: MTL export
