"""JSON-lines sidecar. Python standard library only; no networking or telemetry."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
import sys
import tempfile
import time
from contextlib import ExitStack
from datetime import UTC, datetime
from pathlib import Path

# Electron launches with -I. Only this bundled backend directory is admitted;
# cwd and PYTHONPATH remain excluded from module discovery.
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True

from collector import Collector, Observation, safe_model, safe_title, separate_paths
from demo import build_source
from history import History
from token_pulse.domain import Context, effort, tier

MAX_DISPLAY_TITLE_BYTES = 1024 * 1024
COLLECTION_ISSUES = frozenset({"catching_up", "limited_discovery", "state_unavailable",
                               "logs_unavailable", "source_unavailable", "records_skipped"})


def iso(at: float) -> str:
    return datetime.fromtimestamp(at, UTC).isoformat(timespec="milliseconds")


def snapshot(history: History, observation: Observation, mode: str, now: float) -> dict:
    recent = [sample for sample in history.recent() if sample.ended_at <= now]
    profiles: dict[str, dict] = {}
    samples = []
    def profile(context: Context) -> str:
        metadata = (safe_model(context.model), effort(context.effort), tier(context.requested_tier), tier(context.actual_tier), tier(context.submitted_tier))
        identifier = hashlib.sha256(json.dumps(metadata, separators=(",", ":")).encode()).hexdigest()[:24]
        profiles.setdefault(identifier, {
            "id": identifier, "model": metadata[0], "effort": metadata[1],
            "requestedTier": metadata[2], "actualTier": metadata[3], "submittedTier": metadata[4],
        })
        return identifier
    conversations: dict[str, dict] = {}
    for sample in recent:
        identifier = profile(sample.context)
        samples.append({
            "profileId": identifier, "conversationId": sample.task_id,
            "tps": sample.tps, "completedAt": iso(sample.ended_at),
            "outputTokens": sample.output_tokens if type(sample.output_tokens) is int else 0,
            "durationSeconds": sample.seconds or 0, "exclusion": sample.exclusion,
        })
        conversations.setdefault(sample.task_id, {
            "id": sample.task_id, "title": None, "state": "unknown",
            "updatedAt": None, "profileId": None, "isSubagent": None, "discovered": False,
        })
    for task in observation.tasks[:512]:
        identifier = history.identity(task.id)
        # Active events expire; confirmed completion/failure does not. Stale
        # active state remains unknown rather than being mistaken for stopped.
        observed_state = task.display_state(now)
        state = observed_state if observed_state in {
            "generating", "tool", "waiting", "idle", "error", "unknown"
        } else "unknown"
        updated = task.updated_at
        current_profile = profile(task.context) if task.context != Context() else None
        conversations[identifier] = {
            "id": identifier, "title": safe_title(task.title), "state": state,
            "updatedAt": iso(updated) if math.isfinite(updated) and 0 < updated <= now + 300 else None,
            "profileId": current_profile,
            "isSubagent": task.is_subagent if type(task.is_subagent) is bool else None,
            "discovered": True,
        }
    # Match ephemeral display metadata to existing anonymous identities only.
    # It cannot create conversations, assert running state, or label old models.
    display = {history.identity(raw_id): item for raw_id, item in observation.display_metadata.items()}
    priority = dict.fromkeys([history.identity(task.id) for task in observation.tasks[:512]]
                             + [sample.task_id for sample in reversed(recent)])
    remaining_title_bytes = MAX_DISPLAY_TITLE_BYTES
    for identifier in priority:
        row = conversations.get(identifier)
        if row is None:
            continue
        item = display.get(identifier)
        title = safe_title(item.title) if item else None
        title = title or safe_title(row["title"])
        if title:
            size = len(title.encode("utf-8"))
            row["title"] = title if size <= remaining_title_bytes else None
            if size <= remaining_title_bytes:
                remaining_title_bytes -= size
        if item and row["isSubagent"] is None and type(item.is_subagent) is bool:
            row["isSubagent"] = item.is_subagent
    if not observation.source_available:
        status = "waiting" if recent else "unavailable"
        message = "已显示本地历史，等待 Codex 产生新记录" if recent else "尚未找到今天的会话，等待 Codex 产生记录"
    elif observation.pending:
        status, message = "monitoring", "正在读取本地记录，统计会逐步补齐"
    elif recent:
        status, message = "monitoring", "本地只读监测中"
    else:
        status, message = "waiting", "等待一次完整输出"
    if "limited_discovery" in observation.issues and observation.source_available:
        message = "本地只读监测中；会话发现受限，可能未覆盖全部对话"
    if mode == "demo":
        message = "示例数据 · 未接入 Codex"
    issues = observation.issues & COLLECTION_ISSUES
    if observation.pending:
        issues = issues | {"catching_up"}
    return {"schemaVersion": 3, "mode": mode, "status": status, "message": message,
            "collectionIssues": sorted(issues),
            "updatedAt": iso(now), "activeProfile": samples[-1]["profileId"] if samples else None,
            "profiles": list(profiles.values()), "samples": samples, "conversations": list(conversations.values())}


def error_snapshot(mode: str, now: float) -> dict:
    return {"schemaVersion": 3, "mode": mode, "status": "error", "message": "本地监测暂不可用，请检查目录设置或重新启动小工具", "collectionIssues": ["source_unavailable"], "updatedAt": iso(now), "activeProfile": None, "profiles": [], "samples": [], "conversations": []}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Local read-only Codex TPS monitor")
    parser.add_argument("--mode", choices=("demo", "live"), required=True)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--codex-home", type=Path)
    parser.add_argument("--scratch-dir", type=Path)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    history = None
    try:
        with ExitStack() as stack:
            if args.mode == "demo":
                # Desktop owns its temporary demo directory's lifecycle. Standalone
                # CLI owns a context-managed temporary directory. Neither accepts a
                # real Codex source or reuses a persistent history directory.
                if args.data_dir is None:
                    temporary = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="codex-tps-demo-")))
                    source, data = temporary / "source", temporary / "data"
                else:
                    data = args.data_dir.resolve()
                    temporary = data.parent
                    if (data.name != "data" or not temporary.name.startswith("codex-tps-demo-")
                            or not temporary.is_dir() or data.exists() or (temporary / "source").exists()):
                        raise ValueError("isolated_demo_directory_required")
                    source, data = separate_paths(temporary / "source", data)
                build_source(source, time.time())
                scratch_parent = temporary
            else:
                if args.codex_home is None or args.data_dir is None:
                    raise ValueError("explicit_source_required")
                source, data = separate_paths(args.codex_home, args.data_dir)
                scratch_parent = args.scratch_dir
            history = History(data)
            stack.callback(history.close)
            collector = Collector(source, scratch_dir=scratch_parent)
            stack.callback(collector.close)
            while True:
                now = time.time()
                try:
                    observation = collector.poll(now)
                    # Events may be appended during collection. Judge freshness
                    # after the read, never against a time preceding those events.
                    now = time.time()
                    history.accept(observation.samples, now)
                    output = snapshot(history, observation, args.mode, now)
                except (OSError, sqlite3.Error, ValueError, TypeError, OverflowError):
                    output = error_snapshot(args.mode, now)
                print(json.dumps(output, ensure_ascii=False, allow_nan=False), flush=True)
                if args.once:
                    return 0 if output["status"] != "error" else 1
                time.sleep(2)
    except KeyboardInterrupt:
        return 0
    except (OSError, sqlite3.Error, ValueError, TypeError, OverflowError):
        print(json.dumps(error_snapshot(args.mode, time.time()), ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
