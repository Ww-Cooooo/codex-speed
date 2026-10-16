"""Synthetic timing corrections must also withdraw persisted speed readings."""
from __future__ import annotations

import sys
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collector import Observation
from demo import iso
from history import History
from monitor import snapshot
from token_pulse.domain import PARSER_REVISION
from token_pulse.logs import LogEvidence, TARGET
from token_pulse.projection import project
from token_pulse.rollout import Rollout
from token_pulse.stats import summarize


BASE = 1791892800.0


def feed(parser: Rollout, second: float, kind: str, **payload) -> None:
    parser.feed(project({"timestamp": iso(BASE + second), "type": kind, "payload": payload}))


def completed_output(*, two_items: bool = False) -> Rollout:
    parser = Rollout("task")
    feed(parser, 0, "event_msg", type="task_started", turn_id="turn")
    feed(parser, 0, "turn_context", turn_id="turn", model="model-a", effort="high")
    if two_items:
        feed(parser, 11, "response_item", type="reasoning", id="first")
    feed(parser, 12, "response_item", type="message", role="assistant", id="item")
    feed(parser, 13, "token_usage_record", thread_id="task", turn_id="turn",
         response_id="response", usage={"output_tokens": 100})
    return parser


def start(evidence: LogEvidence, second: float, item: str = "item", kind: str = "message") -> None:
    evidence.accept("task", BASE + second, TARGET,
                    f'turn_id="turn": Output item item_type="{kind}" item_id="{item}"')


class HistoryCorrectionTests(unittest.TestCase):
    def test_late_conflicting_start_withdraws_snapshot_and_average(self):
        parser, evidence = completed_output(), LogEvidence()
        start(evidence, 10)
        initial = parser.samples(evidence)[0]
        self.assertEqual(initial.tps, 50)
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as store:
            store.accept([initial], BASE + 20)
            start(evidence, 11)
            conflicting = parser.samples(evidence)[0]
            self.assertEqual(conflicting.issue, "ambiguous_response")
            store.accept([conflicting], BASE + 20)
            persisted = store.recent()
            self.assertIsNone(persisted[0].tps)
            summary = summarize(persisted)
            self.assertEqual((summary.count, summary.excluded, summary.weighted_tps), (0, 1, None))
            result = snapshot(store, Observation([], [], True, False, set()), "live", BASE + 20)
            self.assertIsNone(result["samples"][0]["tps"])
            self.assertEqual(result["samples"][0]["exclusion"], "ambiguous_response")

    def test_late_item_start_after_its_output_withdraws_old_measurement(self):
        parser, evidence = completed_output(two_items=True), LogEvidence()
        start(evidence, 10, "first", "reasoning")
        initial = parser.samples(evidence)[0]
        self.assertEqual(initial.tps, 50)
        start(evidence, 13)
        conflicting = parser.samples(evidence)[0]
        self.assertEqual(conflicting.issue, "invalid_duration")
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as store:
            store.accept([initial, conflicting], BASE + 20)
            self.assertEqual(store.recent()[0].exclusion, "invalid_duration")
            self.assertIsNone(store.recent()[0].tps)

    def test_timing_withdrawal_survives_restart_missing_evidence_and_old_valid_copies(self):
        parser, evidence = completed_output(), LogEvidence()
        start(evidence, 10)
        initial = parser.samples(evidence)[0]
        missing = parser.samples(LogEvidence())[0]
        self.assertEqual(missing.exclusion, "missing_start")
        with tempfile.TemporaryDirectory() as root:
            for issue in ("ambiguous_response", "invalid_duration"):
                data = Path(root) / issue
                with closing(History(data)) as store:
                    store.accept([initial, replace(initial, issue=issue)], BASE + 20)
                with closing(History(data)) as reopened:
                    reopened.accept([missing, initial, replace(initial, parser_revision=PARSER_REVISION - 1)], BASE + 20)
                    retained = reopened.recent()[0]
                    self.assertEqual(retained.exclusion, issue)
                    self.assertIsNone(retained.tps)

    def test_missing_start_preserves_good_history_and_newer_parser_can_repair(self):
        parser, evidence = completed_output(), LogEvidence()
        start(evidence, 10)
        initial = parser.samples(evidence)[0]
        with tempfile.TemporaryDirectory() as root, closing(History(Path(root))) as store:
            store.accept([initial, parser.samples(LogEvidence())[0]], BASE + 20)
            self.assertEqual(store.recent()[0].tps, 50)
            store.accept([replace(initial, issue="ambiguous_response")], BASE + 20)
            newer = replace(initial, parser_revision=PARSER_REVISION + 1)
            store.accept([newer, replace(initial, issue="invalid_duration")], BASE + 20)
            persisted = store.recent()[0]
            self.assertEqual(persisted.tps, 50)
            self.assertEqual(persisted.parser_revision, PARSER_REVISION + 1)
            self.assertIsNone(persisted.exclusion)


if __name__ == "__main__":
    unittest.main()
