"""Only anonymous measurements persist, in the app's separate data directory."""
from __future__ import annotations

import hashlib
import hmac
import math
import os
import sqlite3
from dataclasses import replace
from pathlib import Path

from collector import safe_model, today_start
from token_pulse.domain import Context, Sample, reconcile, PARSER_REVISION, effort, tier
from token_pulse.rollout import REJECTIONS


class History:
    columns = "task,turn,response,ended,tokens,started,model,issue,revision,timing,effort,requested_tier,actual_tier,submitted_tier,requested_withdrawn,submitted_withdrawn"

    def __init__(self, data: Path):
        data = data.resolve()
        data.mkdir(parents=True, exist_ok=True)
        for name in ("identity.salt", "history.sqlite", "history.sqlite-wal", "history.sqlite-shm"):
            if (data / name).resolve().parent != data:
                raise ValueError("local_data_link_outside")
        salt = data / "identity.salt"
        try:
            with salt.open("xb") as stream:
                stream.write(os.urandom(32))
        except FileExistsError:
            pass
        self.salt = salt.read_bytes()
        if len(self.salt) != 32:
            raise ValueError("invalid_local_identity")
        self.connection = sqlite3.connect(data / "history.sqlite", timeout=0.5)
        try:
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("""CREATE TABLE IF NOT EXISTS samples (
                task TEXT, turn TEXT, response TEXT, ended REAL NOT NULL, tokens INTEGER,
                started REAL, model TEXT, issue TEXT, revision INTEGER NOT NULL,
                timing TEXT, PRIMARY KEY(task,turn,response))""")
            # Python's SQLite context manager does not begin transactions for
            # ALTER TABLE. Begin explicitly so a failed upgrade rolls back both
            # schema additions and label withdrawal, preserving the old store.
            self.connection.execute("BEGIN IMMEDIATE")
            with self.connection:
                columns = {row[1] for row in self.connection.execute("PRAGMA table_info(samples)")}
                for name in ("effort", "requested_tier", "actual_tier", "submitted_tier"):
                    if name not in columns:
                        self.connection.execute(f"ALTER TABLE samples ADD COLUMN {name} TEXT")
                for name in ("requested_withdrawn", "submitted_withdrawn"):
                    if name not in columns:
                        self.connection.execute(f"ALTER TABLE samples ADD COLUMN {name} INTEGER NOT NULL DEFAULT 0")
                # v4 could borrow the thread's present model for historical outputs.
                # Keep anonymous identities and measurements, but withdraw labels
                # until v5 replays the corresponding per-output evidence.
                self.connection.execute(
                    "UPDATE samples SET model=NULL,effort=NULL,requested_tier=NULL,actual_tier=NULL,submitted_tier=NULL WHERE revision<?",
                    (PARSER_REVISION,),
                )
        except sqlite3.Error:
            self.connection.close()
            raise

    def close(self) -> None:
        self.connection.close()

    def identity(self, value: str) -> str:
        """Bind a live task to its history pseudonym without persisting metadata."""
        return hmac.new(self.salt, value.encode("utf-8"), hashlib.sha256).hexdigest()

    def _anonymous(self, sample: Sample) -> Sample:
        context = Context(
            model=safe_model(sample.context.model) if sample.context.model != "Unknown" else None,
            effort=effort(sample.context.effort),
            requested_tier=None if sample.requested_tier_withdrawn else tier(sample.context.requested_tier),
            actual_tier=tier(sample.context.actual_tier),
            submitted_tier=None if sample.submitted_tier_withdrawn else tier(sample.context.submitted_tier),
        ) if sample.parser_revision >= PARSER_REVISION else Context()
        return replace(sample, task_id=self.identity(sample.task_id), turn_id=self.identity(sample.turn_id),
                       response_id=self.identity(sample.response_id), context=context)

    @staticmethod
    def _sample(row) -> Sample:
        task, turn, response, ended, tokens, started, model, issue, revision, timing, configured_effort, requested, actual, submitted, requested_withdrawn, submitted_withdrawn = row
        return Sample(task, turn, response, ended, tokens, started,
                      Context(model=safe_model(model) if model != "Unknown" else None,
                              effort=effort(configured_effort), requested_tier=tier(requested), actual_tier=tier(actual),
                              submitted_tier=tier(submitted)),
                      issue=issue, parser_revision=revision, timing_source=timing,
                      requested_tier_withdrawn=requested_withdrawn == 1,
                      submitted_tier_withdrawn=submitted_withdrawn == 1)

    def accept(self, samples: list[Sample], now: float) -> None:
        with self.connection:
            for incoming in samples:
                if not math.isfinite(incoming.ended_at) or incoming.ended_at > now + 300:
                    continue
                sample = self._anonymous(incoming)
                if sample.issue in REJECTIONS:
                    self.connection.execute("DELETE FROM samples WHERE task=? AND turn=? AND response=?", sample.key)
                    continue
                row = self.connection.execute(f"SELECT {self.columns} FROM samples WHERE task=? AND turn=? AND response=?", sample.key).fetchone()
                if row:
                    sample = reconcile(self._sample(row), sample)
                tokens = sample.output_tokens if type(sample.output_tokens) is int and 0 <= sample.output_tokens <= 2**63 - 1 else None
                started = sample.started_at if sample.started_at is not None and math.isfinite(sample.started_at) else None
                self.connection.execute(f"INSERT OR REPLACE INTO samples ({self.columns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                    *sample.key, sample.ended_at, tokens, started, sample.context.model,
                    sample.exclusion, sample.parser_revision, sample.timing_source,
                    sample.context.effort, sample.context.requested_tier, sample.context.actual_tier, sample.context.submitted_tier,
                    int(sample.requested_tier_withdrawn), int(sample.submitted_tier_withdrawn),
                ))
            self.connection.execute("DELETE FROM samples WHERE ended<?", (now - 30 * 86400,))
            self.connection.execute("DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples ORDER BY ended DESC LIMIT -1 OFFSET 10000)")

    def today(self, now: float) -> list[Sample]:
        rows = self.connection.execute(f"SELECT {self.columns} FROM samples WHERE ended>=? AND ended<=? ORDER BY ended", (today_start(now), now))
        return [self._sample(row) for row in rows]

    def recent(self) -> list[Sample]:
        return [self._sample(row) for row in self.connection.execute(f"SELECT {self.columns} FROM samples ORDER BY ended")]
