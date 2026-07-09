# API Reference

MeshVault exposes a REST API served by FastAPI.

**Base URL**: `http://localhost:8420`

---

## Security model

MeshVault binds to loopback (`127.0.0.1`) by default. By default every filesystem
operation is allowed anywhere on the machine (the browser opens at the user's home
directory); the network protections below — not path confinement — are what keep it
private. Set `MESHVAULT_ROOT` to **restrict** access to one or more directories (then any
path outside them returns `403`). All `/api/*` requests require a session token:

- Opening the app in a browser on the same machine authenticates automatically (an
  `HttpOnly`, `SameSite=Strict` cookie is set when the page loads).
- Programmatic clients pass the token via `Authorization: Bearer <token>` or
  `X-MeshVault-Token: <token>`. The token is printed in the launch banner and published
  for local agents in `~/.meshvault/app_session.json`. A `?token=` query parameter is
  deliberately **not** accepted (query strings leak into logs, history, and `Referer`).
- Requests with a disallowed `Host` header are rejected (DNS-rebinding protection).

Common security responses: `401` (missing/invalid token), `400` (disallowed Host, or an
invalid filename component), `403` (path outside the allowed root).

Environment variables: `MESHVAULT_ROOT` (restrict access to these root(s); `os.pathsep`-separated;
default = whole filesystem), `MESHVAULT_HOST` (bind host — non-loopback prints a warning),
`MESHVAULT_TOKEN` (fixed token), `MESHVAULT_ALLOWED_HOSTS` (comma-separated extra hostnames),
`MESHVAULT_NO_AUTH=1` (disable auth; single-user/testing only).

---

## Endpoints Overview (24 routes)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Serve the main HTML page (issues the session cookie; honors `?path=`/`?dir=` deep links) |
| `POST` | `/api/compare` | Register two surface point sets and return a shape-comparison report (pure math; no filesystem) |
| `GET` | `/api/browse` | Browse a directory for 3D assets and folders |
| `GET` | `/api/asset/file` | Serve a 3D file (auto-converts old `.fbx`→`.obj`) |
| `GET` | `/api/asset/archive` | Extract and serve a 3D file from an archive |
| `GET` | `/api/asset/prepare_archive` | Extract archived asset + return resolved temp paths |
| `GET` | `/api/asset/related` | Serve a related file (material, texture) |
| `POST` | `/api/export` | Export an unmodified asset |
| `POST` | `/api/export_modified` | Export a modified model (OBJ from frontend) |
| `POST` | `/api/export_glb` | Save a GLB (binary glTF) generated in the browser |
| `POST` | `/api/scan_textures` | Scan a folder recursively for texture files |
| `POST` | `/api/reveal` | Open file manager and select a file |
| `POST` | `/api/rename` | Rename a file or folder |
| `POST` | `/api/duplicate` | Duplicate a file |
| `POST` | `/api/delete` | Delete a file or folder |
| `GET` | `/api/default_path` | Get the default browse path (allowed root) |
| `POST` | `/api/agent/open` | Push a model (+ optional camera pose) into every connected app tab |
| `GET` | `/api/events` | SSE stream of agent-bridge events for app tabs |
| `POST` | `/api/agent/state` | App tabs report what the human is looking at (asset + camera) |
| `GET` | `/api/agent/state` | Read the latest reported human-session state (reverse bridge) |
| `GET` | `/api/screenshot` | Headless PNG render of a local model (no browser session needed) |
| `GET` | `/api/screenshot/harness` | Internal viewer page the headless renderer drives |
| `POST` | `/api/scene/save` | Persist a composed-scene manifest as `<dir>/<name>.mvscene` |
| `GET` | `/api/scene/load` | Read a scene manifest (objects re-resolve client-side, guarded) |

---

## `GET /api/browse`

Browse a directory and return its contents: subdirectories and discovered 3D assets (including those inside archives).

### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | No | User home | Absolute path to the directory to browse |

### Response `200 OK`

```json
{
    "current_path": "/Users/me/models",
    "parent_path": "/Users/me",
    "folders": [
        {
            "name": "characters",
            "path": "/Users/me/models/characters",
            "has_children": true
        }
    ],
    "assets": [
        {
            "name": "spaceship",
            "path": "/Users/me/models/spaceship.obj",
            "extension": ".obj",
            "size": 245760,
            "is_in_archive": false,
            "archive_path": null,
            "inner_path": null,
            "related_files": [
                "/Users/me/models/spaceship.mtl",
                "/Users/me/models/spaceship.png"
            ]
        },
        {
            "name": "robot",
            "path": "/Users/me/models/pack.zip",
            "extension": ".fbx",
            "size": 512000,
            "is_in_archive": true,
            "archive_path": "/Users/me/models/pack.zip",
            "inner_path": "models/robot.fbx",
            "related_files": []
        }
    ]
}
```

