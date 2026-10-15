"""Bounded collection from an explicitly supplied source; never changes Codex."""
from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import unicodedata
from contextlib import closing
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlite_snapshot import DatabaseMirrors

from token_pulse.domain import Context, Sample, Task
from token_pulse.logs import LogEvidence, SqliteLogs, label, read_only
from token_pulse.rollout import Rollout
from token_pulse.tailer import JsonlTail


def resolved(path: Path) -> Path:
    path = path.expanduser().resolve()
    value = str(path)
    if os.name == "nt" and value.startswith("\\\\?\\"):
        value = "\\\\" + value[8:] if value.startswith("\\\\?\\UNC\\") else value[4:]
        return Path(value)
    return path


def separate_paths(source: Path, data: Path) -> tuple[Path, Path]:
    source, data = resolved(source), resolved(data)
    if source.is_relative_to(data) or data.is_relative_to(source):
        raise ValueError("source_data_overlap")
    return source, data


def today_start(now: float) -> float:
    # A naive local datetime converts midnight with the host's timezone rules;
    # astimezone() would freeze the offset at `now` on a DST transition day.
    local = datetime.fromtimestamp(now)
    return local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def safe_model(value: object) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_. -]{1,80}", value) else None


def safe_title(value: object) -> str | None:
    """Local display only: bounded Unicode, with no controls or line separators."""
    if not isinstance(value, str):
        return None
    cleaned = "".join(" " if char.isspace() else char for char in value[:160]
                      if char.isspace() or not unicodedata.category(char).startswith("C"))
    return " ".join(cleaned.split()) or None


MAX_DISPLAY_METADATA = 4096
MAX_NAME_INDEX_BYTES = 4 * 1024 * 1024
MAX_NAME_INDEX_LINE_BYTES = 16 * 1024


def source_subagent(value: object) -> bool | None:
    """Recognize only known source labels/shapes; never infer from a nickname."""
    if value in ("cli", "vscode"):
        return False
    if not isinstance(value, str):
        return None
    try:
        source = json.loads(value)
    except (ValueError, TypeError, RecursionError):
        return None
    if not isinstance(source, dict) or len(source) != 1 or "subagent" not in source:
        return None
    subagent = source["subagent"]
    if isinstance(subagent, str) and subagent in {"review", "compact", "memory_consolidation"}:
        return True
    if (isinstance(subagent, dict) and len(subagent) == 1
            and isinstance(subagent.get("thread_spawn"), dict)):
        return True
    return None


@dataclass(frozen=True)
class DisplayMetadata:
    title: str | None = None
    is_subagent: bool | None = None


@dataclass
class Observation:
    samples: list[Sample]
    models: list[str]
    source_available: bool
    pending: bool
    issues: set[str]
    # Titles exist only in this live observation and the sidecar/renderer memory.
    # History accepts samples only and never receives Task or its title.
    tasks: list[Task] = field(default_factory=list)
    display_metadata: dict[str, DisplayMetadata] = field(default_factory=dict)


