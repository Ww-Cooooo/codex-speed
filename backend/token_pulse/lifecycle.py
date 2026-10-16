"""Read current lifecycle independently of full, measurement-preserving replay.

The suffix is not assumed to belong to its filename: forked rollouts can contain
ancestor history. Only an explicit own-session/own-thread boundary establishes
ownership. This reader never supplies measurements to history.
"""
from __future__ import annotations

from collections import deque
from pathlib import Path

from token_pulse.domain import Task
from token_pulse.logs import LogEvidence
from token_pulse.rollout import Rollout, timestamp
from token_pulse.tailer import Batch, JsonlTail

CURRENT_WINDOW_BYTES = 256 * 1024
CURRENT_WINDOWS = (CURRENT_WINDOW_BYTES, 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024)
CURRENT_EXTRA_BUDGET_BYTES = CURRENT_WINDOWS[-1]
MAX_UNOWNED_RECORDS = 512


class CurrentLifecycle:
    def __init__(self, task_id: str, path: Path):
        self.task_id = task_id
        self.tail = JsonlTail(path, budget=CURRENT_WINDOW_BYTES, backfill=CURRENT_WINDOW_BYTES)
        self.window = CURRENT_WINDOW_BYTES
        self.source_size = 0
        self.reset()

    def reset(self) -> None:
        self.owned = False
        self.parser = Rollout(self.task_id)
        self.unowned: deque[dict] = deque(maxlen=MAX_UNOWNED_RECORDS)

    def feed(self, record: dict) -> None:
        kind, value = record.get("type"), record.get("payload")
        if not isinstance(value, dict):
            # A missing record could have been an ownership boundary.
            self.reset()
            return
        event = value.get("type")
        if kind == "session_meta":
            if value.get("id") != self.task_id:
                self.reset()
                return
            self.owned = True
            self.unowned.clear()
        elif kind == "event_msg" and event == "thread_settings_applied":
            if value.get("thread_id") == self.task_id:
                self.owned = True
                self.unowned.clear()
            elif isinstance(value.get("thread_id"), str):
                self.reset()
                return
        elif ((kind == "event_msg" and event == "item_completed")
              or kind == "token_usage_record"):
            owner = value.get("thread_id")
            if isinstance(owner, str) and owner != self.task_id:
                self.reset()
                return
            turn = value.get("turn_id")
            if owner == self.task_id and not self.owned and isinstance(turn, str) and 0 < len(turn) <= 200:
                # An own-thread output proves its turn's attribution. Recover
                # state/config only from the same turn's nearest real boundary
                # within this bounded suffix, never from an ancestor turn.
                buffered = list(self.unowned)
                boundary = next((index for index in range(len(buffered) - 1, -1, -1)
                                 if buffered[index]["payload"].get("turn_id") == turn
                                 and (buffered[index]["type"] == "turn_context"
                                      or buffered[index]["type"] == "event_msg"
                                      and buffered[index]["payload"].get("type") == "task_started")), None)
                self.owned = True
                self.unowned.clear()
                if boundary is not None:
                    for previous in buffered[boundary:]:
                        self._feed_owned(previous)
        if self.owned:
            self._feed_owned(record)
        else:
            self.unowned.append(record)

    def _feed_owned(self, record: dict) -> None:
        at = timestamp(record.get("timestamp"))
        if at is not None and at < self.parser.updated_at - .001:
            # A delayed older record cannot replace a newer observed lifecycle.
            # Measurement replay still sees every record and validates ordering.
            return
        self.parser.feed(record)

    def poll(self) -> Batch:
        try:
            stat = self.tail.path.stat()
        except OSError:
            self.source_size = 0
            self.reset()
            return Batch(error="source_unavailable")
        if self.tail.identity is not None and (
                self.tail.identity != (stat.st_dev, stat.st_ino)
                or stat.st_size < self.tail.offset
                or stat.st_size - self.tail.offset > CURRENT_WINDOW_BYTES):
            # A burst must not turn the current-state reader into another slow
            # history replay. Start at the latest suffix and re-prove ownership.
            self.tail = JsonlTail(self.tail.path, budget=CURRENT_WINDOW_BYTES, backfill=CURRENT_WINDOW_BYTES)
            self.window = CURRENT_WINDOW_BYTES
            self.reset()
        batch = self.tail.read()
        if batch.reset or batch.skipped_prefix:
            self.window = CURRENT_WINDOW_BYTES
        self._consume(batch)
        return batch

    def next_window(self) -> tuple[int, int] | None:
        if (self.tail.identity is None or self.source_size <= self.window
                or self.owned and self.parser.updated_at > 0):
            return None
        # A failed window is tried only once per source/large-append cycle.
        # Unchanged unknown files therefore stop at the cap, without rescanning.
        window = next((value for value in CURRENT_WINDOWS if value > self.window), None)
        return (window, min(window, self.source_size)) if window is not None else None

    def expand(self, budget: int) -> Batch | None:
        requested = self.next_window()
        if requested is None or requested[1] > budget:
            return None
        window, _ = requested
        self.tail = JsonlTail(self.tail.path, budget=window, backfill=window)
        self.reset()
        batch = self.tail.read(budget=budget)
        self._consume(batch)
        self.window = window
        # Future increments and rotations retain the normal small fast path.
        self.tail.budget = self.tail.backfill = CURRENT_WINDOW_BYTES
        return batch

    def _consume(self, batch: Batch) -> None:
        self.source_size = batch.size if batch.error is None else 0
        if batch.reset or batch.skipped_prefix:
            self.reset()
        gaps = set(batch.gaps)
        for index, record in enumerate(batch.records):
            if index in gaps:
                self.reset()
            self.feed(record)
        if len(batch.records) in gaps:
            self.reset()
        batch.records.clear()

    def task(self, evidence: LogEvidence) -> Task | None:
        if not self.owned:
            return None
        task = self.parser.task(evidence)
        return task if task.updated_at > 0 else None
