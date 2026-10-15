"""Synthetic-only regression tests; several parser cases adapted from upstream MIT tests."""
from __future__ import annotations

import io
import hashlib
import hmac
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing, redirect_stdout
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collector import Collector, Observation, separate_paths, today_start
from demo import build_source, iso
from history import History
from monitor import main, snapshot
from token_pulse.domain import Context, Sample, PARSER_REVISION, tier
from token_pulse.logs import LogEvidence, SqliteLogs, Start, read_only
from token_pulse.projection import project
from token_pulse.rollout import Rollout
from token_pulse.stats import summarize
from token_pulse.tailer import JsonlTail


BASE = datetime(2026, 10, 13, 12, tzinfo=UTC).timestamp()


def feed(parser, second, kind, **payload):
    parser.feed(project({"timestamp": iso(BASE + second), "type": kind, "payload": payload}))


def ready():
    parser = Rollout("task")
    feed(parser, 0, "event_msg", type="task_started", turn_id="turn")
    feed(parser, 0, "turn_context", turn_id="turn", model="model-a")
    return parser


def output(parser, second=12, item="item"):
    feed(parser, second, "response_item", type="message", role="assistant", id=item, content="PRIVATE_BODY_CANARY")


def usage(parser, second=13, response="response", tokens=100):
    feed(parser, second, "token_usage_record", response_id=response, thread_id="task", turn_id="turn", usage={"output_tokens": tokens})


def timing():
    logs = LogEvidence()
    logs.starts["task", "item"] = Start(BASE + 10, "turn")
    return logs


