"""Synthetic source in a temporary directory, sent through the live parser chain."""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from collector import today_start


def iso(at: float) -> str:
    return datetime.fromtimestamp(at, UTC).isoformat(timespec="milliseconds")


def build_source(source: Path, now: float) -> None:
    source.mkdir(parents=True)
    sessions = source / "sessions" / "2000" / "01" / "01"
    sessions.mkdir(parents=True)
    db = sqlite3.connect(source / "state_5.sqlite")
    db.execute("CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, model TEXT, updated_at REAL, archived INTEGER)")
    tasks = [f"00000000-0000-4000-8000-{number:012d}" for number in range(1, 9)]
    records = {task: [{"timestamp": iso(min(today_start(now), now - 10)), "type": "session_meta",
                       "payload": {"id": task, "source": {"subagent": {"thread_spawn": {}}} if index == 7 else "cli"}}]
               for index, task in enumerate(tasks)}
    logs = sqlite3.connect(source / "logs_1.sqlite")
    logs.execute("CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)")
    log_rows = []
    midnight = today_start(now)
    span = max(0.1, min(now - midnight - 1, 12 * 1200))
    beginning = max(midnight, now - 1 - span)
    for i in range(12):
        end = beginning + span * (i + 1) / 12
        length = min([8, 12, 20, 10, 9, 15, 13, 8, 14, 11, 12, 10][i], span / 24)
        start = end - length
        model = "gpt-6.1-sol" if i < 10 else "gpt-6-astra"
        configured_effort = "low" if i in (4, 5) else "high" if i < 10 else "max"
        requested_tier = "default" if i < 4 else "priority"
        task = tasks[i // 3]
        turn, item = f"demo-turn-{i}", f"demo-item-{i}"
        def record(at, kind, **payload):
            records[task].append({"timestamp": iso(at), "type": kind, "payload": payload})
        def log(at, target, body):
            seconds = int(at)
            log_rows.append((len(log_rows) + 1, seconds, int((at - seconds) * 1e9), task, target, body))
        record(start - .003, "event_msg", type="task_started", turn_id=turn)
        if i != 6:  # Explicitly exercise missing configuration instead of guessing.
            record(start - .001, "turn_context", turn_id=turn, model=model, effort=configured_effort)
            log(start - .002, "feedback_tags", f'turn_id="{turn}" stream_request{{service_tier={requested_tier}}}: SYNTHETIC_ACCOUNT_TAIL_NOT_PARSED')
        log(start, "codex_core::stream_events_utils", f'turn_id="{turn}": Output item item_type="{"function_call" if i == 4 else "message"}" item_id="{item}"')
        if i == 4:
            record(end, "response_item", type="function_call", id=item, call_id="demo-call", arguments="SYNTHETIC_CONTENT_NOT_SAVED")
        else:
            record(end, "event_msg", type="item_completed", thread_id=task, turn_id=turn,
                   started_at_ms=int(start * 1000), completed_at_ms=int(end * 1000),
                   item={"id": item, "type": "AgentMessage", "text": "SYNTHETIC_CONTENT_NOT_SAVED"})
            record(end, "response_item", type="message", role="assistant", id=item, content="SYNTHETIC_CONTENT_NOT_SAVED")
        record(end + .001, "token_usage_record", thread_id=task, turn_id=turn,
               response_id=f"demo-response-{i}", usage={"output_tokens": int(length * [72, 85, 79, 93, 88, 81, 98, 87, 92, 96, 62, 67][i])})
        record(end + .002, "event_msg", type="task_complete", duration_ms=int(length * 1000))
    # A new output can be running while its row keeps the last completed TPS.
    # These turns intentionally have no usage event and create no speed sample.
    for index, model, configured_effort in ((0, "gpt-6.1-sol", "low"), (2, "gpt-6-astra", "high")):
        task, turn = tasks[index], f"demo-continued-{index}"
        records[task].extend([
            {"timestamp": iso(now - 14 + index), "type": "event_msg",
             "payload": {"type": "task_started", "turn_id": turn}},
            {"timestamp": iso(now - 13 + index), "type": "turn_context",
             "payload": {"turn_id": turn, "model": model, "effort": configured_effort}},
            {"timestamp": iso(now - 2 + index / 2), "type": "response_item",
             "payload": {"type": "reasoning", "id": f"demo-continued-item-{index}"}},
        ])
    # Four ongoing conversations exercise simultaneous rows before a completed
    # response exists. All names and state events below are synthetic.
    for index, task in enumerate(tasks[4:], start=4):
        turn = f"demo-active-{index}"
        records[task].append({"timestamp": iso(now - 8), "type": "event_msg",
                              "payload": {"type": "task_started", "turn_id": turn}})
        if index != 7:
            records[task].append({"timestamp": iso(now - 7), "type": "turn_context",
                                  "payload": {"turn_id": turn, "model": "gpt-6.1-sol",
                                              "effort": "low" if index == 5 else "high"}})
        if index in (5, 6, 7):
            records[task].append({"timestamp": iso(now - 4), "type": "response_item",
                                  "payload": {"type": "reasoning" if index == 5 else "function_call",
                                              "id": f"demo-active-item-{index}", "call_id": f"demo-call-{index}"}})
        if index == 7:
            records[task].append({"timestamp": iso(now - 1), "type": "response_item",
                                  "payload": {"type": "function_call_output", "call_id": "demo-call-7"}})
        if index == 5:
            at = now - 9
            log_rows.append((len(log_rows) + 1, int(at), int((at - int(at)) * 1e9), task,
                             "codex_core::session::handlers",
                             f'session_loop{{thread_id={task}}}: Submission sub=Submission {{ id: "{turn}", '
                             'op: TurnInput { request: TurnInputRequest { thread_settings: ThreadSettingsOverrides { '
                             'service_tier: Some(Some("priority")) }, start: TurnStartOptions { service_tier: None } }, '
                             'mode: StartOrSteer } }'))
    titles = ["课程网站首页", "视频剪辑 · 字幕与画面", "课程网站首页",
              "资料整理：" + "模型输出速度与多窗口监测 " * 12,
              "技能清点", "网页布局修订", "测试与修复", "历史记录检查"]
    for task, title in zip(tasks, titles, strict=True):
        path = sessions / f"rollout-{task}.jsonl"
        path.write_text("".join(json.dumps(r) + "\n" for r in records[task]), encoding="utf-8")
        db.execute("INSERT INTO threads VALUES (?,?,?,?,?,0)", (task, str(path), title, "CURRENT_MODEL_MUST_NOT_LABEL_HISTORY", now))
    db.commit()
    db.close()
    logs.executemany("INSERT INTO logs VALUES (?,?,?,?,?,?)", log_rows)
    logs.commit()
    logs.close()
