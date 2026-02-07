"""
Tests for the FileBrowser component.

Tests real filesystem operations using temporary directories
with actual 3D file structures.
"""

import os
import zipfile
import tempfile
from pathlib import Path

import pytest

from backend.file_browser import FileBrowser, SUPPORTED_3D_EXTENSIONS


@pytest.fixture
def temp_asset_dir():
    """Create a temporary directory with 3D asset structure for testing."""
    with tempfile.TemporaryDirectory(prefix="3d_test_") as tmpdir:
        # Create subdirectories
        sub1 = Path(tmpdir) / "models"
        sub1.mkdir()
        sub2 = Path(tmpdir) / "textures"
        sub2.mkdir()
        empty = Path(tmpdir) / "empty_folder"
        empty.mkdir()

        # Create .obj files with related .mtl
        obj_file = sub1 / "cube.obj"
        obj_file.write_text("# OBJ file\nv 0 0 0\nv 1 0 0\nv 1 1 0\n")

        mtl_file = sub1 / "cube.mtl"
        mtl_file.write_text("# MTL file\nnewmtl default\n")

        # Create .fbx file (binary placeholder)
        fbx_file = sub1 / "character.fbx"
        fbx_file.write_bytes(b"\x00" * 100)

        # Create a zip archive with a 3D asset inside
        zip_path = Path(tmpdir) / "archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("inner_model/spaceship.obj", "# OBJ\nv 0 0 0\n")
            zf.writestr("inner_model/spaceship.mtl", "# MTL\n")
            zf.writestr("inner_model/spaceship.png", "FAKE_PNG")

        # Create a non-3D file (should be ignored)
        txt_file = Path(tmpdir) / "readme.txt"
        txt_file.write_text("Not a 3D file")

        # Create hidden file (should be ignored)
        hidden = Path(tmpdir) / ".hidden_file"
        hidden.write_text("hidden")

        yield tmpdir


@pytest.fixture
def browser():
    """Create a FileBrowser with no root constraint."""
    return FileBrowser()


class TestFileBrowser:
    """Tests for FileBrowser.browse() method."""

    def test_browse_lists_folders(self, browser, temp_asset_dir):
        """Browsing a directory should list its subdirectories."""
        result = browser.browse(temp_asset_dir)

        folder_names = [f.name for f in result.folders]
        assert "models" in folder_names
        assert "textures" in folder_names
        assert "empty_folder" in folder_names

    def test_browse_excludes_hidden(self, browser, temp_asset_dir):
        """Hidden files and folders should be excluded."""
        result = browser.browse(temp_asset_dir)

        all_names = [f.name for f in result.folders] + [
            a.name for a in result.assets
        ]
        assert ".hidden_file" not in all_names

    def test_browse_finds_3d_assets(self, browser, temp_asset_dir):
        """Browsing should find .obj and .fbx files."""
        models_dir = os.path.join(temp_asset_dir, "models")
        result = browser.browse(models_dir)

        asset_names = [a.name for a in result.assets]
        assert "cube" in asset_names
        assert "character" in asset_names

    def test_browse_detects_related_files(self, browser, temp_asset_dir):
        """OBJ files should have their .mtl detected as related."""
        models_dir = os.path.join(temp_asset_dir, "models")
        result = browser.browse(models_dir)

        cube_asset = next(a for a in result.assets if a.name == "cube")
        related_exts = [
            Path(r).suffix.lower() for r in cube_asset.related_files
        ]
        assert ".mtl" in related_exts

    def test_browse_inspects_zip_archives(self, browser, temp_asset_dir):
        """ZIP archives should be inspected for 3D assets."""
        result = browser.browse(temp_asset_dir)

        archive_assets = [a for a in result.assets if a.is_in_archive]
        assert len(archive_assets) > 0

        spaceship = next(
            (a for a in archive_assets if a.name == "spaceship"), None
        )
        assert spaceship is not None
        assert spaceship.extension == ".obj"
        assert spaceship.archive_path is not None

    def test_browse_returns_parent_path(self, browser, temp_asset_dir):
        """Browse result should include parent path for navigation."""
        models_dir = os.path.join(temp_asset_dir, "models")
        result = browser.browse(models_dir)

        # Use resolved paths for comparison (macOS /var -> /private/var)
        assert result.parent_path == str(Path(temp_asset_dir).resolve())

    def test_browse_sets_current_path(self, browser, temp_asset_dir):
        """Browse result should include the resolved current path."""
        result = browser.browse(temp_asset_dir)
        assert result.current_path == str(Path(temp_asset_dir).resolve())

    def test_browse_nonexistent_raises(self, browser):
        """Browsing a non-existent directory should raise FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            browser.browse("/nonexistent/path/that/doesnt/exist")

    def test_browse_file_raises(self, browser, temp_asset_dir):
        """Browsing a file (not directory) should raise ValueError."""
        file_path = os.path.join(temp_asset_dir, "readme.txt")
        with pytest.raises(ValueError):
            browser.browse(file_path)

    def test_has_children_flag(self, browser, temp_asset_dir):
        """Folders with contents should have has_children=True."""
        result = browser.browse(temp_asset_dir)

        models_folder = next(
            f for f in result.folders if f.name == "models"
        )
        assert models_folder.has_children is True

        empty_folder = next(
            f for f in result.folders if f.name == "empty_folder"
        )
        assert empty_folder.has_children is False


class TestFileBrowserRootConstraint:
    """Tests for FileBrowser with root path constraint."""

    def test_root_prevents_escape(self, temp_asset_dir):
        """Browsing outside root should raise ValueError."""
        browser = FileBrowser(root_path=temp_asset_dir)

        # Browsing within root should work
        result = browser.browse(temp_asset_dir)
        assert result.current_path == str(Path(temp_asset_dir).resolve())

        # Browsing outside root should fail
        with pytest.raises(ValueError):
            browser.browse("/tmp")

    def test_root_limits_parent_navigation(self, temp_asset_dir):
        """Parent path should be None when at root boundary."""
        browser = FileBrowser(root_path=temp_asset_dir)
        result = browser.browse(temp_asset_dir)
        assert result.parent_path is None
