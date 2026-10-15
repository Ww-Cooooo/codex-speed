"""Privacy-reduced adapter for output timing and speed-setting provenance.

Adapted from TokenPulse edc27b1 (MIT). No account/auth fields are retained.
SQL removes feedback tails and caps timing / structural submission bodies.
"""
from __future__ import annotations

import re
import sqlite3
from collections import OrderedDict
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from sqlite_snapshot import DatabaseMirrors, read_only
from token_pulse.domain import tier
from token_pulse.submitted_settings import SubmittedSettings, project_submitted_settings, TARGET as SUBMITTED_TARGET

_START = re.compile(r'^Output item item_type="(reasoning|message|function_call|custom_tool_call)" item_id="([\w-]{1,160})"$')
_TURN = re.compile(r'(?:turn\.id|turn_id)="?([\w-]{1,100})')
TARGET = "codex_core::stream_events_utils"
REQUEST_TARGET = "feedback_tags"
_BODY_SQL = """CASE
    WHEN target='feedback_tags' THEN
        CASE WHEN instr(feedback_log_body,': ')>0 AND instr(feedback_log_body,': ')-1<=2400
             THEN substr(feedback_log_body,1,instr(feedback_log_body,': ')-1)||': ' END
    WHEN target='codex_core::session::handlers' THEN
        CASE WHEN length(feedback_log_body)<=16000
                  AND feedback_log_body GLOB 'session_loop{thread_id=*}: Submission sub=Submission {*'
             THEN feedback_log_body END
    ELSE CASE WHEN length(feedback_log_body)<=2400 THEN feedback_log_body END END"""


def label(value: object) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"[\w. -]{1,100}", value) else None


@dataclass(frozen=True)
class Start:
    at: float
    turn_id: str
    ambiguous: bool = False


@dataclass(frozen=True)
class Request:
    at: float
    tier: str | None


class LogEvidence:
    def __init__(self, capacity: int = 40000):
        self.starts: OrderedDict[tuple[str, str], Start] = OrderedDict()
        self.requests: OrderedDict[tuple[str, str], tuple[Request, ...]] = OrderedDict()
        self.request_count = 0
        self.submissions: OrderedDict[tuple[str, str], tuple[SubmittedSettings, ...]] = OrderedDict()
        self.submission_count = 0
        self.capacity = capacity

    def accept(self, task: str, at: float, target: str, body: str) -> None:
        if target not in {TARGET, REQUEST_TARGET, SUBMITTED_TARGET} or not task or len(task) > 160:
            return
        if target == SUBMITTED_TARGET:
            submitted = project_submitted_settings(task, at, target, body)
            if submitted is not None:
                key = submitted.thread_id, submitted.turn_id
                previous = self.submissions.get(key, ())
                same = next((value for value in previous
                             if (value.state, value.tier) == (submitted.state, submitted.tier)), None)
                if same is None or submitted.at < same.at:
                    # Only the earliest timestamp of each distinct allowlisted
                    # setting is needed. Repeated copies cannot evict a conflict.
                    values = tuple(sorted((*(value for value in previous if value is not same), submitted),
                                          key=lambda value: value.at))
                    self.submissions[key] = values
                    self.submissions.move_to_end(key)
                    self.submission_count += len(values) - len(previous)
                    while self.submission_count > self.capacity:
                        _, expired = self.submissions.popitem(last=False)
                        self.submission_count -= len(expired)
            return
        if target == REQUEST_TARGET:
            # Drop arbitrary feedback tails before applying the prefix budget.
            # A long account/diagnostic tail must not discard a short safe span.
            prefix, separator, _ = body.partition(": ")
            body = prefix + separator
        if len(body) > (2402 if target == REQUEST_TARGET else 2400):
            return
        prefix, _, tail = body.rpartition(": ")
        if not prefix or "handle_output_item_done" in prefix or "ToolCall:" in body:
            return
        turn = _TURN.search(prefix[:2000])
        if target == REQUEST_TARGET:
            request = re.search(r"\bstream_request\{([^{}]*)\}", prefix[:2000])
            observed = re.search(r'\bservice_tier="?([a-z_-]+)\b', request[1]) if request else None
            requested = tier(observed[1]) if observed else None
            if turn and request:
                key = task, turn[1]
                previous = self.requests.get(key, ())
                same = next((r for r in previous if r.at == at), None)
                value = Request(at, requested if same is None or same.tier == requested else None)
                values = tuple(sorted((r for r in previous if r.at != at), key=lambda r: r.at)) + (value,)
                values = tuple(sorted(values, key=lambda r: r.at))[-32:]
                self.requests[key] = values
                self.requests.move_to_end(key)
                self.request_count += len(values) - len(previous)
                while self.request_count > self.capacity:
                    _, expired = self.requests.popitem(last=False)
                    self.request_count -= len(expired)
            return
        match = _START.fullmatch(tail)
        if not turn or not match:
            return
        key = task, match[2]
        prior = self.starts.get(key)
        conflict = prior is not None and (prior.ambiguous or (prior.at, prior.turn_id) != (at, turn[1]))
        self.starts[key] = Start(prior.at if prior else at, prior.turn_id if prior else turn[1], conflict)
        self.starts.move_to_end(key)
        while len(self.starts) > self.capacity:
            self.starts.popitem(last=False)

    def request_for(self, task: str, turn: str, start: float | None,
                    after: float | None = None) -> Request | None:
        if start is None:
            return None
        # A prior response's request cannot label a later output whose own
        # request was not observed. This also avoids future settings backfill.
        eligible = [r for r in self.requests.get((task, turn), ())
                    if r.at <= start + .001 and (after is None or r.at > after)]
        return eligible[-1] if eligible else None

    def requested_for(self, task: str, turn: str, start: float | None,
                      after: float | None = None) -> str | None:
        request = self.request_for(task, turn, start, after)
        return request.tier if request else None

    def submitted_for(self, task: str, turn: str, start: float | None) -> SubmittedSettings | None:
        if start is None:
            return None
        eligible = [value for value in self.submissions.get((task, turn), ()) if value.at <= start + .001]
        if not eligible:
            return None
        latest = eligible[-1]
        if len({(value.state, value.tier) for value in eligible}) > 1:
            # The same submission identity cannot establish contradictory
            # settings. Keep an unknown boundary so late evidence withdraws it.
            return SubmittedSettings(task, turn, latest.at, None, "absent")
        return latest


