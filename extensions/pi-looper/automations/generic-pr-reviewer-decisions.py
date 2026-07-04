#!/usr/bin/env python3
"""Deterministic decisions for generic-pr-reviewer automation."""

from __future__ import annotations

import argparse
import json
import re
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable

PENDING_CHECK_STATES = {"QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING"}
EXTERNAL_REVIEW_MARKER_RE = re.compile(
    r"<!--\s*pi-looper:external-review-request\s+head=([0-9a-fA-F]+)\s*-->"
)


@dataclass(frozen=True)
class ReviewDecisionConfig:
    review_label: str = "agent:review"
    reviewing_label: str = "agent:reviewing"
    human_label: str = "ready-for-human"
    blocked_label: str = "agent:blocked"
    auto_merge: bool = False
    external_review_wait_seconds: int = 1800
    now: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


def parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def age_seconds(value: Any, now: datetime) -> float | None:
    parsed = parse_time(value)
    if parsed is None:
        return None
    return (now - parsed).total_seconds()


def label_names(pr: dict[str, Any]) -> set[str]:
    return {str(label.get("name", "")) for label in pr.get("labels") or [] if isinstance(label, dict)}


def review_request_login(request: dict[str, Any]) -> str:
    direct = request.get("login")
    if direct:
        return str(direct).lower()
    nested = request.get("requestedReviewer")
    if isinstance(nested, dict):
        return str(nested.get("login") or "").lower()
    return ""


def has_copilot_review_request(pr: dict[str, Any]) -> bool:
    for request in pr.get("reviewRequests") or []:
        if isinstance(request, dict) and "copilot" in review_request_login(request):
            return True
    return False


def has_pending_checks(pr: dict[str, Any]) -> bool:
    for check in pr.get("statusCheckRollup") or []:
        if not isinstance(check, dict):
            continue
        state = str(check.get("status") or check.get("state") or "").upper()
        if state in PENDING_CHECK_STATES:
            return True
    return False


def has_coderabbit_processing_comment(pr: dict[str, Any]) -> bool:
    for comment in pr.get("comments") or []:
        if not isinstance(comment, dict):
            continue
        author = comment.get("author") if isinstance(comment.get("author"), dict) else {}
        if str(author.get("login") or "").lower() != "coderabbitai":
            continue
        body = str(comment.get("body") or "").lower()
        if "currently processing" in body or "review in progress" in body:
            return True
    return False


def matching_marker_ages(pr: dict[str, Any], now: datetime) -> Iterable[float]:
    head = str(pr.get("headRefOid") or "")
    for comment in pr.get("comments") or []:
        if not isinstance(comment, dict):
            continue
        body = str(comment.get("body") or "")
        for match in EXTERNAL_REVIEW_MARKER_RE.finditer(body):
            if head and match.group(1) != head:
                continue
            age = age_seconds(comment.get("createdAt"), now)
            if age is not None:
                yield age


def external_review_wait_is_stale(pr: dict[str, Any], config: ReviewDecisionConfig) -> bool:
    marker_ages = list(matching_marker_ages(pr, config.now))
    if marker_ages:
        return min(marker_ages) >= config.external_review_wait_seconds

    updated_age = age_seconds(pr.get("updatedAt"), config.now)
    return updated_age is not None and updated_age >= config.external_review_wait_seconds


def external_review_gate(pr: dict[str, Any], config: ReviewDecisionConfig) -> dict[str, Any]:
    marker_ages = list(matching_marker_ages(pr, config.now))
    if marker_ages:
        age = min(marker_ages)
        if age >= config.external_review_wait_seconds:
            return {"action": "fallback_review", "reason": "stale_marker", "waitedSeconds": math.floor(age)}
        return {
            "action": "wait_external_review",
            "reason": "fresh_marker",
            "remainingSeconds": math.ceil(config.external_review_wait_seconds - age),
        }

    if has_copilot_review_request(pr):
        age = age_seconds(pr.get("updatedAt"), config.now)
        if age is not None and age >= config.external_review_wait_seconds:
            return {"action": "fallback_review", "reason": "stale_review_request", "waitedSeconds": math.floor(age)}
        return {"action": "wait_external_review", "reason": "fresh_review_request"}

    return {"action": "request_external_review", "reason": "missing_marker"}


