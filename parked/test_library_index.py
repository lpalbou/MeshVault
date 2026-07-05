"""
Tests for the library index: incremental reindex, search filters, tags, collections.

These validate the general behavior (not specific fixtures): search must match by
substring across folders, filters must AND correctly, and curation (tags/collections)
must persist independently of the file walk.
"""

from pathlib import Path

import pytest

from backend.library_index import LibraryIndex


@pytest.fixture()
def index(tmp_path):
    root = tmp_path / "assets"
    (root / "vehicles").mkdir(parents=True)
    (root / "props").mkdir(parents=True)
    (root / "vehicles" / "spaceship.glb").write_bytes(b"x" * 100)
    (root / "vehicles" / "rover.obj").write_text("o rover\n")
    (root / "props" / "crate.stl").write_bytes(b"y" * 50)
    (root / "props" / "notes.txt").write_text("ignore me")  # not a 3D asset
    idx = LibraryIndex(db_path=str(tmp_path / "lib.db"), roots=[root])
    idx.reindex()
    return idx, root


def test_indexes_only_supported_assets(index):
    idx, _ = index
    assert idx.count() == 3  # glb, obj, stl — not the .txt


def test_search_matches_across_folders(index):
    idx, _ = index
    names = {h.name for h in idx.search(query="r")}  # rover, spaceship(no), crate(no)
    assert "rover" in names


def test_search_ext_filter(index):
    idx, _ = index
    hits = idx.search(exts=["glb"])
    assert len(hits) == 1 and hits[0].ext == ".glb"


def test_search_size_filter(index):
    idx, _ = index
    hits = idx.search(min_size=80)
    assert {h.ext for h in hits} == {".glb"}


def test_incremental_reindex_is_stable(index):
    idx, root = index
    stats = idx.reindex()
    assert stats["added"] == 0 and stats["updated"] == 0

    (root / "vehicles" / "new_car.fbx").write_bytes(b"z" * 10)
    stats2 = idx.reindex()
    assert stats2["added"] == 1


def test_reindex_prunes_deleted(index):
    idx, root = index
    (root / "props" / "crate.stl").unlink()
    idx.reindex()
    assert idx.count() == 2


def test_tags_roundtrip(index):
    idx, root = index
    p = str(root / "vehicles" / "rover.obj")
    idx.add_tag(p, "Hero")  # normalized to lowercase
    assert idx.tags_for(p) == ["hero"]
    hits = idx.search(tag="hero")
    assert len(hits) == 1 and hits[0].name == "rover"
    idx.remove_tag(p, "hero")
    assert idx.tags_for(p) == []


def test_collections_roundtrip(index):
    idx, root = index
    p = str(root / "props" / "crate.stl")
    cid = idx.create_collection("Favorites")
    idx.add_to_collection(cid, p)
    assert idx.collection_paths(cid) == [p]
    cols = {c["name"]: c["count"] for c in idx.list_collections()}
    assert cols["Favorites"] == 1
    idx.remove_from_collection(cid, p)
    assert idx.collection_paths(cid) == []


def test_like_wildcards_are_escaped(index):
    """A query containing % must not act as a wildcard."""
    idx, _ = index
    assert idx.search(query="%") == []


def test_truncated_reindex_does_not_prune(tmp_path):
    """
    Regression: when the walk hits max_files it is truncated, so `seen` is
    incomplete. Pruning in that case would wrongly delete valid rows — it must be
    skipped, leaving previously-indexed rows intact.
    """
    root = tmp_path / "big"
    root.mkdir()
    for i in range(5):
        (root / f"m{i}.glb").write_bytes(b"x" * (10 + i))
    idx = LibraryIndex(db_path=str(tmp_path / "lib.db"), roots=[root])
    idx.reindex()
    assert idx.count() == 5

    # Force truncation at 2 files. Pruning must NOT run, so the count stays 5.
    stats = idx.reindex(max_files=2)
    assert stats["truncated"] is True
    assert stats.get("pruned", 0) == 0
    assert idx.count() == 5
