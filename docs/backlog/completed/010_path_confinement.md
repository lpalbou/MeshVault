# 010 — Path Confinement Across All Filesystem Endpoints

**Priority**: Critical
**Effort**: Medium
**Category**: Security
**Target**: v0.1.1 (hotfix)
**Created**: 2026-07-05

## Summary

Every filesystem endpoint accepts an absolute path and operates on it with no confinement,
allowing arbitrary read, delete, and write anywhere the server user can reach. A
`root_path` confinement mechanism already exists in `FileBrowser` but is never wired into the
app, and the serve/delete/export endpoints bypass `FileBrowser` entirely.

## Reason / evidence (confirmed at runtime 2026-07-05)

- **Arbitrary read**: `GET /api/asset/file?path=/etc/passwd` → `200` with file contents
  (`backend/app.py:227-242`); `/api/asset/related` behaves the same.
- **Arbitrary delete**: `/api/delete` `unlink()`s any file and `shutil.rmtree()`s any dir by
  absolute path (`backend/app.py:518-535`).
- **Arbitrary write + traversal**: `/api/export_modified` writes to any `target_dir` and does
  not sanitize `new_name` — `new_name="../../escape"` escapes the chosen directory
  (`backend/app.py:381-388`). `/api/export` and `/api/export_glb` also take arbitrary
  `target_dir`.
- **Dead safety net**: `FileBrowser(root_path=...)` confinement exists
  (`backend/file_browser.py:59-68`) and is the *only* thing the security tests exercise, but
  the app instantiates `FileBrowser()` with no root (`backend/app.py:78`). The tested control
  is not active in production — false confidence.

## Current code reality

- Path handling is scattered: each endpoint does `Path(request.path)` / `Path(query)` directly.
- No shared "resolve + validate inside allowed root(s)" helper.

## Scope

- Introduce a single `resolve_within_roots(path)` helper: resolve symlinks, then verify the
  real path is inside an allowed-roots set. Reject with `403` otherwise.
- Apply it to **every** endpoint touching the filesystem: browse, asset/file, asset/related,
  asset/archive, prepare_archive, delete, rename, duplicate, export, export_modified,
  export_glb, scan_textures, reveal.
- Sanitize filename components (`new_name`, export names) — reject path separators and `..`.
- Default allowed root = user home (or a `--root` / `ROOT` configured directory). Make the
  active root visible in the UI so users know the sandbox boundary.
- Wire `FileBrowser(root_path=...)` so the tested mechanism is actually used.

## Non-goals

- Fine-grained per-folder ACLs. One (or a small configured set of) root(s) is enough.

## Dependencies

- Pairs with `009` (auth/binding). Both required to close the exposure.

## Acceptance criteria / validation

- `GET /api/asset/file?path=/etc/passwd` → `403` (or `404`), never `200`.
- Delete/export outside the active root → `403`.
- `new_name="../../x"` cannot write outside `target_dir` (and `target_dir` must be inside root).
- Regression tests cover a read, a delete, and a write attempt outside root for each endpoint.


---

## Completion

**Status**: Completed · **Completed**: 2026-07-05

Single `PathGuard.resolve()` (symlink-resolve then in-root check) + filename sanitization; every filesystem endpoint funnels through `_guarded_path()`. Archive extraction base dir added as a server-controlled allowed root. Validated: `tests/test_security.py` (arbitrary read/delete/write/traversal all 403/400) + two adversarial security passes; `/etc/passwd` and an out-of-root secret confirmed unreachable.
