# 011 — Fix Broken `/api/default_path` Route

**Priority**: High
**Effort**: Small
**Category**: Bug
**Target**: v0.1.1
**Created**: 2026-07-05

## Summary

`GET /api/default_path` is broken and returns `422`. Two route decorators are stacked on the
`scan_textures` function, so the first-registered `GET /api/default_path` resolves to
`scan_textures` (which requires a request body), shadowing the real `get_default_path` handler.

## Reason / evidence (confirmed at runtime 2026-07-05)

```568:570:backend/app.py
@app.get("/api/default_path")
@app.post("/api/scan_textures")
async def scan_textures(request: ScanTexturesRequest):
```

- `GET /api/default_path` → `422 {"detail":[{"loc":["body"],"msg":"Field required"}]}`.
- The intended handler at `backend/app.py:599-602` (`get_default_path`) is unreachable.
- The OpenAPI route dump shows the collision.

## Current code reality

- `get_default_path` exists and returns `{"path": DEFAULT_ROOT}` — it just never gets hit.

## Scope

- Remove the stray `@app.get("/api/default_path")` decorator from `scan_textures`.
- Verify `scan_textures` keeps only its `POST` route and `get_default_path` serves the `GET`.

## Acceptance criteria / validation

- `GET /api/default_path` → `200 {"path": ...}`.
- `POST /api/scan_textures` still works.
- Add a regression test for both routes (part of the endpoint-test effort in `023`).
- Reconcile `docs/api.md` (currently documents a happy-path response that cannot occur).


---

## Completion

**Status**: Completed · **Completed**: 2026-07-05

Removed the stray stacked decorator; `GET /api/default_path` returns 200 with the root. Validated: `tests/test_security.py::test_default_path_route_is_fixed` + runtime.
