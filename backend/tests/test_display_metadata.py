"""Synthetic checks for local, ephemeral conversation names and classification."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collector import Collector, DisplayMetadata, Observation, source_subagent, today_start
from demo import build_source, iso
from history import History
from monitor import snapshot
from token_pulse.domain import Context, Sample, Task

BASE = 1791892800.0
FIRST = "00000000-0000-4000-8000-000000000001"


def source_bytes(source: Path) -> dict[str, str]:
    return {str(path.relative_to(source)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in source.rglob("*") if path.is_file()}


def index_line(identifier: str, title: str, at: float) -> bytes:
    return (json.dumps({"id": identifier, "thread_name": title, "updated_at": iso(at)},
                       ensure_ascii=False) + "\n").encode("utf-8")


def minimal_source(source: Path, rows: list[tuple]) -> None:
    source.mkdir()
    with closing(sqlite3.connect(source / "state_5.sqlite")) as db:
        db.execute("CREATE TABLE threads(id TEXT,rollout_path TEXT,updated_at REAL,name TEXT,title TEXT,agent_nickname TEXT,source TEXT)")
        db.executemany("INSERT INTO threads VALUES (?,?,?,?,?,?,?)", rows)
        db.commit()


class DisplayMetadataTests(unittest.TestCase):
    def test_current_name_beats_index_and_legacy_title_and_rename_refreshes(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            build_source(source, BASE)
            with closing(sqlite3.connect(source / "state_5.sqlite")) as db:
                db.execute("ALTER TABLE threads ADD COLUMN name TEXT")
                db.execute("UPDATE threads SET name=? WHERE id=?", ("SIDEBAR_CANARY\n新名", FIRST))
                db.commit()
            (source / "session_index.jsonl").write_bytes(index_line(FIRST, "STALE_INDEX_CANARY", BASE))
            before = source_bytes(source)
            collector = Collector(source)
            try:
                observation = collector.poll(BASE)
                self.assertEqual(next(task.title for task in observation.tasks if task.id == FIRST), "SIDEBAR_CANARY 新名")
                self.assertEqual(source_bytes(source), before)
                with closing(sqlite3.connect(source / "state_5.sqlite")) as db:
                    db.execute("UPDATE threads SET name=? WHERE id=?", ("RENAMED_CANARY", FIRST))
                    db.commit()
                collector.discover(BASE + 11)
                self.assertEqual(collector.display_metadata[FIRST].title, "RENAMED_CANARY")
            finally:
                collector.close()

    def test_index_uses_latest_timestamp_with_missing_columns_and_partial_bad_lines(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            source.mkdir()
            with closing(sqlite3.connect(source / "state_5.sqlite")) as db:
                db.execute("CREATE TABLE threads(id TEXT,rollout_path TEXT,updated_at REAL)")
                db.execute("INSERT INTO threads VALUES (?,?,?)", (FIRST, "missing.jsonl", BASE))
                db.commit()
            (source / "session_index.jsonl").write_bytes(
                index_line(FIRST, "最新名称", BASE)
                + b"{malformed}\n" + b"[" * 1100 + b"]" * 1100 + b"\n"
                + b"x" * 17000 + b"\n"
                + index_line(FIRST, "较旧名称", BASE - 1)
                + index_line(FIRST, "正在写入的未完成记录", BASE + 1).rstrip(b"\n"))
            before = source_bytes(source)
            collector = Collector(source)
            try:
                collector.discover(BASE)
                self.assertEqual(collector.display_metadata[FIRST].title, "最新名称")
                self.assertNotIn("state_unavailable", collector.discovery_issues)
                self.assertEqual(source_bytes(source), before)
            finally:
                collector.close()

    def test_cross_day_history_and_missing_rollout_receive_names_without_extra_rows_or_storage(self):
        with tempfile.TemporaryDirectory() as root:
            source, data = Path(root) / "source", Path(root) / "data"
            old = today_start(BASE) - 60
            minimal_source(source, [
                ("old-raw-id", "missing.jsonl", old, "HISTORY_NAME_CANARY", None, None, "vscode"),
                ("child-raw-id", "missing.jsonl", old, None, None, "CHILD_NICK_CANARY",
                 json.dumps({"subagent": {"thread_spawn": {"parent_thread_id": "PARENT_NOT_RETAINED"}}})),
                ("no-measurement-id", "missing.jsonl", old, "DO_NOT_CREATE_ROW", None, None, "cli"),
            ])
            before = source_bytes(source)
            collector = Collector(source)
            try:
                collector.discover(BASE)
                self.assertEqual(collector.watched, {})
                with closing(History(data)) as history:
                    history.accept([Sample(raw, "turn", "response", old, 100, old - 2, Context("old-model", "high"))
                                    for raw in ("old-raw-id", "child-raw-id")], BASE)
                    observation = Observation([], [], False, False, set(), display_metadata=collector.display_metadata)
                    result = snapshot(history, observation, "live", BASE)
                    rows = {row["id"]: row for row in result["conversations"]}
                    self.assertEqual(len(rows), 2)
                    self.assertEqual(rows[history.identity("old-raw-id")]["title"], "HISTORY_NAME_CANARY")
                    self.assertEqual(rows[history.identity("child-raw-id")]["title"], "子任务 · CHILD_NICK_CANARY")
                    self.assertTrue(rows[history.identity("child-raw-id")]["isSubagent"])
                    self.assertFalse(rows[history.identity("old-raw-id")]["isSubagent"])
                    self.assertTrue(all(row["state"] == "unknown" and row["profileId"] is None for row in rows.values()))
                    self.assertEqual(len(result["samples"]), 2)
                    self.assertNotIn("old-raw-id", json.dumps(result))
                    self.assertNotIn("display_metadata", {row[1] for row in history.connection.execute("PRAGMA table_info(samples)")})
                persisted = b"".join(path.read_bytes() for path in data.iterdir() if path.is_file())
                for marker in (b"HISTORY_NAME_CANARY", b"CHILD_NICK_CANARY", b"old-raw-id", b"PARENT_NOT_RETAINED"):
                    self.assertNotIn(marker, persisted)
                self.assertEqual(source_bytes(source), before)
            finally:
                collector.close()

    def test_nickname_requires_known_subagent_source_and_name_still_wins(self):
        cases = [("cli", False), ("vscode", False), ("subagent", None),
                 ("future", None), (json.dumps({"subagent": "review"}), True),
                 (json.dumps({"subagent": {"thread_spawn": {}}}), True),
                 (json.dumps({"subagent": {"future": {}}}), None),
                 (json.dumps({"subagent": True}), None),
                 ("[" * 1500 + "]" * 1500, None)]
        for source, expected in cases:
            self.assertIs(source_subagent(source), expected)
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            minimal_source(source, [
                ("child", "missing.jsonl", BASE, None, None, "昵称", json.dumps({"subagent": {"thread_spawn": {}}})),
                ("unknown", "missing.jsonl", BASE, None, None, "不要据此猜子任务", "future"),
                ("named-child", "missing.jsonl", BASE, "正式名称", None, "昵称", json.dumps({"subagent": "review"})),
                ("legacy", "missing.jsonl", BASE, None, "旧版标题", None, "cli"),
            ])
            collector = Collector(source)
            try:
                collector.discover(BASE)
                self.assertEqual(collector.display_metadata["child"].title, "子任务 · 昵称")
                self.assertIsNone(collector.display_metadata["unknown"].title)
                self.assertIsNone(collector.display_metadata["unknown"].is_subagent)
                self.assertEqual(collector.display_metadata["named-child"].title, "正式名称")
                self.assertEqual(collector.display_metadata["legacy"].title, "旧版标题")
            finally:
                collector.close()

    def test_bad_database_and_oversized_index_fail_locally(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            source.mkdir()
            (source / "state_5.sqlite").write_bytes(b"synthetic invalid database")
            (source / "session_index.jsonl").write_bytes(index_line(FIRST, "索引名称", BASE))
            before = source_bytes(source)
            collector = Collector(source)
            try:
                collector.discover(BASE)
                self.assertEqual(collector.display_metadata[FIRST].title, "索引名称")
                self.assertIn("state_unavailable", collector.discovery_issues)
                with patch("collector.MAX_NAME_INDEX_BYTES", 16):
                    collector.discover(BASE + 11)
                self.assertEqual(collector.display_metadata, {})
                self.assertEqual(source_bytes(source), before)
            finally:
                collector.close()

    def test_metadata_count_and_title_budget_prioritize_live_then_recent_history(self):
        with tempfile.TemporaryDirectory() as root:
            source, data = Path(root) / "source", Path(root) / "data"
            minimal_source(source, [(f"task-{i}", "missing.jsonl", BASE - i, f"name-{i}", None, None, "cli")
                                    for i in range(4)])
            collector = Collector(source)
            try:
                with patch("collector.MAX_DISPLAY_METADATA", 2):
                    collector.discover(BASE)
                self.assertEqual(set(collector.display_metadata), {"task-0", "task-1"})
            finally:
                collector.close()
            with closing(History(data)) as history:
                history.accept([Sample(raw, "turn", "response", BASE - i - 1, 100, BASE - i - 2)
                                for i, raw in enumerate(("recent", "older", "live"))], BASE)
                metadata = {raw: DisplayMetadata("🙂🙂", True) for raw in ("live", "recent", "older")}
                live = Task("live", "🙂🙂", "generating", BASE - 1, is_subagent=False)
                with patch("monitor.MAX_DISPLAY_TITLE_BYTES", 16):
                    result = snapshot(history, Observation([], [], True, False, set(), [live], metadata), "live", BASE)
                rows = {row["id"]: row for row in result["conversations"]}
                self.assertEqual(rows[history.identity("live")]["title"], "🙂🙂")
                self.assertEqual(rows[history.identity("recent")]["title"], "🙂🙂")
                self.assertIsNone(rows[history.identity("older")]["title"])
                self.assertFalse(rows[history.identity("live")]["isSubagent"])
                self.assertLessEqual(sum(len((row["title"] or "").encode("utf-8")) for row in rows.values()), 16)


if __name__ == "__main__":
    unittest.main()