def pr_number(pr: dict[str, Any]) -> int:
    try:
        return int(pr.get("number"))
    except (TypeError, ValueError):
        return 0


def skip(reason: str, pr: dict[str, Any]) -> dict[str, Any]:
    return {"number": pr.get("number"), "reason": reason}


def select_pr_for_review(prs: list[dict[str, Any]], config: ReviewDecisionConfig) -> dict[str, Any]:
    blocked_labels = {config.reviewing_label, config.blocked_label}
    candidate_labels = {config.review_label, config.human_label} if config.auto_merge else {config.review_label}
    skipped: list[dict[str, Any]] = []

    for pr in sorted(prs, key=pr_number):
        labels = label_names(pr)
        if not labels.intersection(candidate_labels):
            skipped.append(skip("missing_candidate_label", pr))
            continue
        if labels.intersection(blocked_labels):
            skipped.append(skip("blocked_or_reviewing", pr))
            continue
        if pr.get("isDraft"):
            return {
                "selected": True,
                "number": pr.get("number"),
                "action": "draft_gate",
                "reason": "draft",
                "skipped": skipped,
            }
        if has_copilot_review_request(pr) and not external_review_wait_is_stale(pr, config):
            skipped.append(skip("external_review_wait", pr))
            continue
        if has_pending_checks(pr):
            skipped.append(skip("pending_checks", pr))
            continue
        if has_coderabbit_processing_comment(pr) and not external_review_wait_is_stale(pr, config):
            skipped.append(skip("external_review_wait", pr))
            continue
        return {
            "selected": True,
            "number": pr.get("number"),
            "action": "review",
            "reason": "selectable",
            "skipped": skipped,
        }

    return {"selected": False, "reason": "no_candidate", "skipped": skipped}


def parse_bool(value: str) -> bool:
    return value.lower() in {"1", "true", "yes", "on"}


def load_json(path: str | None) -> Any:
    with (open(path, "r", encoding="utf-8") if path else sys.stdin) as stream:
        return json.load(stream)


def load_prs(path: str | None) -> list[dict[str, Any]]:
    data = load_json(path)
    if not isinstance(data, list):
        raise ValueError("PR JSON must be a list")
    return [pr for pr in data if isinstance(pr, dict)]


def load_pr(path: str | None) -> dict[str, Any]:
    data = load_json(path)
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]
    raise ValueError("PR JSON must be an object or a non-empty list")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="Path to PR JSON. Defaults to stdin.")
    parser.add_argument("--mode", choices=["select", "external-review-gate"], default="select")
    parser.add_argument("--review-label", default="agent:review")
    parser.add_argument("--reviewing-label", default="agent:reviewing")
    parser.add_argument("--human-label", default="ready-for-human")
    parser.add_argument("--blocked-label", default="agent:blocked")
    parser.add_argument("--auto-merge", default="0")
    parser.add_argument("--external-review-wait-seconds", type=int, default=1800)
    parser.add_argument("--now", help="Current time for deterministic tests, ISO-8601.")
    parser.add_argument("--exit-code", action="store_true", help="Exit 0 only when a PR is selected.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    now = parse_time(args.now) if args.now else datetime.now(timezone.utc)
    if now is None:
        raise ValueError("--now must be an ISO-8601 timestamp")
    config = ReviewDecisionConfig(
        review_label=args.review_label,
        reviewing_label=args.reviewing_label,
        human_label=args.human_label,
        blocked_label=args.blocked_label,
        auto_merge=parse_bool(args.auto_merge),
        external_review_wait_seconds=args.external_review_wait_seconds,
        now=now,
    )
    if args.mode == "external-review-gate":
        decision = external_review_gate(load_pr(args.input), config)
    else:
        decision = select_pr_for_review(load_prs(args.input), config)
    print(json.dumps(decision, ensure_ascii=False, sort_keys=True))
    if args.exit_code and not decision["selected"]:
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"generic-pr-reviewer-decisions.py: {error}", file=sys.stderr)
        raise SystemExit(2)
