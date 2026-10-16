"""Synthetic coverage for live state while bounded history replay catches up."""
from __future__ import annotations

import sys
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collector import Collector, today_start
from history import History
from monitor import snapshot
from token_pulse.domain import Context, Sample, Task
from token_pulse.lifecycle import CurrentLifecycle, CURRENT_WINDOW_BYTES, CURRENT_EXTRA_BUDGET_BYTES
from token_pulse.logs import LogEvidence
from token_pulse.rollout import Rollout
from token_pulse.tailer import Batch, JsonlTail

BASE = datetime(2026, 10, 16, 12, tzinfo=UTC).timestamp()


def record(at, kind, **payload):
    return {"timestamp": datetime.fromtimestamp(at, UTC).isoformat(), "type": kind, "payload": payload}


def append(path, *records):
    with path.open("a", encoding="utf-8") as stream:
        for value in records:
            stream.write(json.dumps(value) + "\n")


def owned_output(task="task", turn="current", at=BASE):
    return [
        record(at - 3, "event_msg", type="task_started", turn_id=turn),
        record(at - 2, "turn_context", turn_id=turn, model="model-a", effort="high"),
        record(at - 1, "event_msg", type="item_completed", thread_id=task, turn_id=turn,
               started_at_ms=int((at - 2) * 1000), completed_at_ms=int((at - 1) * 1000),
               item={"id": "own-item", "type": "AgentMessage"}),
        record(at - 1, "response_item", type="message", role="assistant", id="own-item"),
        record(at, "token_usage_record", thread_id=task, turn_id=turn,
               response_id=f"own-response-{turn}", usage={"output_tokens": 100}),
    ]


class BackloggedTail(JsonlTail):
    """Keep each source backlogged without allocating large fixture files."""

    def read(self, *, budget=None):
        amount = min(self.budget, budget if budget is not None else self.budget)
        self.offset += amount
        self.identity = (1, id(self))
        return Batch(size=self.offset + self.budget, read_bytes=amount)