### Error Responses

| Status | Condition |
|--------|-----------|
| `404` | Directory does not exist |
| `403` | Directory is outside the allowed root path |

---

## `GET /api/asset/file`

Serve a 3D asset file from the local filesystem for the Three.js viewer. If the file is an FBX with version < 7000, it is automatically converted to OBJ before serving.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Absolute path to the 3D file |

### Response `200 OK`

Binary file content with appropriate `Content-Type` header.

| Extension | Content-Type |
|-----------|-------------|
| `.obj` | `model/obj` |
| `.fbx` | `model/fbx` |

> **Note:** For old FBX files (version < 7000), the response will contain OBJ data even though the source was FBX.

### Error Responses

| Status | Condition |
|--------|-----------|
| `404` | File does not exist |

---

## `GET /api/asset/archive`

Extract a 3D asset from an archive (ZIP or RAR) and serve it. Also extracts related files (materials, textures) to the same temp directory so loaders can find them.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `archive_path` | string | Yes | Absolute path to the archive file |
| `inner_path` | string | Yes | Path of the asset inside the archive |

### Response `200 OK`

Binary file content of the extracted 3D asset.

### Error Responses

| Status | Condition |
|--------|-----------|
| `404` | Extracted file not found after extraction |
| `500` | Extraction failed (corrupt archive, no extraction tool available, etc.) |

---

## `GET /api/asset/prepare_archive`

Extract an archived asset and return JSON with resolved filesystem paths. This endpoint solves the problem of archive-internal paths not being valid filesystem paths — it extracts everything to a temp directory, auto-converts old FBX if needed, and returns absolute paths the frontend can use.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `archive_path` | string | Yes | Absolute path to the archive file |
| `inner_path` | string | Yes | Path of the asset inside the archive |

### Response `200 OK`

