"""Source SQLite files must remain byte-identical, including live WAL/SHM."""
from __future__ import annotations

import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sqlite_snapshot
from sqlite_snapshot import DatabaseMirrors, MirrorUnavailable, read_only
from token_pulse.logs import LogEvidence, SqliteLogs


SCHEMA = "CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)"
ROW = (1, 100, 0, "task", "codex_core::stream_events_utils", 'turn_id="turn": Output item item_type="message" item_id="item"')


def bytes_of(directory: Path) -> dict[str, bytes]:
    return {path.name: path.read_bytes() for path in directory.iterdir() if path.is_file()}


class MirrorTests(unittest.TestCase):
    def test_active_writer_uncheckpointed_wal_and_shm_are_unchanged(self):
        with tempfile.TemporaryDirectory() as root:
            source, scratch = Path(root) / "source", Path(root) / "scratch"
            source.mkdir()
            scratch.mkdir()
            path = source / "logs_1.sqlite"
            writer = sqlite3.connect(path)
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute(SCHEMA)
            writer.execute("INSERT INTO logs VALUES (?,?,?,?,?,?)", ROW)
            writer.commit()
            self.assertTrue(Path(str(path) + "-wal").exists())
            before = bytes_of(source)
            pool = DatabaseMirrors(source, scratch)
            try:
                evidence = LogEvidence()
                adapter = SqliteLogs(path, evidence, pool)
                self.assertIsNone(adapter.poll())
                self.assertEqual(evidence.starts["task", "item"].at, 100)
                self.assertEqual(bytes_of(source), before)
                self.assertEqual(list(Path(pool.temporary.name).iterdir()), [])
                # Cache only fingerprints/observations: an unchanged source needs
                # no new full copy and retains no raw DB between polls.
                with patch.object(pool, "_copy", side_effect=AssertionError("unnecessary copy")):
                    self.assertIsNone(adapter.poll())
                self.assertEqual(bytes_of(source), before)
            finally:
                pool.close()
                writer.close()
            self.assertEqual(list(scratch.iterdir()), [])

    def test_crashed_writer_missing_shm_is_not_recreated(self):
        with tempfile.TemporaryDirectory() as root:
            source, scratch = Path(root) / "source", Path(root) / "scratch"
            source.mkdir()
            scratch.mkdir()
            path = source / "logs_1.sqlite"
            script = """import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('PRAGMA journal_mode=WAL')
c.execute('PRAGMA wal_autocheckpoint=0')
c.execute(sys.argv[2])
c.execute('INSERT INTO logs VALUES (1,100,0,?,?,?)', ('task','codex_core::stream_events_utils','turn_id="turn": Output item item_type="message" item_id="item"'))
c.commit()
os._exit(0)
"""
            subprocess.run([sys.executable, "-I", "-c", script, str(path), SCHEMA], check=True, capture_output=True)
            Path(str(path) + "-shm").unlink(missing_ok=True)
            self.assertTrue(Path(str(path) + "-wal").exists())
            before = bytes_of(source)
            pool = DatabaseMirrors(source, scratch)
            try:
                with closing(read_only(path, pool)) as connection:
                    self.assertEqual(connection.execute("SELECT COUNT(*) FROM logs").fetchone()[0], 1)
                self.assertEqual(bytes_of(source), before)
                self.assertFalse(Path(str(path) + "-shm").exists())
                self.assertEqual(list(Path(pool.temporary.name).iterdir()), [])
            finally:
                pool.close()
            self.assertEqual(list(scratch.iterdir()), [])

    def test_change_during_copy_is_skipped_and_private_copy_removed(self):
        with tempfile.TemporaryDirectory() as root:
            source, scratch = Path(root) / "source", Path(root) / "scratch"
            source.mkdir()
            scratch.mkdir()
            path = source / "state_1.sqlite"
            writer = sqlite3.connect(path)
            writer.execute("CREATE TABLE sample(value INTEGER)")
            writer.commit()
            pool = DatabaseMirrors(source, scratch)
            original = pool._copy
            def change_after_copy(*args):
                original(*args)
                writer.execute("INSERT INTO sample VALUES (1)")
                writer.commit()
            try:
                with patch.object(pool, "_copy", side_effect=change_after_copy):
                    with self.assertRaises(MirrorUnavailable):
                        pool.connect(path)
                self.assertEqual(list(Path(pool.temporary.name).iterdir()), [])
            finally:
                pool.close()
                writer.close()

    def test_size_cap_skips_before_copy_and_source_scratch_overlap_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            source, scratch = Path(root) / "source", Path(root) / "scratch"
            source.mkdir()
            scratch.mkdir()
            path = source / "state.sqlite"
            path.write_bytes(b"synthetic oversized data")
            pool = DatabaseMirrors(source, scratch)
            try:
                with patch.object(sqlite_snapshot, "MAX_DATABASE_BYTES", 10):
                    with self.assertRaises(MirrorUnavailable):
                        pool.connect(path)
                self.assertEqual(list(scratch.iterdir()), [])
                with self.assertRaises(MirrorUnavailable):
                    DatabaseMirrors(source, source / "scratch")
                Path(str(path) + "-journal").write_bytes(b"synthetic hot journal")
                with self.assertRaises(MirrorUnavailable):
                    pool.connect(path)
                self.assertEqual(list(scratch.iterdir()), [])
            finally:
                pool.close()


if __name__ == "__main__":
    unittest.main()
