#!/usr/bin/env python3
"""Decide whether failed GitHub checks may use local CI fallback.

The helper is intentionally conservative. In `billing-only` mode it only allows
fallback when the failure looks like GitHub Actions infrastructure did not run
user code: explicit billing/quota/Actions-disabled text, or every failed job
finishes almost immediately with no steps/logs available.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

PENDING_CHECK_STATES = {"QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING", "REQUESTED"}
FAILURE_CONCLUSIONS = {"FAILURE", "FAILED", "ACTION_REQUIRED", "STARTUP_FAILURE", "TIMED_OUT", "CANCELLED"}
SUCCESS_CONCLUSIONS = {"SUCCESS", "SUCCESSFUL", "NEUTRAL", "SKIPPED"}
INFRASTRUCTURE_TEXT_RE = re.compile(
    r"\b(spending limit|quota|minutes? exceeded|included minutes|actions disabled|"
    r"github actions (?:is )?disabled|github actions.{0,80}billing|billing.{0,80}github actions|"
    r"billing.{0,80}disabled|workflow (?:was )?disabled|payment required|no account minutes|"
    r"cannot run workflows?|disabled by (?:repository|organization))\b",
    re.IGNORECASE,
)
FAILED_STEP_CONCLUSIONS = {"FAILURE", "FAILED", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"}
IMMEDIATE_INFRA_CONCLUSIONS = {"FAILURE", "FAILED", "ACTION_REQUIRED", "STARTUP_FAILURE"}
LOG_UNAVAILABLE_RE = re.compile(r"\b(no logs?|log not found|failed to get logs?|could not fetch logs?)\b", re.IGNORECASE)


def parse_bool(value: str | bool) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


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


def duration_seconds(item: dict[str, Any]) -> float | None:
    started = parse_time(item.get("startedAt") or item.get("started_at"))
    completed = parse_time(item.get("completedAt") or item.get("completed_at"))
    if started is None or completed is None:
        return None
    return (completed - started).total_seconds()


def load_json(path: str | None) -> Any:
    with (open(path, "r", encoding="utf-8") if path else sys.stdin) as stream:
        return json.load(stream)


def load_optional_json(path: str | None) -> Any:
    if not path:
        return None
    return load_json(path)


def pull_request_from(data: Any) -> dict[str, Any]:
    if isinstance(data, dict):
        for key in ("pullRequest", "pull_request", "pr"):
            if isinstance(data.get(key), dict):
                return data[key]
        return data
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]
    return {}


def iter_jobs(data: Any) -> Iterable[dict[str, Any]]:
    if isinstance(data, dict):
        jobs = data.get("jobs")
        if isinstance(jobs, list):
            for job in jobs:
                if isinstance(job, dict):
                    yield job
        runs = data.get("runs") or data.get("workflowRuns") or data.get("workflow_runs")
        if isinstance(runs, list):
            for run in runs:
                yield from iter_jobs(run)
    elif isinstance(data, list):
        for item in data:
            yield from iter_jobs(item)


def status_rollup(pr: dict[str, Any]) -> list[dict[str, Any]]:
    checks = pr.get("statusCheckRollup") or pr.get("status_check_rollup") or []
    return [check for check in checks if isinstance(check, dict)] if isinstance(checks, list) else []


def normalized_conclusion(item: dict[str, Any]) -> str:
    return str(item.get("conclusion") or item.get("state") or "").upper()


def normalized_status(item: dict[str, Any]) -> str:
    return str(item.get("status") or item.get("state") or "").upper()


def is_failure(item: dict[str, Any]) -> bool:
    return normalized_conclusion(item) in FAILURE_CONCLUSIONS


def is_success(item: dict[str, Any]) -> bool:
    conclusion = normalized_conclusion(item)
    status = normalized_status(item)
    return conclusion in SUCCESS_CONCLUSIONS or status == "SUCCESS"


def has_pending(items: Iterable[dict[str, Any]]) -> bool:
    return any(normalized_status(item) in PENDING_CHECK_STATES for item in items)


def recursive_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from recursive_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from recursive_strings(child)


def job_steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    steps = job.get("steps") or []
    return [step for step in steps if isinstance(step, dict)] if isinstance(steps, list) else []


def failed_steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    failed: list[dict[str, Any]] = []
    for step in job_steps(job):
        conclusion = str(step.get("conclusion") or step.get("status") or "").upper()
        if conclusion in FAILED_STEP_CONCLUSIONS:
            failed.append(step)
    return failed


def check_summary(item: dict[str, Any]) -> str:
    name = item.get("name") or item.get("workflowName") or item.get("displayTitle") or "unnamed"
    duration = duration_seconds(item)
    if duration is None:
        return f"{name}: duration unknown"
    return f"{name}: {duration:.0f}s"


def decide(data: Any, jobs_data: Any, log_text: str, enabled: bool, mode: str, max_immediate_seconds: float) -> dict[str, Any]:
    pr = pull_request_from(data)
    combined_jobs_source = jobs_data if jobs_data is not None else data
    checks = status_rollup(pr)
    jobs = list(iter_jobs(combined_jobs_source))
    evidence: list[str] = []

    text_blob = "\n".join([*recursive_strings(pr), *recursive_strings(combined_jobs_source), log_text])
    explicit_infra = INFRASTRUCTURE_TEXT_RE.search(text_blob) is not None
    if explicit_infra:
        evidence.append("GitHub Actions の課金・quota・Actions 停止系の文言を検出しました。")

    observable_items = [*checks, *jobs] or jobs or checks
    failed_jobs = [job for job in jobs if is_failure(job)]
    failed_checks = [check for check in checks if is_failure(check)]
    failed_items = failed_jobs or failed_checks

    if not enabled:
        return {
            "enabled": False,
            "mode": mode,
            "classification": "disabled",
            "fallbackAllowed": False,
            "reason": "ci_fallback_disabled",
            "evidence": evidence,
        }
    if mode != "billing-only":
        return {
            "enabled": True,
            "mode": mode,
            "classification": "unsupported_mode",
            "fallbackAllowed": False,
            "reason": "unsupported_mode",
            "evidence": [*evidence, "現在サポートする mode は billing-only だけです。"],
        }
    if not observable_items:
        return {
            "enabled": True,
            "mode": mode,
            "classification": "unknown_ci_failure",
            "fallbackAllowed": False,
            "reason": "no_check_data",
            "evidence": [*evidence, "GitHub checks / job 情報がありません。"],
        }
    if has_pending(observable_items):
        return {
            "enabled": True,
            "mode": mode,
            "classification": "pending",
            "fallbackAllowed": False,
            "reason": "checks_pending",
            "evidence": [*evidence, "進行中の check があるため fallback 判定をしません。"],
        }
    if not failed_items:
        return {
            "enabled": True,
            "mode": mode,
            "classification": "no_failure",
            "fallbackAllowed": False,
            "reason": "no_failed_checks",
            "evidence": [*evidence, "失敗した check / job がありません。"],
        }

    successful_items = [item for item in observable_items if is_success(item)]
    job_failed_steps = [step for job in failed_jobs for step in failed_steps(job)]
    if job_failed_steps:
        return {
            "enabled": True,
            "mode": mode,
            "classification": "ordinary_ci_failure",
            "fallbackAllowed": False,
            "reason": "failed_job_step",
            "evidence": [
                *evidence,
                "失敗 step があるため、コード実行後の通常 CI failure と扱います。",
                *[f"failed step: {step.get('name') or step.get('number') or 'unnamed'}" for step in job_failed_steps[:5]],
            ],
        }

    durations = [duration_seconds(item) for item in failed_items]
    all_durations_known = all(duration is not None for duration in durations)
    all_immediate = all_durations_known and all(duration <= max_immediate_seconds for duration in durations if duration is not None)
    all_observable_failed = len(successful_items) == 0 and all(is_failure(item) for item in observable_items)
    all_immediate_conclusions_match = all(normalized_conclusion(item) in IMMEDIATE_INFRA_CONCLUSIONS for item in failed_items)
    all_failed_jobs_have_no_steps = bool(failed_jobs) and all(len(job_steps(job)) == 0 for job in failed_jobs)
    no_log_available = not log_text.strip() or LOG_UNAVAILABLE_RE.search(log_text) is not None

    if explicit_infra:
        return {
            "enabled": True,
            "mode": mode,
            "classification": "ci_infrastructure_failure",
            "fallbackAllowed": True,
            "reason": "explicit_infrastructure_text",
            "evidence": evidence,
        }

    if (
        all_observable_failed
        and all_immediate
        and all_immediate_conclusions_match
        and all_failed_jobs_have_no_steps
        and no_log_available
    ):
        summaries = [check_summary(item) for item in failed_items[:8]]
        return {
            "enabled": True,
            "mode": mode,
            "classification": "ci_infrastructure_failure",
            "fallbackAllowed": True,
            "reason": "all_jobs_failed_immediately_without_steps_or_logs",
            "evidence": [
                *evidence,
                f"すべての失敗 check / job が {max_immediate_seconds:g} 秒以内に終了し、job steps と log がありません。",
                *summaries,
            ],
        }

    reason = "mixed_or_slow_failures"
    detail = "成功した check と失敗した check が混在、または失敗までの時間が通常実行相当です。"
    if not all_durations_known:
        reason = "insufficient_duration_data"
        detail = "失敗までの時間を確認できないため、billing-only fallback は許可しません。"
    return {
        "enabled": True,
        "mode": mode,
        "classification": "ordinary_ci_failure" if successful_items or not all_immediate else "unknown_ci_failure",
        "fallbackAllowed": False,
        "reason": reason,
        "evidence": [*evidence, detail, *[check_summary(item) for item in failed_items[:8]]],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="Combined PR/check/job JSON. Defaults to stdin.")
    parser.add_argument("--jobs", help="Optional gh run view --json jobs JSON file.")
    parser.add_argument("--log-file", action="append", default=[], help="Optional GitHub Actions log text file. Can repeat.")
    parser.add_argument("--enabled", default="false")
    parser.add_argument("--mode", default="billing-only")
    parser.add_argument("--max-immediate-seconds", type=float, default=5.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    data = load_json(args.input)
    jobs_data = load_optional_json(args.jobs)
    log_parts: list[str] = []
    for log_file in args.log_file:
        log_parts.append(Path(log_file).read_text(encoding="utf-8", errors="replace"))
    input_log = data.get("logText") if isinstance(data, dict) else ""
    if input_log:
        log_parts.append(str(input_log))
    decision = decide(
        data,
        jobs_data,
        "\n".join(log_parts),
        parse_bool(args.enabled),
        args.mode,
        args.max_immediate_seconds,
    )
    print(json.dumps(decision, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ci-fallback-decision.py: {error}", file=sys.stderr)
        raise SystemExit(2)