```json
{
    "file_url": "/api/asset/file?path=/tmp/3d_browser_xxx/model.obj",
    "file_path": "/tmp/3d_browser_xxx/model.obj",
    "related_files": [
        "/tmp/3d_browser_xxx/model.mtl"
    ],
    "actual_extension": ".obj"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `file_url` | string | Ready-to-use URL for the main asset file |
| `file_path` | string | Absolute temp path to the extracted file |
| `related_files` | array | Absolute temp paths to extracted related files |
| `actual_extension` | string | The format to load (may differ from original if FBX was auto-converted to OBJ) |

### Error Responses

| Status | Condition |
|--------|-----------|
| `500` | Extraction failed |

---

## `GET /api/asset/related`

Serve a related file (material file, texture) for the Three.js viewer. Used by the OBJ+MTL loading pipeline to fetch `.mtl` files and their referenced textures.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Absolute path to the related file |

### Response `200 OK`

Binary file content with guessed `Content-Type`.

### Error Responses

| Status | Condition |
|--------|-----------|
| `404` | File does not exist |

---

## `POST /api/export`

Export a 3D asset to a target directory with a new name. Handles both filesystem files and archived assets. If the asset has related files, they are exported together in a subfolder.

### Request Body (JSON)

```json
{
    "source_path": "/Users/me/models/spaceship.obj",
    "target_dir": "/Users/me/export",
    "new_name": "my_spaceship",
    "is_in_archive": false,
    "archive_path": null,
    "inner_path": null,
    "related_files": [
        "/Users/me/models/spaceship.mtl",
        "/Users/me/models/spaceship.png"
    ]
}
```

### Request Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `source_path` | string | Yes | — | Path to the source 3D file |
| `target_dir` | string | Yes | — | Target directory for export |
| `new_name` | string | Yes | — | New name for the asset (without extension) |
| `is_in_archive` | boolean | No | `false` | Whether source is inside an archive |
| `archive_path` | string | No | `null` | Path to the archive (if `is_in_archive`) |
| `inner_path` | string | No | `null` | Path inside the archive (if `is_in_archive`) |
| `related_files` | array | No | `[]` | Paths to related files to include in export |

### Response `200 OK`

```json
{
    "success": true,
    "output_path": "/Users/me/export/my_spaceship",
    "message": "Exported 3 file(s) successfully",
    "files_exported": [
        "/Users/me/export/my_spaceship/my_spaceship.obj",
        "/Users/me/export/my_spaceship/my_spaceship.mtl",
        "/Users/me/export/my_spaceship/spaceship.png"
    ]
}
```

### Export Behavior

- **Single file** (no related files): Exported as `<target_dir>/<new_name>.<ext>`
- **Multiple files** (has related files): Exported into `<target_dir>/<new_name>/` subfolder

### Error Responses

| Status | Condition |
|--------|-----------|
| `422` | Invalid request body (missing required fields) |
| `500` | Export failed (permissions, disk full, etc.) |

---

## `POST /api/export_modified`

Export a modified model (OBJ text generated by the frontend after Center/Ground/Orient/Scale). The OBJ content is generated by Three.js OBJExporter with all transforms baked into the vertex data.

### Request Body (JSON)

```json
{
    "target_dir": "/Users/me/export",
    "new_name": "my_model_centered",
    "obj_content": "# MeshVault modified export\nv 0.0 0.0 0.0\n..."
}
```

### Request Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `target_dir` | string | Yes | Target directory for export |
| `new_name` | string | Yes | Output file name (without extension) |
| `obj_content` | string | Yes | OBJ file content (from Three.js OBJExporter) |

### Response `200 OK`

```json
{
    "success": true,
    "output_path": "/Users/me/export",
    "message": "Exported modified model as OBJ",
    "files_exported": ["/Users/me/export/my_model_centered.obj"]
}
```

### Error Responses

| Status | Condition |
|--------|-----------|
| `422` | Invalid request body |
| `500` | Write failed (permissions, disk full, etc.) |

---

## `POST /api/export_glb`

Save a GLB (binary glTF) file generated in the browser by Three.js `GLTFExporter`. This is
the viewer's default export format: a single self-contained file with geometry, PBR materials,
and embedded textures. Sent as `multipart/form-data`.

### Form Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The GLB binary blob |
| `target_dir` | string | Yes | Target directory (confined to the allowed root) |
| `file_name` | string | Yes | Output file name (`.glb` appended if missing) |

### Response `200 OK`

```json
{
    "success": true,
    "output_path": "/Users/me/export",
    "file_path": "/Users/me/export/model.glb",
    "file_size": 1048576,
    "message": "Exported GLB: model.glb"
}
```

### Error Responses

| Status | Condition |
|--------|-----------|
| `400` | Invalid filename component |
| `403` | Target directory outside the allowed root |
| `500` | Write failed |

---

## `GET /api/default_path`

Returns the default browse path (the primary allowed root, typically the user's home directory).

### Response `200 OK`

```json
{
    "path": "/Users/me"
}
```

---

## `POST /api/agent/open`

Push a model — and optionally a camera pose — into every connected app tab (the agent
bridge behind the MCP `open_in_app` tool). The path is confined by the PathGuard like
every other filesystem input; malformed camera payloads are rejected with `422` so a
human co-reviewer can never end up silently looking at a different view than the agent.

At launch, `meshvault` publishes its URL + token to `~/.meshvault/app_session.json`
(mode 0600, removed on shutdown), so local agent processes can discover a running app
without configuration.

### Request Body (JSON)

```json
{
    "path": "/abs/path/to/model.glb",
    "camera": { "position": [3.2, 2.1, -2.0], "target": [0, 0, 0], "fov": 45 },
    "source": "mcp"
}
```

`camera` and `source` are optional. `camera.position` is required within `camera`;
`fov` is degrees (1–179).

### Response `200 OK`

```json
{
    "ok": true,
    "clients": 1,
    "deep_link": "http://localhost:8420/?path=/abs/path/to/model.glb"
}
```

`clients` is the number of tabs that received the push; `deep_link` reproduces the
open for a tab that was not connected. Errors: `401/403/404` (auth/confinement/missing
file), `422` (non-model extension, malformed camera).

---

## `GET /api/events`

Server-Sent Events stream (`text/event-stream`) of agent-bridge messages. The app
subscribes on load via `EventSource` (the same-origin session cookie authenticates it).
Frames are JSON: a `{"type": "connected"}` frame on subscribe, then one
`{"type": "open_asset", "path": …, "camera": …, "source": …}` per push; heartbeat
comments flow every 15 s.

---

## `POST /api/agent/state` · `GET /api/agent/state`

App tabs periodically report what the human is looking at; agents read it back to
pick up the human's session headless (MCP `get_app_state`). POST body:
`{path, name, camera}` (camera validated like `/api/agent/open`; 422 on malformed).
GET response:

```json
{
    "ok": true,
    "state": {
        "path": "/abs/model.glb",
        "name": "model.glb",
        "camera": { "position": [2.8, 1.7, 2.6], "target": [0, 0, 0], "fov": 45 },
        "age_seconds": 3.2
    },
    "clients": 1
}
```

`state` is `null` until a tab reports; `age_seconds` is the report's freshness
(tabs report on load and whenever the camera settles, ~2 s cadence).

---

## `GET /api/screenshot`

Render a local model to PNG, headless — no browser session, no MCP client. The
render happens in a lazily-started headless Chromium driving the standalone viewer
on this app's own origin, so PathGuard confinement and multi-file resolution
(OBJ+MTL+textures via `/api/asset/related`) apply exactly as in the interactive app.

### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | required | Absolute path of the model file (PathGuard-confined) |
| `view` | string | — | Camera preset: `front/back/left/right/top/bottom/iso` |
| `azimuth` / `elevation` | float | — | Explicit camera angles in degrees (elevation defaults to 15) |
| `best_view` | bool | false | Frame the model's most detailed angle first (adds `best_view` metadata) |
| `preset` | string | `studio` | Render preset: `studio` / `neutral` / `dark` / `none` — pins ALL lighting/background state so renders are reproducible; `none` inherits session state |
| `fill` | float 0.1–1 | — | Framing tightness |
| `width` / `height` | int 16–8192 | 1024 | Output resolution |
| `transparent` | bool | false | Alpha background |
| `hide_ground` | bool | false | Hide the ground/shadow plane |

### Response `200 OK`

`image/png` bytes. Render facts (path, chosen view/best-view angles, preset) come
back as compact JSON in the `X-MeshVault-Screenshot` header.

```bash
curl -H "X-MeshVault-Token: $TOKEN" \
  "http://localhost:8420/api/screenshot?path=/abs/model.glb&best_view=true&width=512&height=512" \
  -o shot.png
