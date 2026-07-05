# 013 — Reconcile Docs With Code (Blend/Max, Endpoint Count, GLB Export)

**Priority**: High
**Effort**: Small (docs) or Large (if implementing blend)
**Category**: Documentation / Integrity
**Target**: v0.1.1
**Created**: 2026-07-05

## Summary

Documentation and the changelog advertise capabilities that do not exist in code. This is an
intellectual-honesty problem before it is a feature problem: the product claims `.blend` and
`.max` support, a `blend_converter.py` module, and "14 endpoints", none of which match reality.
Either remove the claims or implement them — do not ship both.

## Reason / evidence (confirmed 2026-07-05)

- **`.blend` support is fictional in code**: `docs/architecture.md:14,23,31-32` and
  `README.md:19,35` and `CHANGELOG.md:23,86` describe `blend_converter.py` and
  ".blend → .glb via Blender CLI", but there is **no** `blend_converter.py` (only 5 backend
  files) and `SUPPORTED_3D_EXTENSIONS = {.obj,.fbx,.gltf,.glb,.stl}`. `_maybe_convert_asset`
  only handles FBX; `app.py` docstrings (lines 233, 238) still claim blend→glb.
- **`.max` support is fictional**: advertised as "detection only" but `.max` is not in
  `SUPPORTED_3D_EXTENSIONS`; only a frontend SVG icon exists.
- **Endpoint count wrong**: README/architecture say "14 endpoints"; the app registers 15
  `/api` routes (16 with the `default_path` duplicate). `docs/api.md` documents 13 and omits
  `/api/export_glb`, which is the UI's *default* export format (`app.js:1031`).

## Current code reality

- Supported formats are OBJ, FBX, GLTF, GLB, STL (+ archive inspection). No Blender, no Max.

## Scope (decision required)

Pick one path per capability and apply consistently across README, `docs/architecture.md`,
`docs/getting_started.md`, `docs/api.md`, and `CHANGELOG.md`:

1. **Blender/.blend**: either (a) remove all `.blend`/`blend_converter.py`/Blender-CLI claims,
   or (b) actually implement `blend_converter.py` (**Large**; Blender CLI detection + headless
   export + caching). Recommendation: remove now, re-add as a real `proposed/` feature.
2. **.max**: remove "detection only" claim, or add real detection to the browser.
3. **API docs**: correct the endpoint count and document `/api/export_glb`.

## Acceptance criteria / validation

- No doc references a module or format that the code does not implement.
- `docs/api.md` endpoint list matches the OpenAPI route dump exactly (excluding the
  `default_path` duplicate, which `011` removes).
- CHANGELOG "Unreleased" notes the correction honestly.


---

## Completion

**Status**: Completed · **Completed**: 2026-07-05

Removed fictional `.blend`/`.max`/`blend_converter.py` claims across README/architecture/getting_started/faq/CHANGELOG; corrected endpoint count (15) and documented `/api/export_glb`; added the security-model section to `docs/api.md`.
