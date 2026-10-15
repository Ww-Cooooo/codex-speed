"""Query private DB/WAL mirrors without opening a source SQLite connection.

SQLite's mode=ro may create/update the source SHM file. All SQLite access here
therefore targets a temporary copy. Source files are only opened as binary reads.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import tempfile
from pathlib import Path

MAX_DATABASE_BYTES = 128 * 1024 * 1024  # DB and WAL combined, per source.
CHUNK_BYTES = 1024 * 1024


class MirrorUnavailable(OSError):
    """A source changed while copying, was too large, or could not be read."""


def _fingerprint(path: Path) -> tuple | None:
    try:
        if path.is_symlink() or path.resolve() != path:
            raise MirrorUnavailable("source_link_changed")
        stat = path.stat()
        if not path.is_file():
            raise MirrorUnavailable("source_not_file")
        # Header/tail digests also catch WAL resets or same-size rewrites on hosts
        # whose last-write metadata is delayed while a writer handle remains open.
        with path.open("rb") as stream:
            start = stream.read(128)
            stream.seek(max(0, stat.st_size - 128))
            end = stream.read(128)
        return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns,
                stat.st_ctime_ns, hashlib.sha256(start + end).digest())
    except FileNotFoundError:
        return None


class MirrorConnection(sqlite3.Connection):
    _owned_pool = None
    _mirror_folder = None
    _mirror_pool = None

    def close(self) -> None:
        try:
            super().close()
        finally:
            folder, self._mirror_folder = self._mirror_folder, None
            if folder is not None:
                self._mirror_pool.remove(folder)
            pool, self._owned_pool = self._owned_pool, None
            if pool is not None:
                pool.close()


class DatabaseMirrors:
    def __init__(self, source_root: Path, temporary_parent: Path | None = None):
        self.source_root = source_root.resolve()
        self.temporary_parent = (temporary_parent or Path(tempfile.gettempdir())).resolve()
        if self.temporary_parent.is_relative_to(self.source_root):
            raise MirrorUnavailable("mirror_inside_source")
        self.temporary: tempfile.TemporaryDirectory | None = None
        self.counter = 0

    def close(self) -> None:
        if self.temporary is not None:
            self.temporary.cleanup()
            self.temporary = None

    def _private_root(self) -> Path:
        if self.temporary is None:
            self.temporary = tempfile.TemporaryDirectory(prefix="codex-tps-sqlite-", dir=self.temporary_parent)
        return Path(self.temporary.name)

    def _state(self, source: Path) -> tuple:
        journal = source.with_name(source.name + "-journal")
        if journal.exists() and journal.stat().st_size:
            # A hot rollback journal needs source recovery; a DB-only copy must
            # never treat its partially applied pages as a committed snapshot.
            raise MirrorUnavailable("source_recovery_pending")
        db = _fingerprint(source)
        wal = _fingerprint(source.with_name(source.name + "-wal"))
        if db is None or sum(state[2] for state in (db, wal) if state) > MAX_DATABASE_BYTES:
            raise MirrorUnavailable("source_unavailable_or_too_large")
        return db, wal

    def source_fingerprint(self, path: Path) -> tuple:
        source = path.resolve()
        if not source.is_relative_to(self.source_root):
            raise MirrorUnavailable("source_outside_root")
        return self._state(source)

    def remove(self, folder: Path) -> None:
        if self.temporary is None or not folder.resolve().is_relative_to(Path(self.temporary.name).resolve()):
            raise MirrorUnavailable("invalid_private_cleanup")
        shutil.rmtree(folder)

    @staticmethod
    def _copy(source: Path, destination: Path, expected: tuple) -> None:
        remaining = expected[2]
        with source.open("rb") as incoming, destination.open("xb") as outgoing:
            # Check the opened file identity, not just the path used before open.
            actual = os.fstat(incoming.fileno())
            if (actual.st_dev, actual.st_ino, actual.st_size) != expected[:3]:
                raise MirrorUnavailable("source_changed")
            while remaining:
                data = incoming.read(min(CHUNK_BYTES, remaining))
                if not data:
                    raise MirrorUnavailable("source_changed")
                outgoing.write(data)
                remaining -= len(data)
            if incoming.read(1):
                raise MirrorUnavailable("source_changed")

    def connect(self, path: Path) -> MirrorConnection:
        source = path.resolve()
        if not source.is_relative_to(self.source_root):
            raise MirrorUnavailable("source_outside_root")
        before = self._state(source)
        self.counter += 1
        folder = self._private_root() / str(self.counter)
        folder.mkdir()
        destination = folder / "snapshot.sqlite"
        connection = None
        try:
            self._copy(source, destination, before[0])
            if before[1] is not None:
                self._copy(source.with_name(source.name + "-wal"), destination.with_name(destination.name + "-wal"), before[1])
            if self._state(source) != before:
                raise MirrorUnavailable("source_changed")
            # Source SHM is never even opened. SQLite rebuilds the WAL index privately.
            connection = sqlite3.connect(destination.as_uri() + "?mode=ro", uri=True,
                                         timeout=0.2, factory=MirrorConnection)
            connection.execute("PRAGMA query_only=ON")
            connection._mirror_folder, connection._mirror_pool = folder, self
            return connection
        except (OSError, ValueError, sqlite3.Error):
            if connection is not None:
                sqlite3.Connection.close(connection)
            self.remove(folder)
            raise


def read_only(path: Path, mirrors: DatabaseMirrors | None = None) -> MirrorConnection:
    owned = mirrors is None
    pool = mirrors or DatabaseMirrors(path.resolve().parent)
    try:
        connection = pool.connect(path)
        if owned:
            connection._owned_pool = pool
        return connection
    except (OSError, sqlite3.Error, ValueError):
        if owned:
            pool.close()
        raise
