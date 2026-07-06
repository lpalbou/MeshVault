# Browser-free MeshVault MCP — full strategy (not currently a priority)

**Status**: Parked strategy — feasibility proven, deliberately NOT scheduled.
**Decision (2026-07-06)**: headless Chromium is good enough for the current goals
(MCP service on remote SSH servers; local/web 3D tool). This document exists so the
work can start on a day's notice if a trigger below fires.

---

## 1. Why we are NOT doing this now

- **Remote SSH servers already work.** Headless Chromium needs no display; the entire
  2026-07-06 test campaign ran that way. See `docs/mcp.md` → "Remote servers".
- **The speed argument mostly evaporates on GPU-less servers.** `webgl-node` renders
  through EGL; without a GPU that is Mesa/llvmpipe — software rendering, same class as
  Chromium's SwiftShader. Browser-free is dramatically faster only where a real GPU is
  present (dev machines, GPU instances).
- **What we'd actually gain today**: ~0.9 GB → ~30-50 MB RAM per session, no
  `playwright install chromium` step, faster cold start (~6 s → <1 s). Real but not
  blocking for a single-user MCP service.

## 2. Triggers that make this worth scheduling

Any ONE of these:

- **Fleet scale**: >5 concurrent MCP sessions needed on one host (RAM ceiling).
- **abstract3d integration**: generative pipelines that must QA MANY generated meshes
  (describe/stats per artifact). Stage 1 below serves this at ~1/30th the memory and
  none of the browser startup cost — this is the most likely real trigger.
- **GPU servers**: deployment on machines with GPUs where render latency matters
  (SwiftShader 10-60 s/shot → sub-second native).
- **Packaging pain**: environments where installing Chromium is prohibited/painful
  (containers with strict policies, air-gapped hosts).

## 3. Proven foundation (PoC, 2026-07-06)

three r170 `WebGLRenderer` runs in pure Node against `webgl-node`'s WebGL2 context
(native EGL/GLES3, macOS/Linux/Windows, x64+arm64) with a ~15-line canvas shim —
including the exact MeshVault pipeline pieces: PMREM + RoomEnvironment IBL, ACES tone
mapping, MeshStandardMaterial, readPixels → PNG. Details + repro in
`040_browserless_mcp_runtime.md`.

## 4. Staged plan

### Stage 0 — seam extraction (prerequisite, benefits everyone)
Isolate the engine's DOM touchpoints behind injectable adapters (they are already few):
container element (size only, for the API-driven case), event listeners, label sprites
(2D canvas), `createImageBitmap` texture decode, worker-based decoders. Ships as pure
refactor inside `viewer_3d.js` / loaders with zero behavior change; aligns with backlog
022 (module split). Effort: S-M.

### Stage 1 — text-only Node runtime (the high-value slice)
`meshvault-mcp --runtime=node-text` (or auto-fallback when Chromium is absent):
three core + GLTF/OBJ/STL/PLY loaders in Node, no renderer. Serves `load_model`
(geometry), `describe_scene`, `get_mesh_stats`, bounds/measure/transforms/export —
everything except screenshots and view scoring (which error with "requires the browser
runtime"). Texture DIMENSIONS via header sniffing (PNG/JPG/KTX2 headers), no decode.
Draco/KTX2-geometry via the decoders' non-worker JS paths or `worker_threads`.
Effort: M. **This is the abstract3d-scale QA workhorse.**

### Stage 2 — full rendering via webgl-node
The PoC path industrialized: canvas shim, camera driven programmatically (OrbitControls
replaced by a small target/up/update stub — the control API never uses pointer input),
texture decode via `sharp`, label sprites via `@napi-rs/canvas` or skipped in captures.
Opt-in `MESHVAULT_MCP_RUNTIME=node`; Chromium stays default until the adversarial
harness passes (same models, same commands, screenshots compared visually + by
luminance/coverage metrics, NOT byte-equality — driver AA differs). Effort: L.

### Stage 3 — retire Chromium default (optional endgame)
Only after Stage 2 has months of parity. Chromium path remains available for
`capture_views`-style exactness and as an escape hatch.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `webgl-node` is young (2026-03, ~680 dl/wk) | Pin version; keep Chromium runtime as permanent fallback; alternatives tracked (wgpu-based `headless-three-renderer`, Dawn `node-webgpu` — both need the three/webgpu port, bigger). |
| Render differences vs Chromium | Perceptual validation (coverage/luminance bands), not byte-diff; document that hero shots may differ subtly between runtimes. |
| Loader browser-API drift on three upgrades | The Stage 0 adapter seam is the contract; CI smoke test in Node per three bump. |
| Native module builds on exotic hosts | Prebuilt binaries exist for the 6 mainstream platform/arch combos; others fall back to Chromium runtime. |

## 6. Relationship to abstract3d (tmp/abstractframework/abstract3d)

When generative capabilities land, MeshVault's role grows from browse/fix/analyze to
the QA + presentation layer of a generation loop: generate → `describe_scene` +
`get_mesh_stats` (reject/score candidates) → fix (recompute normals, simplify) →
hero shots. Stages 0-1 make that loop cheap enough to run per-candidate at scale;
Stage 2 adds fast thumbnails/turntables on GPU hosts. Nothing in this strategy blocks
on abstract3d, and nothing in abstract3d should wait for it — the Chromium runtime
serves the integration fine until fleet-scale triggers fire.
