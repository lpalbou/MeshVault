# 009 — Loopback Binding, Auth Token, and Host Allow-List

**Priority**: Critical
**Effort**: Medium
**Category**: Security
**Target**: v0.1.1 (hotfix)
**Created**: 2026-07-05

## Summary

The server binds all network interfaces with no authentication and no `Host` header
validation. Combined with the unconfined filesystem endpoints (see `010`), this turns
MeshVault into a remote arbitrary-file read/delete/write service running as the current user.
This is the single highest-risk issue and blocks any "professional" or shareable framing.

## Reason / evidence (confirmed at runtime 2026-07-05)

- `backend/app.py:610-614` runs `uvicorn.run(..., host="0.0.0.0", ...)` — every device on the
  LAN can reach the API.
- No authentication anywhere; `app.user_middleware == []` (no CORS, no host check).
- Because GET endpoints are reachable cross-origin and there is no `Host` allow-list, a
  malicious website visited while the server runs can use **DNS rebinding** to hit
  `127.0.0.1:8420` and exfiltrate files (paired with `010`'s arbitrary read).

## Current code reality

- Single FastAPI app in `backend/app.py`, launched by `main()`.
- No settings/config object; port comes from `PORT` env var only.

## Scope

- Bind to `127.0.0.1` by default. Allow opt-in `HOST`/`--host` override with an explicit,
  logged warning when it is not loopback.
- Generate a per-session bearer token at startup, print it in the launch banner, and require
  it (header or signed cookie) on all `/api/*` routes via middleware. Serve the static app
  shell so the token can be injected into the page on first load from loopback.
- Add a `Host` header allow-list middleware (`localhost`, `127.0.0.1`, `[::1]`, plus any
  explicitly configured host) to neutralize DNS rebinding regardless of auth.
- Keep single-user UX friction near zero: opening `http://localhost:8420` should still "just
  work" locally.

## Non-goals

- Multi-user accounts, RBAC, TLS. Out of scope for a local tool.

## Dependencies

- Pairs with `010` (path confinement). Either alone is insufficient.

## Acceptance criteria / validation

- With defaults, the socket is not reachable from another host on the LAN.
- Requests to `/api/*` without the token return `401`.
- A request with a forged `Host: evil.com` header is rejected (DNS-rebinding guard).
- New regression tests assert: loopback bind default, `401` without token, `403`/`400` on
  bad Host. These must run in CI (currently no endpoint tests exist).

## ADR note

Establishes a durable policy ("local tools bind loopback + require a token by default").
Create/So update an ADR at closure recording this default.


---

## Completion

**Status**: Completed · **Completed**: 2026-07-05

Loopback bind by default; per-session token on all `/api/*` (HttpOnly+SameSite cookie for the browser, `Authorization`/`X-MeshVault-Token` header for clients; query-param token deliberately rejected); Host allow-list (fails closed on empty Host) blocks DNS rebinding. `backend/security.py`. Validated: `tests/test_security.py` (401 without token, 400 bad/empty Host) + runtime curl.
