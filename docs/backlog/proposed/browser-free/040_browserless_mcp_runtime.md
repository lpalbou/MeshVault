# 040 — Browser-free MCP runtime (no Chromium)

**Priority**: Medium-High
**Effort**: Large (staged)
**Category**: MCP / runtime
**Status**: Proposed — feasibility PROVEN by PoC (2026-07-06)
**Created**: 2026-07-06

## Summary

The MCP server currently hosts the viewer in headless Chromium: no window, works on
servers/CI, but costs ~0.9 GB RSS per session and renders through SwiftShader software
GL (10–60 s per screenshot — the dominant cost in every agent session measured).

A browser-free runtime is now feasible: `webgl-node` (npm, 2026) provides a
spec-compliant **WebGL2** context in Node via native EGL/GLES3 bindings on a **real
GPU**, cross-platform (macOS/Linux/Windows, x64+arm64). PoC executed on this machine:
three r170 `WebGLRenderer` + `PMREMGenerator`/`RoomEnvironment` IBL + ACES rendered a
PBR scene and read pixels back to PNG in ~2 s total, zero browser processes.

Expected wins: per-session footprint from ~0.9 GB → tens of MB; screenshot latency from
10–60 s (SwiftShader) → likely sub-second (real GPU); much higher concurrent-agent
ceiling; simpler deployment (`playwright install chromium` no longer needed).

## Why it's staged (the honest cost)

The engine (`viewer_3d.js`) assumes a DOM: container element, OrbitControls (pointer
events), ResizeObserver, 2D-canvas label sprites. And loaders assume browser APIs:
`createImageBitmap` for textures, Web Workers for Draco/KTX2 decoding — none exist in
Node as-is.

- **Stage 1 — text-only tools, no rendering** (small-medium): run three core + loaders
  in Node for `describe_scene`, `get_mesh_stats`, bounds/measure — geometry parses fine;
  textures can be stubbed (dimensions readable without decoding via header sniffing).
  Screenshots/score_views stay on the Chromium path.
- **Stage 2 — full rendering via webgl-node** (large): canvas/DOM shim layer (PoC shows
  ~15 lines suffice for the renderer itself; OrbitControls replaced by a target+update
  stub since the API drives the camera programmatically), texture decode via `sharp`,
  Draco/KTX2 via their JS (non-worker) fallbacks or `worker_threads` adapters.
- Keep Chromium as the default runtime; browser-free as opt-in
  (`MESHVAULT_MCP_RUNTIME=node`) until parity is verified by the adversarial harness
  (same screenshots, pixel-compared).

## Risks

- `webgl-node` is young (published 2026-03, ~680 weekly downloads) — pin + vendor-watch.
  Alternatives if it stalls: wgpu-based `nexus-render` / `headless-three-renderer`
  (require three/webgpu — a bigger port), or Dawn's `node-webgpu`.
- Renderer output differs slightly from Chromium/SwiftShader (driver AA, precision) —
  hero-shot outputs must be validated visually, not byte-compared.

## PoC evidence (reproducible)

`/tmp/headless_poc/poc.mjs`: `createWebGL2Context(400,400)` + minimal canvas shim →
`new THREE.WebGLRenderer({canvas, context: gl})` → PMREM RoomEnvironment + ACES +
MeshStandardMaterial torus → `gl.readPixels` → PNG. Output verified: correct lit PBR
render, `renderer.capabilities.isWebGL2 === true`, 26% subject coverage.
