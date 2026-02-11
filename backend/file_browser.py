"""
File browser module - handles filesystem navigation and 3D asset discovery.

Responsible for:
- Listing directory contents (folders + 3D assets)
- Identifying supported 3D file formats
- Delegating archive inspection to archive_inspector
"""

import os
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

from backend.archive_inspector import ArchiveInspector


# Supported 3D asset extensions
SUPPORTED_3D_EXTENSIONS = {".obj", ".fbx", ".gltf", ".glb", ".stl"}

# Supported archive extensions
SUPPORTED_ARCHIVE_EXTENSIONS = {".zip", ".rar", ".unitypackage"}


@dataclass
class AssetInfo:
    """Represents a discovered 3D asset."""
    name: str
    path: str  # Full path to the file or archive
    extension: str
    size: int  # File size in bytes
    is_in_archive: bool = False
    archive_path: Optional[str] = None  # Path to the archive if asset is inside one
    inner_path: Optional[str] = None  # Path inside the archive
    # Related files (e.g., .mtl for .obj)
    related_files: list[str] = field(default_factory=list)


@dataclass
class FolderInfo:
    """Represents a folder in the file browser."""
    name: str
    path: str
    has_children: bool = False


@dataclass
class BrowseResult:
    """Result of browsing a directory."""
    current_path: str
    parent_path: Optional[str]
    folders: list[FolderInfo]
    assets: list[AssetInfo]


class FileBrowser:
    """Handles filesystem navigation and 3D asset discovery."""

    def __init__(self, root_path: Optional[str] = None):
        """
        Initialize the file browser.

        Args:
            root_path: Optional root constraint. If set, browsing is limited
                       to this directory and its descendants.
        """
        self._root_path = Path(root_path).resolve() if root_path else None
        self._archive_inspector = ArchiveInspector()

    @property
    def root_path(self) -> Optional[Path]:
        return self._root_path

    def browse(self, directory: str) -> BrowseResult:
        """
        Browse a directory and return its contents.

        Lists all subdirectories and discovers 3D assets including
        those inside archives.

        Args:
            directory: Path to the directory to browse.

        Returns:
            BrowseResult with folders and discovered assets.

        Raises:
            ValueError: If directory is outside the root path.
            FileNotFoundError: If directory doesn't exist.
        """
        dir_path = Path(directory).resolve()

        # Security: ensure we stay within root if one is set
        if self._root_path and not self._is_within_root(dir_path):
            raise ValueError(
                f"Access denied: {dir_path} is outside root {self._root_path}"
            )

        if not dir_path.exists():
            raise FileNotFoundError(f"Directory not found: {dir_path}")

        if not dir_path.is_dir():
            raise ValueError(f"Not a directory: {dir_path}")

        folders = []
        assets = []

        try:
            entries = sorted(dir_path.iterdir(), key=lambda e: e.name.lower())
        except PermissionError:
            return BrowseResult(
                current_path=str(dir_path),
                parent_path=self._get_parent_path(dir_path),
                folders=[],
                assets=[],
            )

        for entry in entries:
            try:
                # Skip hidden files/folders
                if entry.name.startswith("."):
                    continue

                if entry.is_dir():
                    has_children = self._has_visible_children(entry)
                    folders.append(FolderInfo(
                        name=entry.name,
                        path=str(entry),
                        has_children=has_children,
                    ))

                elif entry.is_file():
                    ext = entry.suffix.lower()

                    # Direct 3D asset
                    if ext in SUPPORTED_3D_EXTENSIONS:
                        related = self._find_related_files(entry)
                        assets.append(AssetInfo(
                            name=entry.stem,
                            path=str(entry),
                            extension=ext,
                            size=entry.stat().st_size,
                            related_files=related,
                        ))

                    # Archive that might contain 3D assets
                    elif ext in SUPPORTED_ARCHIVE_EXTENSIONS:
                        archive_assets = self._archive_inspector.inspect(
                            str(entry)
                        )
                        assets.extend(archive_assets)

            except (PermissionError, OSError):
                # Skip files we can't access
                continue

        return BrowseResult(
            current_path=str(dir_path),
            parent_path=self._get_parent_path(dir_path),
            folders=folders,
            assets=assets,
        )

    def _is_within_root(self, path: Path) -> bool:
        """Check if a path is within the root directory."""
        if self._root_path is None:
            return True
        try:
            path.relative_to(self._root_path)
            return True
        except ValueError:
            return False

    def _get_parent_path(self, dir_path: Path) -> Optional[str]:
        """Get parent path, respecting root boundary."""
        parent = dir_path.parent
        if parent == dir_path:
            # We're at filesystem root
            return None
        if self._root_path and not self._is_within_root(parent):
            return None
        return str(parent)

    def _has_visible_children(self, dir_path: Path) -> bool:
        """Check if a directory has any visible children (non-hidden)."""
        try:
            for entry in dir_path.iterdir():
                if not entry.name.startswith("."):
                    return True
        except PermissionError:
            pass
        return False

    def _find_related_files(self, asset_path: Path) -> list[str]:
        """
        Find related files for a 3D asset (e.g., .mtl for .obj).

        Looks for files with the same stem in the same directory
        that are commonly associated with the asset type.
        """
        related = []
        parent = asset_path.parent
        stem = asset_path.stem
        ext = asset_path.suffix.lower()

        # Related file patterns by asset type
        related_extensions = {
            ".obj": [".mtl"],
            ".fbx": [],
        }

        # Check for known related extensions
        for rel_ext in related_extensions.get(ext, []):
            candidate = parent / f"{stem}{rel_ext}"
            if candidate.exists():
                related.append(str(candidate))

        # Also check for texture files with same stem
        texture_extensions = [".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tiff"]
        for tex_ext in texture_extensions:
            candidate = parent / f"{stem}{tex_ext}"
            if candidate.exists():
                related.append(str(candidate))

        return related
