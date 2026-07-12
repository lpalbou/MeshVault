# 0048 — Commit the browser E2E suites into the repo

- **State**: completed
- **Created**: 2026-07-11
- **Completed**: 2026-07-12 (v0.8.0)

## Completion

`tests/e2e/` now holds the full regression net — grown well past the 68
checks this item was filed about, because the 050/053/054 cycles added their
own suites:

| file | checks | covers |
|------|-------:|--------|
| `test_sculpt_paint.py` | 33 | primitives, brushes+reset, paint atlas isolation, meanAlpha, pick/raycast, batch, manifest |
| `test_articulation_timeline.py` | 35 | pivots, parenting, keyframes, animated-GLB round-trip, detect/split, simplify_region, fix_mesh, repair brushes, tiers |
| `test_symmetry_heal.py` | 26 | detect_symmetry (determinism, tie-breaks, staleness), mirror_paint chirality, undo_paint, cycle-2 regressions |
| `test_edit_ui.py` | 20 | human UI arbitration matrix, gesture undo, keyframe authoring, ESC/guards |
| `test_brush_gestures.py` | 12 | cycle-2 UI regressions (FPV, panels, invert, opacity composition) + undo_group ledger |
| `test_vflip_roundtrip.py` | 1 | the v0.7.0 GLB→GLB UV data-loss regression, now SELF-CONTAINED (paint→export→reload→export, V-range bit-equal — no machine-local portrait fixture) |

Mechanics per the item: `mv_app` session fixture (`conftest.py`) uses
`MESHVAULT_E2E_URL`/`MESHVAULT_E2E_TOKEN` against a running app or spins up
its OWN uvicorn server (ephemeral port, `/tmp` root, token auth) — no
reliance on `/tmp` scripts or a pre-running app; `pytest -m e2e` marker
(opt-in via `MESHVAULT_E2E=1`, so plain `pytest tests/` self-skips — 7
skipped, CI-safe); `scripts/e2e.sh` runner; release workflow gained an `e2e`
job (chromium + SwiftShader + built bundles) gating `build` alongside the
Python test matrix.

Verified: `scripts/e2e.sh` green from the repo with an OWNED server —
7 passed in 182 s. Default `pytest tests/` unchanged (109 passed + e2e
skips).
- **Origin**: 045–047 consolidation. The two Playwright smoke harnesses that
  validated every capability cycle (68 checks total) live in `/tmp` — one
  reboot deletes the only regression net for the entire agent surface.

## Context

`/tmp/mv_sculpt_smoke.py` (33 checks: primitives, param whitelists, sculpt
tools + reset, radius_rel, batch, teaching errors, UV-atlas isolation,
meanAlpha, plaid regression, square stamps + edge clamp, sRGB fidelity,
painted/sculpted flags, parametric paths, pick/raycast, manifest metadata) and
`/tmp/mv_artic_smoke.py` (35 checks: pivots, parenting, keyframes + timeline,
animated GLB export round-trip incl. the V-flip regression, detect/split with
partition handshake, simplify_region + fix_mesh, inspect_region/texture,
clone/blur paint, resize tiers) caught the sRGB blending bug, the stroke
double-blend, and the exporter V-flip. They are the proof that "green" means
anything for the viewer core.

## Task

1. Move both harnesses to `tests/e2e/` (rename `test_e2e_sculpt_paint.py`,
   `test_e2e_articulation_timeline.py`); parameterize the app URL/token via
   env (`MESHVAULT_E2E_URL`, default starts its own server like
   `tests/test_glb_export_integration.py` does).
2. Add the V-flip round-trip check (`/tmp/mv_vflip_test.py`) as a third file —
   it is the regression test for a data-loss bug.
3. A `pytest -m e2e` marker (skipped when playwright/chromium missing, same
   pattern as the existing integration test) + a `scripts/e2e.sh` runner.
4. CI: run on release branches at minimum (SwiftShader renders make the full
   suite ~2-4 min).

## Acceptance

- `poetry run pytest -m e2e` green from a clean checkout (after
  `playwright install chromium`), no reliance on `/tmp` or a running app.