class Collector:
    def __init__(self, source: Path, *, scratch_dir: Path | None = None):
        self.source = resolved(source)
        self.mirrors = DatabaseMirrors(self.source, scratch_dir)
        self.evidence = LogEvidence()
        self.logs: SqliteLogs | None = None
        self.watched: dict[str, tuple[JsonlTail, Rollout]] = {}
        self.titles: dict[str, str | None] = {}
        self.display_metadata: dict[str, DisplayMetadata] = {}
        self.next_discovery = 0.0
        self.discovery_day = None
        self.discovery_issues: set[str] = set()
        self.rotation = 0

    def close(self) -> None:
        self.mirrors.close()

    def _inside(self, path: Path, suffix: str) -> Path | None:
        path = resolved(path)
        return path if path.is_relative_to(self.source) and path.suffix == suffix and path.is_file() else None

    def _database(self, stem: str) -> Path | None:
        choices = []
        for path in self.source.glob(f"{stem}_*.sqlite"):
            match = re.fullmatch(rf"{stem}_(\d+)\.sqlite", path.name)
            checked = self._inside(path, ".sqlite")
            if match and checked:
                choices.append((int(match[1]), checked))
        return max(choices)[1] if choices else None

    def _name_index(self) -> dict[str, DisplayMetadata]:
        """Read only the small name index, never session messages or user text."""
        latest: dict[str, tuple[float, str | None]] = {}
        try:
            path = self._inside(self.source / "session_index.jsonl", ".jsonl")
            if path is None:
                return {}
            expected = path.stat()
            if expected.st_size > MAX_NAME_INDEX_BYTES:
                return {}
            with path.open("rb") as stream:
                stat = os.fstat(stream.fileno())
                if ((stat.st_dev, stat.st_ino) != (expected.st_dev, expected.st_ino)
                        or stat.st_size > MAX_NAME_INDEX_BYTES or self._inside(path, ".jsonl") != path):
                    return {}
                data = stream.read(MAX_NAME_INDEX_BYTES + 1)
            if len(data) > MAX_NAME_INDEX_BYTES:
                return {}
            for line in data.splitlines(keepends=True):
                # An append may be in progress. Its final partial line is not a
                # rename, and an oversized/malformed line cannot hide older names.
                if len(line) > MAX_NAME_INDEX_LINE_BYTES or not line.endswith(b"\n"):
                    continue
                try:
                    record = json.loads(line)
                    if not isinstance(record, dict):
                        continue
                    identifier, stamp = record.get("id"), record.get("updated_at")
                    if (not isinstance(identifier, str) or not 0 < len(identifier) <= 160
                            or not isinstance(stamp, str) or len(stamp) > 40):
                        continue
                    parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        continue
                    at = parsed.timestamp()
                    if not math.isfinite(at):
                        continue
                    if identifier not in latest or at >= latest[identifier][0]:
                        latest[identifier] = (at, safe_title(record.get("thread_name")))
                except (OSError, ValueError, TypeError, OverflowError, RecursionError):
                    continue
        except (OSError, ValueError):
            return {}
        return {identifier: DisplayMetadata(title)
                for identifier, (_, title) in sorted(latest.items(), key=lambda pair: pair[1][0], reverse=True)[:MAX_DISPLAY_METADATA]}

    def discover(self, now: float) -> None:
        self.discovery_issues.clear()
        path = self._database("logs")
        if path and (not self.logs or self.logs.path != path):
            self.logs = SqliteLogs(path, self.evidence, self.mirrors)
        if path is None:
            self.logs = None
        found: dict[str, tuple[Path, Context]] = {}
        indexed = self._name_index()
        metadata: dict[str, DisplayMetadata] = {}
        state = self._database("state")
        if state:
            try:
                with closing(read_only(state, self.mirrors)) as connection:
                    # updated_at deliberately discovers old sessions continued today.
                    # Thread settings describe its current state, never historical
                    # responses. Only per-turn rollout/log evidence may label them.
                    columns = {row[1] for row in connection.execute("PRAGMA table_info(threads)")}
                    def display_column(name: str, length: int = 160) -> str:
                        return f"substr({name},1,{length})" if name in columns else "NULL"
                    # Names/classification also label already-collected history.
                    # This metadata query never discovers/replays old rollouts.
                    display_rows = connection.execute(
                        f"SELECT substr(id,1,161), {display_column('name')}, {display_column('title')}, "
                        f"{display_column('agent_nickname')}, {display_column('source', 4096)} FROM threads "
                        f"ORDER BY updated_at DESC LIMIT {MAX_DISPLAY_METADATA}")
                    for task, name, title, nickname, source in display_rows:
                        if not isinstance(task, str) or not 0 < len(task) <= 160:
                            continue
                        is_subagent = source_subagent(source)
                        indexed_title = indexed.get(task, DisplayMetadata()).title
                        display_title = safe_title(name) or indexed_title or safe_title(title)
                        if not display_title and is_subagent is True and (nickname := safe_title(nickname)):
                            display_title = safe_title(f"子任务 · {nickname}")
                        metadata[task] = DisplayMetadata(display_title, is_subagent)
                    rows = connection.execute(
                        "SELECT id, rollout_path FROM threads "
                        "WHERE updated_at>=? ORDER BY updated_at DESC LIMIT 512", (today_start(now),),
                    )
                    for task, raw_path in rows:
                        if not isinstance(task, str) or not 0 < len(task) <= 160 or not isinstance(raw_path, str):
                            continue
                        checked = self._inside(Path(raw_path), ".jsonl")
                        if checked:
                            found[task] = (checked, Context())
            except (OSError, sqlite3.Error, ValueError, TypeError):
                self.discovery_issues.add("state_unavailable")
        if not found:
            # Without the index only recent date directories are probed; no recursive
            # scan of the user's history. A missing index is a visible limitation.
            self.discovery_issues.add("limited_discovery")
            recent = datetime.fromtimestamp(now, UTC)
            directories = [self.source / "sessions"] + [
                self.source / "sessions" / (recent - timedelta(days=i)).strftime("%Y/%m/%d")
                for i in range(3)
            ]
            candidates = []
            for directory in directories:
                for path in directory.glob("*.jsonl"):
                    checked = self._inside(path, ".jsonl")
                    match = re.search(r"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})", path.name)
                    if checked and match and checked.stat().st_mtime >= today_start(now):
                        candidates.append((checked.stat().st_mtime, match[1], checked))
            for _, task, path in sorted(candidates, reverse=True)[:512]:
                found[task] = path, Context()
        self.watched = {key: pair for key, pair in self.watched.items() if key in found}
        for task, item in indexed.items():
            if task not in metadata and len(metadata) < MAX_DISPLAY_METADATA:
                metadata[task] = item
        self.display_metadata = metadata
        self.titles = {task: item.title for task, item in metadata.items()}
        for task, (path, context) in found.items():
            if task not in self.watched or self.watched[task][0].path != path:
                # Replay from the beginning for correct cumulative usage baselines.
                # Memory/read budget stays bounded; catch-up continues over polls.
                self.watched[task] = JsonlTail(path, backfill=None), Rollout(task, context=context)
        self.next_discovery = now + 10
        self.discovery_day = today_start(now)

    def poll(self, now: float) -> Observation:
        if now >= self.next_discovery or self.discovery_day != today_start(now):
            try:
                self.discover(now)
            except (OSError, ValueError):
                self.discovery_issues.add("source_unavailable")
                self.next_discovery = now + 10
        issues = set(self.discovery_issues)
        if self.logs:
            issue = self.logs.poll() if self._inside(self.logs.path, ".sqlite") == self.logs.path else "logs_unavailable"
            if issue:
                issues.add(issue)
        observed: dict[tuple, Sample] = {}
        pending = False
        pairs = list(self.watched.values())
        if pairs:
            start = self.rotation % len(pairs)
            pairs = pairs[start:] + pairs[:start]
        self.rotation += 32
        budget = 16 * 1024 * 1024
        for tail, rollout in pairs[:32]:
            # Resolve again at the point of read to reject a changed symlink.
            if self._inside(tail.path, ".jsonl") != tail.path:
                issues.add("source_unavailable")
                continue
            if budget <= 0:
                pending = True
                break
            batch = tail.read(budget=budget)
            budget -= batch.read_bytes
            pending |= tail.offset < batch.size
            if batch.reset or batch.skipped_prefix:
                rollout.reset()
            if batch.error:
                issues.add(batch.error)
            if batch.malformed or batch.oversized:
                issues.add("records_skipped")
            gaps = set(batch.gaps)
            for index, record in enumerate(batch.records):
                if index in gaps:
                    rollout.damage("record_gap")
                rollout.feed(record)
                # Flush within each batch before the core's bounded deque expires.
                if index % 64 == 63:
                    observed.update((s.key, s) for s in rollout.samples(self.evidence))
            if len(batch.records) in gaps:
                rollout.damage("record_gap")
            observed.update((s.key, s) for s in rollout.samples(self.evidence))
            batch.records.clear()
        pending |= any(tail.identity is None for tail, _ in pairs[32:])
        models = [safe_model(rollout.context.model) or "Unknown" for _, rollout in pairs]
        tasks = [replace(rollout.task(self.evidence), title=self.titles.get(rollout.task_id))
                 for _, rollout in pairs]
        return Observation(list(observed.values()), models, bool(self.watched), pending, issues, tasks,
                           dict(self.display_metadata))
