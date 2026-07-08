#!/usr/bin/env python3
"""Decide whether issue-coordinator should keep watching a Worker.

The promise file remains the only completion authority. This helper only decides
whether a missing/invalid promise is safe to nudge, keep waiting, or consider for
pane close based on recent activity and the post-nudge grace period.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from typing import Any, Iterable

RECENT_WORKER_ACTIVITY_SECONDS = 600
MIN_POST_NUDGE_GRACE_SECONDS = 300
ACTIVE_AGENT_STATUSES = frozenset({"active", "busy", "running", "working"})
SETTLED_PROMISE_STATUSES = frozenset({"complete", "blocked"})

TOP_LEVEL_ACTIVITY_KEYS = (
    "lastActivityAt",
    "lastToolActivityAt",
    "lastFileReadAt",
    "lastAgentSessionUpdatedAt",
    "agentUpdatedAt",
    "sessionUpdatedAt",
    "paneUpdatedAt",
    "recentOutputAt",
)
NESTED_ACTIVITY_KEYS = ("lastActivityAt", "updatedAt", "lastUpdatedAt", "lastOutputAt")
NESTED_ACTIVITY_OBJECTS = ("agent", "session", "pane")
SESSION_ACTIVITY_KINDS = frozenset({"agent_session", "session"})
PANE_OUTPUT_ACTIVITY_KINDS = frozenset({"pane_output", "output"})


def parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def seconds_between(now: datetime, past: datetime | None) -> int | None:
    if past is None:
        return None
    return math.floor((now - past).total_seconds())


def iter_activity_times(observation: dict[str, Any]) -> Iterable[datetime]:
    for key in TOP_LEVEL_ACTIVITY_KEYS:
        parsed = parse_time(observation.get(key))
        if parsed is not None:
            yield parsed

    for object_key in NESTED_ACTIVITY_OBJECTS:
        nested = observation.get(object_key)
        if not isinstance(nested, dict):
            continue
        for key in NESTED_ACTIVITY_KEYS:
            parsed = parse_time(nested.get(key))
            if parsed is not None:
                yield parsed

    for event in observation.get("activity") or observation.get("events") or []:
        if not isinstance(event, dict):
            continue
        parsed = parse_time(event.get("at") or event.get("createdAt") or event.get("updatedAt"))
        if parsed is not None:
            yield parsed


def latest_activity_at(observation: dict[str, Any]) -> datetime | None:
    times = list(iter_activity_times(observation))
    return max(times) if times else None


def active_agent_status(observation: dict[str, Any]) -> str:
    direct = observation.get("agentStatus") or observation.get("agent_status") or observation.get("status")
    if direct:
        return str(direct).lower()
    agent = observation.get("agent")
    if isinstance(agent, dict):
        return str(agent.get("agent_status") or agent.get("status") or "").lower()
    return ""


def activity_kinds(observation: dict[str, Any]) -> set[str]:
    kinds: set[str] = set()
    for event in observation.get("activity") or observation.get("events") or []:
        if isinstance(event, dict) and event.get("kind"):
            kinds.add(str(event["kind"]))
    return kinds


def has_any_key(data: dict[str, Any], keys: Iterable[str]) -> bool:
    return any(key in data for key in keys)


def has_checked_nested_object(observation: dict[str, Any], object_key: str) -> bool:
    nested = observation.get(object_key)
    return isinstance(nested, dict) and has_any_key(nested, NESTED_ACTIVITY_KEYS)


def missing_required_observations(observation: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    kinds = activity_kinds(observation)
    if not active_agent_status(observation):
        missing.append("agent_status")
    if not (
        has_any_key(observation, ("lastAgentSessionUpdatedAt", "agentUpdatedAt", "sessionUpdatedAt"))
        or has_checked_nested_object(observation, "agent")
        or has_checked_nested_object(observation, "session")
        or bool(kinds & SESSION_ACTIVITY_KINDS)
    ):
        missing.append("agent_session_updated_at")
    if not (
        has_any_key(observation, ("paneUpdatedAt", "recentOutputAt"))
        or has_checked_nested_object(observation, "pane")
        or bool(kinds & PANE_OUTPUT_ACTIVITY_KINDS)
    ):
        missing.append("pane_recent_output")
    return missing


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in {"1", "true", "yes", "on"}
    return bool(value)


def build_observations(
    observation: dict[str, Any],
    now: datetime,
    last_activity: datetime | None,
    nudge_sent_at: datetime | None,
) -> dict[str, Any]:
    return {
        "promiseStatus": str(observation.get("promiseStatus") or observation.get("promise_status") or "none"),
        "worktreeHasChanges": parse_bool(observation.get("worktreeHasChanges", False)),
        "agentStatus": active_agent_status(observation),
        "lastActivityAt": last_activity.isoformat().replace("+00:00", "Z") if last_activity else None,
        "secondsSinceLastActivity": seconds_between(now, last_activity),
        "nudgeSentAt": nudge_sent_at.isoformat().replace("+00:00", "Z") if nudge_sent_at else None,
        "secondsSinceNudge": seconds_between(now, nudge_sent_at),
        "recentWorkerActivitySeconds": RECENT_WORKER_ACTIVITY_SECONDS,
        "minPostNudgeGraceSeconds": MIN_POST_NUDGE_GRACE_SECONDS,
    }


def close_log(observations: dict[str, Any]) -> str:
    return (
        f"promise={observations['promiseStatus']}; "
        f"agentStatus={observations['agentStatus'] or 'unknown'}; "
        f"lastActivityAt={observations['lastActivityAt'] or 'unknown'}; "
        f"secondsSinceLastActivity={observations['secondsSinceLastActivity']}; "
        f"nudgeSentAt={observations['nudgeSentAt'] or 'unknown'}; "
        f"secondsSinceNudge={observations['secondsSinceNudge']}; "
        f"minPostNudgeGraceSeconds={observations['minPostNudgeGraceSeconds']}; "
        f"worktreeHasChanges={str(observations['worktreeHasChanges']).lower()}"
    )


def decide_worker_watch(observation: dict[str, Any]) -> dict[str, Any]:
    now = parse_time(observation.get("now")) or datetime.now(timezone.utc)
    promise_status = str(observation.get("promiseStatus") or observation.get("promise_status") or "none")
    last_activity = latest_activity_at(observation)
    nudge_sent_at = parse_time(observation.get("nudgeSentAt") or observation.get("lastNudgeAt"))
    observations = build_observations(observation, now, last_activity, nudge_sent_at)

    if promise_status in SETTLED_PROMISE_STATUSES:
        return {"action": "promise_settled", "reason": promise_status, "observations": observations}

    agent_status = observations["agentStatus"]
    if agent_status in ACTIVE_AGENT_STATUSES:
        return {"action": "continue_waiting", "reason": "agent_status_active", "observations": observations}

    activity_age = observations["secondsSinceLastActivity"]
    if activity_age is not None and activity_age <= RECENT_WORKER_ACTIVITY_SECONDS:
        return {"action": "continue_waiting", "reason": "recent_activity", "observations": observations}

    if nudge_sent_at is None:
        return {"action": "nudge_worker", "reason": "missing_promise", "observations": observations}

    nudge_age = observations["secondsSinceNudge"]
    if nudge_age is None or nudge_age < MIN_POST_NUDGE_GRACE_SECONDS:
        return {"action": "continue_waiting", "reason": "nudge_grace_period", "observations": observations}

    missing_observations = missing_required_observations(observation)
    if missing_observations:
        return {
            "action": "collect_observations",
            "reason": "missing_required_observations",
            "missingObservations": missing_observations,
            "observations": observations,
        }

    return {
        "action": "may_close_pane",
        "reason": "inactive_after_grace",
        "observations": observations,
        "closeLog": close_log(observations),
    }


def load_input(path: str | None) -> dict[str, Any]:
    with (open(path, "r", encoding="utf-8") if path else sys.stdin) as stream:
        data = json.load(stream)
    if not isinstance(data, dict):
        raise ValueError("watch observation JSON must be an object")
    return data


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="Path to watch observation JSON. Defaults to stdin.")
    parser.add_argument("--now", help="Override observation now for deterministic runs.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    observation = load_input(args.input)
    if args.now:
        observation["now"] = args.now
    print(json.dumps(decide_worker_watch(observation), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"worker-watch-decision.py: {error}", file=sys.stderr)
        raise SystemExit(2)
