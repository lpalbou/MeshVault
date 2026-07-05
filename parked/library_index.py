"""
Library index — a local SQLite catalog of 3D assets for cross-folder search,
tagging, and collections.

Why SQLite: the per-folder browse endpoint answers "what is in this directory",
but a library at scale needs "where, anywhere under my roots, is the asset named X"
and "which assets did I tag as 'hero_prop'". Those are set/aggregate queries over
potentially tens of thousands of files, which a filesystem walk per keystroke cannot
serve. A single embedded SQLite file gives durable, indexed, transactional answers
with zero external services — appropriate for a local-first tool.

Design notes:
- The index is authoritative only about *metadata* (path, name, ext, size, mtime).
  The filesystem remains the source of truth; a stale row is treated as a cache miss
  and reconciled on the next reindex.
- Indexing is incremental (skip unchanged mtimes) and bounded, so re-scans are cheap.
- Tags and collections reference assets by absolute path. When an asset is removed
  from the filesystem, its index row is pruned on reindex but tag rows are preserved
  until explicitly cleared, so a temporarily-offline drive does not lose curation.
"""

import os
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from backend.file_browser import SUPPORTED_3D_EXTENSIONS


@dataclass
class SearchHit:
    """One search result row."""
    path: str
    name: str
    ext: str
    size: int
    mtime: float
    is_in_archive: bool
    archive_path: Optional[str]
    inner_path: Optional[str]
    tags: list[str]


