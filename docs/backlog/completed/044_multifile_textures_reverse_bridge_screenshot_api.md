# 044 — Multi-file texture fix + reverse co-review bridge + GET /api/screenshot

**Priority**: High (1 confirmed defect + 2 approved follow-ups of 043)
**Effort**: Large (three coordinated items)
**Category**: Agent workflows / correctness
**Status**: Done (2026-07-09)
**Created**: 2026-07-09

## Scope (approved as a batch)

1. Fix the confirmed untextured-multi-file defect in the MCP/headless path.
2. Reverse co-review bridge: `get_app_state` (agent reads what the human sees).
3. `GET /api/screenshot`: headless renders over plain HTTP for curl/non-MCP agents,
   on a shared headless-runtime module (the seam 024's batch CLI will reuse).

## 1. Multi-file textures (defect fix)

Root causes found and fixed at the root, not patched per-runtime:

- **Texture race (all runtimes)**: `_isUsableTexture` treated still-loading textures
  as unusable; `_enhanceModel` stripped them right after mesh parse. Over loopback
  the mesh always parses first → MCP/headless was ALWAYS untextured; the app raced.
  Now: pending vs definitively-broken classification (`_isBrokenTexture`), pending
  preserved, one janitor pass after settle clears real failures. See KnowledgeBase.
- **No serving story for companions (MCP)**: `/models/<token>` served ONE file.
  Now `/models/<token>/<name>` serves the model's directory companions, confined
  (resolve + `is_relative_to`), so relative MTL/texture/.bin refs work as sibling
  URLs. Downloads isolated per-directory so tokens don't cross-expose.
- **Resolver had no model context (standalone)**: default resolver now resolves
  relative refs against the model URL's directory (`getModelBaseUrl()`); the `load`
  command accepts `relatedFiles`; `load_model` discovers companions server-side
  (OBJ `mtllib` parse + same-stem fallback; FBX bounded texture scan; glTF none —
  loader-relative).

Evidence: real-MCP-client E2E — textured cube (OBJ+MTL+PNG in a spaced subdir)
reports textureCount 1 and renders 23% red pixels; external-buffer `.gltf`+`.bin`
loads 320 triangles. Unit tests: mtllib parsing (spaces/backslashes/binary noise),
companion discovery bounds/confinement, `LocalModelServer` traversal 404s.

## 2. Reverse bridge (`get_app_state`)

Tabs POST `{path, name, camera}` to `/api/agent/state` (~2 s cadence, content-
deduplicated; camera validated like the push path); agents read `GET
/api/agent/state` (or the `get_app_state` MCP tool, with the same session-file
discovery + stale-pid handling as `open_in_app`). E2E: moved the tab camera twice —
reports followed within a tick; a real MCP client loaded the human's model and
reproduced the exact pose.

## 3. `GET /api/screenshot`

Per the adversarial review's must-haves: app-origin harness (inherits PathGuard AND
multi-file resolution via `/api/asset/related` — an MCP-registry variant would have
reproduced the texture bug), guard + 512 MB cap before browser start, single-flight
lock (429), hard timeout (504), per-request unload+reload+preset re-pin (no state
bleed via the shared scene), distinct 503s (playwright pkg vs Chromium binary),
lifespan-closed browser, presets shared with MCP (`headless_viewer.RENDER_PRESETS`).
Measured 8–17 s/call on SwiftShader. E2E: curl → PNG with correct metadata header;
textured OBJ renders red through the endpoint (27.6% red pixels).

New modules: `backend/headless_viewer.py` (HeadlessViewer + LocalModelServer +
presets + companion discovery), `backend/screenshot_api.py` (DI'd router; no import
cycle). `mcp_server.py` now composes the shared runtime (net shrink).

## Relationship to other items

- 024 (batch turntable/thumbnail CLI): the hard lifecycle work now lives in
  `headless_viewer.py`; the CLI is a consumer away.
- 043: this completes the co-review loop in both directions and closes its
  known-limit list item on multi-file assets.
- browser-free strategy (040) unchanged: Chromium remains the runtime; the shared
  module is where a Node runtime would slot in.
