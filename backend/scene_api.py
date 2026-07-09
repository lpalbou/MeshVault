"""
Scene manifest persistence — save/load composed scenes (.mvscene, backlog 042).

A scene manifest is viewer-produced JSON (get_scene_manifest): per-object source +
placement transform + visibility/opacity, plus scene lighting/environment/background.
The endpoints only STORE and RETURN manifests — object resolution happens in the
client through the existing guarded /api/asset/* routes, one object at a time, so no
new filesystem-probing loop exists server-side (adversarial review requirement).

Save contract (mirrors the repo's other write endpoints — export_glb pattern):
- target_dir + sanitized name, NEVER a raw client path (a raw-path write endpoint is
  an arbitrary-file-write primitive under the default unconfined root).
- The .mvscene suffix is FORCED, existing files are not clobbered unless the caller
  explicitly passes overwrite=true, and only .mvscene files may ever be overwritten.
- Manifests are size- and object-count-capped on both save and load (memory/DoS).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

SCENE_EXTENSION = ".mvscene"
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_SCENE_OBJECTS = 128


class SceneSaveRequest(BaseModel):
    """Request body for saving a scene manifest."""
    target_dir: str
    name: str
    manifest: dict
    overwrite: bool = False


def validate_manifest(manifest: dict) -> dict:
    """Structural validation of a version-1 scene manifest (shared by save/load).

    Deliberately shallow: the manifest is DATA consumed by the viewer, which
    re-resolves every object through the PathGuarded asset routes. What matters
    here is bounding it (counts/sizes/types) so a hostile file cannot be a memory
    bomb or smuggle non-JSON structure, not re-implementing the viewer's schema.
    """
    if not isinstance(manifest, dict):
        raise HTTPException(status_code=422, detail="Manifest must be an object")
    if manifest.get("version") != 1:
        raise HTTPException(status_code=422,
                            detail=f"Unsupported manifest version {manifest.get('version')!r} "
                                   "(expected 1)")
    objects = manifest.get("objects")
    if not isinstance(objects, list) or len(objects) == 0:
        raise HTTPException(status_code=422, detail="Manifest has no objects")
    if len(objects) > MAX_SCENE_OBJECTS:
        raise HTTPException(status_code=422,
                            detail=f"Too many objects ({len(objects)}); max {MAX_SCENE_OBJECTS}")
    for i, obj in enumerate(objects):
        if not isinstance(obj, dict):
            raise HTTPException(status_code=422, detail=f"objects[{i}] must be an object")
        source = obj.get("source")
        if not isinstance(source, dict) or source.get("kind") not in {"file", "archive", "url"}:
            raise HTTPException(status_code=422,
                                detail=f"objects[{i}].source.kind must be file|archive|url")
        for key in ("path", "archivePath", "innerPath", "url"):
            value = source.get(key)
            if value is not None and (not isinstance(value, str) or len(value) > 4096):
                raise HTTPException(status_code=422,
                                    detail=f"objects[{i}].source.{key} invalid")
    serialized = json.dumps(manifest)
    if len(serialized) > MAX_MANIFEST_BYTES:
        raise HTTPException(status_code=413,
                            detail=f"Manifest exceeds {MAX_MANIFEST_BYTES // 1024} KB")
    return manifest


def create_router(
    *,
    guarded_path: Callable[..., Path],
    sanitize_component: Callable[[str], str],
) -> APIRouter:
    """Scene endpoints with the app's trust-boundary helpers injected."""
    router = APIRouter()

    @router.post("/api/scene/save")
    def scene_save(body: SceneSaveRequest):
        """Persist a scene manifest as <target_dir>/<name>.mvscene."""
        target_dir = guarded_path(body.target_dir, must_exist=False, require_dir=True)
        try:
            safe_name = sanitize_component(body.name)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        if not safe_name.lower().endswith(SCENE_EXTENSION):
            safe_name += SCENE_EXTENSION

        manifest = validate_manifest(body.manifest)

        target_dir.mkdir(parents=True, exist_ok=True)
        out_path = target_dir / safe_name
        if out_path.exists():
            if not body.overwrite:
                raise HTTPException(status_code=409,
                                    detail=f"Already exists: {safe_name} "
                                           "(pass overwrite=true to replace)")
            # Even with overwrite, never clobber anything but a scene file.
            if not (out_path.is_file() and out_path.suffix.lower() == SCENE_EXTENSION):
                raise HTTPException(status_code=409, detail="Refusing to overwrite a non-scene file")

        try:
            out_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Failed to write scene: {e}")

        return {"ok": True, "path": str(out_path),
                "objects": len(manifest["objects"])}

    @router.get("/api/scene/load")
    def scene_load(path: str = Query(...)):
        """Read a scene manifest. The client re-resolves each object through the
        guarded asset routes; a missing/denied object degrades per-object there."""
        file_path = guarded_path(path, require_file=True)
        if file_path.suffix.lower() != SCENE_EXTENSION:
            raise HTTPException(status_code=422,
                                detail=f"Not a scene file (expected {SCENE_EXTENSION})")
        if file_path.stat().st_size > MAX_MANIFEST_BYTES:
            raise HTTPException(status_code=413,
                                detail=f"Scene file exceeds {MAX_MANIFEST_BYTES // 1024} KB")
        try:
            manifest = json.loads(file_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise HTTPException(status_code=422, detail="Scene file is not valid JSON")

        return {"ok": True, "path": str(file_path),
                "manifest": validate_manifest(manifest)}

    return router