```

### Behavior & errors

- Every request unloads, reloads, and re-pins the preset — nothing bleeds between
  requests through the shared page. First call pays the browser start (~5 s);
  renders take seconds on software GL (measured 8–17 s end-to-end per call).
- Single-flight: one render at a time; concurrent callers wait briefly, then `429`.
- `403/404` path confinement, `413` model over 512 MB, `422` bad view/preset,
  `503` playwright/Chromium not installed (`pip install "meshvault[mcp]"` +
  `playwright install chromium`), `504` render exceeded the timeout
  (`MESHVAULT_SCREENSHOT_TIMEOUT`, default 240 s).

---

## `POST /api/scene/save` · `GET /api/scene/load`

Persist / read composed-scene manifests (`.mvscene`, version-1 JSON: per-object
source + placement transform + visibility/opacity, plus scene lighting/environment/
background — produced by the viewer's `get_scene_manifest` command).

Save takes `{target_dir, name, manifest, overwrite=false}` — the name is sanitized
and the `.mvscene` suffix is FORCED (never a raw-path write), existing files return
`409` unless `overwrite=true`, and only `.mvscene` files can ever be overwritten.
Manifests are capped (128 objects, 2 MB) on both save and load. Load returns the
manifest; the client re-resolves each object through the guarded `/api/asset/*`
routes, so an unavailable object degrades per-object without a server-side probe
loop. Scene files also appear in `/api/browse` listings and load on click in the app.

---

## Deep links (`GET /?path=` / `GET /?dir=` / `GET /?scene=`)

The app shell honors URL parameters over the remembered last directory:

- `/?dir=/abs/folder` — open the file browser at that folder.
- `/?path=/abs/folder/model.glb` — open the folder, highlight the asset, load it.
- `/?path=/abs/pack.zip!inner/model.obj` — same for a model inside an archive
  (`archive!inner` — the app's composite asset key).
- `/?scene=/abs/composition.mvscene` — rebuild a saved composed scene.

The URL stays in sync while browsing (`replaceState`), so the address bar is always a
shareable deep link to the current view. Invalid deep links toast an error and fall
back to the normal start (last directory or home).

---

## Interactive Docs

The FastAPI auto-docs (`/docs`, `/redoc`, `/openapi.json`) are **disabled** on purpose:
for a local single-user tool the schema is free reconnaissance surface (see
`backend/app.py`). This document is the API reference.
