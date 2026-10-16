"""UI-independent observations. Unknown evidence remains None."""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

PARSER_REVISION = 5
EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"})
TIERS = frozenset({"auto", "default", "standard", "fast", "priority", "ultrafast", "flex", "scale"})
STATE_CLOCK_SKEW_SECONDS = 2


def effort(value: object) -> str | None:
    return value if isinstance(value, str) and value in EFFORTS else None


def tier(value: object) -> str | None:
    if not isinstance(value, str) or value not in TIERS:
        return None
    return {"fast": "priority", "standard": "default"}.get(value, value)


@dataclass(frozen=True)
class Context:
    """Per-output configuration evidence, never inferred from current settings."""

    model: str | None = None
    effort: str | None = None
    requested_tier: str | None = None
    actual_tier: str | None = None
    submitted_tier: str | None = None


@dataclass(frozen=True)
class Sample:
    """One output range, with Unix-second timestamps and an explicit token scope.

    Identifiers are source identities during parsing and HMAC pseudonyms in history.
    Incomplete records retain tokens/evidence; exclusion determines TPS eligibility.
    """

    task_id: str
    turn_id: str
    response_id: str
    ended_at: float
    output_tokens: int | None
    started_at: float | None = None
    context: Context = Context()
    source: str = "codex-local-log-v1"
    token_scope: str = "total_output"
    issue: str | None = None
    parser_revision: int = PARSER_REVISION
    timing_source: str | None = None
    requested_tier_withdrawn: bool = False
    submitted_tier_withdrawn: bool = False

    @property
    def exclusion(self) -> str | None:
        if self.issue:
            return self.issue
        if self.token_scope != "total_output":
            return "unsupported_token_scope"
        if not math.isfinite(self.ended_at):
            return "invalid_timestamp"
        if self.started_at is None:
            return "missing_start"
        if not math.isfinite(self.started_at) or self.ended_at <= self.started_at:
            return "invalid_duration"
        if type(self.output_tokens) is not int or not 0 <= self.output_tokens <= 2**63 - 1:
            return "invalid_tokens"
        return None

    @property
    def seconds(self) -> float | None:
        if self.exclusion is not None:
            return None
        assert self.started_at is not None
        return self.ended_at - self.started_at

    @property
    def tps(self) -> float | None:
        seconds = self.seconds
        return self.output_tokens / seconds if seconds is not None else None

    @property
    def key(self) -> tuple[str, str, str]:
        return self.task_id, self.turn_id, self.response_id

    @property
    def group(self) -> tuple:
        return (self.context,)

    def is_stale(self, now: float, max_age: float = 60) -> bool:
        return now - self.ended_at > max_age or now < self.ended_at


def reconcile(previous: Sample, incoming: Sample) -> Sample:
    """Preserve complete measurements and explicit parser boundary corrections."""
    if previous.key != incoming.key:
        raise ValueError("Cannot reconcile different output samples")
    revised_measurement = (
        incoming.parser_revision > previous.parser_revision and incoming.exclusion is None
    )
    withdrawals = {"unconfirmed_tool_start", "unconfirmed_initial_span"}
    revised_boundary = (
        incoming.parser_revision > previous.parser_revision and incoming.issue in withdrawals
    )
    if previous.issue in withdrawals and previous.parser_revision > incoming.parser_revision:
        base = previous
    else:
        base = (
            incoming
            if previous.exclusion is not None or revised_measurement or revised_boundary
            else previous
        )
    if incoming.parser_revision > previous.parser_revision:
        # A new parser can explicitly withdraw unsupported old attribution.
        context = incoming.context
        requested_withdrawn = incoming.requested_tier_withdrawn
        submitted_withdrawn = incoming.submitted_tier_withdrawn
    elif incoming.parser_revision < previous.parser_revision:
        context = previous.context
        requested_withdrawn = previous.requested_tier_withdrawn
        submitted_withdrawn = previous.submitted_tier_withdrawn
    else:
        context = Context(**{
            name: getattr(incoming.context, name) or getattr(previous.context, name)
            for name in ("model", "effort", "requested_tier", "actual_tier", "submitted_tier")
        })
        requested_withdrawn = previous.requested_tier_withdrawn or incoming.requested_tier_withdrawn
        submitted_withdrawn = previous.submitted_tier_withdrawn or incoming.submitted_tier_withdrawn
    if requested_withdrawn:
        context = replace(context, requested_tier=None)
    if submitted_withdrawn:
        context = replace(context, submitted_tier=None)
    return replace(base, context=context,
                   parser_revision=max(previous.parser_revision, incoming.parser_revision),
                   requested_tier_withdrawn=requested_withdrawn,
                   submitted_tier_withdrawn=submitted_withdrawn)


@dataclass(frozen=True)
class Task:
    id: str
    title: str | None
    state: str
    updated_at: float
    context: Context = Context()
    latest: Sample | None = None
    turn_seconds: float | None = None
    wait_seconds: float | None = None
    notice: str | None = None
    is_subagent: bool | None = None

    def has_recent_state(self, now: float, max_age: float = 120) -> bool:
        # Local writers can be slightly ahead of the monitor's clock. This is
        # bounded clock tolerance, not permission to treat future history as live.
        return math.isfinite(self.updated_at) and -STATE_CLOCK_SKEW_SECONDS <= now - self.updated_at <= max_age

    def display_state(self, now: float) -> str:
        # Completion/failure is a lifecycle fact; silence cannot undo it. Active
        # phases still expire because an old event cannot prove ongoing work.
        if self.state in {"idle", "error"} and math.isfinite(self.updated_at) and 0 < self.updated_at <= now + STATE_CLOCK_SKEW_SECONDS:
            return self.state
        if self.state != "unknown" and not self.has_recent_state(now):
            return "stale"
        return self.state
