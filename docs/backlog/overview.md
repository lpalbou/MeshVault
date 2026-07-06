# MeshVault Backlog — Overview

Durable planning memory for MeshVault. Records what exists, what is next, what was
considered, and why priorities are ordered as they are. Treat stale text here as a bug.

Last update: 2026-07-06 (026 compressed-glTF decoders + 027 IBL + 029 describe_scene
(incl. 031 QA checks) + 030 MCP adapter implemented, each adversarially reviewed).

---

## Lifecycle Layout

- `planned/` — committed implementation work.
- `proposed/` — plausible but uncommitted ideas / experiments.
- `completed/` — closed audit records (each carries a `## Completion` report).
- Item files use a four-digit global prefix: `NNNN_slug.md`. Numbers are never reused.

Next free ID: **0025**.

---

## Counts

| State | Count | IDs |
|-------|------:|-----|
| completed | 25 | 001–005, 009–014, 017–021, 025, 026, 027, 029, 030, 031, 036, 037, 039 |
| planned | 3 | 006, 007, 008 |
| proposed | 14 | 015, 016, 022, 023, 024, 028, 032, 033, 034, 035, 038 (partial), 040 (parked), 041 (v1 done; v2 proposed), 042 |

Next free ID: **0043**.

Note: `039` completed with `compare_models` (geometric shape comparison / registration —
`sample_points` + `backend/mesh_compare.py`), 4-agent reviewed; the MCP now exposes 7
tools. `038` still partial (UV diagnostics / image stats remain).

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

Next free ID: **0036**.

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

Editing track — gated behind the shipped Phase 0 (confinement, `010`/`012`) and the
`022` viewer refactor. Lower priority than trust + library-at-scale.
- `006` — Material editor
- `007` — Component picker (click-to-select mesh)
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
