"""
Main FastAPI application - serves the 3D asset browser.

This is the entry point that:
- Serves the frontend static files
- Provides REST API for file browsing, asset loading, and export
- Manages the lifecycle of backend services
"""

import os
import sys
import subprocess
import platform
import mimetypes
import urllib.parse
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel

from backend.file_browser import FileBrowser
from backend.archive_inspector import ArchiveInspector
from backend.export_manager import ExportManager
from backend.fbx_converter import get_fbx_version, convert_fbx_to_obj
from backend.security import (
    SecurityConfig,
    PathGuard,
    HostAllowlistMiddleware,
    TokenAuthMiddleware,
    attach_session_cookie,
)


# --- Configuration ---

# The security config is the single source of truth for the trust boundary
# (allowed roots, bind host, session token). Built once at import time.
security_config = SecurityConfig.from_env()

# Where the file browser OPENS (home by default) — a friendly starting point, not a
# security boundary. Access is bounded by security_config.allowed_roots (the whole
# filesystem unless MESHVAULT_ROOT narrows it).
DEFAULT_ROOT = str(security_config.default_browse_path)

# Register additional MIME types for 3D files
mimetypes.add_type("model/obj", ".obj")
mimetypes.add_type("model/fbx", ".fbx")
mimetypes.add_type("model/mtl", ".mtl")
mimetypes.add_type("model/gltf+json", ".gltf")
mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/stl", ".stl")
mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/vnd.collada+xml", ".dae")
mimetypes.add_type("application/octet-stream", ".ply")
mimetypes.add_type("model/3mf", ".3mf")
mimetypes.add_type("model/vnd.usdz+zip", ".usdz")


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


class ExportModifiedRequest(BaseModel):
    """Request body for exporting a modified model (OBJ text from frontend)."""
    target_dir: str
    new_name: str
    obj_content: str


class BrowseResponse(BaseModel):
    """Response for browse endpoint."""
    current_path: str
    parent_path: Optional[str]
    folders: list[dict]
    assets: list[dict]


# --- App lifecycle ---

archive_inspector = ArchiveInspector()

# PathGuard confines every filesystem operation to the allowed roots. The archive
# extraction base dir is a legitimate server-controlled location, so it is added as
# an allowed root — this lets us serve extracted textures without opening the whole
# system temp directory.
path_guard = PathGuard(
    security_config.allowed_roots + [Path(archive_inspector.base_dir)]
)

# The file browser is confined to the primary root so navigation (parent links)
# cannot walk above the sandbox in the UI. Per-endpoint access is independently
# validated by path_guard (defense in depth).
file_browser = FileBrowser(root_path=str(security_config.allowed_roots[0]))
export_manager = ExportManager()