class CoreTests(unittest.TestCase):
    def test_turn_configuration_changes_and_missing_settings_do_not_inherit(self):
        parser = ready()
        feed(parser, 1, "turn_context", turn_id="turn", model="model-a", effort="high")
        output(parser)
        # Applying settings after output began cannot relabel that output.
        feed(parser, 12.5, "turn_context", turn_id="turn", model="model-b", effort="low")
        usage(parser)
        feed(parser, 20, "event_msg", type="task_started", turn_id="second")
        feed(parser, 22, "response_item", type="message", role="assistant", id="second-item")
        feed(parser, 23, "token_usage_record", thread_id="task", turn_id="second",
             response_id="second-response", usage={"output_tokens": 100})
        feed(parser, 30, "turn_context", turn_id="third", model="model-a", effort="ultra")
        feed(parser, 32, "response_item", type="message", role="assistant", id="third-item")
        feed(parser, 33, "token_usage_record", thread_id="task", turn_id="third",
             response_id="third-response", usage={"output_tokens": 100})
        samples = parser.samples(LogEvidence())
        self.assertEqual([s.context for s in samples], [Context("model-a", "high"), Context(), Context("model-a", "ultra")])
        with self.assertRaisesRegex(ValueError, "configurations"):
            summarize([Sample("t", "u", "1", BASE, 10, BASE - 1, Context("m", "low")),
                       Sample("t", "u", "2", BASE, 10, BASE - 1, Context("m", "high"))])

    def test_requested_tier_is_time_and_turn_scoped_with_late_metadata(self):
        parser = ready()
        output(parser)
        usage(parser)
        logs = timing()
        before = parser.samples(logs)[0]
        self.assertIsNone(before.context.requested_tier)
        logs.accept("task", BASE + 9, "feedback_tags", 'turn_id="turn" stream_request{service_tier=priority}: SECRET_ACCOUNT_TAIL')
        after = parser.samples(logs)[0]
        self.assertEqual(after.context.requested_tier, "priority")
        self.assertIsNone(after.context.actual_tier)
        self.assertNotIn("SECRET", repr(logs.__dict__))
        logs.accept("task", BASE + 19, "feedback_tags", 'turn_id="turn" stream_request{service_tier=default}: ignored')
        self.assertEqual(parser.samples(logs)[0].context.requested_tier, "priority")
        logs.starts["task", "next-item"] = Start(BASE + 20, "turn")
        output(parser, 22, "next-item")
        usage(parser, 23, "next-response")
        self.assertEqual(parser.samples(logs)[-1].context.requested_tier, "default")
        logs.starts["task", "third-item"] = Start(BASE + 30, "turn")
        output(parser, 32, "third-item")
        usage(parser, 33, "third-response")
        self.assertIsNone(parser.samples(logs)[-1].context.requested_tier)
        self.assertIsNone(logs.requested_for("task", "different-turn", BASE + 30))
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as store:
            store.accept([before], BASE + 40)
            store.accept([after, after], BASE + 40)
            self.assertEqual(len(store.recent()), 1)
            self.assertEqual(store.recent()[0].context.requested_tier, "priority")
            self.assertEqual(store.recent()[0].tps, before.tps)

    def test_config_allowlist_and_conflicting_requests_remain_unknown(self):
        projected = project({"timestamp": iso(BASE), "type": "turn_context", "payload": {
            "turn_id": "turn", "model": "model-a", "effort": "unsupported", "service_tier": "priority",
            "content": "SECRET_MESSAGE_WITH_service_tier=priority",
        }})
        self.assertIsNone(projected["payload"]["effort"])
        self.assertNotIn("service_tier", projected["payload"])
        self.assertNotIn("SECRET", repr(projected))
        logs = LogEvidence()
        logs.accept("task", BASE, "feedback_tags", 'turn_id="turn" stream_request{service_tier=priority}: ignored')
        logs.accept("task", BASE, "feedback_tags", 'turn_id="turn" stream_request{service_tier=default}: ignored')
        self.assertIsNone(logs.requested_for("task", "turn", BASE + 1))
        logs.accept("task", BASE + 2, "feedback_tags", 'turn_id="turn" stream_request{service_tier=unsupported}: ignored')
        logs.accept("task", BASE + 3, "feedback_tags", 'turn_id="turn" ToolCall: stream_request{service_tier=priority}: ignored')
        self.assertIsNone(logs.requested_for("task", "turn", BASE + 4))
        self.assertEqual(tier("fast"), "priority")
        self.assertEqual(tier("standard"), "default")
        self.assertEqual(tier("auto"), "auto")
        self.assertIsNone(tier("unknown"))

    def test_late_conflict_withdraws_saved_tier_but_missing_logs_do_not(self):
        parser = ready()
        output(parser)
        usage(parser)
        logs = timing()
        logs.accept("task", BASE + 9, "feedback_tags", 'turn_id="turn" stream_request{service_tier=priority}: ignored')
        known = parser.samples(logs)[0]
        missing = parser.samples(timing())[0]
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as store:
            store.accept([known], BASE + 20)
            store.accept([missing], BASE + 20)
            self.assertEqual(store.recent()[0].context.requested_tier, "priority")
            logs.accept("task", BASE + 9, "feedback_tags", 'turn_id="turn" stream_request{service_tier=default}: ignored')
            conflicting = parser.samples(logs)[0]
            self.assertTrue(conflicting.requested_tier_withdrawn)
            self.assertIsNone(conflicting.context.requested_tier)
            store.accept([conflicting], BASE + 20)
            self.assertEqual(len(store.recent()), 1)
            self.assertEqual(store.recent()[0].tps, known.tps)
            self.assertIsNone(store.recent()[0].context.requested_tier)

    def test_exact_pairing_missing_start_and_late_repair(self):
        parser = ready()
        output(parser)
        usage(parser)
        missing = parser.samples(LogEvidence())[0]
        self.assertEqual(missing.exclusion, "missing_start")
        repaired = parser.samples(timing())[0]
        self.assertEqual(repaired.tps, 50)
        self.assertNotIn("PRIVATE_BODY_CANARY", repr(parser.__dict__))
        with tempfile.TemporaryDirectory() as root:
            store = History(Path(root))
            store.accept([missing], BASE + 20)
            store.accept([repaired, repaired], BASE + 20)
            self.assertEqual(len(store.recent()), 1)
            self.assertEqual(store.recent()[0].tps, 50)
            store.close()

    def test_duplicate_usage_and_legacy_notice_do_not_double_count(self):
        parser = ready()
        output(parser)
        usage(parser)
        usage(parser)
        feed(parser, 13, "event_msg", type="token_count", info={"last_token_usage": {"output_tokens": 100}})
        self.assertEqual(len(parser.samples(timing())), 1)

    def test_tool_wait_and_prefill_excluded(self):
        parser = ready()
        feed(parser, 11, "response_item", type="reasoning", id="item")
        feed(parser, 12, "response_item", type="custom_tool_call", id="tool", call_id="call")
        feed(parser, 40, "response_item", type="custom_tool_call_output", call_id="call", output="SECRET_TOOL_BODY")
        usage(parser, 41)
        sample = parser.samples(timing())[0]
        self.assertEqual(sample.seconds, 2)
        self.assertEqual(sample.tps, 50)

    def test_tool_first_is_excluded_even_with_start(self):
        parser = ready()
        feed(parser, 12, "response_item", type="function_call", id="item", arguments="SECRET")
        usage(parser)
        self.assertEqual(parser.samples(timing())[0].exclusion, "unconfirmed_tool_start")

    def test_item_lifecycle_works_without_diagnostic_logs(self):
        parser = ready()
        feed(parser, 12, "event_msg", type="item_completed", thread_id="task", turn_id="turn", started_at_ms=int((BASE + 10) * 1000), completed_at_ms=int((BASE + 12) * 1000), item={"id": "item", "type": "AgentMessage", "text": "SECRET"})
        output(parser)
        usage(parser)
        self.assertEqual(parser.samples(LogEvidence())[0].tps, 50)

    def test_weighted_average_and_unknown_values(self):
        values = [Sample("t", "u", "a", BASE, 100, BASE - 1, Context(model="m")),
                  Sample("t", "u", "b", BASE, 100, BASE - 9, Context(model="m")),
                  Sample("t", "u", "c", BASE, 100, None, Context(model="m"))]
        summary = summarize(values)
        self.assertEqual(summary.weighted_tps, 20)
        self.assertEqual(summary.count, 2)
        self.assertEqual(summary.excluded, 1)
        self.assertIsNone(values[-1].tps)

    def test_projection_drops_every_content_and_account_field(self):
        for record in [
            {"timestamp": iso(BASE), "type": "session_meta", "payload": {"id": "task", "cwd": "SECRET_PATH", "model_provider": "SECRET_PROVIDER"}},
            {"timestamp": iso(BASE), "type": "response_item", "payload": {"type": "message", "id": "item", "role": "assistant", "content": "SECRET_MESSAGE", "auth_mode": "SECRET_KEY"}},
            {"timestamp": iso(BASE), "type": "turn_context", "payload": {"model": "model-a", "turn_id": "turn", "effort": "SECRET_EFFORT", "service_tier": "SECRET_TIER"}},
        ]:
            self.assertNotIn("SECRET", repr(project(record)))

    def test_invalid_boundary_is_excluded_then_next_turn_recovers(self):
        parser = ready()
        parser.feed(project({"timestamp": iso(BASE + 1), "type": "event_msg", "payload": {"type": []}}))
        output(parser)
        usage(parser)
        self.assertIsNone(parser.samples(timing())[0].tps)
        feed(parser, 20, "turn_context", turn_id="next", model="model-a")
        feed(parser, 22, "response_item", type="message", role="assistant", id="next-item")
        feed(parser, 23, "token_usage_record", response_id="next-response", thread_id="task", turn_id="next", usage={"output_tokens": 100})
        logs = timing()
        logs.starts["task", "next-item"] = Start(BASE + 20, "next")
        self.assertEqual(parser.samples(logs)[-1].tps, 50)


