# 0048 — Commit the browser E2E suites into the repo

- **State**: planned
- **Created**: 2026-07-11
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
