# 043 — Shared session between MCP agents and the app + URL deep links

**Priority**: High (external feature request)
**Effort**: Medium
**Category**: Agent workflows / UX
**Status**: Done (2026-07-08)
**Created**: 2026-07-08

## Origin (external FR, verbatim)

> Shared session between the MCP server and the running app. The headless MCP server
> and the browser app are separate processes with separate state. When an agent
> inspects or critiques a model headless, a human co-reviewing in the app can't see
> what the agent sees — during this session I had to inject meshvault_lastDir into
> localStorage via DevTools to surface the agent's subject in the UI. Proposal: (a) an
> MCP tool like open_in_app(path, camera?) that pushes the current model + camera into
> the running app (or an opt-in mode where both share one session), and (b) honoring
> the ?path=/?dir= URL parameters over the localStorage default, so deep links work for
> both humans and automation. Nice-to-have: a documented lighting/background preset
> parameter on screenshot so renders are comparable across sessions.

## Delivered 2026-07-08

- **(a) `open_in_app` MCP tool** — pushes the agent's current model + camera into every
  open app tab, live. Architecture: app writes `~/.meshvault/app_session.json`
  ({url, token}, 0600, pid-checked removal) at launch → tool discovers it (env
  overrides: `MESHVAULT_APP_URL`/`MESHVAULT_TOKEN`) → `POST /api/agent/open`
  (PathGuard + token + camera validation) → `GET /api/events` SSE fan-out
  (cookie-authenticated EventSource, bounded queues) → tab loads via the normal asset
  flow and applies the camera. Same-model pushes move only the camera. Returns
  `{clients, deep_link}` for the no-tab-connected case.
  The "both share one session" alternative from the FR was NOT chosen: the message
  channel keeps both processes independent (no lifecycle coupling) and the deep link
  covers the cold-start case.
- **(b) `?path=` / `?dir=` deep links** — honored over the localStorage default;
  archive members via the composite key (`?path=/abs/pack.zip!inner/model.obj`);
  URL kept in sync while browsing (replaceState) so the address bar is always
  shareable; exact-then-basename matching absorbs server path canonicalization
  (`/tmp` → `/private/tmp`); graceful fallback on invalid links.
  New module: `frontend/js/agent_link.js`.
- **(nice-to-have) `screenshot { preset }`** — `studio` / `neutral` / `dark`, each
  pinning ALL pixel-affecting lighting/background state; values documented in
  `docs/mcp.md`. Measured cross-session mean per-channel diff: 0.03/255.

## Verification

- `tests/test_agent_bridge.py` (24 tests): endpoint auth (401), confinement (403),
  validation (404/422 incl. malformed camera table), broadcaster fan-out/backpressure,
  session-file lifecycle + discovery precedence, full-stack SSE delivery against a
  real uvicorn server (TestClient cannot consume infinite streams through
  BaseHTTPMiddleware — see KnowledgeBase).
- Browser E2E: deep links with spaces + symlinked roots (`/tmp/mv e2e/sub dir/space
  helmet.glb`), `?dir=`, archive member, invalid-link fallback, URL sync after
  sidebar clicks.
- MCP E2E (real client over stdio): `load_model` → `orbit` → `screenshot
  {preset:"studio"}` → `open_in_app` → app tab loaded the model with the identical
  camera `[3.29, 2.195, -2.088]`; push delivered to 1 client.

## Hardening round from external testing (same day)

An external tester exercised the feature and reported four findings, all addressed:

1. **Stale session file after SIGKILL** (their launch was reaped ungracefully; the
   leftover file pointed at a port where an older instance answered → 404 chase).
   Fixed two-sided: the file is published only AFTER `uvicorn.Server.started`
   (a failed bind publishes nothing and cannot clobber the live instance's file),
   and discovery pid-probes the publisher (`StaleSessionError(pid)`, file removed,
   actionable tool error). POSIX-only probe — on Windows `os.kill(pid, 0)` would
   TerminateProcess (see KnowledgeBase). Plus a specific error when the answering
   server lacks `/api/agent/open` ("older MeshVault (< 0.4) still running").
2. **`/openapi.json` 404** — deliberate hardening; now stated explicitly in
   docs/api.md so script agents don't hunt for the schema.
3. **`get_camera`/`set_camera` mistaken for MCP tools** — they are viewer commands
   via `viewer_execute`; docs/mcp.md now says so where they're mentioned.
4. **`meshvault --help` started the server** — real argparse CLI added
   (`--help`, `--version`, `--port`).

## Known limits (documented in docs/mcp.md)

- `open_in_app` needs a local file: models loaded from URLs via the browser path have
  no local file (the CORS-fallback temp download does, and is pushable).
- Confined apps (`MESHVAULT_ROOT`) reject pushes outside their roots (403) — correct
  behavior, surfaced in the tool error.
- One session file = one discoverable app instance (last writer wins). Multi-instance
  setups use the env overrides.
- Live push requires an open, connected tab; otherwise the returned `deep_link`
  covers it.

## Relationship to other items

- Complements 039 (agent capture ergonomics) — presets close its "comparable renders"
  gap.
- 032 (shareable URL state for the web viewer) stays open: camera/render-mode/bg in
  the URL is still only proposed for `web/`; the local app now has asset/folder deep
  links (this item) but deliberately does NOT encode camera in the URL (the push
  channel carries it with full fidelity).
