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
from token_pulse.lifecycle import CurrentLifecycle, CURRENT_EXTRA_BUDGET_BYTES
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
        self.current: dict[str, CurrentLifecycle] = {}
        self.titles: dict[str, str | None] = {}
        self.display_metadata: dict[str, DisplayMetadata] = {}
        self.next_discovery = 0.0
        self.discovery_day = None
        self.discovery_issues: set[str] = set()
        self.rotation = 0
        self.current_rotation = 0
        self.current_extra_rotation = 0

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
        index_available = False
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
                        "WHERE updated_at>=? ORDER BY updated_at DESC LIMIT 513", (today_start(now),),
                    )
                    for index, (task, raw_path) in enumerate(rows):
                        if index >= 512:
                            self.discovery_issues.add("limited_discovery")
                            break
                        if not isinstance(task, str) or not 0 < len(task) <= 160 or not isinstance(raw_path, str):
                            continue
                        checked = self._inside(Path(raw_path), ".jsonl")
                        if checked:
                            found[task] = (checked, Context())
                    index_available = True
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
            if len(candidates) > 512:
                self.discovery_issues.add("limited_discovery")
        # A degraded index/fallback is not evidence that a known source vanished.
        # Keep its parser and offset, while rechecking the source boundary. A
        # successful index still retires entries outside the current candidate set.
        self.watched = {key: pair for key, pair in self.watched.items()
                        if key in found or (not index_available
                        and self._inside(pair[0].path, ".jsonl") == pair[0].path)}
        for task, item in indexed.items():
            if task not in metadata and len(metadata) < MAX_DISPLAY_METADATA:
                metadata[task] = item
        self.display_metadata = metadata
        self.titles = {task: item.title for task, item in metadata.items()}
        for task, (path, context) in found.items():
            if task not in self.watched or self.watched[task][0].path != path:
                # Retaining known sources during degradation must not remove the
                # original discovery bound. Existing parsers keep their place.
                if task not in self.watched and len(self.watched) >= 512:
                    self.discovery_issues.add("limited_discovery")
                    continue
                # Replay from the beginning for correct cumulative usage baselines.
                # Memory/read budget stays bounded; catch-up continues over polls.
                self.watched[task] = JsonlTail(path, backfill=None), Rollout(task, context=context)
        self.current = {task: reader for task, reader in self.current.items()
                        if task in self.watched and self.watched[task][0].path == reader.tail.path}
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
        unavailable_sources: set[str] = set()
        # Current lifecycle must not wait for hundreds of megabytes of historical
        # output to replay. Its suffix has an independent bounded/fair cursor and
        # never contributes samples or usage baselines to the measurement path.
        for task, (tail, _) in self.watched.items():
            if task not in self.current or self.current[task].tail.path != tail.path:
                self.current[task] = CurrentLifecycle(task, tail.path)
        current_pairs = [(task, self.current[task]) for task in self.watched]
        current_start = self.current_rotation % len(current_pairs) if current_pairs else 0
        current_pairs = current_pairs[current_start:] + current_pairs[:current_start]
        for task, reader in current_pairs[:32]:
            if self._inside(reader.tail.path, ".jsonl") != reader.tail.path:
                issues.add("source_unavailable")
                unavailable_sources.add(task)
                reader.reset()
                continue
            batch = reader.poll()
            pending |= reader.tail.offset < batch.size
            if batch.error:
                issues.add(batch.error)
                unavailable_sources.add(task)
                reader.reset()
            if batch.malformed or batch.oversized:
                issues.add("records_skipped")
        self.current_rotation = (current_start + min(32, len(current_pairs))) % len(current_pairs) if current_pairs else 0
        pending |= any(reader.tail.identity is None for _, reader in current_pairs[32:])
        # Large tool-result lines can push all ownership evidence beyond the
        # normal suffix. Expand only unresolved readers, with one shared budget
        # and a separate fair cursor. A deferred large request leads next poll.
        extra_pairs = [(task, self.current[task]) for task in self.watched]
        extra_count = len(extra_pairs)
        extra_start = self.current_extra_rotation % extra_count if extra_count else 0
        extra_budget = CURRENT_EXTRA_BUDGET_BYTES
        extra_visited = 0
        idle_visits = 0
        while extra_budget > 0 and extra_visited < 4 * extra_count:
            task, reader = extra_pairs[(extra_start + extra_visited) % extra_count]
            requested = reader.next_window() if task not in unavailable_sources else None
            if requested is None:
                extra_visited += 1
                idle_visits += 1
                if idle_visits >= extra_count:
                    break
                continue
            if requested[1] > extra_budget:
                break
            extra_visited += 1
            idle_visits = 0
            if self._inside(reader.tail.path, ".jsonl") != reader.tail.path:
                issues.add("source_unavailable")
                unavailable_sources.add(task)
                reader.reset()
                continue
            batch = reader.expand(extra_budget)
            if batch is None:
                continue
            extra_budget -= batch.read_bytes
            pending |= reader.tail.offset < batch.size
            if batch.error:
                issues.add(batch.error)
                unavailable_sources.add(task)
                reader.reset()
            if batch.malformed or batch.oversized:
                issues.add("records_skipped")
        self.current_extra_rotation = (extra_start + extra_visited) % extra_count if extra_count else 0
        pending |= any(reader.next_window() is not None for _, reader in extra_pairs)
        pairs = list(self.watched.values())
        start = 0
        if pairs:
            start = self.rotation % len(pairs)
            pairs = pairs[start:] + pairs[:start]
        budget = 16 * 1024 * 1024
        processed = 0
        for tail, rollout in pairs[:32]:
            if budget <= 0:
                pending = True
                break
            processed += 1
            # Resolve again at the point of read to reject a changed symlink.
            if self._inside(tail.path, ".jsonl") != tail.path:
                issues.add("source_unavailable")
                unavailable_sources.add(rollout.task_id)
                continue
            batch = tail.read(budget=budget)
            budget -= batch.read_bytes
            pending |= tail.offset < batch.size
            if batch.reset or batch.skipped_prefix:
                rollout.reset()
            if batch.error:
                issues.add(batch.error)
                unavailable_sources.add(rollout.task_id)
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
        # A full byte budget can stop well before the file-count bound. Advance
        # by actual visits so that backlogged files cannot starve the rest.
        self.rotation = (start + processed) % len(pairs) if pairs else 0
        pending |= any(tail.identity is None for tail, _ in pairs[32:])
        models = [safe_model(rollout.context.model) or "Unknown" for _, rollout in pairs]
        tasks = []
        for tail, rollout in pairs:
            historical = rollout.task(self.evidence)
            reader = self.current[rollout.task_id]
            try:
                checked = self._inside(tail.path, ".jsonl")
                if checked != tail.path:
                    raise OSError("source_unavailable")
                stat = checked.stat()
                source_identity = stat.st_dev, stat.st_ino
                if reader.tail.identity is not None and (reader.tail.identity != source_identity
                                                        or reader.tail.offset > stat.st_size):
                    reader.reset()
                caught_up = tail.identity == source_identity and tail.offset >= stat.st_size
            except (OSError, ValueError):
                unavailable_sources.add(rollout.task_id)
                issues.add("source_unavailable")
                caught_up = False
            current = reader.task(self.evidence)
            if rollout.task_id in unavailable_sources:
                reader.reset()
                rollout.ownership_confirmed = False
                task = replace(historical, state="unknown", updated_at=0.0, context=Context())
            elif current is not None and (not caught_up or current.updated_at >= historical.updated_at):
                task = replace(current, latest=historical.latest)
            elif caught_up and rollout.ownership_confirmed:
                task = historical
            else:
                # A completed turn in an unread prefix cannot establish today's
                # current state. Keep discovery visible without inventing work.
                task = replace(historical, state="unknown", updated_at=0.0, context=Context())
            tasks.append(replace(task, title=self.titles.get(rollout.task_id)))
        return Observation(list(observed.values()), models, bool(self.watched), pending, issues, tasks,
                           dict(self.display_metadata))
