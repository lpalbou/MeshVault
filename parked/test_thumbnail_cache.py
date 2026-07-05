"""Tests for the thumbnail cache: identity keying, invalidation, eviction."""

import time
from pathlib import Path

import pytest

from backend.thumbnail_cache import ThumbnailCache


@pytest.fixture()
def cache(tmp_path):
    return ThumbnailCache(cache_dir=str(tmp_path / "thumbs"), max_entries=3)


def _asset(tmp_path, name="m.glb", data=b"model"):
    p = tmp_path / name
    p.write_bytes(data)
    return p


def test_put_get_roundtrip(cache, tmp_path):
    asset = _asset(tmp_path)
    key = cache.key_for(asset)
    assert cache.get(key) is None
    cache.put(key, b"\x89PNG-fake")
    got = cache.get(key)
    assert got is not None and got.read_bytes() == b"\x89PNG-fake"


def test_key_changes_on_content_change(cache, tmp_path):
    asset = _asset(tmp_path, data=b"v1")
    k1 = cache.key_for(asset)
    time.sleep(0.01)
    asset.write_bytes(b"v2-longer")  # size + mtime change
    k2 = cache.key_for(asset)
    assert k1 != k2  # stale thumbnail is unreachable after edit


def test_missing_asset_key_is_none(cache, tmp_path):
    assert cache.key_for(tmp_path / "does_not_exist.glb") is None


def test_archive_sig_keying(cache, tmp_path):
    asset = _asset(tmp_path, name="pack.zip")
    k = cache.key_for(asset, archive_sig=f"{asset}!inner/model.glb@123")
    assert isinstance(k, str) and len(k) == 64


def test_eviction_respects_capacity(cache, tmp_path):
    for i in range(5):
        cache.put(f"{'a'*63}{i}", b"data")
        time.sleep(0.01)
    remaining = list((tmp_path / "thumbs").glob("*.png"))
    assert len(remaining) <= 3
