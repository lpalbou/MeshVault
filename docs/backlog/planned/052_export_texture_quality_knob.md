# 0052 — Export quality knob (texture format + JPEG quality)

- **State**: planned
- **Created**: 2026-07-11
- **Origin**: 047 texture-LoD ladder. The tier proofs exposed that GLB size is
  dominated by GLTFExporter's re-encode policy, not by our texel caps: the
  xhigh Jupiter GLB shrank vs high because canvas layers re-encode as JPEG at
  a fixed internal quality while pristine source textures pass through as
  PNG.

## Context

`export_model` / `export_glb` gained `texture_size` (downscale-only, named
tiers). What agents cannot control yet:

- FORMAT: canvas paint layers export via GLTFExporter's canvas path (JPEG
  when opaque); resized pristine textures land on the PNG path — 4096² PNG
  photos are enormous where JPEG q90 would be visually identical.
- QUALITY: no way to trade size vs fidelity for archives vs review copies.

## Design sketch

1. `texture_format: "auto" | "png" | "jpeg"` — auto keeps today's behavior;
   explicit values force re-encode of color textures (normal/ORM maps stay
   PNG always — JPEG artifacts corrupt normal data; this guard is documented,
   not optional).
2. `texture_quality: 1..100` (default 90) applied to JPEG encodes. Implement
   by pre-encoding textures to canvases/blobs BEFORE GLTFExporter sees them
   (mirror of the existing `_downscaleForExport` hook) rather than forking the
   exporter.
3. Report per-texture decisions in the export result (`textures: [{name,
   format, size, bytes}]`) so agents get quantified feedback (KnowledgeBase
   rule: mutations return evidence).
4. MCP `export_model` passes both through; docs get a size-ladder example.

## Acceptance

- Jupiter tier ladder re-exported at png / jpeg-q90 / jpeg-q60 with a bytes
  table in the proof pack; normal-mapped asset proves normals stayed PNG;
  reload of every variant renders correctly.
