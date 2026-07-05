#!/usr/bin/env python3
"""Deterministic decisions for issue-coordinator automation."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


DEFAULT_READY_LABEL = "ready-for-agent"
DEFAULT_IMPLEMENT_LABEL = "agent:implement"
DEFAULT_IN_PROGRESS_LABEL = "agent:in-progress"
DEFAULT_BLOCKED_LABEL = "agent:blocked"
DEFAULT_HUMAN_LABEL = "ready-for-human"
DEFAULT_NEEDS_INFO_LABEL = "needs-info"
DEFAULT_WONTFIX_LABEL = "wontfix"

INLINE_DEPENDENCY_RE = re.compile(r"(?:Depends on|Blocked by|依存:|ブロック:)\s*#(\d+)", re.IGNORECASE)
DEPENDENCY_SECTION_RE = re.compile(r"^##\s*(?:Blocked by|Depends on|依存|ブロック)\b.*?(?=^##|\Z)", re.IGNORECASE | re.MULTILINE | re.DOTALL)
NONE_LINE_RE = re.compile(r"^\s*none\s*(?:-|$)", re.IGNORECASE | re.MULTILINE)
ISSUE_REFERENCE_RE = re.compile(r"#(\d+)")


@dataclass(frozen=True)
class IssueDecisionConfig:
    ready_label: str = DEFAULT_READY_LABEL
    implement_label: str = DEFAULT_IMPLEMENT_LABEL
    in_progress_label: str = DEFAULT_IN_PROGRESS_LABEL
    blocked_label: str = DEFAULT_BLOCKED_LABEL
    human_label: str = DEFAULT_HUMAN_LABEL
    needs_info_label: str = DEFAULT_NEEDS_INFO_LABEL
    wontfix_label: str = DEFAULT_WONTFIX_LABEL


class CommandError(RuntimeError):
    pass


class CommandRunner:
    def json(self, args: list[str]) -> Any:
        output = self.text(args)
        return json.loads(output)

    def text(self, args: list[str], check: bool = True) -> str:
        try:
            result = subprocess.run(args, text=True, capture_output=True, check=False)
        except FileNotFoundError as error:
            if check:
                raise CommandError(str(error)) from error
            return ""
        if check and result.returncode != 0:
            raise CommandError((result.stderr or result.stdout or f"command failed: {args!r}").strip())
        return result.stdout


def labels_of(issue: dict[str, Any]) -> set[str]:
    labels = issue.get("labels") or []
    names: set[str] = set()
    for label in labels:
        if isinstance(label, str):
            names.add(label)
        elif isinstance(label, dict) and label.get("name"):
            names.add(str(label["name"]))
    return names


def issue_number(issue: dict[str, Any]) -> int:
    try:
        return int(issue.get("number"))
    except (TypeError, ValueError):
        return 0


def body_dependency_numbers(body: str | None) -> set[int]:
    text = body or ""
    dependencies = {int(value) for value in INLINE_DEPENDENCY_RE.findall(text)}
    for match in DEPENDENCY_SECTION_RE.finditer(text):
        section = match.group(0)
        if NONE_LINE_RE.search(section):
            continue
        dependencies.update(int(value) for value in ISSUE_REFERENCE_RE.findall(section))
    return dependencies


def skip(reason: str, issue: dict[str, Any]) -> dict[str, Any]:
    return {"number": issue.get("number"), "reason": reason}


def dependency_states_closed(
    dependencies: set[int],
    dependency_state: Callable[[int], str | None],
) -> tuple[bool, list[dict[str, Any]]]:
    open_dependencies: list[dict[str, Any]] = []
    for number in sorted(dependencies):
        state = dependency_state(number)
        if str(state or "OPEN").upper() != "CLOSED":
            open_dependencies.append({"number": number, "state": state or "UNKNOWN"})
    return len(open_dependencies) == 0, open_dependencies


def select_issue_for_implementation(
    issues: list[dict[str, Any]],
    config: IssueDecisionConfig,
    relationship_dependencies: Callable[[dict[str, Any]], set[int]],
    dependency_state: Callable[[int], str | None],
) -> dict[str, Any]:
    required_labels = {config.ready_label, config.implement_label}
    skip_labels = {
        config.in_progress_label,
        config.blocked_label,
        config.needs_info_label,
        config.human_label,
        config.wontfix_label,
    }
    skipped: list[dict[str, Any]] = []

    for issue in sorted(issues, key=issue_number):
        labels = labels_of(issue)
        if not required_labels <= labels:
            skipped.append(skip("missing_required_label", issue))
            continue
        if labels & skip_labels:
            skipped.append(skip("skip_label", issue))
            continue

        dependencies = body_dependency_numbers(issue.get("body") or "")
        dependencies.update(relationship_dependencies(issue))
        closed, open_dependencies = dependency_states_closed(dependencies, dependency_state)
        if not closed:
            skipped.append({**skip("open_dependency", issue), "dependencies": open_dependencies})
            continue

        return {
            "selected": True,
            "number": issue.get("number"),
            "reason": "selectable",
            "dependencies": sorted(dependencies),
            "skipped": skipped,
        }

    return {"selected": False, "reason": "no_candidate", "skipped": skipped}


def parse_dependency_state_map(data: dict[str, Any]) -> dict[int, str]:
    states = data.get("dependencyStates") or {}
    return {int(number): str(state) for number, state in states.items()}


def parse_relationship_dependency_map(data: dict[str, Any]) -> dict[int, set[int]]:
    relationships = data.get("relationshipDependencies") or data.get("blockedBy") or {}
    parsed: dict[int, set[int]] = {}
    for number, dependencies in relationships.items():
        parsed[int(number)] = {int(value) for value in dependencies or []}
    return parsed


def fixture_decision(path: str, config: IssueDecisionConfig) -> dict[str, Any]:
    data = json.loads(Path(path).read_text())
    states = parse_dependency_state_map(data)
    relationships = parse_relationship_dependency_map(data)

    return select_issue_for_implementation(
        issues=[issue for issue in data.get("issues") or [] if isinstance(issue, dict)],
        config=config,
        relationship_dependencies=lambda issue: relationships.get(issue_number(issue), set()),
        dependency_state=lambda number: states.get(number),
    )


def issue_blocked_by_numbers(repo: str, number: int, runner: CommandRunner) -> set[int]:
    owner, name = repo.split("/", 1)
    try:
        data = runner.json(
            [
                "gh",
                "api",
                "graphql",
                "-f",
                f"owner={owner}",
                "-f",
                f"name={name}",
                "-F",
                f"number={number}",
                "-f",
                "query=query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { issue(number:$number) { blockedBy(first:20) { nodes { number } } } } }",
            ]
        )
    except (CommandError, json.JSONDecodeError, ValueError):
        return set()
    nodes = (((data.get("data") or {}).get("repository") or {}).get("issue") or {}).get("blockedBy", {}).get("nodes", [])
    return {int(node["number"]) for node in nodes if isinstance(node, dict) and node.get("number") is not None}


def live_dependency_state(repo: str, number: int, runner: CommandRunner) -> str | None:
    try:
        data = runner.json(["gh", "issue", "view", str(number), "-R", repo, "--json", "state"])
    except (CommandError, json.JSONDecodeError):
        return None
    state = data.get("state") if isinstance(data, dict) else None
    return str(state) if state else None


def load_issues(path: str | None) -> list[dict[str, Any]]:
    with (open(path, "r", encoding="utf-8") if path else sys.stdin) as stream:
        data = json.load(stream)
    if not isinstance(data, list):
        raise ValueError("issue JSON must be a list")
    return [issue for issue in data if isinstance(issue, dict)]


def config_from_args(args: argparse.Namespace) -> IssueDecisionConfig:
    return IssueDecisionConfig(
        ready_label=args.ready_label,
        implement_label=args.implement_label,
        in_progress_label=args.in_progress_label,
        blocked_label=args.blocked_label,
        human_label=args.human_label,
        needs_info_label=args.needs_info_label,
        wontfix_label=args.wontfix_label,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="Path to issue JSON. Defaults to stdin.")
    parser.add_argument("--fixture", help="Load issues and dependency states from a fixture JSON file.")
    parser.add_argument("--repo", default=os.environ.get("PI_LOOPER_GITHUB_REPO"))
    parser.add_argument("--ready-label", default=os.environ.get("PI_LOOPER_READY_LABEL", DEFAULT_READY_LABEL))
    parser.add_argument("--implement-label", default=os.environ.get("PI_LOOPER_IMPLEMENT_LABEL", DEFAULT_IMPLEMENT_LABEL))
    parser.add_argument("--in-progress-label", default=os.environ.get("PI_LOOPER_IN_PROGRESS_LABEL", DEFAULT_IN_PROGRESS_LABEL))
    parser.add_argument("--blocked-label", default=os.environ.get("PI_LOOPER_BLOCKED_LABEL", DEFAULT_BLOCKED_LABEL))
    parser.add_argument("--human-label", default=os.environ.get("PI_LOOPER_HUMAN_LABEL", DEFAULT_HUMAN_LABEL))
    parser.add_argument("--needs-info-label", default=os.environ.get("PI_LOOPER_NEEDS_INFO_LABEL", DEFAULT_NEEDS_INFO_LABEL))
    parser.add_argument("--wontfix-label", default=os.environ.get("PI_LOOPER_WONTFIX_LABEL", DEFAULT_WONTFIX_LABEL))
    parser.add_argument("--exit-code", action="store_true", help="Exit 0 only when an issue is selected.")
    parser.add_argument("--json", action="store_true", help="Print JSON output.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = config_from_args(args)

    if args.fixture:
        decision = fixture_decision(args.fixture, config)
    else:
        if not args.repo:
            raise ValueError("--repo or PI_LOOPER_GITHUB_REPO is required")
        runner = CommandRunner()
        issues = load_issues(args.input)
        decision = select_issue_for_implementation(
            issues=issues,
            config=config,
            relationship_dependencies=lambda issue: issue_blocked_by_numbers(args.repo, issue_number(issue), runner),
            dependency_state=lambda number: live_dependency_state(args.repo, number, runner),
        )

    if args.json:
        print(json.dumps(decision, ensure_ascii=False, sort_keys=True))
    elif decision["selected"]:
        print(f"selected issue #{decision['number']}")
    else:
        print("no selectable issue")

    if args.exit_code and not decision["selected"]:
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"issue-coordinator-decisions.py: {error}", file=sys.stderr)
        raise SystemExit(2)
