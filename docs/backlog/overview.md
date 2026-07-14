# MeshVault Backlog — Overview

Durable planning memory for MeshVault. Records what exists, what is next, what was
considered, and why priorities are ordered as they are. Treat stale text here as a bug.

Last update: 2026-07-12 (051 + 049 COMPLETED for v0.9.0 through the same
adversarial program — design review → implementation → static audit → live
field gauntlet → fixes → regression. 051: cut-face capping via became-open
rim classification, capped BY DEFAULT after the field verdict; three field
bugs fixed (mod-2 rim rule + angular junction walk for re-splits through
caps, UV-degenerate paint path so caps accept paint, median-rim-color anchor
killing the one-texel color lottery). 049: morph targets via sculpt-pose
capture — the portrait TALKS (field verdict: qualified yes; jaw/smile morphs,
4 s keyed talk cycle, GLB round-trip driving the deformation); four field
bugs fixed (GPU render-cost budget preventing the 8-morph SwiftShader wedge,
imported GLB morphs drive-only addressable, morph-aware paint aim, morph-aware
vertex bakes) plus the field's requested hinge pose brush. Earlier 2026-07-12:
050 + 053 + 054 for v0.8.0 — symmetry healing, the abstract3d→MeshVault
pipeline recipe, the human editing UI; 048 E2E suites in-repo. Longer-term
context in 053/054: these capabilities are candidates for integration into
blackpixel, the user's image+video app.)

---

## Lifecycle Layout

- `planned/` — committed implementation work.
- `proposed/` — plausible but uncommitted ideas / experiments.
- `completed/` — closed audit records (each carries a `## Completion` report).
- Item files use a four-digit global prefix: `NNNN_slug.md`. Numbers are never reused.

Next free ID: **0055**.

---

## Counts

| State | Count | IDs |
|-------|------:|-----|
| completed | 37 | 001–005, 009–014, 017–021, 025, 026, 027, 029, 030, 031, 036, 037, 039, 042, 043, 044, 045, 046, 047, 048, 049, 050, 051, 053, 054 |
| planned | 4 | 006, 007, 008, 052 (export quality knob) |
| proposed | 13 | 015, 016, 022 (urgency raised 2026-07-11), 023, 024 (partial — endpoint slice shipped in 044, CLI remains), 028, 032, 033, 034, 035, 038 (partial), 040 (parked), 041 (v1 done; v2 rides on 042's set_object_transform) |

051 + 049 landed (2026-07-12, v0.9.0): plane cuts CAP by default; the hinge
pose brush joined the sculpt tools; morphs ride GLB exports and reloaded
targets stay drivable. Remaining wave: 052 by demand, then the long-standing
UI items (006–008). `tests/e2e/` now carries 8 suites incl. capping and
morph field-fix regressions (own-server fixture, `scripts/e2e.sh`,
release-workflow gate) — the `022` viewer refactor has the behavior net its
2026-07-05 note demanded.

Note: `047` (2026-07-11) — texture forensics (pick.uv, get_texture UV views,
get_uv_islands, transform_uv island scoping + bleed dry-runs), screen-space
project_paint (the correct repair for fragmented atlases — proven by an honest
falsification cycle), exploded-view articulation proofs with numeric separation,
animation persistence proofs (.mvscene v2 + animated GLB + in-app play/pause),
the critical GLB round-trip V-flip fix, and the assembled proof pack at
~/MeshVault_assets/proofs/ (INDEX.md). 3 agents × 5 cycles.

Note: `046` (2026-07-11) shipped the five-track mandate in 0.7.0 — composition
ergonomics (bounds/clone/ground/place/look_at), regional inspect+repair
(boundary-locked simplify_region, fix_mesh, heal/blur brushes, texel-density
audit), texture LoD tiers to 4096, articulation (detect_parts/split_object with
suggested pivots, set_parent/set_pivot via mathematical TRS composition), and
the scene keyframe timeline (deterministic seeks, teaching notes incl. the
360°-identity trap, motion contact sheets, animated GLB export, manifest v2,
timeline UI). 3 design adversaries + 3 agent gauntlets; deferrals in the item.

Note: `045` (2026-07-11) shipped AI dynamic sculpting/painting + the performance diet
in 0.7.0 — 7 primitives with paint-safe UV atlases, 6 seam-safe world-space sculpt
brushes, texture painting (max-alpha strokes, sRGB-correct, square stamps, edge
clamping, meanAlpha honesty), pick/raycast hand-eye loop, batch, scene-scoped camera;
demand-driven rendering (0.0% idle CPU), idle browser shutdown, lazy accessor-decoded
reset snapshots (also fixes the latent quantized bake→reset corruption). 3
adversarial reviews + 3 live artist-agent MCP cycles; deferrals recorded in the item.

Note: `042` (2026-07-09) shipped ALL four stages of scene composition in 0.6.0 —
object registry + placement wrappers + gizmo/panel UX + `.mvscene` persistence +
composed GLB export + MCP parity (`load_model {add:true}`, `save_scene`/`load_scene`,
11 tools). Two pre-implementation adversarial reviews drove the design; their
must-fix lists are fully implemented and their deferrals recorded in the item.
Incidentally fixed: the documented reset-after-simplify crash, and exports baking
viewer display state (clay materials / ghost opacity) into assets.

Note: `044` (2026-07-09) fixed the untextured multi-file defect at the root (texture
pending-vs-broken classification + directory-companion serving + model-relative
resolver), added the REVERSE co-review bridge (`get_app_state` + `/api/agent/state`),
and shipped `GET /api/screenshot` on the new shared headless runtime
(`backend/headless_viewer.py`) — the seam `024`'s batch CLI will consume. The MCP now
exposes 9 tools.

Note: `043` (2026-07-08, external FR) shipped the agent bridge: `open_in_app` MCP tool
(session-file discovery → `POST /api/agent/open` → SSE fan-out to app tabs, camera
included), `?path=`/`?dir=` deep links with live URL sync (archive members via
`archive!inner`), and `screenshot {preset}` reproducible render presets. Partially
overlaps `032` (web-viewer URL state) — see the item file.

Note: `039` completed with `compare_models` (geometric shape comparison / registration —
`sample_points` + `backend/mesh_compare.py`), 4-agent reviewed. `038` still partial
(UV diagnostics / image stats remain).

Note: `041` v1 (in-app compare: deviation heatmap + verdict panel over `POST
/api/compare`) shipped 2026-07-06 after a 3-agent design review; its v2 (co-loaded
registered overlay) folds into `042` (virtual scene composition — multi-object scenes,
positioning gizmos, scene manifest persistence, merged-GLB export, agent parity), the
natural abstract3d integration point.

Note: `040` and its full staged strategy live in `proposed/browser-free/` — deliberately
parked (headless Chromium is good enough for current goals); the strategy doc lists the
concrete triggers that would justify scheduling it (fleet scale, abstract3d batch QA,
GPU hosts).

## 2026-07-06 MCP field test (3 face-reconstruction iterations, 3 agents + self)

Real-world use surfaced the next high-value gaps, filed as `037` (mesh statistics +
issue localization — connectivity QA alone gives wrong quality verdicts), `038` (texture
/material introspection + authored-vs-displayed PBR fidelity), `039` (multi-view MCP
capture, best-view metadata, A/B compare). Fixed immediately: intra-session load→describe
race (serialized), measurement overlay not clearable (`clear_measurement` +
`set_measure_mode false` now clears).

Note: `015` (library index/search) and `016` (tags/collections) were **built then parked**
(speculative; see `parked/` and each item's history). `021` (offline bundle) is **done**.
`025` extracted the embeddable viewer core + AI-agent control API; `022` (physical module
split of `viewer_3d.js`) is now lower-risk and still open.

## 2026 feature research (026–035) — from a 3-agent online study

Ranked highest-value additions (market + AI-agent + web-deploy passes):
- `026` Compressed glTF decoders (Draco/KTX2/Meshopt) — **top pick**: many real GLBs don't
  open today. **Done 2026-07-06** (vendored decoders, offline-verified, worker-safe).
- `027` HDRI/IBL environment lighting — biggest realism win. **Done 2026-07-06**
  (procedural RoomEnvironment PMREM, `set_environment` API, solid-mode suspension).
- `029` Structured `describe_scene` report — highest leverage for agents. **Done
  2026-07-06** (one-call text snapshot + QA issues; 031 folded in).
- `030` thin MCP adapter — **Done 2026-07-06** (`meshvault-mcp`, 6 tools, URL or local
  file input, image content back; see docs/mcp.md).
- `028` PBR-Neutral tone mapping (S), `031` model-QA command,
  `032` shareable URL state + embed, `033` scene-graph inspector, `034` CORS-aware load UX,
  `035` secondary bundle (shadow catcher, section caps, video export, A/B compare, splats…).

**Explicitly NOT recommended (do not build):** WebXR/AR + USDZ AR button, cinematic post-FX
(DoF/bloom), WebGPU migration, hosted-sharing platform, embedded VLMs, undo/history stacks,
pixel-based interaction, CORS proxy, generative-AI integrations — poor fit for the local,
embeddable, agent-controllable identity or low value/high cost.

---

## Ledger — completed 2026-07-05 (Phase 0–2)

| ID | Title | Phase | Key validation |
|----|-------|-------|----------------|
| 009 | Loopback bind + token auth + Host allow-list | 0 | `tests/test_security.py`, 2 security passes |
| 010 | Path confinement (`PathGuard`) across all endpoints | 0 | `tests/test_security.py`, arbitrary read/write/delete blocked |
| 011 | Fix broken `/api/default_path` route | 0 | `test_default_path_route_is_fixed` |
| 012 | UV-preserving simplify + recompute-normals | 0 | code review vs three r170; UX render check |
| 013 | Reconcile docs with code (remove `.blend`/`.max`) | 0 | doc/code parity |
| 014 | Thumbnail generation (client render, **browser** cache) | 1 | UX cache-on-revisit; server cache dropped |
| 017 | Animation playback UI | 2 | UX (bar hides for non-animated) |
| 018 | Formats: PLY / DAE / 3MF / USDZ | 2 | loader wiring; OBJ/STL render verified |
| 019 | Drag-and-drop load + recent files | 2 | UX (recent reload, drag-over) |
| 020 | Measurement / dimensions overlay | 2 | UX (two-point distance label) |
| 021 | Offline esbuild bundle (Three.js vendored) | 3 | zero external requests verified |

Full detail and completion reports live in each `completed/NNNN_*.md`.

New modules (active): `backend/security.py`; `frontend/js/thumbnailer.js` (browser-cached);
`scripts/build.mjs` (esbuild). New tests: `tests/test_security.py` (suite: 28 passed, 1 skipped).
Parked (built, not wired): `parked/library_index.py`, `parked/library_search.js`,
`parked/thumbnail_cache.py` + their tests — see `parked/README.md`.

---

## Remaining planned

Post-047 wave (planned 2026-07-11; 048/050/053/054 completed 2026-07-12
for v0.8.0; 049/051 completed 2026-07-12 for v0.9.0):
- `052` — Export quality knob (texture format + JPEG quality)

Editing track — gated behind the shipped Phase 0 (confinement, `010`/`012`) and the
`022` viewer refactor. Lower priority than trust + library-at-scale.
- `006` — Material editor (054's paint panel absorbed part of this)
- `007` — Component picker (click-to-select mesh; scene panel click-select shipped in 042 —
  what remains is sub-mesh picking within one object)
- `008` — MTL export with modified materials

## Remaining proposed (roadmap — Phase 3: hardening & differentiators)

- `021` — Frontend build + vendored Three.js (offline + SRI). **Note:** the CDN/importmap
  dependency is still present; the app does not load offline. Recommended next.
- `022` — Refactor the `viewer_3d.js` monolith (now larger after 017/018/020).
- `023` — Broaden test coverage: FBX parser + more endpoint/integration tests.
  (Security + index + thumbnail cache are now covered; FBX parser and several endpoints
  remain untested.)
- `024` — Batch turntable / thumbnail render CLI (reuses the 014 render path).

---

## Known follow-ups from the 2026-07-05 adversarial review (not yet items)

- **Heavy sync endpoints in threadpool, not the loop:** archive/FBX/RAR endpoints were
  converted to `def` so they run in Starlette's threadpool; if true concurrency limits
  bite, consider a bounded worker pool or async subprocess. (Addressed for the event-loop
  freeze; revisit under load.)
- **USDZ is import-only**; no USD authoring/export.
- **Thumbnails for degenerate/flat meshes** render near-blank (expected, not a bug).
- **First-thumbnail feedback:** cards show the format icon with no spinner while the first
  render is in flight — minor UX polish candidate.

## Known follow-ups from the 2026-07-06 adversarial reviews (026/027/029)

- **Pre-existing bug: `reset` after `simplify` fails** with "offset is out of bounds"
  (found by the 029 robustness reviewer; unrelated to describe_scene — the saved original
  geometry snapshot conflicts with the simplified attribute layout). Needs its own fix.
- **Pre-existing bug: `rotate` on a playing SKINNED model double-transforms** (baked
  geometry + live bones render corrupt; found by the 036 design attacker). The quantized
  sibling of this bug (integer-attribute bake corruption) was fixed with 036; the skinned
  case still needs a decision (block transform while animated, or re-bind skeletons).
- **Key/fill direction controls are visually subdued on metallic models while IBL is on**
  (IBL dominates, as in reference viewers) — accepted behavior, documented here.
- **Vendored decoder wasm (`frontend/vendor/`) must be re-synced when `three` is bumped**
  (loader/decoder are a matched pair; see KnowledgeBase).
- **Embedders hosting `meshvault-viewer.js` away from `vendor/` must pass `assetBaseUrl`**
  or compressed glTF decoding 404s (documented constraint).
- **IBL control has no human UI** (agents have `set_environment`); lighting panels in the
  app + web viewer could grow an environment toggle/slider.

---

## Operating Rules

- Read the code before editing backlog text; patch the backlog when it disagrees with code.
- Keep each item standalone enough to execute without the original chat.
- Update this overview in the same pass whenever counts, states, or priorities change.
- Prefer `proposed/` for uncertain follow-ups; promote to `planned/` only with clear mandate.
