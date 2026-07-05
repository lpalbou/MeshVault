"""
Thumbnail cache — persistent on-disk store for rendered asset previews.

Rendering strategy (decided in backlog 014): the browser already owns a complete,
correct Three.js pipeline, so thumbnails are rendered client-side into an offscreen
canvas and uploaded here. The server's job is purely to persist and serve them so a
second visit to a folder is instant and does not re-render. This avoids shipping a
headless GPU/software-GL renderer in the Python process while still giving a real
rendered preview (not a format icon).

Cache key: a hash of (absolute asset path + size + mtime). Any edit to the asset
changes mtime/size, which changes the key, so a stale thumbnail is never served —
the old entry simply becomes unreachable and is reclaimed by capacity eviction.
"""

import hashlib
import os
import time
from pathlib import Path
from typing import Optional


class ThumbnailCache:
    """LRU-ish on-disk PNG cache keyed by asset identity (path+size+mtime)."""

    def __init__(self, cache_dir: str, max_entries: int = 5000):
        self._dir = Path(cache_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._max_entries = max_entries

    @staticmethod
    def _stat_signature(asset_path: Path) -> Optional[tuple[int, int]]:
        """Return (size, mtime_ns) or None if the asset is unreadable."""
        try:
            st = asset_path.stat()
            return st.st_size, st.st_mtime_ns
        except OSError:
            return None

    def key_for(self, asset_path: Path, *, archive_sig: Optional[str] = None) -> Optional[str]:
        """
        Compute the cache key for an asset.

        For a filesystem asset the key binds to its size+mtime. For an in-archive
        asset the caller passes an `archive_sig` (e.g. "<archive_path>!<inner>@<mtime>")
        because the inner file has no independent stat.
        """
        if archive_sig is not None:
            raw = archive_sig
        else:
            sig = self._stat_signature(asset_path)
            if sig is None:
                return None
            raw = f"{asset_path.resolve()}|{sig[0]}|{sig[1]}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _path_for_key(self, key: str) -> Path:
        return self._dir / f"{key}.png"

    def get(self, key: str) -> Optional[Path]:
        """Return the cached PNG path if present, refreshing its access time."""
        p = self._path_for_key(key)
        if p.exists():
            try:
                os.utime(p, None)  # bump atime/mtime for LRU eviction ordering
            except OSError:
                pass
            return p
        return None

    def put(self, key: str, png_bytes: bytes) -> Path:
        """Store PNG bytes under key and enforce the capacity limit."""
        p = self._path_for_key(key)
        p.write_bytes(png_bytes)
        self._evict_if_needed()
        return p

    def _evict_if_needed(self) -> None:
        """Evict least-recently-used entries when over capacity."""
        try:
            entries = list(self._dir.glob("*.png"))
        except OSError:
            return
        if len(entries) <= self._max_entries:
            return
        entries.sort(key=lambda f: f.stat().st_mtime)  # oldest first
        for f in entries[: len(entries) - self._max_entries]:
            try:
                f.unlink()
            except OSError:
                pass

    def clear(self) -> int:
        removed = 0
        for f in self._dir.glob("*.png"):
            try:
                f.unlink()
                removed += 1
            except OSError:
                pass
        return removed
