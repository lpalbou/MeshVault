"""
Main FastAPI application - serves the 3D asset browser.

This is the entry point that:
- Serves the frontend static files
- Provides REST API for file browsing, asset loading, and export
- Manages the lifecycle of backend services
"""

import os
import sys
import mimetypes
import urllib.parse
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel

from backend.file_browser import FileBrowser
from backend.archive_inspector import ArchiveInspector
from backend.export_manager import ExportManager
from backend.fbx_converter import get_fbx_version, convert_fbx_to_obj


# --- Configuration ---

# Default browse root: user's home directory
DEFAULT_ROOT = str(Path.home())

# Register additional MIME types for 3D files
mimetypes.add_type("model/obj", ".obj")
mimetypes.add_type("model/fbx", ".fbx")
mimetypes.add_type("model/mtl", ".mtl")
mimetypes.add_type("model/gltf+json", ".gltf")
mimetypes.add_type("model/gltf-binary", ".glb")


# --- Pydantic models for API ---

class ExportRequest(BaseModel):
    """Request body for exporting an asset."""
    source_path: str
    target_dir: str
    new_name: str
    is_in_archive: bool = False
    archive_path: Optional[str] = None
    inner_path: Optional[str] = None
    related_files: list[str] = []


class BrowseResponse(BaseModel):
    """Response for browse endpoint."""
    current_path: str
    parent_path: Optional[str]
    folders: list[dict]
    assets: list[dict]


# --- App lifecycle ---

