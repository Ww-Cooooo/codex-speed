"""Discard message, tool, account, and path contents immediately after JSON decode."""
from __future__ import annotations

from token_pulse.domain import effort


def project(record: dict) -> dict:
    value = record.get("payload")
    kind = record.get("type")
    kind = kind if isinstance(kind, str) and len(kind) <= 80 else None
    stamp = record.get("timestamp")
    stamp = stamp if isinstance(stamp, str) and len(stamp) <= 40 else None
    if not isinstance(value, dict):
        return {"timestamp": stamp, "type": kind, "payload": None}
    event = value.get("type")
    if event is not None and not isinstance(event, str):
        return {"timestamp": stamp, "type": kind, "payload": None}
    event = event if isinstance(event, str) and len(event) <= 80 else None
    payload = {"type": event}
    keys: tuple[str, ...] = ()
    if kind == "session_meta":
        keys = ("id",)
        source = value.get("source")
        # Retain only a classification bit, never parent identities or any
        # nested source payload. Unsupported future variants stay unknown.
        if isinstance(source, str) and source in {"cli", "vscode"}:
            payload["is_subagent"] = False
        elif isinstance(source, dict) and len(source) == 1 and "subagent" in source and (
            isinstance(source["subagent"], str) and source["subagent"] in {"review", "compact", "memory_consolidation"}
            or isinstance(source["subagent"], dict) and len(source["subagent"]) == 1
            and "thread_spawn" in source["subagent"] and isinstance(source["subagent"]["thread_spawn"], dict)
        ):
            payload["is_subagent"] = True
        else:
            payload["is_subagent"] = None
    elif kind == "turn_context":
        keys = ("turn_id", "model")
        payload["effort"] = effort(value.get("effort"))
    elif kind == "response_item":
        keys = ("id", "role", "call_id")
    elif kind == "token_usage_record":
        keys = ("thread_id", "turn_id", "response_id")
        usage = value.get("usage")
        payload["usage"] = {"output_tokens": tokens(usage.get("output_tokens"))} if isinstance(usage, dict) else None
    elif kind == "event_msg":
        if event == "token_count":
            info = value.get("info")
            payload["info"] = {}
            if isinstance(info, dict):
                for name in ("last_token_usage", "total_token_usage"):
                    usage = info.get(name)
                    payload["info"][name] = {"output_tokens": tokens(usage.get("output_tokens"))} if isinstance(usage, dict) else None
        elif event == "item_completed":
            keys = ("thread_id", "turn_id", "started_at_ms", "completed_at_ms")
            item = value.get("item")
            payload["item"] = {k: bounded(item.get(k)) for k in ("id", "type")} if isinstance(item, dict) else None
        elif event == "task_started":
            keys = ("turn_id",)
        elif event == "thread_settings_applied":
            keys = ("thread_id",)
        elif event in {"task_complete", "task_failed", "turn_aborted"}:
            keys = ("duration_ms", "time_to_first_token_ms")
    for key in keys:
        candidate = value.get(key)
        # IDs and labels are bounded. Invalid evidence remains invalid rather than
        # accidentally retaining an arbitrary JSON object or message body.
        payload[key] = bounded(candidate)
    return {"timestamp": stamp, "type": kind, "payload": payload}


def tokens(value: object) -> int | None:
    return value if type(value) is int and 0 <= value <= 2**63 - 1 else None


def bounded(value: object):
    return value if (value is None or type(value) in (int, float) or isinstance(value, str) and len(value) <= 200) else None
