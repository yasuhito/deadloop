#!/usr/bin/env python3
"""Deterministically clean completed pi-looper Herdr worker worktrees.

The script has two modes:

- plan mode (default): inspect GitHub PRs, Herdr worktrees, and git status, then
  report removable worker worktrees.
- apply mode: execute the plan without force-removing dirty worktrees.

It intentionally keeps the removal decision outside LLM prompts so the issue
coordinator only has to invoke this script and report its result.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_REVIEW_LABEL = "agent:review"
DEFAULT_HUMAN_LABEL = "ready-for-human"


@dataclass(frozen=True)
class Config:
    repo: str
    repo_path: str
    worktree_root: str
    review_label: str
    human_label: str


class CommandError(RuntimeError):
    pass


class CommandRunner:
    def json(self, args: list[str], cwd: str | None = None) -> Any:
        output = self.text(args, cwd=cwd)
        return json.loads(output)

    def text(self, args: list[str], cwd: str | None = None, check: bool = True) -> str:
        try:
            result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)
        except FileNotFoundError as error:
            if check:
                raise CommandError(str(error)) from error
            return ""
        if check and result.returncode != 0:
            raise CommandError((result.stderr or result.stdout or f"command failed: {args!r}").strip())
        return result.stdout

    def code(self, args: list[str], cwd: str | None = None) -> int:
        try:
            return subprocess.run(args, cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode
        except FileNotFoundError:
            return 127


def labels_of(item: dict[str, Any]) -> set[str]:
    labels = item.get("labels") or []
    names: set[str] = set()
    for label in labels:
        if isinstance(label, str):
            names.add(label)
        elif isinstance(label, dict) and label.get("name"):
            names.add(str(label["name"]))
    return names


def is_merged_pr(pr: dict[str, Any]) -> bool:
    return str(pr.get("state") or "").upper() == "MERGED" or bool(pr.get("mergedAt"))


def is_closed_pr(pr: dict[str, Any]) -> bool:
    state = str(pr.get("state") or "").upper()
    return state in {"CLOSED", "MERGED"} or bool(pr.get("closedAt")) or bool(pr.get("mergedAt"))


def is_pi_looper_pr(pr: dict[str, Any], config: Config) -> bool:
    branch = str(pr.get("headRefName") or "")
    return branch.startswith("agent/issue-") or bool(labels_of(pr) & {config.review_label, config.human_label})


def norm_path(value: str) -> str:
    return os.path.abspath(os.path.expanduser(value))


def is_under_root(path: str, root: str) -> bool:
    if not root:
        return True
    try:
        return os.path.commonpath([norm_path(path), norm_path(root)]) == norm_path(root)
    except ValueError:
        return False


def is_clean_status(status: Any) -> bool:
    return str(status or "").strip() == ""


def local_head_matches_closed_pr(worktree: dict[str, Any], pr: dict[str, Any], git_heads: dict[str, str], runner: CommandRunner | None) -> bool:
    head_oid = str(pr.get("headRefOid") or "")
    if not head_oid:
        return False
    path = str(worktree.get("path") or "")
    local_head = git_heads.get(path)
    if local_head is None and runner is not None:
        local_head = runner.text(["git", "-C", path, "rev-parse", "HEAD"], check=False).strip()
    if not local_head:
        return False
    if local_head == head_oid:
        return True
    if runner is None:
        return False
    return runner.code(["git", "-C", path, "merge-base", "--is-ancestor", local_head, head_oid]) == 0


def skip(reason: str, pr: dict[str, Any], worktree: dict[str, Any]) -> dict[str, Any]:
    return {
        "reason": reason,
        "prNumber": pr.get("number"),
        "branch": worktree.get("branch") or pr.get("headRefName"),
        "path": worktree.get("path"),
        "workspaceId": worktree.get("open_workspace_id"),
    }


def candidate(pr: dict[str, Any], worktree: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "prNumber": pr.get("number"),
        "branch": worktree.get("branch"),
        "path": worktree.get("path"),
        "workspaceId": worktree.get("open_workspace_id"),
        "reason": reason,
    }


def select_cleanup_plan(
    *,
    config: Config,
    prs: list[dict[str, Any]],
    worktrees: list[dict[str, Any]],
    git_statuses: dict[str, str],
    git_heads: dict[str, str] | None = None,
    runner: CommandRunner | None = None,
) -> dict[str, list[dict[str, Any]]]:
    git_heads = git_heads or {}
    by_branch = {str(worktree.get("branch") or ""): worktree for worktree in worktrees if worktree.get("branch")}
    candidates: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    selected_paths: set[str] = set()

    for pr in sorted(prs, key=lambda item: int(item.get("number") or 0)):
        branch = str(pr.get("headRefName") or "")
        if not branch or not is_closed_pr(pr) or not is_pi_looper_pr(pr, config):
            continue
        worktree = by_branch.get(branch)
        if not worktree:
            continue

        path = str(worktree.get("path") or "")
        if not path:
            skipped.append(skip("missing_path", pr, worktree))
            continue
        if norm_path(path) == norm_path(config.repo_path):
            skipped.append(skip("main_workspace", pr, worktree))
            continue
        if worktree.get("is_linked_worktree") is False:
            skipped.append(skip("not_linked_worktree", pr, worktree))
            continue
        if not worktree.get("open_workspace_id"):
            skipped.append(skip("missing_workspace_id", pr, worktree))
            continue
        if not is_under_root(path, config.worktree_root):
            skipped.append(skip("outside_worktree_root", pr, worktree))
            continue

        status = git_statuses.get(path)
        if status is None and runner is not None:
            try:
                status = runner.text(["git", "-C", path, "status", "--short"])
            except CommandError:
                skipped.append(skip("status_unavailable", pr, worktree))
                continue
        if status is None:
            skipped.append(skip("status_unavailable", pr, worktree))
            continue
        if not is_clean_status(status):
            skipped.append(skip("dirty_worktree", pr, worktree))
            continue

        if is_merged_pr(pr):
            reason = "merged_pr"
        elif local_head_matches_closed_pr(worktree, pr, git_heads, runner):
            reason = "closed_pr_head_preserved"
        else:
            skipped.append(skip("closed_pr_head_not_verified", pr, worktree))
            continue

        if path in selected_paths:
            continue
        selected_paths.add(path)
        candidates.append(candidate(pr, worktree, reason))

    return {"candidates": candidates, "skipped": skipped}


def config_from_env() -> Config:
    return Config(
        repo=os.environ.get("PI_LOOPER_GITHUB_REPO") or os.environ["HEADR_GITHUB_REPO"],
        repo_path=os.environ.get("PI_LOOPER_REPO_PATH") or os.environ["HEADR_REPO_PATH"],
        worktree_root=os.environ.get("PI_LOOPER_WORKTREE_ROOT") or os.environ.get("HEADR_WORKTREE_ROOT", ""),
        review_label=os.environ.get("PI_LOOPER_REVIEW_LABEL") or os.environ.get("HEADR_REVIEW_LABEL", DEFAULT_REVIEW_LABEL),
        human_label=os.environ.get("PI_LOOPER_HUMAN_LABEL") or os.environ.get("HEADR_HUMAN_LABEL", DEFAULT_HUMAN_LABEL),
    )


def config_from_fixture(data: dict[str, Any]) -> Config:
    return Config(
        repo=str(data.get("repo") or "owner/repo"),
        repo_path=str(data.get("repoPath") or "/repo"),
        worktree_root=str(data.get("worktreeRoot") or ""),
        review_label=str(data.get("reviewLabel") or DEFAULT_REVIEW_LABEL),
        human_label=str(data.get("humanLabel") or DEFAULT_HUMAN_LABEL),
    )


def load_live_plan(config: Config, runner: CommandRunner) -> dict[str, list[dict[str, Any]]]:
    prs: list[dict[str, Any]] = []
    seen: set[int] = set()
    for state in ("merged", "closed"):
        try:
            batch = runner.json([
                "gh",
                "pr",
                "list",
                "-R",
                config.repo,
                "--state",
                state,
                "--limit",
                "100",
                "--json",
                "number,state,mergedAt,closedAt,headRefName,headRefOid,labels",
            ])
        except (CommandError, json.JSONDecodeError):
            batch = []
        for pr in batch:
            number = int(pr.get("number") or 0)
            if number in seen:
                continue
            seen.add(number)
            prs.append(pr)

    worktree_data = runner.json(["herdr", "worktree", "list", "--cwd", config.repo_path, "--json"])
    worktrees = ((worktree_data.get("result") or {}).get("worktrees") or []) if isinstance(worktree_data, dict) else []
    return select_cleanup_plan(config=config, prs=prs, worktrees=worktrees, git_statuses={}, runner=runner)


def load_fixture_plan(path: str) -> dict[str, list[dict[str, Any]]]:
    data = json.loads(Path(path).read_text())
    return select_cleanup_plan(
        config=config_from_fixture(data),
        prs=data.get("prs") or [],
        worktrees=data.get("worktrees") or [],
        git_statuses=(data.get("git") or {}).get("statuses") or {},
        git_heads=(data.get("git") or {}).get("heads") or {},
        runner=None,
    )


def apply_plan(plan: dict[str, list[dict[str, Any]]], config: Config, runner: CommandRunner) -> dict[str, Any]:
    runner.text(["git", "-C", config.repo_path, "fetch", "--prune"], check=False)
    removed: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []

    for item in plan["candidates"]:
        workspace_id = item.get("workspaceId")
        try:
            if not workspace_id:
                raise CommandError("missing Herdr workspace id; refusing direct git worktree removal")
            runner.text(["herdr", "worktree", "remove", "--workspace", str(workspace_id), "--json"])
            removed.append(item)
        except CommandError as error:
            failed.append({**item, "error": str(error)})

    return {**plan, "removed": removed, "failed": failed}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="remove selected worktrees")
    parser.add_argument("--plan", action="store_true", help="only print the cleanup plan (default)")
    parser.add_argument("--json", action="store_true", help="print JSON output")
    parser.add_argument("--fixture", help="load all inputs from a fixture JSON file")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    runner = CommandRunner()

    if args.fixture:
        plan = load_fixture_plan(args.fixture)
        result: dict[str, Any] = plan
    else:
        config = config_from_env()
        plan = load_live_plan(config, runner)
        result = apply_plan(plan, config, runner) if args.apply else plan

    if args.json:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    else:
        print(f"cleanup candidates: {len(result.get('candidates') or [])}")
        if result.get("removed") is not None:
            print(f"removed: {len(result.get('removed') or [])}")
        if result.get("failed"):
            print(f"failed: {len(result.get('failed') or [])}")
    return 1 if result.get("failed") else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
