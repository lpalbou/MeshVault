# 035 — Secondary viewer enhancements (tracking bundle)

**Priority**: Low–Medium
**Effort**: Varies
**Status**: Proposed
**Created**: 2026-07-06

## Summary

A tracking list of secondary, lower-priority viewer features surfaced by the 2026 feature
research. Each is a candidate to promote into its own `NNNN` item when prioritized; they are
grouped here to avoid premature fragmentation.

## Candidates (with rationale + rough effort)

- **Shadow catcher / contact shadows** (M) — a soft ground shadow greatly improves "grounded"
  hero shots and cutouts; better than the current hard shadow plane.
- **Section caps** (M) — fill the cut face when using clipping planes so cross-sections look
  solid instead of hollow.
- **Turntable video export** (M) — export the existing turntable as MP4/GIF/WebM (MediaRecorder
  or frame capture) for shareable spins.
- **A/B compare** (M) — load two models and compare side-by-side / overlay (versioning, QA).
- **Gaussian splats / point clouds** (M–L) — `.splat` / gaussian `.ply` are increasingly
  expected for scan-derived assets; assess demand before committing.
- **Angle / radius measurement** (S) — extend the point-to-point measure with angle and radius.
- **Batch macros** (S) — let an agent send a sequence of commands in one call.
- **Thin JS/Python SDK** (S) — a small wrapper around the control API for scripting.

## Notes

Explicitly NOT recommended by the research (do not build): WebXR/AR + USDZ AR button,
cinematic post-FX (DoF/bloom), WebGPU migration, hosted-sharing platform, embedded VLMs,
undo/history stacks, pixel-based interaction, a CORS proxy, generative-AI integrations.
Rationale: poor fit for the local, embeddable, agent-controllable identity, or low value/high
cost. See `overview.md`.