class ReplayFairnessTests(unittest.TestCase):
    def test_byte_budget_advances_by_actual_visits_for_32_and_64_sources(self):
        for count in (32, 64):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as root:
                source = Path(root)
                collector = Collector(source)
                self.addCleanup(collector.close)
                collector.next_discovery = BASE + 100
                collector.discovery_day = today_start(BASE)
                for index in range(count):
                    path = source / f"{index}.jsonl"
                    path.touch()
                    collector.watched[str(index)] = BackloggedTail(path, backfill=None), Rollout(str(index))
                # Eight 2 MiB reads exhaust each 16 MiB poll. Every source must
                # get its turn before any source receives a second visit.
                for poll in range(count // 8):
                    observation = collector.poll(BASE + poll)
                    self.assertTrue(observation.pending)
                self.assertEqual({tail.offset for tail, _ in collector.watched.values()}, {2 * 1024 * 1024})


class CurrentLifecycleTests(unittest.TestCase):
    def test_large_history_does_not_delay_current_state_or_supply_tail_measurements(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            source.mkdir()
            path = source / "rollout.jsonl"
            append(path, record(BASE - 600, "session_meta", id="task", source="cli"),
                   record(BASE - 599, "event_msg", type="task_started", turn_id="old"),
                   record(BASE - 598, "event_msg", type="task_complete"))
            padding = json.dumps(record(BASE - 500, "ignored", padding="synthetic" * 128)) + "\n"
            with path.open("a", encoding="utf-8") as stream:
                stream.write(padding * 6000)
            append(path, *owned_output())
            with closing(sqlite3.connect(source / "state_5.sqlite")) as connection:
                connection.execute("CREATE TABLE threads(id TEXT,rollout_path TEXT,updated_at REAL)")
                connection.execute("INSERT INTO threads VALUES (?,?,?)", ("task", str(path), BASE))
                connection.commit()
            collector = Collector(source)
            self.addCleanup(collector.close)
            first = collector.poll(BASE)
            self.assertTrue(first.pending)
            self.assertLess(collector.watched["task"][0].offset, path.stat().st_size)
            self.assertEqual(first.tasks[0].state, "generating")
            self.assertEqual(first.tasks[0].context, Context("model-a", "high"))
            self.assertEqual(first.samples, [])  # suffix usage never enters history
            with closing(History(Path(root) / "data")) as store:
                output = snapshot(store, first, "live", BASE)
                self.assertEqual(output["samples"], [])
                self.assertEqual(output["conversations"][0]["state"], "generating")
                self.assertTrue(output["conversations"][0]["discovered"])
                self.assertIn("catching_up", output["collectionIssues"])
            append(path, record(BASE + 1, "event_msg", type="task_complete"))
            # Replay still encounters the old prefix. It must not undo the newer
            # suffix completion; eventually its complete measurement is retained.
            samples = {}
            for poll in range(1, 8):
                observed = collector.poll(BASE + poll)
                self.assertEqual(observed.tasks[0].state, "idle")
                self.assertEqual(observed.tasks[0].updated_at, BASE + 1)
                samples.update((sample.key, sample) for sample in observed.samples)
            self.assertEqual(len(samples), 1)
            self.assertEqual(next(iter(samples.values())).tps, 100)

    def test_fork_ancestor_needs_an_own_boundary_or_own_thread_evidence(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "child.jsonl"
            append(path, record(BASE - 20, "session_meta", id="ancestor", source="cli"),
                   *owned_output("ancestor", "ancestor-turn", BASE - 10))
            reader = CurrentLifecycle("child", path)
            reader.poll()
            self.assertIsNone(reader.task(LogEvidence()))
            append(path, record(BASE - 4, "event_msg", type="thread_settings_applied", thread_id="child"),
                   record(BASE - 3, "event_msg", type="task_started", turn_id="child-turn"))
            reader.poll()
            self.assertEqual(reader.task(LogEvidence()).state, "waiting")
            # An ancestor boundary invalidates previously established ownership.
            append(path, record(BASE, "session_meta", id="ancestor", source="cli"),
                   record(BASE + 1, "event_msg", type="task_complete"))
            reader.poll()
            self.assertIsNone(reader.task(LogEvidence()))
            append(path, *owned_output("child", "own-output", BASE + 10))
            reader.poll()
            self.assertEqual(reader.task(LogEvidence()).state, "generating")
            self.assertEqual(reader.task(LogEvidence()).updated_at, BASE + 9)

    def test_own_header_does_not_bless_an_ancestor_suffix_without_own_evidence(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "child.jsonl"
            append(path, record(BASE - 20, "session_meta", id="child", source="cli"),
                   record(BASE - 19, "session_meta", id="ancestor", source="cli"))
            with path.open("a", encoding="utf-8") as stream:
                stream.write(" " * (CURRENT_WINDOW_BYTES * 2) + "\n")
            append(path, *owned_output("ancestor", "ancestor-turn"))
            reader = CurrentLifecycle("child", path)
            reader.poll()
            self.assertIsNone(reader.task(LogEvidence()))

    def test_partial_line_truncation_and_rotation_require_fresh_ownership(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "task.jsonl"
            append(path, record(BASE - 4, "session_meta", id="task", source="cli"), *owned_output())
            reader = CurrentLifecycle("task", path)
            reader.poll()
            self.assertEqual(reader.task(LogEvidence()).state, "generating")
            complete = json.dumps(record(BASE + 1, "event_msg", type="task_complete"))
            with path.open("a", encoding="utf-8") as stream:
                stream.write(complete[:len(complete) // 2])
            reader.poll()
            self.assertEqual(reader.task(LogEvidence()).state, "generating")
            with path.open("a", encoding="utf-8") as stream:
                stream.write(complete[len(complete) // 2:] + "\n")
            reader.poll()
            self.assertEqual(reader.task(LogEvidence()).display_state(BASE + 300), "idle")
            path.write_text(json.dumps(record(BASE + 2, "event_msg", type="task_complete")) + "\n")
            reader.poll()
            self.assertIsNone(reader.task(LogEvidence()))
            append(path, record(BASE + 3, "session_meta", id="task", source="cli"),
                   record(BASE + 4, "event_msg", type="task_started", turn_id="recovered"))
            reader.poll()
            self.assertEqual(reader.task(LogEvidence()).state, "waiting")
            append(path, record(BASE + 5, "event_msg", type="turn_aborted"))
            reader.poll()
            self.assertEqual(reader.task(LogEvidence()).display_state(BASE + 400), "error")
            replacement = path.with_name("replacement.jsonl")
            replacement.write_text(json.dumps(record(BASE + 6, "event_msg", type="task_complete")) + "\n")
            replacement.replace(path)
            reader.poll()
            self.assertIsNone(reader.task(LogEvidence()))

    def test_missing_records_clear_suffix_ownership_then_own_boundary_recovers(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "task.jsonl"
            append(path, record(BASE - 4, "session_meta", id="task", source="cli"), *owned_output())
            reader = CurrentLifecycle("task", path)
            reader.poll()
            with path.open("a", encoding="utf-8") as stream:
                stream.write("invalid JSON\n")
            append(path, record(BASE + 1, "event_msg", type="task_complete"))
            batch = reader.poll()
            self.assertEqual(batch.malformed, 1)
            self.assertIsNone(reader.task(LogEvidence()))
            append(path, record(BASE + 2, "session_meta", id="task", source="cli"),
                   record(BASE + 3, "event_msg", type="task_started", turn_id="next"))
            reader.poll()
            self.assertEqual(reader.task(LogEvidence()).state, "waiting")

    def test_foreign_thread_anchors_clear_owned_scope_even_without_session_meta(self):
        foreign = [
            record(BASE + 1, "event_msg", type="thread_settings_applied", thread_id="ancestor"),
            record(BASE + 1, "event_msg", type="item_completed", thread_id="ancestor", turn_id="foreign"),
            record(BASE + 1, "token_usage_record", thread_id="ancestor", turn_id="foreign"),
        ]
        for anchor in foreign:
            with self.subTest(anchor=anchor["payload"].get("type") or anchor["type"]), tempfile.TemporaryDirectory() as root:
                path = Path(root) / "task.jsonl"
                append(path, record(BASE - 4, "session_meta", id="task", source="cli"), *owned_output())
                reader = CurrentLifecycle("task", path)
                reader.poll()
                self.assertEqual(reader.task(LogEvidence()).state, "generating")
                append(path, anchor,
                       record(BASE + 2, "response_item", type="reasoning", id="foreign-item"),
                       record(BASE + 3, "event_msg", type="task_complete"))
                reader.poll()
                self.assertIsNone(reader.task(LogEvidence()))

    def test_delayed_older_state_does_not_undo_a_newer_lifecycle(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "task.jsonl"
            append(path, record(BASE - 4, "session_meta", id="task", source="cli"), *owned_output())
            reader = CurrentLifecycle("task", path)
            reader.poll()
            append(path, record(BASE - 5, "event_msg", type="task_complete"))
            reader.poll()
            self.assertEqual((reader.task(LogEvidence()).state, reader.task(LogEvidence()).updated_at),
                             ("generating", BASE - 1))
            append(path, record(BASE + 1, "event_msg", type="task_complete"))
            reader.poll()
            append(path, record(BASE, "event_msg", type="task_started", turn_id="older"))
            reader.poll()
            self.assertEqual((reader.task(LogEvidence()).state, reader.task(LogEvidence()).updated_at),
                             ("idle", BASE + 1))

    def test_unread_or_lost_ownership_cannot_publish_prefix_completion(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            path = source / "task.jsonl"
            append(path, record(BASE - 4, "session_meta", id="task", source="cli"), *owned_output(),
                   record(BASE + 1, "event_msg", type="item_completed", thread_id="ancestor", turn_id="foreign"),
                   record(BASE + 2, "event_msg", type="task_complete"))
            collector = Collector(source)
            self.addCleanup(collector.close)
            collector.watched["task"] = JsonlTail(path, backfill=None), Rollout("task")
            collector.next_discovery = BASE + 100
            collector.discovery_day = today_start(BASE)
            observed = collector.poll(BASE + 2)
            self.assertEqual((observed.tasks[0].state, observed.tasks[0].updated_at), ("unknown", 0))
            path.unlink()
            missing = collector.poll(BASE + 3)
            self.assertEqual((missing.tasks[0].state, missing.tasks[0].updated_at), ("unknown", 0))
            self.assertIn("source_unavailable", missing.issues)
            append(path, record(BASE + 4, "session_meta", id="task", source="cli"),
                   record(BASE + 5, "event_msg", type="task_started", turn_id="recovered"))
            recovered = collector.poll(BASE + 5)
            self.assertEqual(recovered.tasks[0].state, "waiting")

    def test_a_previously_active_source_disappearing_is_reported_unknown(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            path = source / "task.jsonl"
            append(path, record(BASE - 4, "session_meta", id="task", source="cli"), *owned_output())
            collector = Collector(source)
            self.addCleanup(collector.close)
            collector.watched["task"] = JsonlTail(path, backfill=None), Rollout("task")
            collector.next_discovery = BASE + 100
            collector.discovery_day = today_start(BASE)
            self.assertEqual(collector.poll(BASE).tasks[0].state, "generating")
            path.unlink()
            lost = collector.poll(BASE + 1)
            self.assertEqual((lost.tasks[0].state, lost.tasks[0].updated_at), ("unknown", 0))
            self.assertIn("source_unavailable", lost.issues)


class CollectionContractTests(unittest.TestCase):
    def test_discovery_survives_without_samples_and_issue_strings_are_allowlisted(self):
        from collector import Observation
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as history:
            history.accept([Sample("history", "turn", "response", BASE - 1, 50, BASE - 2)], BASE)
            observation = Observation([], [], True, True,
                                      {"state_unavailable", "logs_unavailable", "SECRET_PATH_CANARY"},
                                      [Task("discovered", None, "unknown", 0)])
            output = snapshot(history, observation, "live", BASE)
            rows = {row["id"]: row for row in output["conversations"]}
            self.assertTrue(rows[history.identity("discovered")]["discovered"])
            self.assertIsNone(rows[history.identity("discovered")]["updatedAt"])
            self.assertFalse(rows[history.identity("history")]["discovered"])
            self.assertEqual(output["collectionIssues"], ["catching_up", "logs_unavailable", "state_unavailable"])
            self.assertNotIn("SECRET_PATH_CANARY", json.dumps(output))

    def test_index_limit_is_reported_without_increasing_watch_count(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            path = source / "synthetic.jsonl"
            path.touch()
            with closing(sqlite3.connect(source / "state_5.sqlite")) as connection:
                connection.execute("CREATE TABLE threads(id TEXT,rollout_path TEXT,updated_at REAL)")
                connection.executemany("INSERT INTO threads VALUES (?,?,?)",
                                       ((str(index), str(path), BASE) for index in range(513)))
                connection.commit()
            collector = Collector(source)
            self.addCleanup(collector.close)
            collector.discover(BASE)
            self.assertEqual(len(collector.watched), 512)
            self.assertIn("limited_discovery", collector.discovery_issues)


class AdaptiveSuffixTests(unittest.TestCase):
    def make_collector(self, source, paths):
        collector = Collector(source)
        self.addCleanup(collector.close)
        collector.next_discovery = BASE + 1000
        collector.discovery_day = today_start(BASE)
        for task, path in paths.items():
            collector.watched[task] = JsonlTail(path, backfill=None), Rollout(task)
        return collector

    def tool_result(self, at, size):
        return record(at, "response_item", type="function_call_output", call_id="large-call",
                      output="x" * size)

    def test_cold_start_expands_past_large_tool_output_without_using_tail_samples(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            path = source / "task.jsonl"
            append(path, record(BASE - 100, "session_meta", id="task", source="cli"))
            with path.open("a", encoding="utf-8") as stream:
                stream.write(" " * (12 * 1024 * 1024) + "\n")
            append(path, *owned_output(), self.tool_result(BASE + 1, 3 * 1024 * 1024),
                   record(BASE + 2, "event_msg", type="token_count"))
            collector = self.make_collector(source, {"task": path})
            observed = collector.poll(BASE + 2)
            self.assertEqual(observed.tasks[0].state, "waiting")
            self.assertEqual(observed.tasks[0].updated_at, BASE + 1)
            self.assertEqual(collector.current["task"].window, 4 * 1024 * 1024)
            self.assertLess(collector.watched["task"][0].offset, path.stat().st_size)
            self.assertEqual(observed.samples, [])

    def test_burst_append_jumps_to_latest_completion_then_new_turn(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            path = source / "task.jsonl"
            append(path, record(BASE - 4, "session_meta", id="task", source="cli"), *owned_output())
            collector = self.make_collector(source, {"task": path})
            self.assertEqual(collector.poll(BASE).tasks[0].state, "generating")
            append(path, self.tool_result(BASE + 9, 3 * 1024 * 1024),
                   record(BASE + 10, "event_msg", type="task_complete"))
            complete = collector.poll(BASE + 10)
            self.assertEqual((complete.tasks[0].state, complete.tasks[0].updated_at), ("idle", BASE + 10))
            self.assertEqual(collector.current["task"].tail.offset, path.stat().st_size)
            append(path, *owned_output(turn="next", at=BASE + 20),
                   self.tool_result(BASE + 23, 3 * 1024 * 1024),
                   record(BASE + 24, "response_item", type="reasoning", id="next-output"))
            resumed = collector.poll(BASE + 24)
            self.assertEqual((resumed.tasks[0].state, resumed.tasks[0].updated_at), ("generating", BASE + 24))
            self.assertEqual(collector.current["task"].tail.offset, path.stat().st_size)
            self.assertEqual(collector.current["task"].tail.budget, CURRENT_WINDOW_BYTES)

    def test_anchor_outside_cap_stays_unknown_and_unchanged_file_is_not_rescanned(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "task.jsonl"
            append(path, record(BASE - 4, "session_meta", id="task", source="cli"), *owned_output(),
                   self.tool_result(BASE + 1, 9 * 1024 * 1024),
                   record(BASE + 2, "event_msg", type="token_count"))
            reader = CurrentLifecycle("task", path)
            reader.poll()
            while reader.next_window() is not None:
                self.assertIsNotNone(reader.expand(CURRENT_EXTRA_BUDGET_BYTES))
            self.assertEqual(reader.window, 8 * 1024 * 1024)
            self.assertIsNone(reader.task(LogEvidence()))
            for _ in range(5):
                self.assertEqual(reader.poll().read_bytes, 0)
                self.assertIsNone(reader.next_window())

    def test_shared_extra_budget_and_cursor_allow_later_sources_to_expand(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            paths = {}
            for index in range(32):
                task = f"task-{index}"
                path = source / f"{task}.jsonl"
                # Mixed sizes require different actual byte grants at 4 MiB.
                length = (1200 if index % 2 else 3000) * 1024
                append(path, record(BASE - 4, "session_meta", id=task, source="cli"),
                       *owned_output(task=task), self.tool_result(BASE + 1, length),
                       record(BASE + 2, "event_msg", type="token_count"))
                paths[task] = path
            collector = self.make_collector(source, paths)
            # Keep history backlogged independently, so it cannot mask a failure
            # of current-state scheduling or provide the desired final state.
            collector.watched = {task: (BackloggedTail(path, backfill=None), Rollout(task))
                                 for task, path in paths.items()}
            actual_read = JsonlTail.read
            reads = []
            def counted_read(tail, **kwargs):
                batch = actual_read(tail, **kwargs)
                reads.append((tail.budget, batch.read_bytes))
                return batch
            with patch.object(JsonlTail, "read", counted_read):
                for poll in range(24):
                    reads.clear()
                    collector.poll(BASE + 2 + poll)
                    extra = sum(count for window, count in reads if window > CURRENT_WINDOW_BYTES)
                    regular = sum(count for window, count in reads if window == CURRENT_WINDOW_BYTES)
                    self.assertLessEqual(extra, CURRENT_EXTRA_BUDGET_BYTES)
                    self.assertLessEqual(regular, 32 * CURRENT_WINDOW_BYTES)
                    if poll == 0:
                        self.assertEqual(collector.current["task-31"].window, CURRENT_WINDOW_BYTES)
                    if all(reader.task(LogEvidence()) is not None for reader in collector.current.values()):
                        break
                else:
                    self.fail("Later sources were starved of adaptive suffix scans")
            self.assertEqual(collector.current["task-31"].task(LogEvidence()).state, "waiting")


if __name__ == "__main__":
    unittest.main()
