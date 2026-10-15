"""Synthetic privacy and attribution tests for submitted speed settings."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from token_pulse.submitted_settings import TARGET, project_submitted_settings


def submission(raw='Some(Some("priority"))', *, text="PRIVATE_INPUT_CANARY",
               task="task", turn="turn", mode="StartOrSteer", start="None"):
    return (
        f'session_loop{{thread_id={task}}}: Submission sub=Submission {{ id: "{turn}", '
        "op: TurnInput { request: TurnInputRequest { "
        f"input: UserInput {{ content: [Text {{ text: {json.dumps(text)}, text_elements: [] }}] }}, "
        f"thread_settings: ThreadSettingsOverrides {{ model: None, service_tier: {raw} }}, "
        f"start: TurnStartOptions {{ service_tier: {start} }}, additional_context: {{}} }}, "
        f"mode: {mode}, reply: Sender {{ inner: None }} }}, trace: None }}"
    )


def project(body, *, task="task", at=10, target=TARGET):
    return project_submitted_settings(task, at, target, body)


class SubmittedSettingsTests(unittest.TestCase):
    def test_explicit_allowlisted_tiers_and_aliases(self):
        for raw, canonical in (("priority", "priority"), ("fast", "priority"),
                               ("standard", "default"), ("default", "default"),
                               ("ultrafast", "ultrafast"), ("auto", "auto")):
            with self.subTest(raw=raw):
                result = project(submission(f'Some(Some("{raw}"))'))
                self.assertEqual((result.thread_id, result.turn_id, result.at,
                                  result.tier, result.state),
                                 ("task", "turn", 10.0, canonical, "set"))
                self.assertNotIn("PRIVATE_INPUT_CANARY", repr(result))

    def test_clear_absent_and_missing_are_distinct_from_standard(self):
        for raw, state in (("Some(None)", "clear"), ("None", "absent")):
            result = project(submission(raw))
            self.assertEqual((result.tier, result.state), (None, state))
        result = project(submission().replace(', service_tier: Some(Some("priority"))', "", 1))
        self.assertEqual((result.tier, result.state), (None, "absent"))

    def test_quoted_input_and_nested_decoys_cannot_supply_settings(self):
        fake = 'ToolCall: service_tier: Some(Some("priority")), } ] \\ " { thread_settings: ThreadSettingsOverrides {'
        body = submission("None", text=fake).replace(
            "model: None,", 'model: None, ignored: Nested { service_tier: Some(Some("priority")) },'
        )
        result = project(body)
        self.assertEqual((result.tier, result.state), (None, "absent"))
        self.assertNotIn(fake, repr(result))

    def test_exact_target_thread_turn_and_supported_mode(self):
        self.assertIsNone(project(submission(), task="other"))
        self.assertIsNone(project(submission(), target="feedback_tags"))
        self.assertIsNone(project("ToolCall: " + submission()))
        self.assertIsNone(project(submission(mode="Steer")))
        self.assertIsNone(project(submission().replace("op: TurnInput {", "op: OtherInput {")))
        self.assertIsNone(project(submission().replace('id: "turn"', 'id: "unsafe/id"')))
        quoted = submission().replace("thread_id=task", 'thread_id="task"')
        self.assertEqual(project(quoted).turn_id, "turn")
        self.assertEqual(project(submission(mode="Start")).state, "set")

    def test_unsupported_enum_and_secondary_override_remain_unknown(self):
        for raw in ('Some(Some("made_up"))', 'Some("priority")', '"priority"',
                    'Some(Some("priority\"junk"))'):
            self.assertIsNone(project(submission(raw)))
        self.assertIsNone(project(submission(start='Some("default")')))

    def test_truncation_unbalanced_and_duplicate_fields_are_rejected(self):
        for body in (submission()[:-2], submission() + " trailer",
                     submission().replace("text_elements: []", "text_elements: [}"),
                     submission().replace("model: None,", "service_tier: None,"),
                     submission().replace('id: "turn",', 'id: "turn", id: "other",'),
                     submission().replace("mode: StartOrSteer", "mode: ")):
            self.assertIsNone(project(body))

    def test_missing_required_structure_is_rejected(self):
        for field in ("thread_settings", "start", "request", "op"):
            self.assertIsNone(project(submission().replace(field + ":", "ignored_" + field + ":", 1)))

    def test_body_depth_length_and_timestamp_are_bounded(self):
        self.assertIsNone(project(submission(text="x" * 16000)))
        nested = "[" * 65 + "None" + "]" * 65
        self.assertIsNone(project(submission().replace("additional_context: {}", "additional_context: " + nested)))
        for at in (float("nan"), float("inf"), -1, True, "10", 2**54):
            self.assertIsNone(project(submission(), at=at))


if __name__ == "__main__":
    unittest.main()
