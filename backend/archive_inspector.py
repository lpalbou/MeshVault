"""
Archive inspector module - discovers 3D assets inside ZIP and RAR archives.

Responsible for:
- Inspecting archive contents without full extraction
- Identifying 3D assets and their related files within archives
- Extracting specific files from archives for viewing
- Fallback extraction via subprocess (bsdtar, unrar, 7z, unar)
"""

import os
import logging
import zipfile
import tempfile
import shutil
import subprocess
from pathlib import Path, PurePosixPath
from typing import Optional

try:
    import rarfile
    HAS_RARFILE = True
except ImportError:
    HAS_RARFILE = False

from dataclasses import dataclass, field


logger = logging.getLogger(__name__)

# Supported 3D extensions (duplicated here to avoid circular imports)
SUPPORTED_3D_EXTENSIONS = {".obj", ".fbx", ".gltf", ".glb"}

# Texture and related file extensions
RELATED_EXTENSIONS = {".mtl", ".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tiff"}


@dataclass
class AssetInfo:
    """Represents a discovered 3D asset (mirrors file_browser.AssetInfo)."""
    name: str
    path: str
    extension: str
    size: int
    is_in_archive: bool = False
    archive_path: Optional[str] = None
    inner_path: Optional[str] = None
    related_files: list[str] = field(default_factory=list)


