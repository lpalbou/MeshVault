"""
Export manager module - handles renaming and exporting 3D assets.

Responsible for:
- Renaming asset files and their related files
- Exporting assets (with derivatives) to a target location
- Handling export from archives (extract + rename + place)
"""

import os
import shutil
import zipfile
from pathlib import Path
from typing import Optional
from dataclasses import dataclass

try:
    import rarfile
    HAS_RARFILE = True
except ImportError:
    HAS_RARFILE = False


@dataclass
class ExportResult:
    """Result of an export operation."""
    success: bool
    output_path: str
    message: str
    files_exported: list[str]


class ExportManager:
    """Handles exporting and renaming of 3D assets."""

    @staticmethod
    def _is_same_path(a: Path, b: Path) -> bool:
        """
        Return True if both paths refer to the same filesystem location.
        Uses strict=False so the comparison works even before destination exists.
        """
        try:
            return a.resolve(strict=False) == b.resolve(strict=False)
        except Exception:
            return os.path.abspath(str(a)) == os.path.abspath(str(b))

    def export_asset(
        self,
        source_path: str,
        target_dir: str,
        new_name: str,
        is_in_archive: bool = False,
        archive_path: Optional[str] = None,
        inner_path: Optional[str] = None,
        related_files: Optional[list[str]] = None,
    ) -> ExportResult:
        """
        Export a 3D asset to a target directory with a new name.

        If the asset has related files (textures, materials), they are
        exported together in a folder. If it's a single file, it's
        exported as a single file.

        Args:
            source_path: Path to the source asset file.
            target_dir: Directory to export to.
            new_name: New name for the asset (without extension).
            is_in_archive: Whether the asset is inside an archive.
            archive_path: Path to the archive (if applicable).
            inner_path: Path inside the archive (if applicable).
            related_files: List of related file paths.

        Returns:
            ExportResult describing the outcome.
        """
        related_files = related_files or []
        target_path = Path(target_dir)

        # Ensure target directory exists
        target_path.mkdir(parents=True, exist_ok=True)

        try:
            if is_in_archive and archive_path and inner_path:
                return self._export_from_archive(
                    archive_path, inner_path, target_path, new_name, related_files
                )
            else:
                return self._export_from_filesystem(
                    source_path, target_path, new_name, related_files
                )
        except Exception as e:
            return ExportResult(
                success=False,
                output_path=str(target_path),
                message=f"Export failed: {str(e)}",
                files_exported=[],
            )

    def _export_from_filesystem(
        self,
        source_path: str,
        target_dir: Path,
        new_name: str,
        related_files: list[str],
    ) -> ExportResult:
        """Export an asset from the filesystem."""
        src = Path(source_path)
        ext = src.suffix

        exported = []

        if related_files:
            # Multiple files => create a subfolder
            asset_dir = target_dir / new_name
            asset_dir.mkdir(parents=True, exist_ok=True)

            # Copy main asset
            dest = asset_dir / f"{new_name}{ext}"
            if not self._is_same_path(src, dest):
                shutil.copy2(str(src), str(dest))
            exported.append(str(dest))

            # Copy related files, preserving their extensions
            for rel_path in related_files:
                rel_src = Path(rel_path)
                rel_dest = asset_dir / f"{new_name}{rel_src.suffix}"
                # If multiple related files share an extension, use original name
                if rel_dest.exists():
                    rel_dest = asset_dir / rel_src.name
                if not self._is_same_path(rel_src, rel_dest):
                    shutil.copy2(str(rel_src), str(rel_dest))
                exported.append(str(rel_dest))
        else:
            # Single file => just copy with new name
            dest = target_dir / f"{new_name}{ext}"
            if not self._is_same_path(src, dest):
                shutil.copy2(str(src), str(dest))
            exported.append(str(dest))

        return ExportResult(
            success=True,
            output_path=str(target_dir),
            message=f"Exported {len(exported)} file(s) successfully",
            files_exported=exported,
        )

    def _export_from_archive(
        self,
        archive_path: str,
        inner_path: str,
        target_dir: Path,
        new_name: str,
        related_files: list[str],
    ) -> ExportResult:
        """Export an asset from inside an archive."""
        archive = Path(archive_path)
        ext_lower = archive.suffix.lower()

        # Determine the extension of the 3D asset
        asset_ext = Path(inner_path).suffix

        exported = []

        # Collect all paths to extract
        paths_to_extract = [inner_path] + related_files

        if len(paths_to_extract) > 1:
            # Multiple files => create subfolder
            asset_dir = target_dir / new_name
            asset_dir.mkdir(parents=True, exist_ok=True)
            out_dir = asset_dir
        else:
            out_dir = target_dir

        if ext_lower == ".zip":
            exported = self._extract_and_rename_zip(
                archive_path, paths_to_extract, out_dir, new_name, asset_ext
            )
        elif ext_lower == ".rar" and HAS_RARFILE:
            exported = self._extract_and_rename_rar(
                archive_path, paths_to_extract, out_dir, new_name, asset_ext
            )
        else:
            return ExportResult(
                success=False,
                output_path=str(target_dir),
                message=f"Unsupported archive format: {ext_lower}",
                files_exported=[],
            )

        return ExportResult(
            success=True,
            output_path=str(out_dir),
            message=f"Exported {len(exported)} file(s) from archive",
            files_exported=exported,
        )

    def _extract_and_rename_zip(
        self,
        archive_path: str,
        paths: list[str],
        out_dir: Path,
        new_name: str,
        main_ext: str,
    ) -> list[str]:
        """Extract files from a ZIP and rename the main asset."""
        exported = []
        with zipfile.ZipFile(archive_path, "r") as zf:
            for i, inner in enumerate(paths):
                data = zf.read(inner)
                inner_ext = Path(inner).suffix
                if i == 0:
                    # Main asset gets the new name
                    dest = out_dir / f"{new_name}{main_ext}"
                else:
                    # Related files keep original names unless single export
                    if len(paths) > 1:
                        dest = out_dir / Path(inner).name
                    else:
                        dest = out_dir / f"{new_name}{inner_ext}"
                dest.write_bytes(data)
                exported.append(str(dest))
        return exported

    def _extract_and_rename_rar(
        self,
        archive_path: str,
        paths: list[str],
        out_dir: Path,
        new_name: str,
        main_ext: str,
    ) -> list[str]:
        """Extract files from a RAR and rename the main asset."""
        if not HAS_RARFILE:
            return []
        exported = []
        with rarfile.RarFile(archive_path, "r") as rf:
            for i, inner in enumerate(paths):
                data = rf.read(inner)
                inner_ext = Path(inner).suffix
                if i == 0:
                    dest = out_dir / f"{new_name}{main_ext}"
                else:
                    if len(paths) > 1:
                        dest = out_dir / Path(inner).name
                    else:
                        dest = out_dir / f"{new_name}{inner_ext}"
                dest.write_bytes(data)
                exported.append(str(dest))
        return exported