def _build_file_response(file_path: Path) -> FileResponse:
    """
    Serve files with explicit no-cache headers.

    This prevents stale browser caching when an extracted temp file is repaired
    (e.g., previously 0-byte archive extraction, then re-extracted correctly).
    """
    content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    return FileResponse(
        path=str(file_path),
        media_type=content_type,
        filename=file_path.name,
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle — clean up temp files on shutdown."""
    yield
    archive_inspector.cleanup()


# --- FastAPI App ---

app = FastAPI(
    title="MeshVault",
    description="Local-first 3D asset browser & viewer with archive inspection",
    version="0.1.0",
    lifespan=lifespan,
    # The interactive docs and schema are unauthenticated reconnaissance surface for a
    # local single-user tool; disable them. (Re-enable behind auth if ever needed.)
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# --- Security middleware (order matters: host check first, then auth) ---
# Middleware added later runs first in Starlette, so add auth before host so that
# the Host allow-list is the outermost guard.
app.add_middleware(TokenAuthMiddleware, config=security_config)
app.add_middleware(HostAllowlistMiddleware, allowed_hosts=security_config.allowed_hosts)

# Serve frontend static files
# Works both in development (project root) and when installed via pip
# (frontend/ is installed alongside backend/ in site-packages parent)
_project_root = Path(__file__).parent.parent
frontend_dir = _project_root / "frontend"
if not frontend_dir.exists():
    # Fallback: check if installed as a package (site-packages layout)
    import importlib.resources
    try:
        frontend_dir = Path(importlib.resources.files("frontend"))
    except Exception:
        pass
app.mount(
    "/static",
    StaticFiles(directory=str(frontend_dir)),
    name="static",
)


# --- Routes ---

@app.get("/", response_class=HTMLResponse)
async def root():
    """Serve the main HTML page and issue the session-token cookie."""
    index_path = frontend_dir / "index.html"
    response = HTMLResponse(content=index_path.read_text(encoding="utf-8"))
    # Same-origin fetches and Three.js loader requests will carry this cookie,
    # so the SPA is authenticated without exposing the token to other origins.
    attach_session_cookie(response, security_config)
    return response


@app.get("/api/browse")
def browse(path: Optional[str] = Query(default=None)):
    """
    Browse a directory and return its contents.

    Query params:
        path: Directory path to browse. Defaults to user's home.
    """
    browse_path = path or DEFAULT_ROOT

    # Confine first with a generic error, so we never echo resolved absolute paths
    # (which would disclose host layout and the real root location).
    _guarded_path(browse_path, require_dir=True)

    try:
        result = file_browser.browse(browse_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Directory not found")
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

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
                "mtime": a.mtime,
                "is_in_archive": a.is_in_archive,
                "archive_path": a.archive_path,
                "inner_path": a.inner_path,
                "related_files": a.related_files,
            }
            for a in result.assets
        ],
    }


def _maybe_convert_asset(file_path: Path) -> tuple[Path, str]:
    """
    Check if a file needs conversion before serving.
    Currently handles old FBX (version < 7000) → OBJ.
    """
    ext = file_path.suffix.lower()
    if ext == ".fbx":
        return _maybe_convert_fbx(file_path)
    return file_path, ext


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


def _guarded_path(
    path: str,
    *,
    must_exist: bool = True,
    require_file: bool = False,
    require_dir: bool = False,
) -> Path:
    """
    Resolve a client-supplied path through the PathGuard and map guard errors to
    HTTP responses. Every endpoint that touches the filesystem uses this so the
    trust boundary is enforced in exactly one place.
    """
    try:
        return path_guard.resolve(
            path,
            must_exist=must_exist,
            require_file=require_file,
            require_dir=require_dir,
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/asset/file")
def serve_asset_file(path: str = Query(...)):
    """
    Serve a 3D asset file for the viewer.

    Auto-converts old FBX (version < 7000) → OBJ via the built-in parser.
    The path is confined to the allowed roots.
    """
    file_path = _guarded_path(path, require_file=True)
    # Auto-convert if needed (old fbx→obj)
    serve_path, _ = _maybe_convert_asset(file_path)
    return _build_file_response(serve_path)


@app.get("/api/asset/archive")
def serve_archive_asset(
    archive_path: str = Query(...),
    inner_path: str = Query(...),
):
    """
    Extract and serve a 3D asset from an archive.

    Extracts the asset (and related files) to a temp directory,
    then serves the main asset file.
    """
    # Confine the archive itself to the allowed roots; the extraction target is
    # inside the server-controlled base dir (also an allowed root).
    guarded_archive = _guarded_path(archive_path, require_file=True)
    extracted = archive_inspector.extract_asset(str(guarded_archive), inner_path)
    if extracted is None:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract {inner_path} from {archive_path}",
        )

    file_path = _guarded_path(extracted, require_file=True)
    return _build_file_response(file_path)


@app.get("/api/asset/prepare_archive")
def prepare_archive_asset(
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
    guarded_archive = _guarded_path(archive_path, require_file=True)
    extracted = archive_inspector.extract_asset(str(guarded_archive), inner_path)
    if extracted is None:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract {inner_path} from {archive_path}",
        )

    file_path = _guarded_path(extracted, require_file=True)

    # Auto-convert if needed (old fbx→obj)
    serve_path, actual_ext = _maybe_convert_asset(file_path)

    # Build the file URL for the main asset (points to converted file if applicable)
    stat = serve_path.stat()
    version = f"{stat.st_size}-{stat.st_mtime_ns}"
    file_url = (
        f"/api/asset/file?path={urllib.parse.quote(str(serve_path))}"
        f"&v={version}"
    )

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
def serve_related_file(path: str = Query(...)):
    """
    Serve a related file (texture, material) for the 3D viewer.

    This endpoint allows the Three.js loaders to fetch .mtl files,
    textures, etc., that are referenced by the main 3D asset.
    """
    file_path = _guarded_path(path, require_file=True)
    return _build_file_response(file_path)


@app.post("/api/export")
def export_asset(request: ExportRequest):
    """
    Export a 3D asset to a target directory with a new name.

    Handles both regular files and archived assets.
    """
    # Confine target dir and the source(s); sanitize the new filename component.
    target = _guarded_path(request.target_dir, must_exist=False, require_dir=True)
    try:
        safe_name = PathGuard.sanitize_component(request.new_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # The archive branch is taken by ExportManager ONLY when is_in_archive AND
    # archive_path AND inner_path are all present (export_manager.py). The endpoint's
    # predicate MUST match exactly: if inner_path is missing, the manager falls back to
    # a filesystem copy of source_path + related_files, so those must be guarded. A
    # mismatch here is what allowed the archive-branch bypass (unguarded related_files
    # copied into the sandbox). Guard for the branch that will actually run.
    is_archive_mode = bool(
        request.is_in_archive and request.archive_path and request.inner_path
    )
    if is_archive_mode:
        # Archive source: only the archive file is a filesystem path; inner_path and
        # related_files are members read via the archive reader. Confine the archive.
        source_arg = request.source_path
        archive_arg = str(_guarded_path(request.archive_path, require_file=True))
        related_arg = request.related_files
    else:
        # Filesystem source: EVERY path the export copies from must be confined,
        # including related_files. Otherwise an attacker names arbitrary absolute
        # files as "related" and the copy lands them inside the sandbox, where the
        # read endpoints then serve them back (arbitrary file read). Guard them all.
        source_arg = str(_guarded_path(request.source_path, require_file=True))
        archive_arg = request.archive_path
        related_arg = [
            str(_guarded_path(rf, require_file=True)) for rf in request.related_files
        ]

    result = export_manager.export_asset(
        source_path=source_arg,
        target_dir=str(target),
        new_name=safe_name,
        is_in_archive=request.is_in_archive,
        archive_path=archive_arg,
        inner_path=request.inner_path,
        related_files=related_arg,
    )

    if not result.success:
        raise HTTPException(status_code=500, detail=result.message)

    return {
        "success": result.success,
        "output_path": result.output_path,
        "message": result.message,
        "files_exported": result.files_exported,
    }


@app.post("/api/export_modified")
def export_modified(request: ExportModifiedRequest):
    """
    Export a modified model (OBJ text generated by the frontend).

    This is used when the user has recentered, auto-oriented, or scaled
    the model in the viewer and wants to export the modified version.
    """
    target_dir = _guarded_path(request.target_dir, must_exist=False, require_dir=True)
    try:
        safe_name = PathGuard.sanitize_component(request.new_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    target_dir.mkdir(parents=True, exist_ok=True)

    obj_path = target_dir / f"{safe_name}.obj"
    try:
        obj_path.write_text(request.obj_content, encoding="utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write: {e}")

    return {
        "success": True,
        "output_path": str(target_dir),
        "message": f"Exported modified model as OBJ",
        "files_exported": [str(obj_path)],
    }


@app.post("/api/export_glb")
async def export_glb(
    file: UploadFile = File(...),
    target_dir: str = Form(...),
    file_name: str = Form(...),
):
    """
    Write a GLB (binary glTF) file generated by the frontend to disk.

    The frontend's Three.js GLTFExporter produces the GLB in-browser;
    this endpoint simply saves the binary blob to the user's chosen directory.
    GLB files are self-contained: geometry + PBR materials + textures in one file.
    """
    target_path = _guarded_path(target_dir, must_exist=False, require_dir=True)
    try:
        safe_name = PathGuard.sanitize_component(file_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    target_path.mkdir(parents=True, exist_ok=True)

    if not safe_name.lower().endswith(".glb"):
        safe_name += ".glb"

    output_file = target_path / safe_name

    try:
        content = await file.read()
        output_file.write_bytes(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write GLB: {e}")

    return {
        "success": True,
        "output_path": str(target_path),
        "file_path": str(output_file),
        "file_size": len(content),
        "message": f"Exported GLB: {safe_name}",
    }


class RevealRequest(BaseModel):
    """Request body for revealing a file in the OS file manager."""
    path: str


class RenameRequest(BaseModel):
    """Request body for renaming a file or folder."""
    path: str
    new_name: str


class DeleteRequest(BaseModel):
    """Request body for deleting a file or folder."""
    path: str


class DuplicateRequest(BaseModel):
    """Request body for duplicating a file."""
    path: str


class ScanTexturesRequest(BaseModel):
    """Request body for scanning a folder for texture files."""
    path: str


@app.post("/api/reveal")
def reveal_in_file_manager(request: RevealRequest):
    """
    Open the OS file manager and select/highlight the given file or folder.

    Works on macOS (Finder), Linux (xdg-open), and Windows (Explorer).
    """
    file_path = _guarded_path(request.path)

    try:
        system = platform.system()
        if system == "Darwin":
            # macOS: open Finder and select the file
            subprocess.Popen(["open", "-R", str(file_path)])
        elif system == "Windows":
            # Windows: open Explorer and select the file
            subprocess.Popen(["explorer", "/select,", str(file_path)])
        elif system == "Linux":
            # Linux: open the parent directory (no universal "select file" support)
            parent = str(file_path.parent) if file_path.is_file() else str(file_path)
            subprocess.Popen(["xdg-open", parent])
        else:
            raise HTTPException(status_code=500, detail=f"Unsupported OS: {system}")

        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to reveal: {e}")


@app.post("/api/rename")
def rename_file(request: RenameRequest):
    """
    Rename a file or folder. The new_name is just the filename (not a path).
    The file stays in the same directory.
    """
    file_path = _guarded_path(request.path)

    try:
        new_name = PathGuard.sanitize_component(request.new_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    new_path = file_path.parent / new_name
    if new_path.exists():
        raise HTTPException(status_code=409, detail=f"Already exists: {new_name}")

    try:
        file_path.rename(new_path)
        return {"success": True, "new_path": str(new_path)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rename failed: {e}")


@app.post("/api/delete")
def delete_file(request: DeleteRequest):
    """
    Delete a file or empty folder.
    """
    file_path = _guarded_path(request.path)

    try:
        if file_path.is_file():
            file_path.unlink()
        elif file_path.is_dir():
            import shutil
            shutil.rmtree(str(file_path))
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Delete failed: {e}")


@app.post("/api/duplicate")
def duplicate_file(request: DuplicateRequest):
    """
    Duplicate a file. Creates a copy named <stem>_copy<ext> in the same directory.
    If that name exists, appends _copy2, _copy3, etc.
    """
    import shutil
    file_path = _guarded_path(request.path, require_file=True)

    # Generate a unique copy name
    stem = file_path.stem
    ext = file_path.suffix
    parent = file_path.parent
    new_path = parent / f"{stem}_copy{ext}"
    counter = 2
    while new_path.exists():
        new_path = parent / f"{stem}_copy{counter}{ext}"
        counter += 1

    try:
        shutil.copy2(str(file_path), str(new_path))
        return {"success": True, "new_path": str(new_path)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Duplicate failed: {e}")


@app.post("/api/scan_textures")
def scan_textures(request: ScanTexturesRequest):
    """
    Scan a folder recursively for texture/image files.

    Returns a map of lowercase filename → absolute path for quick lookup.
    The frontend uses this to resolve missing texture references by filename.
    """
    TEXTURE_EXTENSIONS = {
        ".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tiff", ".tif",
        ".dds", ".exr", ".hdr", ".webp", ".gif",
    }

    folder = _guarded_path(request.path, require_dir=True)

    textures = {}
    try:
        for f in folder.rglob("*"):
            if f.is_file() and f.suffix.lower() in TEXTURE_EXTENSIONS:
                # Map by lowercase filename for case-insensitive matching
                key = f.name.lower()
                textures[key] = str(f)
    except PermissionError:
        pass

    return {"folder": str(folder), "count": len(textures), "textures": textures}


@app.get("/api/default_path")
async def get_default_path():
    """Return the default browse path (user home)."""
    return {"path": DEFAULT_ROOT}


def main():
    """Entry point for running the server."""
    port = int(os.environ.get("PORT", 8420))
    host = security_config.bind_host

    print(f"\n  🎨 MeshVault")
    if security_config.confined:
        roots = ", ".join(str(r) for r in security_config.allowed_roots)
        print(f"  📁 File access confined to: {roots}")
    else:
        print(f"  📁 File access: whole filesystem (opens at {DEFAULT_ROOT}).")
        print(f"     Set MESHVAULT_ROOT=/path[:/path2] to restrict.")
    if security_config.is_loopback_bind:
        print(f"  → Open http://localhost:{port} in your browser")
    else:
        # Non-loopback bind is a deliberate, higher-risk choice — make it loud.
        print(f"  ⚠  Binding to {host}:{port} (reachable beyond this machine).")
        print(f"  → Open http://{host}:{port} — other devices must send the token")
        print(f"     via the 'X-MeshVault-Token' or 'Authorization: Bearer' header.")
    if security_config.require_auth:
        print(f"  🔑 Session token: {security_config.token}")
        print(f"     (opening the URL above on this machine authenticates automatically)")
    print()

    uvicorn.run(
        "backend.app:app",
        host=host,
        port=port,
        reload=False,
    )


if __name__ == "__main__":
    main()
