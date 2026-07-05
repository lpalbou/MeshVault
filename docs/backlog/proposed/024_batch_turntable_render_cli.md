# 024 — Batch Turntable / Thumbnail Render CLI

**Priority**: Medium
**Effort**: Medium
**Category**: Feature / Differentiator
**Status**: Proposed
**Created**: 2026-07-05

## Summary

A headless CLI/endpoint to batch-render turntable GIFs/MP4s and high-quality still previews for
a folder or whole library. This leans into MeshVault's defensible lane — a scriptable,
pip-installable, local asset tool — and produces the thumbnails `014`/`015` consume, plus
shareable previews no lightweight viewer offers out of the box.

## Reason

- Competitive review: batch preview/turntable generation is a genuine differentiator for a
  local, headless-capable tool (contrast Sketchfab's cloud model and F3D's single-file focus).

## Sketch of scope

- `meshvault render <path> --turntable --frames N --out ...` producing PNG/GIF/MP4.
- Reuse the viewer's rendering config for consistency with interactive previews.
- Feed the thumbnail cache (`014`) so batch runs pre-warm the library gallery.
- Headless rendering approach (offscreen WebGL/software GL, or Blender if available) is the key
  decision.

## Decision boundaries

- Render engine: browser/offscreen Three.js vs Blender-headless. Blender gives quality but adds a
  heavy dependency; offscreen Three.js keeps the zero-dependency story.

## Dependencies

- Shares rendering primitives with `014`; benefits from `021` (vendored/build).
