"""Synthetic tests for ephemeral names and simultaneous conversation metadata."""
from __future__ import annotations

import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing, redirect_stdout
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collector import Collector, Observation, safe_title, today_start
from demo import build_source, iso
from history import History
from monitor import main, snapshot
from token_pulse.domain import Context, Sample, Task
from token_pulse.projection import project
from token_pulse.rollout import Rollout
from token_pulse.logs import LogEvidence
from token_pulse.tailer import JsonlTail, Batch

BASE = 1791892800.0


class OverviewTests(unittest.TestCase):
    def test_titles_are_ephemeral_exact_identity_and_update_on_rename(self):
        with tempfile.TemporaryDirectory() as root:
            source, data = Path(root) / "source", Path(root) / "data"
            build_source(source, BASE)
            collector = Collector(source)
            try:
                with closing(History(data)) as store:
                    observation = collector.poll(BASE)
                    store.accept(observation.samples, BASE)
                    before = snapshot(store, observation, "live", BASE)
                    matching = [row for row in before["conversations"] if row["title"] == "课程网站首页"]
                    self.assertEqual(len(matching), 2)
                    self.assertNotEqual(matching[0]["id"], matching[1]["id"])
                    raw_id = "00000000-0000-4000-8000-000000000001"
                    bound_id = store.identity(raw_id)
                    self.assertIn(bound_id, {sample["conversationId"] for sample in before["samples"]})
                    with closing(sqlite3.connect(source / "state_5.sqlite")) as connection:
                        connection.execute("UPDATE threads SET title=? WHERE id=?", ("EPHEMERAL_TITLE_CANARY\n新名称", raw_id))
                        connection.commit()
                    after_observation = collector.poll(BASE + 11)
                    store.accept(after_observation.samples, BASE + 11)
                    after = snapshot(store, after_observation, "live", BASE + 11)
                    renamed = next(row for row in after["conversations"] if row["id"] == bound_id)
                    self.assertEqual(renamed["title"], "EPHEMERAL_TITLE_CANARY 新名称")
                    self.assertEqual(len(after["samples"]), len(before["samples"]))
                    self.assertNotIn(raw_id, json.dumps(after))
                    self.assertNotIn("title", {row[1] for row in store.connection.execute("PRAGMA table_info(samples)")})
                disk = b"".join(path.read_bytes() for path in data.iterdir() if path.is_file())
                self.assertNotIn(b"EPHEMERAL_TITLE_CANARY", disk)
                self.assertNotIn("课程网站首页".encode(), disk)
                with closing(History(data)) as restarted:
                    history_only = snapshot(restarted, Observation([], [], False, False, set()), "live", BASE + 11)
                    self.assertTrue(all(row["title"] is None and row["state"] == "unknown"
                                        for row in history_only["conversations"]))
            finally:
                collector.close()

    def test_ongoing_task_without_output_is_visible(self):
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as store:
            task = Task("running", "正在检查", "tool", BASE - 1, Context("model-a", "high"))
            result = snapshot(store, Observation([], [], True, False, set(), [task]), "live", BASE)
            self.assertEqual(result["samples"], [])
            self.assertEqual(len(result["conversations"]), 1)
            row = result["conversations"][0]
            self.assertEqual(row["state"], "tool")
            self.assertEqual(row["title"], "正在检查")
            self.assertEqual(row["id"], store.identity("running"))
            self.assertIn(row["profileId"], {profile["id"] for profile in result["profiles"]})

    def test_poll_projects_state_at_collection_end_not_before_its_events(self):
        # A writer emits this event while the collector is working. Using the
        # poll-start clock would classify it as a future, unknown task.
        task = Task("during-poll", None, "generating", BASE + 3)
        observation = Observation([], [], True, False, set(), [task])
        store = Mock()
        store.recent.return_value = []
        store.identity.side_effect = lambda identifier: identifier
        collector = Mock()
        collector.poll.return_value = observation
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as root:
            with (patch("monitor.History", return_value=store),
                  patch("monitor.Collector", return_value=collector),
                  patch("monitor.time.time", side_effect=[BASE, BASE + 5]),
                  redirect_stdout(output)):
                code = main(["--mode", "live", "--codex-home", str(Path(root) / "source"),
                             "--data-dir", str(Path(root) / "data"), "--once"])
        self.assertEqual(code, 0)
        collector.poll.assert_called_once_with(BASE)
        store.accept.assert_called_once_with([], BASE + 5)
        result = json.loads(output.getvalue())
        self.assertEqual(result["conversations"][0]["state"], "generating")
        self.assertEqual(result["updatedAt"], "2026-10-13T12:00:05.000+00:00")

    def test_small_clock_skew_is_bounded_and_active_silence_still_expires(self):
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as store:
            tasks = [Task(identifier, None, state, updated) for identifier, state, updated in (
                ("during-read", "generating", BASE + .05),
                ("clock-limit", "tool", BASE + 2),
                ("future", "waiting", BASE + 2.01),
                ("silent", "tool", BASE - 121),
            )]
            result = snapshot(store, Observation([], [], True, False, set(), tasks), "live", BASE)
            states = {row["id"]: row["state"] for row in result["conversations"]}
            self.assertEqual(states, {store.identity(identifier): state for identifier, state in (
                ("during-read", "generating"), ("clock-limit", "tool"),
                ("future", "unknown"), ("silent", "unknown"),
            )})

    def test_explicit_terminal_events_survive_silence_but_not_invalid_clocks(self):
        tasks = []
        for event, expected in (("task_complete", "idle"), ("task_failed", "error"), ("turn_aborted", "error")):
            parser = Rollout(event)
            for second, payload in ((-130, {"type": "task_started", "turn_id": "turn"}),
                                    (-121, {"type": event})):
                parser.feed(project({"timestamp": iso(BASE + second),
                                     "type": "event_msg", "payload": payload}))
            task = parser.task(LogEvidence())
            self.assertEqual(task.state, expected)
            tasks.append(task)
        tasks.extend([Task("future-terminal", None, "idle", BASE + 3),
                      Task("invalid-terminal", None, "error", float("nan"))])
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as store:
            result = snapshot(store, Observation([], [], True, False, set(), tasks), "live", BASE)
            states = {row["id"]: row["state"] for row in result["conversations"]}
            for identifier, expected in (("task_complete", "idle"), ("task_failed", "error"),
                                         ("turn_aborted", "error"), ("future-terminal", "unknown"),
                                         ("invalid-terminal", "unknown")):
                self.assertEqual(states[store.identity(identifier)], expected)

    def test_degraded_discovery_keeps_safe_parser_offsets_and_recovers_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            # These indexed sessions deliberately live in an old date directory,
            # outside fallback discovery, as real continued sessions can do.
            build_source(source, BASE)
            collector = Collector(source)
            try:
                collector.poll(BASE)
                before = dict(collector.watched)
                offsets = {identifier: tail.offset for identifier, (tail, _) in before.items()}
                outside = Path(root) / "outside.jsonl"
                outside.touch()
                collector.watched["outside"] = JsonlTail(outside), Rollout("outside")
                with patch("collector.read_only", side_effect=sqlite3.OperationalError("synthetic copy race")):
                    collector.discover(BASE + 10)
                self.assertIn("state_unavailable", collector.discovery_issues)
                self.assertNotIn("outside", collector.watched)
                self.assertEqual(set(collector.watched), set(before))
                for identifier, pair in before.items():
                    self.assertIs(collector.watched[identifier], pair)
                    self.assertEqual(pair[0].offset, offsets[identifier])
                continued = collector.poll(BASE + 11)
                self.assertEqual(len(continued.tasks), 8)
                for identifier, (tail, _) in collector.watched.items():
                    self.assertEqual(tail.offset, offsets[identifier])
                removed = next(iter(before))
                with closing(sqlite3.connect(source / "state_5.sqlite")) as connection:
                    connection.execute("DELETE FROM threads WHERE id=?", (removed,))
                    connection.commit()
                collector.discover(BASE + 20)
                self.assertNotIn("state_unavailable", collector.discovery_issues)
                self.assertNotIn(removed, collector.watched)
                self.assertEqual(set(collector.watched), set(before) - {removed})
                for identifier, pair in collector.watched.items():
                    self.assertIs(pair, before[identifier])
            finally:
                collector.close()

    def test_degraded_discovery_retains_the_existing_source_count_bound(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            sessions = source / "sessions"
            sessions.mkdir(parents=True)
            known = source / "known.jsonl"
            known.touch()
            identifier = "00000000-0000-4000-8000-000000000001"
            candidate = sessions / f"rollout-{identifier}.jsonl"
            candidate.touch()
            os.utime(candidate, (BASE, BASE))
            collector = Collector(source)
            try:
                collector.watched = {f"known-{index}": (JsonlTail(known), Rollout(f"known-{index}"))
                                     for index in range(512)}
                before = dict(collector.watched)
                collector.discover(BASE)
                self.assertIn("limited_discovery", collector.discovery_issues)
                self.assertEqual(set(collector.watched), set(before))
                for task, pair in before.items():
                    self.assertIs(collector.watched[task], pair)
            finally:
                collector.close()

    def test_current_profile_does_not_backfill_or_relabel_output(self):
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as store:
            old_context = Context("old-model", "high", "default")
            store.accept([Sample("task", "turn", "response", BASE - 5, 100, BASE - 7, old_context)], BASE)
            current = Task("task", "切换过配置", "waiting", BASE - 1, Context("new-model", "low", "priority"))
            result = snapshot(store, Observation([], [], True, False, set(), [current]), "live", BASE)
            row, sample = result["conversations"][0], result["samples"][0]
            self.assertNotEqual(row["profileId"], sample["profileId"])
            profiles = {profile["id"]: profile for profile in result["profiles"]}
            self.assertEqual(profiles[row["profileId"]]["model"], "new-model")
            self.assertEqual(profiles[sample["profileId"]]["model"], "old-model")
            self.assertEqual(store.recent()[0].context, old_context)
            unknown = replace(current, context=Context(), updated_at=BASE - 121)
            next_result = snapshot(store, Observation([], [], True, False, set(), [unknown]), "live", BASE)
            self.assertIsNone(next_result["conversations"][0]["profileId"])
            self.assertEqual(next_result["conversations"][0]["state"], "unknown")
            self.assertEqual(next_result["samples"][0]["profileId"], sample["profileId"])

    def test_missing_title_column_keeps_collection_working(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            build_source(source, BASE)
            with closing(sqlite3.connect(source / "state_5.sqlite")) as connection:
                connection.execute("ALTER TABLE threads DROP COLUMN title")
                connection.commit()
            collector = Collector(source)
            try:
                observation = collector.poll(BASE)
                self.assertEqual(len(observation.samples), 12)
                self.assertEqual(len(observation.tasks), 8)
                self.assertNotIn("state_unavailable", observation.issues)
                self.assertTrue(all(task.title is None for task in observation.tasks))
            finally:
                collector.close()

    def test_title_sanitization_is_unicode_bounded_and_single_line(self):
        self.assertEqual(safe_title("  修订\n页面\r\t\x1b\u202e🙂  "), "修订 页面 🙂")
        self.assertEqual(len(safe_title("名" * 500)), 160)
        self.assertIsNone(safe_title("\x00\x1b\u202e"))
        self.assertIsNone(safe_title({"title": "not a string"}))

    def test_only_structural_own_session_source_classifies_subagent(self):
        sources = [
            ("cli", False), ("vscode", False), ("unknown future", None),
            ({"subagent": {"thread_spawn": {"parent_thread_id": "PRIVATE_PARENT_CANARY"}}}, True),
            ({"subagent": "review"}, True), ({"subagent": "compact"}, True),
            ({"subagent": "unknown future"}, None), ({"subagent": True}, None),
            ({"subagent": {"private": "PRIVATE_PARENT_CANARY"}}, None),
        ]
        for source, expected in sources:
            record = project({"timestamp": "2026-10-13T12:00:00Z", "type": "session_meta",
                              "payload": {"id": "task", "source": source, "is_subagent": True}})
            self.assertEqual(record["payload"]["is_subagent"], expected)
            self.assertNotIn("PRIVATE_PARENT_CANARY", repr(record))
            parser = Rollout("task")
            parser.feed(record)
            self.assertEqual(parser.task(LogEvidence()).is_subagent, expected)
        parent_record = project({"timestamp": "2026-10-13T12:00:00Z", "type": "session_meta",
                                 "payload": {"id": "parent", "source": {"subagent": "review"}}})
        parser = Rollout("child")
        parser.feed(parent_record)
        self.assertIsNone(parser.task(LogEvidence()).is_subagent)

    def test_tail_small_remaining_budget_and_rotation_report_consumption(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "events.jsonl"
            path.write_bytes(b" " * 1000)
            tail = JsonlTail(path, budget=1024, backfill=None)
            first = tail.read(budget=17)
            self.assertEqual((tail.offset, first.read_bytes), (17, 17))
            second = tail.read(budget=13)
            self.assertEqual((tail.offset, second.read_bytes), (30, 13))
            # A rewrite resets offset; consumed bytes remain positive and exact.
            path.write_bytes(b"x" * 1000)
            rotated = tail.read(budget=11)
            self.assertTrue(rotated.reset)
            self.assertEqual((tail.offset, rotated.read_bytes), (11, 11))
            with self.assertRaises(ValueError):
                tail.read(budget=0)

    def test_demo_classification_exposes_one_optional_subagent_row(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            build_source(source, BASE)
            collector = Collector(source)
            try:
                observation = collector.poll(BASE)
                self.assertEqual(len(observation.tasks), 8)
                self.assertEqual(sum(task.is_subagent is True for task in observation.tasks), 1)
                self.assertEqual(sum(task.is_subagent is False for task in observation.tasks), 7)
                continued = [task for task in observation.tasks if task.id in {
                    "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000003"
                }]
                self.assertEqual({task.latest.tps for task in continued}, {79, 92})
                self.assertTrue(all(task.state == "generating" and task.context != task.latest.context
                                    for task in continued))
            finally:
                collector.close()

    def test_collector_caps_last_file_to_remaining_payload_budget(self):
        class FixedTail(JsonlTail):
            def __init__(self, path, length):
                super().__init__(path, backfill=None)
                self.length = length
            def read(self, *, budget=None):
                amount = min(self.length - self.offset, self.budget,
                             budget if budget is not None else self.budget)
                self.offset += amount
                self.identity = (1, 1)
                return Batch(size=self.length, read_bytes=amount)
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            source.mkdir()
            collector = Collector(source)
            collector.next_discovery = BASE + 10
            collector.discovery_day = today_start(BASE)
            try:
                for index in range(9):
                    path = source / f"task-{index}.jsonl"
                    path.touch()
                    collector.watched[str(index)] = (FixedTail(path, 1 if index == 0 else 3 * 1024 * 1024), Rollout(str(index)))
                observation = collector.poll(BASE)
                tails = [tail for tail, _ in collector.watched.values()]
                self.assertEqual(sum(tail.offset for tail in tails), 16 * 1024 * 1024)
                self.assertEqual(tails[-1].offset, 2 * 1024 * 1024 - 1)
                self.assertTrue(observation.pending)
            finally:
                collector.close()


if __name__ == "__main__":
    unittest.main()
