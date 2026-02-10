# 007 — Component Picker (Click to Select Mesh)

**Priority**: High
**Effort**: Medium
**Category**: Viewer
**Target**: v0.2.0

## Description

Allow users to click on individual mesh components within a model to select them. Selected meshes get a highlight outline. This enables per-component material assignment.

## Tasks

- [ ] Raycast on click to identify the specific mesh hit
- [ ] Highlight selected mesh (outline pass or emissive tint)
- [ ] Show selected mesh info (name, vertex count, material)
- [ ] Multi-select with Shift+click
- [ ] Deselect on click in empty space
- [ ] Wire selection to material editor (assign material to selected)