archive_inspector = ArchiveInspector()
file_browser = FileBrowser()
export_manager = ExportManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle — clean up temp files on shutdown."""
    yield
    archive_inspector.cleanup()


# --- FastAPI App ---

app = FastAPI(
    title="MeshVault",
    description="Professional 3D asset browser for rapid management",
    version="0.1.0",
    lifespan=lifespan,
)

# Serve frontend static files
frontend_dir = Path(__file__).parent.parent / "frontend"
app.mount(
    "/static",
    StaticFiles(directory=str(frontend_dir)),
    name="static",
)


# --- Routes ---

@app.get("/", response_class=HTMLResponse)
async def root():
    """Serve the main HTML page."""
    index_path = frontend_dir / "index.html"
    return HTMLResponse(content=index_path.read_text(encoding="utf-8"))


@app.get("/api/browse")
async def browse(path: Optional[str] = Query(default=None)):
    """
    Browse a directory and return its contents.

    Query params:
        path: Directory path to browse. Defaults to user's home.
    """
    browse_path = path or DEFAULT_ROOT

    try:
        result = file_browser.browse(browse_path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

    return {
        "current_path": result.current_path,
        "parent_path": result.parent_path,
        "folders": [
            {
                "name": f.name,
                "path": f.path,
                "has_children": f.has_children,
            }
            for f in result.folders
        ],
        "assets": [
            {
                "name": a.name,
                "path": a.path,
                "extension": a.extension,
                "size": a.size,
                "is_in_archive": a.is_in_archive,
                "archive_path": a.archive_path,
                "inner_path": a.inner_path,
                "related_files": a.related_files,
            }
            for a in result.assets
        ],
    }


def _maybe_convert_fbx(file_path: Path) -> tuple[Path, str]:
    """
    Check if an FBX file needs conversion (version < 7000) and convert it.

    Returns (path_to_serve, extension) — if converted, path points to the
    generated OBJ file and extension is ".obj". Otherwise returns the
    original path and extension unchanged.
    """
    ext = file_path.suffix.lower()
    if ext != ".fbx":
        return file_path, ext

    version = get_fbx_version(str(file_path))
    if version is not None and version < 7000:
        # FBX version too old for Three.js — convert to OBJ
        obj_path = file_path.with_suffix(".converted.obj")
        if not obj_path.exists():
            success = convert_fbx_to_obj(str(file_path), str(obj_path))
            if not success:
                # Conversion failed — let the frontend try anyway
                return file_path, ext
        return obj_path, ".obj"

    return file_path, ext


@app.get("/api/asset/file")
async def serve_asset_file(path: str = Query(...)):
    """
    Serve a 3D asset file for the viewer.

    For regular files, serves directly.
    For FBX files with version < 7000, auto-converts to OBJ.
    """
    file_path = Path(path)
    if file_path.exists() and file_path.is_file():
        # Auto-convert old FBX if needed
        serve_path, _ = _maybe_convert_fbx(file_path)
        content_type = mimetypes.guess_type(str(serve_path))[0] or "application/octet-stream"
        return FileResponse(
            path=str(serve_path),
            media_type=content_type,
            filename=serve_path.name,
        )

    raise HTTPException(status_code=404, detail=f"File not found: {path}")


@app.get("/api/asset/archive")
async def serve_archive_asset(
    archive_path: str = Query(...),
    inner_path: str = Query(...),
):
    """
    Extract and serve a 3D asset from an archive.

    Extracts the asset (and related files) to a temp directory,
    then serves the main asset file.
    """
    extracted = archive_inspector.extract_asset(archive_path, inner_path)
    if extracted is None:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract {inner_path} from {archive_path}",
        )

    file_path = Path(extracted)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Extracted file not found")

    content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    return FileResponse(
        path=str(file_path),
        media_type=content_type,
        filename=file_path.name,
    )


@app.get("/api/asset/prepare_archive")
async def prepare_archive_asset(
    archive_path: str = Query(...),
    inner_path: str = Query(...),
):
    """
    Extract an archived asset and return JSON with resolved temp paths.

    This endpoint extracts the main asset and its related files to a
    temp directory, then returns the absolute filesystem paths so the
    frontend can use /api/asset/file and /api/asset/related with them.

    This solves the problem of archive-internal paths not being valid
    filesystem paths for the Three.js loaders.
    """
    extracted = archive_inspector.extract_asset(archive_path, inner_path)
    if extracted is None:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract {inner_path} from {archive_path}",
        )

    file_path = Path(extracted)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Extracted file not found")

    # Auto-convert old FBX if needed
    serve_path, actual_ext = _maybe_convert_fbx(file_path)

    # Build the file URL for the main asset (points to converted file if applicable)
    file_url = f"/api/asset/file?path={urllib.parse.quote(str(serve_path))}"

    # Resolve related file paths: map archive-internal -> extracted temp paths
    # First, get all related files from the archive listing
    result = file_browser.browse(str(Path(archive_path).parent))
    archived_asset = None
    for a in result.assets:
        if (a.archive_path == archive_path and a.inner_path == inner_path):
            archived_asset = a
            break

    related_inner = archived_asset.related_files if archived_asset else []
    related_resolved = archive_inspector.get_extracted_related_paths(
        archive_path, related_inner
    )

    return {
        "file_url": file_url,
        "file_path": str(serve_path),
        "related_files": related_resolved,
        # Tell frontend the actual format to use (may differ if converted)
        "actual_extension": actual_ext,
    }


@app.get("/api/asset/related")
async def serve_related_file(path: str = Query(...)):
    """
    Serve a related file (texture, material) for the 3D viewer.

    This endpoint allows the Three.js loaders to fetch .mtl files,
    textures, etc., that are referenced by the main 3D asset.
    """
    file_path = Path(path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")

    content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    return FileResponse(
        path=str(file_path),
        media_type=content_type,
        filename=file_path.name,
    )


@app.post("/api/export")
async def export_asset(request: ExportRequest):
    """
    Export a 3D asset to a target directory with a new name.

    Handles both regular files and archived assets.
    """
    result = export_manager.export_asset(
        source_path=request.source_path,
        target_dir=request.target_dir,
        new_name=request.new_name,
        is_in_archive=request.is_in_archive,
        archive_path=request.archive_path,
        inner_path=request.inner_path,
        related_files=request.related_files,
    )

    if not result.success:
        raise HTTPException(status_code=500, detail=result.message)

    return {
        "success": result.success,
        "output_path": result.output_path,
        "message": result.message,
        "files_exported": result.files_exported,
    }


@app.get("/api/default_path")
async def get_default_path():
    """Return the default browse path (user home)."""
    return {"path": DEFAULT_ROOT}


def main():
    """Entry point for running the server."""
    port = int(os.environ.get("PORT", 8420))
    print(f"\n  🎨 MeshVault")
    print(f"  → Open http://localhost:{port} in your browser\n")
    uvicorn.run(
        "backend.app:app",
        host="0.0.0.0",
        port=port,
        reload=False,
    )


if __name__ == "__main__":
    main()
