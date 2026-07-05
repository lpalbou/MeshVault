# MeshVault Backlog — Overview

Durable planning memory for MeshVault. Records what exists, what is next, what was
considered, and why priorities are ordered as they are. Treat stale text here as a bug.

Last update: 2026-07-05 (Phase 0–2 implemented, adversarially reviewed over 2 cycles).

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
| completed | 16 | 001–005, 009–014, 017–021 |
| planned | 3 | 006, 007, 008 |
| proposed | 5 | 015, 016, 022, 023, 024 |

Note: `015` (library index/search) and `016` (tags/collections) were **built then parked**
(speculative; see `parked/` and each item's history). `021` (offline bundle) is **done**.

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

---

## Operating Rules

- Read the code before editing backlog text; patch the backlog when it disagrees with code.
- Keep each item standalone enough to execute without the original chat.
- Update this overview in the same pass whenever counts, states, or priorities change.
- Prefer `proposed/` for uncertain follow-ups; promote to `planned/` only with clear mandate.