class ArchiveInspector:
    """Discovers 3D assets inside archives and extracts them for viewing."""

    def __init__(self):
        # Cache of temporary extraction directories: archive_path -> temp_dir
        self._temp_dirs: dict[str, str] = {}
        # Discovered CLI extraction tool for RAR (cached after first lookup)
        self._rar_tool: Optional[list[str]] = None
        self._rar_tool_searched = False

    def inspect(self, archive_path: str) -> list[AssetInfo]:
        """
        Inspect an archive and return a list of 3D assets found inside.

        Args:
            archive_path: Path to the archive file.

        Returns:
            List of AssetInfo for each 3D asset found.
        """
        path = Path(archive_path)
        ext = path.suffix.lower()

        if ext == ".zip":
            return self._inspect_zip(archive_path)
        elif ext == ".rar":
            return self._inspect_rar(archive_path)
        return []

    def extract_asset(
        self, archive_path: str, inner_path: str
    ) -> Optional[str]:
        """
        Extract a specific asset (and its related files) from an archive.

        Returns the path to the extracted file in a temporary directory.
        Tries multiple extraction methods for maximum compatibility.

        Args:
            archive_path: Path to the archive.
            inner_path: Path of the asset inside the archive.

        Returns:
            Path to the extracted file, or None if extraction fails.
        """
        path = Path(archive_path)
        ext = path.suffix.lower()

        if ext == ".zip":
            return self._extract_from_zip(archive_path, inner_path)
        elif ext == ".rar":
            return self._extract_from_rar(archive_path, inner_path)
        return None

    def get_extracted_related_paths(
        self, archive_path: str, inner_related_files: list[str]
    ) -> list[str]:
        """
        Return absolute temp paths for related files that were extracted
        alongside the main asset.

        This maps archive-internal paths to their extracted filesystem paths.

        Args:
            archive_path: Path to the archive.
            inner_related_files: List of archive-internal paths for related files.

        Returns:
            List of absolute filesystem paths to the extracted related files.
            Only includes paths that actually exist on disk.
        """
        temp_dir = self._temp_dirs.get(archive_path)
        if not temp_dir:
            return []

        resolved = []
        for inner in inner_related_files:
            full = os.path.join(temp_dir, inner)
            if os.path.exists(full):
                resolved.append(full)
        return resolved

    def cleanup(self):
        """Remove all temporary extraction directories."""
        for temp_dir in self._temp_dirs.values():
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception:
                pass
        self._temp_dirs.clear()

    # ==========================================================
    # Inspection (list contents without extraction)
    # ==========================================================

    def _inspect_zip(self, archive_path: str) -> list[AssetInfo]:
        """Inspect a ZIP archive for 3D assets."""
        assets = []
        try:
            with zipfile.ZipFile(archive_path, "r") as zf:
                all_names = zf.namelist()
                for name in all_names:
                    inner_path = PurePosixPath(name)
                    ext = inner_path.suffix.lower()
                    if ext in SUPPORTED_3D_EXTENSIONS:
                        related = self._find_related_in_list(name, all_names)
                        info = zf.getinfo(name)
                        assets.append(AssetInfo(
                            name=inner_path.stem,
                            path=archive_path,
                            extension=ext,
                            size=info.file_size,
                            is_in_archive=True,
                            archive_path=archive_path,
                            inner_path=name,
                            related_files=related,
                        ))
        except (zipfile.BadZipFile, Exception) as e:
            logger.warning(f"Failed to inspect ZIP {archive_path}: {e}")
        return assets

    def _inspect_rar(self, archive_path: str) -> list[AssetInfo]:
        """
        Inspect a RAR archive for 3D assets.

        Uses rarfile (Python) for header parsing if available,
        falls back to subprocess tools for listing.
        """
        # Try rarfile first (can parse headers without unrar for listing)
        if HAS_RARFILE:
            try:
                return self._inspect_rar_with_rarfile(archive_path)
            except Exception as e:
                logger.debug(f"rarfile inspect failed, trying CLI: {e}")

        # Fallback: use CLI tool to list contents
        return self._inspect_rar_with_cli(archive_path)

    def _inspect_rar_with_rarfile(self, archive_path: str) -> list[AssetInfo]:
        """Inspect RAR using the rarfile Python module."""
        assets = []
        with rarfile.RarFile(archive_path, "r") as rf:
            all_names = rf.namelist()
            for name in all_names:
                inner_path = PurePosixPath(name)
                ext = inner_path.suffix.lower()
                if ext in SUPPORTED_3D_EXTENSIONS:
                    related = self._find_related_in_list(name, all_names)
                    info = rf.getinfo(name)
                    assets.append(AssetInfo(
                        name=inner_path.stem,
                        path=archive_path,
                        extension=ext,
                        size=info.file_size,
                        is_in_archive=True,
                        archive_path=archive_path,
                        inner_path=name,
                        related_files=related,
                    ))
        return assets

    def _inspect_rar_with_cli(self, archive_path: str) -> list[AssetInfo]:
        """
        Inspect RAR using CLI tools (bsdtar, unrar, 7z).
        Falls back through available tools to list archive contents.
        """
        tool = self._find_rar_tool()
        if not tool:
            logger.warning("No RAR extraction tool found")
            return []

        try:
            # Use bsdtar to list (most commonly available on macOS)
            tool_name = os.path.basename(tool[0])
            if tool_name == "bsdtar":
                result = subprocess.run(
                    [*tool, "-tf", archive_path],
                    capture_output=True, text=True, timeout=30
                )
            elif tool_name in ("unrar",):
                result = subprocess.run(
                    [*tool, "lb", archive_path],
                    capture_output=True, text=True, timeout=30
                )
            elif tool_name in ("7z", "7za"):
                result = subprocess.run(
                    [*tool, "l", "-ba", archive_path],
                    capture_output=True, text=True, timeout=30
                )
            elif tool_name == "unar":
                result = subprocess.run(
                    [*tool, "-l", archive_path],
                    capture_output=True, text=True, timeout=30
                )
            else:
                return []

            if result.returncode != 0:
                return []

            # Parse file list from output
            all_names = [
                line.strip() for line in result.stdout.strip().split("\n")
                if line.strip() and not line.strip().endswith("/")
            ]

            assets = []
            for name in all_names:
                inner_path = PurePosixPath(name)
                ext = inner_path.suffix.lower()
                if ext in SUPPORTED_3D_EXTENSIONS:
                    related = self._find_related_in_list(name, all_names)
                    assets.append(AssetInfo(
                        name=inner_path.stem,
                        path=archive_path,
                        extension=ext,
                        size=0,  # Unknown without header parsing
                        is_in_archive=True,
                        archive_path=archive_path,
                        inner_path=name,
                        related_files=related,
                    ))
            return assets
        except Exception as e:
            logger.warning(f"CLI RAR inspection failed: {e}")
            return []

    # ==========================================================
    # Extraction
    # ==========================================================

    def _extract_from_zip(
        self, archive_path: str, inner_path: str
    ) -> Optional[str]:
        """Extract an asset and related files from a ZIP archive."""
        try:
            temp_dir = self._get_temp_dir(archive_path)

            with zipfile.ZipFile(archive_path, "r") as zf:
                # Extract the main asset
                zf.extract(inner_path, temp_dir)

                # Also extract related files
                all_names = zf.namelist()
                related = self._find_related_in_list(inner_path, all_names)
                for rel in related:
                    try:
                        zf.extract(rel, temp_dir)
                    except Exception:
                        pass

            return os.path.join(temp_dir, inner_path)
        except Exception as e:
            logger.error(f"ZIP extraction failed for {inner_path}: {e}")
            return None

    def _extract_from_rar(
        self, archive_path: str, inner_path: str
    ) -> Optional[str]:
        """
        Extract an asset and related files from a RAR archive.

        Tries multiple methods in order:
        1. rarfile Python library (requires unrar CLI)
        2. Subprocess with bsdtar (common on macOS)
        3. Subprocess with unrar, 7z, or unar
        """
        temp_dir = self._get_temp_dir(archive_path)
        target_path = os.path.join(temp_dir, inner_path)

        # If already extracted (e.g., from a previous full extraction), reuse it
        if os.path.exists(target_path):
            return target_path

        # Strategy 1: Try rarfile Python library
        if HAS_RARFILE:
            try:
                with rarfile.RarFile(archive_path, "r") as rf:
                    rf.extract(inner_path, temp_dir)

                    # Also extract related files
                    all_names = rf.namelist()
                    related = self._find_related_in_list(
                        inner_path, all_names
                    )
                    for rel in related:
                        try:
                            rf.extract(rel, temp_dir)
                        except Exception:
                            pass

                if os.path.exists(target_path):
                    return target_path
            except Exception as e:
                logger.debug(
                    f"rarfile extraction failed, trying CLI fallback: {e}"
                )

        # Strategy 2: Full extraction via CLI tool (most reliable)
        extracted = self._extract_rar_with_cli(archive_path, temp_dir)
        if extracted and os.path.exists(target_path):
            return target_path

        logger.error(
            f"All RAR extraction methods failed for {inner_path} "
            f"in {archive_path}"
        )
        return None

    def _extract_rar_with_cli(
        self, archive_path: str, temp_dir: str
    ) -> bool:
        """
        Extract entire RAR archive to temp_dir using an available CLI tool.

        Tries tools in order: bsdtar, unrar, 7z, unar.
        Extracts the full archive (simpler and avoids path quoting issues).

        Returns True if extraction succeeded.
        """
        tool = self._find_rar_tool()
        if not tool:
            logger.error(
                "No RAR extraction tool available. "
                "Install one of: unrar, bsdtar, 7z, unar"
            )
            return False

        tool_name = os.path.basename(tool[0])
        try:
            if tool_name == "bsdtar":
                result = subprocess.run(
                    [*tool, "-xf", archive_path, "-C", temp_dir],
                    capture_output=True, text=True, timeout=120,
                )
            elif tool_name == "unrar":
                result = subprocess.run(
                    [*tool, "x", "-y", "-o+", archive_path, temp_dir + "/"],
                    capture_output=True, text=True, timeout=120,
                )
            elif tool_name in ("7z", "7za"):
                result = subprocess.run(
                    [*tool, "x", f"-o{temp_dir}", "-y", archive_path],
                    capture_output=True, text=True, timeout=120,
                )
            elif tool_name == "unar":
                result = subprocess.run(
                    [*tool, "-o", temp_dir, "-f", archive_path],
                    capture_output=True, text=True, timeout=120,
                )
            else:
                return False

            if result.returncode != 0:
                logger.warning(
                    f"{tool_name} extraction failed (exit {result.returncode}): "
                    f"{result.stderr[:300]}"
                )
                return False

            logger.info(f"RAR extracted via {tool_name}: {archive_path}")
            return True

        except subprocess.TimeoutExpired:
            logger.error(f"{tool_name} extraction timed out: {archive_path}")
            return False
        except Exception as e:
            logger.error(f"{tool_name} extraction error: {e}")
            return False

    def _find_rar_tool(self) -> Optional[list[str]]:
        """
        Find an available CLI tool that can extract RAR archives.

        Searches for: bsdtar, unrar, 7z, 7za, unar.
        Caches the result after first search.

        Returns a list of command parts (e.g., ["/opt/anaconda3/bin/bsdtar"])
        or None if no tool is found.
        """
        if self._rar_tool_searched:
            return self._rar_tool

        self._rar_tool_searched = True

        # Tools to try, in order of preference
        # bsdtar is first because it's commonly available on macOS via Xcode/anaconda
        candidates = ["bsdtar", "unrar", "7z", "7za", "unar"]

        for tool_name in candidates:
            tool_path = shutil.which(tool_name)
            if tool_path:
                logger.info(f"Found RAR tool: {tool_path}")
                self._rar_tool = [tool_path]
                return self._rar_tool

        # Also check common non-PATH locations (macOS anaconda, homebrew)
        extra_paths = [
            "/opt/anaconda3/bin/bsdtar",
            "/usr/local/bin/unrar",
            "/opt/homebrew/bin/unrar",
            "/usr/local/bin/7z",
            "/opt/homebrew/bin/7z",
            "/usr/local/bin/unar",
            "/opt/homebrew/bin/unar",
        ]
        for path in extra_paths:
            if os.path.isfile(path) and os.access(path, os.X_OK):
                logger.info(f"Found RAR tool at extra path: {path}")
                self._rar_tool = [path]
                return self._rar_tool

        logger.warning("No RAR extraction tool found on this system")
        self._rar_tool = None
        return None

    # ==========================================================
    # Utilities
    # ==========================================================

    def _get_temp_dir(self, archive_path: str) -> str:
        """Get or create a temporary directory for an archive."""
        if archive_path not in self._temp_dirs:
            self._temp_dirs[archive_path] = tempfile.mkdtemp(
                prefix="3d_browser_"
            )
        return self._temp_dirs[archive_path]

    def _find_related_in_list(
        self, asset_name: str, all_names: list[str]
    ) -> list[str]:
        """
        Find related files for a 3D asset within an archive's file list.

        Looks for files with the same stem in the same directory inside
        the archive, as well as common texture directories.
        """
        asset_path = PurePosixPath(asset_name)
        asset_stem = asset_path.stem.lower()
        asset_dir = str(asset_path.parent)

        related = []
        for name in all_names:
            if name == asset_name:
                continue
            name_path = PurePosixPath(name)
            name_ext = name_path.suffix.lower()

            # Check if it's a known related extension
            if name_ext not in RELATED_EXTENSIONS:
                continue

            # Same directory + same stem or texture file
            name_dir = str(name_path.parent)
            if name_dir == asset_dir:
                related.append(name)

        return related