class SourceTests(unittest.TestCase):
    def test_thread_current_model_cannot_fill_missing_historical_context(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            build_source(source, BASE)
            path = sorted(source.glob("sessions/*/*/*/*.jsonl"))[0]
            records = [json.loads(line) for line in path.read_text().splitlines()]
            records = [record for record in records if not (
                record["type"] == "turn_context" and record["payload"]["turn_id"] == "demo-turn-0"
            )]
            path.write_text("".join(json.dumps(record) + "\n" for record in records))
            collector = Collector(source)
            self.addCleanup(collector.close)
            observed = sorted(collector.poll(BASE).samples, key=lambda s: s.ended_at)
            self.assertIsNone(observed[0].context.model)
            self.assertEqual(observed[1].context.model, "gpt-6.1-sol")
            self.assertNotIn("CURRENT_MODEL_MUST_NOT_LABEL_HISTORY", repr(observed))

    def test_demo_chain_old_session_today_and_privacy(self):
        with tempfile.TemporaryDirectory() as root:
            source, data = Path(root) / "source", Path(root) / "data"
            build_source(source, BASE)
            (source / "config.toml").write_text('api_key="SECRET_CONFIG"')
            (source / "auth.json").write_text('{"secret":"SECRET_CREDENTIAL"}')
            opened = []
            actual = Path.open
            def spy(path, *args, **kwargs):
                opened.append(path.name)
                return actual(path, *args, **kwargs)
            with patch.object(Path, "open", spy):
                collector = Collector(source)
                self.addCleanup(collector.close)
                observation = collector.poll(BASE)
            self.assertEqual(len(observation.samples), 12)
            self.assertNotIn("config.toml", opened)
            self.assertNotIn("auth.json", opened)
            store = History(data)
            store.accept(observation.samples, BASE)
            result = snapshot(store, observation, "live", BASE)
            self.assertEqual(sum(s["exclusion"] is None for s in result["samples"]), 11)
            self.assertEqual(sum(s["exclusion"] is not None for s in result["samples"]), 1)
            self.assertEqual(len({s["conversationId"] for s in result["samples"]}), 4)
            self.assertEqual(result["schemaVersion"], 3)
            self.assertEqual(len(result["profiles"]), 10)
            self.assertEqual(len(result["conversations"]), 8)
            self.assertEqual(result["activeProfile"], result["samples"][-1]["profileId"])
            self.assertEqual([s["completedAt"] for s in result["samples"]], sorted(s["completedAt"] for s in result["samples"]))
            self.assertTrue(all(len(s["conversationId"]) == 64 for s in result["samples"]))
            self.assertTrue(all(p["actualTier"] is None for p in result["profiles"]))
            self.assertIn({"model": None, "effort": None, "requestedTier": None, "actualTier": None, "submittedTier": None},
                          [{key: value for key, value in p.items() if key != "id"} for p in result["profiles"]])
            first_ids = {s["conversationId"] for s in result["samples"]}
            replay = collector.poll(BASE + 1)
            store.accept(replay.samples, BASE + 1)
            again = snapshot(store, replay, "live", BASE + 1)
            self.assertEqual(len(again["samples"]), 12)
            self.assertEqual(first_ids, {s["conversationId"] for s in again["samples"]})
            self.assertNotIn("SECRET", json.dumps(result))
            self.assertNotIn("SYNTHETIC", json.dumps(result))
            store.close()
            disk = b"".join(p.read_bytes() for p in data.iterdir() if p.is_file())
            self.assertNotIn(b"00000000-0000-4000-8000-000000000001", disk)
            self.assertNotIn(b"SYNTHETIC", disk)

    def test_read_only_sqlite_and_only_timing_logs(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "logs.sqlite"
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)")
            db.executemany("INSERT INTO logs VALUES (?,?,?,?,?,?)", [
                (1, int(BASE), 0, "task", "feedback_tags", "SECRET_AUTH_AND_TIER"),
                (2, int(BASE + 10), 0, "task", "codex_core::stream_events_utils", 'turn_id="turn": Output item item_type="message" item_id="item"'),
            ])
            db.commit()
            db.close()
            connection = read_only(path)
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("DELETE FROM logs")
            connection.close()
            evidence = LogEvidence()
            adapter = SqliteLogs(path, evidence)
            self.assertIsNone(adapter.poll())
            self.assertEqual(evidence.starts["task", "item"].at, BASE + 10)
            self.assertNotIn("SECRET", repr(evidence.__dict__))
            # Truncation/replacement replays only timing rows and remains deduplicated.
            path.rename(Path(root) / "old.sqlite")
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)")
            db.execute("INSERT INTO logs VALUES (1,?,?,?,?,?)", (int(BASE + 20), 0, "task", "codex_core::stream_events_utils", 'turn_id="turn": Output item item_type="message" item_id="next"'))
            db.commit()
            db.close()
            self.assertIsNone(adapter.poll())
            self.assertIn(("task", "next"), evidence.starts)
            self.assertIn(("task", "item"), evidence.starts)

    def test_partial_malformed_and_rotation(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "events.jsonl"
            line = (json.dumps({"timestamp": iso(BASE), "type": "turn_context", "payload": {"model": "model-a", "turn_id": "turn", "private": "隐私"}}, ensure_ascii=False) + "\r\n").encode("utf-8")
            path.write_bytes(line[:-3])
            tail = JsonlTail(path)
            self.assertEqual(tail.read().records, [])
            with path.open("ab") as stream:
                stream.write(line[-3:] + b"broken\n")
            batch = tail.read()
            self.assertEqual(len(batch.records), 1)
            self.assertEqual(batch.malformed, 1)
            self.assertNotIn("隐私", repr(batch.records))
            self.assertNotIn("隐私".encode(), tail.anchor)
            path.write_bytes(line + line)
            batch = tail.read()
            self.assertTrue(batch.reset)
            self.assertEqual(len(batch.records), 2)

    def test_changed_source_symlink_cannot_redirect_read(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            build_source(source, BASE)
            collector = Collector(source)
            self.addCleanup(collector.close)
            collector.poll(BASE)
            tail = next(iter(collector.watched.values()))[0]
            original = tail.path
            outside = Path(root) / "outside.jsonl"
            outside.write_text("SECRET_EXTERNAL_DATA")
            original.unlink()
            try:
                original.symlink_to(outside)
            except OSError:
                self.skipTest("Windows host does not permit test symlink creation")
            observed = collector.poll(BASE + 1)
            self.assertIn("source_unavailable", observed.issues)
            self.assertNotIn("SECRET", repr(observed))

    def test_overlap_and_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            source.mkdir()
            with self.assertRaises(ValueError):
                separate_paths(source, source / "data")
            with self.assertRaises(ValueError):
                separate_paths(source, source.parent)
            link = Path(root) / "link"
            try:
                link.symlink_to(source, target_is_directory=True)
            except OSError:
                self.skipTest("Windows host does not permit test symlink creation")
            with self.assertRaises(ValueError):
                separate_paths(source, link / "data")


class HistoryTests(unittest.TestCase):
    def test_legacy_migration_preserves_identity_measurement_and_reenriches(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            salt = bytes(range(32))
            (path / "identity.salt").write_bytes(salt)
            identities = tuple(hmac.new(salt, value.encode(), hashlib.sha256).hexdigest()
                               for value in ("PRIVATE_TASK", "PRIVATE_TURN", "PRIVATE_RESPONSE"))
            connection = sqlite3.connect(path / "history.sqlite")
            connection.execute("""CREATE TABLE samples (
                task TEXT,turn TEXT,response TEXT,ended REAL NOT NULL,tokens INTEGER,
                started REAL,model TEXT,issue TEXT,revision INTEGER NOT NULL,timing TEXT,
                PRIMARY KEY(task,turn,response))""")
            connection.execute("INSERT INTO samples VALUES (?,?,?,?,?,?,?,?,?,?)",
                               (*identities, BASE, 100, BASE - 2, "unsafe-current-model", None, 4, "item-event"))
            connection.commit()
            connection.close()
            actual_connect = sqlite3.connect
            class InterruptedUpgrade(sqlite3.Connection):
                def execute(self, sql, *args, **kwargs):
                    if sql == "ALTER TABLE samples ADD COLUMN requested_tier TEXT":
                        raise sqlite3.OperationalError("synthetic interrupted upgrade")
                    return super().execute(sql, *args, **kwargs)
            with patch("history.sqlite3.connect", lambda *args, **kwargs: actual_connect(*args, **kwargs, factory=InterruptedUpgrade)):
                with self.assertRaises(sqlite3.OperationalError):
                    History(path)
            with closing(actual_connect(path / "history.sqlite")) as rolled_back:
                self.assertNotIn("effort", {row[1] for row in rolled_back.execute("PRAGMA table_info(samples)")})
                self.assertEqual(rolled_back.execute("SELECT model FROM samples").fetchone()[0], "unsafe-current-model")
            store = History(path)
            migrated = store.recent()[0]
            self.assertEqual(migrated.key, identities)
            self.assertEqual(migrated.tps, 50)
            self.assertEqual(migrated.context, Context())
            corrected = Sample("PRIVATE_TASK", "PRIVATE_TURN", "PRIVATE_RESPONSE", BASE, 100, BASE - 2,
                               Context("observed-model", "high", "priority"), parser_revision=PARSER_REVISION,
                               timing_source="item-event")
            store.accept([corrected, corrected], BASE)
            self.assertEqual(len(store.recent()), 1)
            self.assertEqual(store.recent()[0].context, corrected.context)
            self.assertEqual(store.recent()[0].key, identities)
            self.assertEqual(store.recent()[0].tps, 50)
            store.close()
            with closing(History(path)) as reopened:
                self.assertEqual(reopened.recent()[0].context, corrected.context)

    def test_retained_history_stays_visible_without_current_source(self):
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as store:
            sample = Sample("task", "turn", "response", BASE - 86400, 100, BASE - 86402,
                            Context("model-a", "high", "priority"))
            store.accept([sample], BASE)
            result = snapshot(store, Observation([], [], False, False, set()), "live", BASE)
            self.assertEqual(result["status"], "waiting")
            self.assertEqual(len(result["samples"]), 1)
            self.assertIsNotNone(result["activeProfile"])

    def test_restart_replay_dedup_and_withdrawal(self):
        with tempfile.TemporaryDirectory() as root:
            sample = Sample("PRIVATE_TASK", "PRIVATE_TURN", "PRIVATE_RESPONSE", BASE, 100, BASE - 2, Context(model="model-a"), parser_revision=4)
            store = History(Path(root))
            store.accept([sample], BASE)
            store.close()
            store = History(Path(root))
            store.accept([sample], BASE)
            self.assertEqual(len(store.recent()), 1)
            withdrawn = Sample("PRIVATE_TASK", "PRIVATE_TURN", "PRIVATE_RESPONSE", BASE, 100, BASE - 2, Context(model="model-a"), issue="inherited_history", parser_revision=4)
            store.accept([withdrawn], BASE)
            self.assertEqual(store.recent(), [])
            store.close()

    def test_retention_age_count_and_local_day(self):
        with tempfile.TemporaryDirectory() as root:
            store = History(Path(root))
            old = Sample("t", "u", "old", BASE - 31 * 86400, 100, BASE - 31 * 86400 - 1, Context(model="m"))
            values = [Sample("t", "u", str(i), BASE - 10001 + i, 10, BASE - 10002 + i, Context(model="m")) for i in range(10001)]
            store.accept([old, *values], BASE)
            self.assertEqual(len(store.recent()), 10000)
            self.assertTrue(all(s.ended_at >= BASE - 30 * 86400 for s in store.recent()))
            self.assertTrue(all(s.ended_at >= today_start(BASE) for s in store.today(BASE)))
            store.close()

    def test_midnight_is_local_not_utc(self):
        expected = datetime.fromtimestamp(BASE).astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        self.assertEqual(today_start(BASE), expected.timestamp())

    def test_demo_cli_isolation_and_error_redaction(self):
        with tempfile.TemporaryDirectory() as root:
            forbidden = Path(root) / "must-not-touch"
            output = io.StringIO()
            with redirect_stdout(output):
                code = main(["--mode", "demo", "--codex-home", str(forbidden), "--scratch-dir", str(forbidden), "--once"])
            result = json.loads(output.getvalue())
            self.assertEqual(code, 0)
            self.assertEqual(result["mode"], "demo")
            self.assertFalse(forbidden.exists())
            output = io.StringIO()
            with redirect_stdout(output):
                code = main(["--mode", "live", "--codex-home", str(forbidden), "--data-dir", str(forbidden / "SECRET_PATH"), "--once"])
            self.assertEqual(code, 1)
            self.assertNotIn("SECRET_PATH", output.getvalue())
            self.assertNotIn(root, output.getvalue())

    def test_desktop_owns_demo_temporary_directory(self):
        with tempfile.TemporaryDirectory(prefix="codex-tps-demo-") as root:
            output = io.StringIO()
            with redirect_stdout(output):
                code = main(["--mode", "demo", "--data-dir", str(Path(root) / "data"), "--once"])
            self.assertEqual(code, 0)
            self.assertTrue((Path(root) / "data" / "history.sqlite").exists())
            self.assertTrue((Path(root) / "source" / "state_5.sqlite").exists())


if __name__ == "__main__":
    unittest.main()
