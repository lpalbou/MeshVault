# API Reference

MeshVault exposes a REST API served by FastAPI. When the server is running, interactive Swagger docs are also available at `http://localhost:8420/docs`.

**Base URL**: `http://localhost:8420`

---

## Endpoints Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Serve the main HTML page |
| `GET` | `/api/browse` | Browse a directory for folders and 3D assets (`.obj`, `.fbx`, `.gltf`, `.glb`) |
| `GET` | `/api/asset/file` | Serve a 3D file from the filesystem (auto-converts old FBX to OBJ) |
| `GET` | `/api/asset/archive` | Extract and serve a 3D file from an archive |
| `GET` | `/api/asset/prepare_archive` | Extract archived asset + return resolved temp paths and actual format |
| `GET` | `/api/asset/related` | Serve a related file (material, texture) |
| `POST` | `/api/export` | Export an unmodified asset with a new name to a target directory |
| `POST` | `/api/export_modified` | Export a modified model (OBJ text from frontend) to a target directory |
| `GET` | `/api/default_path` | Get the default browse path (user home) |

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

## `GET /api/default_path`

Returns the default browse path (the current user's home directory).

### Response `200 OK`

```json
{
    "path": "/Users/me"
}
```

---

## Interactive Docs

When the server is running, FastAPI automatically generates interactive API documentation:

- **Swagger UI**: http://localhost:8420/docs
- **ReDoc**: http://localhost:8420/redoc
