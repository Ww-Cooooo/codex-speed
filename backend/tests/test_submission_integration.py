"""Synthetic end-to-end submission provenance and history upgrade checks."""
from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from dataclasses import replace
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from history import History
from token_pulse.domain import Context, Sample, PARSER_REVISION
from token_pulse.logs import LogEvidence, SqliteLogs
from token_pulse.submitted_settings import TARGET, project_submitted_settings
from test_backend import BASE, output, ready, timing, usage
from test_submitted_settings import submission


class SubmissionIntegrationTests(unittest.TestCase):
    def test_exact_turn_timestamp_and_missing_start_do_not_guess(self):
        parser = ready()
        output(parser)
        usage(parser)
        evidence = timing()
        evidence.accept("other", BASE + 8, TARGET, submission(task="other"))
        evidence.accept("task", BASE + 8, TARGET, submission(turn="other-turn"))
        evidence.accept("task", BASE + 11, TARGET, submission())
        self.assertIsNone(parser.samples(evidence)[0].context.submitted_tier)
        evidence.accept("task", BASE + 9, TARGET, submission())
        sample = parser.samples(evidence)[0]
        self.assertEqual(sample.context.submitted_tier, "priority")
        self.assertIsNone(sample.context.requested_tier)
        self.assertIsNone(sample.context.actual_tier)
        missing = LogEvidence()
        missing.accept("task", BASE + 9, TARGET, submission())
        self.assertIsNone(parser.samples(missing)[0].context.submitted_tier)
        self.assertNotIn("PRIVATE_INPUT_CANARY", repr(evidence.__dict__))

    def test_late_clear_withdraws_but_missing_evidence_preserves_history(self):
        parser = ready()
        output(parser)
        usage(parser)
        evidence = timing()
        evidence.accept("task", BASE + 9, TARGET, submission())
        known = parser.samples(evidence)[0]
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as store:
            store.accept([known], BASE + 20)
            store.accept(parser.samples(timing()), BASE + 20)
            self.assertEqual(store.recent()[0].context.submitted_tier, "priority")
            evidence.accept("task", BASE + 9, TARGET, submission("Some(None)"))
            withdrawn = parser.samples(evidence)[0]
            self.assertIsNone(withdrawn.context.submitted_tier)
            self.assertTrue(withdrawn.submitted_tier_withdrawn)
            store.accept([withdrawn], BASE + 20)
            self.assertEqual(len(store.recent()), 1)
            self.assertIsNone(store.recent()[0].context.submitted_tier)
            self.assertEqual(store.recent()[0].tps, known.tps)
            self.assertEqual(store.recent()[0].context.model, known.context.model)

    def test_sql_projection_keeps_short_request_prefix_and_private_input_ephemeral(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "logs.sqlite"
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)")
                connection.executemany("INSERT INTO logs VALUES (?,?,?,?,?,?)", [
                    (1, int(BASE + 9), 0, "task", TARGET, submission()),
                    (2, int(BASE + 9), 0, "task", "feedback_tags", 'turn_id="turn" stream_request{service_tier=priority}: ' + "PRIVATE_TAIL" * 3000),
                    (3, int(BASE + 10), 0, "task", "codex_core::stream_events_utils", 'turn_id="turn": Output item item_type="message" item_id="item"'),
                    (4, int(BASE + 9), 0, "task", TARGET, submission(text="x" * 16000)),
                    (5, int(BASE + 9), 0, "task", TARGET, "OTHER_HANDLER_PRIVATE_CANARY"),
                ])
                connection.commit()
            evidence = LogEvidence()
            with patch("token_pulse.logs.project_submitted_settings", wraps=project_submitted_settings) as projector:
                self.assertIsNone(SqliteLogs(path, evidence).poll())
                self.assertEqual(projector.call_count, 1)
            parser = ready()
            output(parser)
            usage(parser)
            sample = parser.samples(evidence)[0]
            self.assertEqual((sample.context.requested_tier, sample.context.submitted_tier), ("priority", "priority"))
            self.assertEqual(evidence.submission_count, 1)
            self.assertNotIn("PRIVATE", repr(evidence.__dict__))
            data = Path(root) / "history"
            with closing(History(data)) as store:
                store.accept([sample], BASE + 20)
            disk = b"".join(item.read_bytes() for item in data.iterdir() if item.is_file())
            self.assertNotIn(b"PRIVATE", disk)

    def test_additive_upgrade_preserves_existing_v5_configuration(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root)
            sample = Sample("task", "turn", "response", BASE, 100, BASE - 2,
                            Context("model-a", "high", "priority"), parser_revision=PARSER_REVISION)
            with closing(History(data)) as store:
                store.accept([sample], BASE)
                previous = store.recent()[0]
            with closing(sqlite3.connect(data / "history.sqlite")) as connection:
                connection.execute("ALTER TABLE samples DROP COLUMN submitted_tier")
                connection.commit()
            with closing(History(data)) as upgraded:
                restored = upgraded.recent()[0]
                self.assertEqual(restored, previous)
                enriched = Sample("task", "turn", "response", BASE, 100, BASE - 2,
                                  Context("model-a", "high", "priority", submitted_tier="priority"))
                upgraded.accept([enriched], BASE)
                self.assertEqual(len(upgraded.recent()), 1)
                self.assertEqual(upgraded.recent()[0].context.submitted_tier, "priority")
                self.assertEqual(upgraded.recent()[0].tps, previous.tps)

    def test_withdrawals_survive_restart_and_earlier_metadata_replay(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root)
            known = Sample("task", "turn", "response", BASE, 100, BASE - 2,
                           Context("model-a", "high", "priority", submitted_tier="priority"))
            withdrawn = replace(known, context=Context("model-a", "high"),
                                requested_tier_withdrawn=True, submitted_tier_withdrawn=True)
            with closing(History(data)) as store:
                store.accept([known, withdrawn, known], BASE)
                self.assertIsNone(store.recent()[0].context.requested_tier)
                self.assertIsNone(store.recent()[0].context.submitted_tier)
            with closing(History(data)) as reopened:
                reopened.accept([known], BASE)
                result = reopened.recent()[0]
                self.assertTrue(result.requested_tier_withdrawn)
                self.assertTrue(result.submitted_tier_withdrawn)
                self.assertIsNone(result.context.requested_tier)
                self.assertIsNone(result.context.submitted_tier)
                self.assertEqual(result.tps, known.tps)
                reopened.accept([replace(known, parser_revision=PARSER_REVISION + 1)], BASE)
                corrected = reopened.recent()[0]
                self.assertEqual(corrected.context.requested_tier, "priority")
                self.assertEqual(corrected.context.submitted_tier, "priority")
                self.assertFalse(corrected.requested_tier_withdrawn)
                self.assertFalse(corrected.submitted_tier_withdrawn)


if __name__ == "__main__":
    unittest.main()
