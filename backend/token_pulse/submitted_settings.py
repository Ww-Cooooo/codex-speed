"""Project only per-turn tier settings from a bounded diagnostic submission.

The quote-aware structural scanner is adapted from TokenPulse edc27b1 (MIT;
see backend/TOKENPULSE-LICENSE.txt). Input/tool text is skipped while balancing
its structure, never searched for configuration markers or returned. A submitted
setting is evidence of the client submission, not the server's processing tier.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Literal

from token_pulse.domain import tier

TARGET = "codex_core::session::handlers"
MAX_BODY_CHARS = 16000
_HEADER = re.compile(
    r'session_loop\{thread_id=(?:"([A-Za-z0-9_-]{1,100})"|([A-Za-z0-9_-]{1,100}))\}: '
    r"Submission sub="
)
_IDENTIFIER = re.compile(r'"([A-Za-z0-9_-]{1,100})"')
Span = tuple[int, int]


@dataclass(frozen=True)
class SubmittedSettings:
    thread_id: str
    turn_id: str
    at: float
    tier: str | None
    state: Literal["set", "clear", "absent"]


def _trim(body: str, start: int, end: int) -> Span:
    while start < end and body[start].isspace():
        start += 1
    while end > start and body[end - 1].isspace():
        end -= 1
    return start, end


def _fields(body: str, span: Span, name: str, wanted: set[str]) -> dict[str, Span]:
    """Validate one Debug struct, retaining offsets of allowlisted fields only."""
    start, end = _trim(body, *span)
    prefix = name + " {"
    if not body.startswith(prefix, start) or end <= start + len(prefix) or body[end - 1] != "}":
        raise ValueError("unexpected_structure")
    content_start = start + len(prefix)
    part_start = content_start
    selected: dict[str, Span] = {}
    seen: set[str] = set()
    stack: list[str] = []
    quoted = escaped = False
    # The final synthetic comma accepts a final field without a trailing comma.
    for index in range(content_start, end):
        char = body[index] if index < end - 1 else ","
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
            continue
        if char == '"':
            quoted = True
        elif char in "{[(":
            stack.append(char)
            if len(stack) > 64:
                raise ValueError("nesting_too_deep")
        elif char in "}])":
            if not stack or stack.pop() != {"}": "{", "]": "[", ")": "("}[char]:
                raise ValueError("unbalanced_structure")
        elif char == "," and not stack:
            left, right = _trim(body, part_start, index)
            part_start = index + 1
            if left == right:
                continue
            colon = body.find(":", left, right)
            if colon == -1:
                raise ValueError("missing_field_name")
            key = body[left:colon].strip()
            if not re.fullmatch(r"[a-z_]{1,80}", key) or key in seen:
                raise ValueError("invalid_field_name")
            seen.add(key)
            if len(seen) > 128:
                raise ValueError("too_many_fields")
            value = _trim(body, colon + 1, right)
            if value[0] == value[1]:
                raise ValueError("missing_field_value")
            if key in wanted:
                selected[key] = value
    if stack or quoted:
        raise ValueError("truncated_structure")
    return selected


def _value(body: str, fields: dict[str, Span], key: str, default: str = "") -> str:
    span = fields.get(key)
    return body[slice(*span)] if span is not None else default


def project_submitted_settings(task: str, at: float, target: str,
                               body: str) -> SubmittedSettings | None:
    """Return exact-thread/turn metadata; unsupported or ambiguous data is None.

    Callers must still correlate the submission timestamp to that turn's output.
    ``clear`` and ``absent`` are unknown tiers, not proof of standard processing.
    The complete body must be discarded immediately after this projection.
    """
    if (target != TARGET or not isinstance(task, str) or not isinstance(body, str)
            or len(body) > MAX_BODY_CHARS or type(at) not in (int, float)
            or not math.isfinite(at) or not 0 <= at <= 2**53):
        return None
    header = _HEADER.match(body)
    if not header or (header[1] or header[2]) != task:
        return None
    try:
        submission = _fields(body, (header.end(), len(body)), "Submission", {"id", "op"})
        identifier = _IDENTIFIER.fullmatch(_value(body, submission, "id"))
        if not identifier or "op" not in submission:
            return None
        operation = _fields(body, submission["op"], "TurnInput", {"request", "mode"})
        if _value(body, operation, "mode") not in {"Start", "StartOrSteer"}:
            return None
        request = _fields(body, operation["request"], "TurnInputRequest", {"thread_settings", "start"})
        settings = _fields(body, request["thread_settings"], "ThreadSettingsOverrides", {"service_tier"})
        start = _fields(body, request["start"], "TurnStartOptions", {"service_tier"})
        # Precedence of an additional start override is not established here.
        if _value(body, start, "service_tier", "None") != "None":
            return None
        raw = _value(body, settings, "service_tier", "None")
        match = re.fullmatch(r'Some\(Some\("([a-z][a-z0-9_-]{0,39})"\)\)', raw)
        if match:
            observed = tier(match[1])
            if observed is None:
                return None
            state = "set"
        elif raw in {"Some(None)", "None"}:
            observed, state = None, "clear" if raw == "Some(None)" else "absent"
        else:
            return None
        return SubmittedSettings(task, identifier[1], float(at), observed, state)
    except (KeyError, ValueError):
        return None
