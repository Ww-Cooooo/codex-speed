"""Bounded JSONL tailing; partial lines never become partial observations."""

from __future__ import annotations

import json
import os
import hashlib
from dataclasses import dataclass, field
from pathlib import Path

from token_pulse.projection import project


@dataclass
class Batch:
    records: list[dict] = field(default_factory=list)
    reset: bool = False
    skipped_prefix: bool = False
    malformed: int = 0
    oversized: int = 0
    gaps: list[int] = field(default_factory=list)
    error: str | None = None
    size: int = 0
    read_bytes: int = 0


class JsonlTail:
    def __init__(
        self,
        path: Path,
        *,
        budget: int = 2 * 1024 * 1024,
        max_line: int = 8 * 1024 * 1024,
        backfill: int | None = 4 * 1024 * 1024,
    ):
        if min(budget, max_line) <= 0 or (backfill is not None and backfill <= 0):
            raise ValueError("read limits must be positive")
        self.path = path
        self.budget = budget
        self.max_line = max_line
        self.backfill = backfill
        self.offset = 0
        self.pending = b""
        self.dropping = False
        self.identity: tuple[int, int] | None = None
        self.anchor = b""
        self.anchor_length = 0

    def read(self, *, budget: int | None = None) -> Batch:
        if budget is not None and (type(budget) is not int or budget <= 0):
            raise ValueError("read budget must be positive")
        batch = Batch()
        try:
            with self.path.open("rb") as stream:
                stat = os.fstat(stream.fileno())
                batch.size = stat.st_size
                identity = stat.st_dev, stat.st_ino
                replaced = self.identity is not None and identity != self.identity
                changed = False
                if self.anchor and stat.st_size >= self.offset:
                    stream.seek(self.offset - self.anchor_length)
                    changed = hashlib.sha256(stream.read(self.anchor_length)).digest() != self.anchor
                if replaced or changed or stat.st_size < self.offset:
                    self.offset = 0
                    self.pending = b""
                    self.dropping = False
                    self.anchor = b""
                    self.anchor_length = 0
                    batch.reset = True
                if self.identity is None or batch.reset:
                    if self.backfill is not None and stat.st_size > self.backfill:
                        self.offset = stat.st_size - self.backfill
                        self.dropping = True
                        batch.skipped_prefix = True
                self.identity = identity
                stream.seek(self.offset)
                data = stream.read(min(self.budget, budget) if budget is not None else self.budget)
                batch.read_bytes = len(data)
                self.offset += len(data)
                stream.seek(max(0, self.offset - 128))
                self.anchor_length = min(128, self.offset)
                self.anchor = hashlib.sha256(stream.read(self.anchor_length)).digest() if self.anchor_length else b""
        except OSError:
            # Do not return OS exception text, which can contain private paths.
            batch.error = "source_unavailable"
            return batch

        for fragment in data.splitlines(keepends=True):
            # bytes.splitlines only splits CR/LF. JSONL records require LF completion.
            complete = fragment.endswith(b"\n")
            if not self.dropping:
                self.pending += fragment
                if len(self.pending) > self.max_line:
                    self.pending = b""
                    self.dropping = True
                    batch.oversized += 1
                    batch.gaps.append(len(batch.records))
            if complete:
                if not self.dropping and self.pending.strip():
                    try:
                        record = json.loads(self.pending)
                        if isinstance(record, dict):
                            batch.records.append(project(record))
                        else:
                            batch.malformed += 1
                            batch.gaps.append(len(batch.records))
                    except (ValueError, UnicodeError, RecursionError):
                        batch.malformed += 1
                        batch.gaps.append(len(batch.records))
                self.pending = b""
                self.dropping = False
        return batch