class LibraryIndex:
    """
    SQLite-backed catalog of 3D assets under a set of roots.

    Thread-safe via a per-call connection (SQLite connections are not shareable
    across threads). Writes are serialized with a lock to avoid 'database is locked'
    under the reindex thread + request threads.
    """

    def __init__(self, db_path: str, roots: list[Path]):
        self._db_path = str(db_path)
        self._roots = [Path(r).resolve() for r in roots]
        self._write_lock = threading.Lock()
        self._indexing = False
        self._last_index_stats: dict = {}
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    # ---- connection helpers -------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_schema(self) -> None:
        with self._write_lock, self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS assets (
                    path TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    ext TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    mtime REAL NOT NULL,
                    is_in_archive INTEGER NOT NULL DEFAULT 0,
                    archive_path TEXT,
                    inner_path TEXT,
                    indexed_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
                CREATE INDEX IF NOT EXISTS idx_assets_ext ON assets(ext);

                CREATE TABLE IF NOT EXISTS tags (
                    path TEXT NOT NULL,
                    tag TEXT NOT NULL,
                    PRIMARY KEY (path, tag)
                );
                CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

                CREATE TABLE IF NOT EXISTS collections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS collection_items (
                    collection_id INTEGER NOT NULL,
                    path TEXT NOT NULL,
                    PRIMARY KEY (collection_id, path),
                    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
                );
                """
            )

    # ---- indexing -----------------------------------------------------------

    @property
    def is_indexing(self) -> bool:
        return self._indexing

    @property
    def last_index_stats(self) -> dict:
        return dict(self._last_index_stats)

    def reindex(self, archive_inspector=None, max_files: int = 200_000) -> dict:
        """
        Walk the roots and refresh the asset table.

        Incremental: rows whose (size, mtime) are unchanged are left untouched.
        Rows for files that no longer exist are pruned. Optionally inspects archives
        via the provided archive_inspector so in-archive assets are searchable too.

        Returns stats dict. Safe to call from a background thread.
        """
        if self._indexing:
            return {"status": "already_running", **self._last_index_stats}

        self._indexing = True
        started = time.time()
        seen: set[str] = set()
        added = 0
        updated = 0
        scanned = 0
        truncated = False
        error = None
        # Commit in bounded batches, acquiring the write lock only per batch. Holding
        # the lock (and one connection) for the entire walk would freeze every other
        # writer (tag/collection edits) for the whole scan; short batches let them
        # interleave. WAL readers (search) are never blocked either way.
        BATCH = 500
        batch: list[tuple] = []

        def flush(rows):
            if not rows:
                return
            with self._write_lock, self._connect() as conn:
                conn.executemany(
                    """
                    INSERT INTO assets(path, name, ext, size, mtime, is_in_archive,
                                       archive_path, inner_path, indexed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(path) DO UPDATE SET
                        name=excluded.name, ext=excluded.ext, size=excluded.size,
                        mtime=excluded.mtime, is_in_archive=excluded.is_in_archive,
                        archive_path=excluded.archive_path, inner_path=excluded.inner_path,
                        indexed_at=excluded.indexed_at
                    """,
                    rows,
                )

        try:
            existing = self._load_existing_mtimes()
            for root in self._roots:
                if truncated:
                    break
                for dirpath, dirnames, filenames in os.walk(root):
                    dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                    if scanned >= max_files:
                        truncated = True
                        break
                    for fname in filenames:
                        if fname.startswith("."):
                            continue
                        if scanned >= max_files:
                            truncated = True
                            break
                        fpath = os.path.join(dirpath, fname)
                        ext = Path(fname).suffix.lower()
                        if ext in SUPPORTED_3D_EXTENSIONS:
                            scanned += 1
                            row = self._direct_asset_row(fpath, fname, ext, existing)
                            seen.add(fpath)
                            if row is not None:
                                batch.append(row)
                                added += 1 if fpath not in existing else 0
                                updated += 1 if fpath in existing else 0
                        elif archive_inspector is not None and ext in {
                            ".zip", ".rar", ".unitypackage",
                        }:
                            scanned += 1
                            rows, paths = self._archive_asset_rows(
                                fpath, archive_inspector, existing
                            )
                            seen.update(paths)
                            for r in rows:
                                batch.append(r)
                                added += 1 if r[0] not in existing else 0
                                updated += 1 if r[0] in existing else 0
                        if len(batch) >= BATCH:
                            flush(batch)
                            batch = []
            flush(batch)

            # Prune only after a COMPLETE walk. A truncated walk (hit max_files) has an
            # incomplete `seen` set, so pruning would wrongly delete valid rows.
            pruned = 0
            if not truncated:
                with self._write_lock, self._connect() as conn:
                    pruned = self._prune_missing(conn, seen)

            self._last_index_stats = {
                "status": "ok",
                "added": added,
                "updated": updated,
                "pruned": pruned,
                "scanned": scanned,
                "truncated": truncated,
                "elapsed_s": round(time.time() - started, 3),
            }
        except Exception as e:  # capture, don't silently swallow
            error = str(e)
            self._last_index_stats = {
                "status": "error",
                "error": error,
                "added": added,
                "updated": updated,
                "scanned": scanned,
                "elapsed_s": round(time.time() - started, 3),
            }
        finally:
            self._indexing = False
        return self._last_index_stats

    def _load_existing_mtimes(self) -> dict[str, tuple[int, float]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT path, size, mtime FROM assets").fetchall()
        return {r["path"]: (r["size"], r["mtime"]) for r in rows}

    def _direct_asset_row(self, fpath, fname, ext, existing) -> Optional[tuple]:
        """Return an upsert row for a filesystem asset, or None if unchanged/unreadable."""
        try:
            st = os.stat(fpath)
        except OSError:
            return None
        prev = existing.get(fpath)
        if prev and prev[0] == st.st_size and abs(prev[1] - st.st_mtime) < 1e-6:
            return None  # unchanged
        return (
            fpath, Path(fname).stem, ext, st.st_size, st.st_mtime,
            0, None, None, time.time(),
        )

    def _archive_asset_rows(self, archive_path, inspector, existing):
        """Return (rows, seen_keys) for the 3D assets inside one archive."""
        rows: list[tuple] = []
        paths: set[str] = set()
        try:
            assets = inspector.inspect(archive_path)
        except Exception:
            return rows, paths
        try:
            arch_mtime = os.stat(archive_path).st_mtime
        except OSError:
            arch_mtime = time.time()
        for a in assets:
            key = f"{archive_path}!{a.inner_path}"
            paths.add(key)
            prev = existing.get(key)
            if prev and abs(prev[1] - arch_mtime) < 1e-6:
                continue  # unchanged
            rows.append((
                key, a.name, a.extension, a.size, arch_mtime,
                1, archive_path, a.inner_path, time.time(),
            ))
        return rows, paths

    def _prune_missing(self, conn, seen: set[str]) -> int:
        rows = conn.execute("SELECT path FROM assets").fetchall()
        to_delete = [r["path"] for r in rows if r["path"] not in seen]
        for p in to_delete:
            conn.execute("DELETE FROM assets WHERE path=?", (p,))
        return len(to_delete)

    # ---- search -------------------------------------------------------------

    def search(
        self,
        query: str = "",
        exts: Optional[list[str]] = None,
        tag: Optional[str] = None,
        min_size: Optional[int] = None,
        max_size: Optional[int] = None,
        limit: int = 200,
        offset: int = 0,
    ) -> list[SearchHit]:
        """Search the catalog. All filters are ANDed; empty query matches all."""
        clauses = []
        params: list = []
        if query:
            clauses.append("a.name LIKE ? ESCAPE '\\'")
            params.append(f"%{self._escape_like(query)}%")
        if exts:
            norm = [e.lower() if e.startswith(".") else f".{e.lower()}" for e in exts]
            clauses.append(f"a.ext IN ({','.join('?' for _ in norm)})")
            params.extend(norm)
        if min_size is not None:
            clauses.append("a.size >= ?")
            params.append(min_size)
        if max_size is not None:
            clauses.append("a.size <= ?")
            params.append(max_size)
        if tag:
            clauses.append("a.path IN (SELECT path FROM tags WHERE tag = ?)")
            params.append(tag)

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = (
            f"SELECT a.* FROM assets a {where} "
            f"ORDER BY a.name COLLATE NOCASE LIMIT ? OFFSET ?"
        )
        params.extend([limit, offset])

        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
            tag_map = self._tags_for_paths(conn, [r["path"] for r in rows])

        return [
            SearchHit(
                path=r["path"], name=r["name"], ext=r["ext"], size=r["size"],
                mtime=r["mtime"], is_in_archive=bool(r["is_in_archive"]),
                archive_path=r["archive_path"], inner_path=r["inner_path"],
                tags=tag_map.get(r["path"], []),
            )
            for r in rows
        ]

    @staticmethod
    def _escape_like(s: str) -> str:
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    def _tags_for_paths(self, conn, paths: list[str]) -> dict[str, list[str]]:
        if not paths:
            return {}
        placeholders = ",".join("?" for _ in paths)
        rows = conn.execute(
            f"SELECT path, tag FROM tags WHERE path IN ({placeholders}) ORDER BY tag",
            paths,
        ).fetchall()
        out: dict[str, list[str]] = {}
        for r in rows:
            out.setdefault(r["path"], []).append(r["tag"])
        return out

    def count(self) -> int:
        with self._connect() as conn:
            return conn.execute("SELECT COUNT(*) AS c FROM assets").fetchone()["c"]

    # ---- tags ---------------------------------------------------------------

    def add_tag(self, path: str, tag: str) -> None:
        tag = tag.strip().lower()
        if not tag:
            raise ValueError("Empty tag")
        with self._write_lock, self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO tags(path, tag) VALUES (?, ?)", (path, tag)
            )

    def remove_tag(self, path: str, tag: str) -> None:
        with self._write_lock, self._connect() as conn:
            conn.execute(
                "DELETE FROM tags WHERE path=? AND tag=?", (path, tag.strip().lower())
            )

    def tags_for(self, path: str) -> list[str]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT tag FROM tags WHERE path=? ORDER BY tag", (path,)
            ).fetchall()
        return [r["tag"] for r in rows]

    def all_tags(self) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT tag, COUNT(*) AS c FROM tags GROUP BY tag ORDER BY tag"
            ).fetchall()
        return [{"tag": r["tag"], "count": r["c"]} for r in rows]

    # ---- collections --------------------------------------------------------

    def create_collection(self, name: str) -> int:
        name = name.strip()
        if not name:
            raise ValueError("Empty collection name")
        with self._write_lock, self._connect() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO collections(name, created_at) VALUES (?, ?)",
                (name, time.time()),
            )
            if cur.lastrowid:
                return cur.lastrowid
            row = conn.execute(
                "SELECT id FROM collections WHERE name=?", (name,)
            ).fetchone()
            return row["id"]

    def delete_collection(self, collection_id: int) -> None:
        with self._write_lock, self._connect() as conn:
            conn.execute("DELETE FROM collections WHERE id=?", (collection_id,))

    def add_to_collection(self, collection_id: int, path: str) -> None:
        with self._write_lock, self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO collection_items(collection_id, path) VALUES (?, ?)",
                (collection_id, path),
            )

    def remove_from_collection(self, collection_id: int, path: str) -> None:
        with self._write_lock, self._connect() as conn:
            conn.execute(
                "DELETE FROM collection_items WHERE collection_id=? AND path=?",
                (collection_id, path),
            )

    def list_collections(self) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT c.id, c.name, COUNT(ci.path) AS c
                FROM collections c
                LEFT JOIN collection_items ci ON ci.collection_id = c.id
                GROUP BY c.id, c.name ORDER BY c.name COLLATE NOCASE
                """
            ).fetchall()
        return [{"id": r["id"], "name": r["name"], "count": r["c"]} for r in rows]

    def collection_paths(self, collection_id: int) -> list[str]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT path FROM collection_items WHERE collection_id=? ORDER BY path",
                (collection_id,),
            ).fetchall()
        return [r["path"] for r in rows]