class SqliteLogs:
    def __init__(self, path: Path, evidence: LogEvidence, mirrors: DatabaseMirrors | None = None):
        self.path, self.evidence = path, evidence
        self.mirrors = mirrors
        self.cursor: int | None = None
        self.identity: tuple[int, int] | None = None
        self.source_fingerprint = None

    def poll(self) -> str | None:
        try:
            stat = self.path.stat()
            identity = stat.st_dev, stat.st_ino
            fingerprint = self.mirrors.source_fingerprint(self.path) if self.mirrors else None
            if fingerprint is not None and fingerprint == self.source_fingerprint:
                return None
            with closing(read_only(self.path, self.mirrors)) as connection:
                maximum = connection.execute("SELECT MAX(id) FROM logs").fetchone()[0] or 0
                if self.cursor is None or identity != self.identity or maximum < self.cursor:
                    self.cursor = 0
                    # Retain bounded timing evidence across rotation. Existing parsed
                    # output still needs it; conflicts remain explicitly ambiguous.
                    rows = connection.execute(
                        "SELECT id, ts, ts_nanos, thread_id, target, "
                        + _BODY_SQL + " FROM logs WHERE id IN (SELECT id FROM logs WHERE target IN (?,?,?) "
                        "ORDER BY id DESC LIMIT 40000) ORDER BY id", (TARGET, REQUEST_TARGET, SUBMITTED_TARGET),
                    )
                    self._rows(rows)
                    self.cursor = maximum
                else:
                    rows = connection.execute(
                        "SELECT id, ts, ts_nanos, thread_id, target, "
                        + _BODY_SQL + " FROM logs WHERE id>? AND target IN (?,?,?) ORDER BY id LIMIT 10000",
                        (self.cursor, TARGET, REQUEST_TARGET, SUBMITTED_TARGET),
                    )
                    count = self._rows(rows)
                    if count < 10000:
                        self.cursor = maximum
                self.identity = identity
                if self.cursor >= maximum:
                    self.source_fingerprint = fingerprint
        except (OSError, sqlite3.Error, TypeError, ValueError):
            return "logs_unavailable"
        return None

    def _rows(self, rows) -> int:
        count = 0
        for row_id, seconds, nanos, task, target, body in rows:
            count += 1
            self.cursor = row_id
            if (isinstance(body, str) and isinstance(task, str)
                    and type(seconds) in (int, float) and type(nanos) in (int, float)
                    and 0 <= seconds <= 2**53 and 0 <= nanos < 1e9):
                self.evidence.accept(task, seconds + nanos / 1e9, target, body)
        return count
