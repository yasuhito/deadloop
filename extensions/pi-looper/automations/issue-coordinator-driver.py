#!/usr/bin/env python3
"""Deterministic issue-coordinator driver.

The scheduler runs this after precheck and before sending any prompt. It handles
safe no-op, cleanup, and gate outcomes itself. When the remaining work still
needs the legacy LLM orchestration path, it returns a bounded `needs_llm` prompt
instead of the full static coordinator prompt.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
DECISION_SCRIPT = SCRIPT_DIR / "issue-coordinator-decisions.py"
CLEANUP_SCRIPT = SCRIPT_DIR / "cleanup-completed-worker-worktrees.py"

DEFAULT_READY_LABEL = "ready-for-agent"
DEFAULT_IMPLEMENT_LABEL = "agent:implement"
DEFAULT_IN_PROGRESS_LABEL = "agent:in-progress"
DEFAULT_BLOCKED_LABEL = "agent:blocked"
DEFAULT_REVIEW_LABEL = "agent:review"
DEFAULT_NEEDS_TRIAGE_LABEL = "needs-triage"

CONTRACT_BRIEF_RE = re.compile(r"^##\s*(?:Agent Brief|What to build)\b", re.IGNORECASE | re.MULTILINE)
CONTRACT_ACCEPTANCE_RE = re.compile(r"^##\s*(?:Acceptance criteria|受け入れ条件)\b|\bAcceptance criteria\b|受け入れ条件", re.IGNORECASE | re.MULTILINE)
PRD_ONLY_RE = re.compile(r"^##\s*(?:PRD|RFC|設計|計画)\b|\b(?:PRD|RFC)\b", re.IGNORECASE | re.MULTILINE)
TASK_LIST_RE = re.compile(r"^\s*- \[[ xX]\] .+#\d+", re.MULTILINE)


def result(action: str, summary: str, **extra: Any) -> dict[str, Any]:
    return {"action": action, "summary": summary, **extra}


def run_text(args: list[str], *, input_text: str | None = None, check: bool = True) -> str:
    completed = subprocess.run(args, input=input_text, text=True, capture_output=True, check=False)
    if check and completed.returncode != 0:
        message = (completed.stderr or completed.stdout or f"command failed: {args!r}").strip()
        raise RuntimeError(message)
    return completed.stdout


def run_json(args: list[str], *, input_text: str | None = None) -> Any:
    return json.loads(run_text(args, input_text=input_text))


def shell_quote(value: str | int) -> str:
    text = str(value)
    if re.match(r"^[A-Za-z0-9_./:@%+=,-]+$", text):
        return text
    return "'" + text.replace("'", "'\"'\"'") + "'"


def one_line(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\r", " ").replace("\n", " ").replace("\t", " ")).strip()


def load_fixture(path: str | None) -> dict[str, Any] | None:
    if not path:
        return None
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("fixture must be a JSON object")
    return data


def cleanup_plan(fixture: dict[str, Any] | None) -> dict[str, Any]:
    if fixture is not None:
        return dict(fixture.get("cleanup") or {"candidates": []})
    return run_json(["python3", str(CLEANUP_SCRIPT), "--plan", "--json"])


def apply_cleanup(plan: dict[str, Any], fixture: dict[str, Any] | None) -> dict[str, Any]:
    if fixture is not None:
        return {**plan, "appliedFromFixture": True}
    return run_json(["python3", str(CLEANUP_SCRIPT), "--apply", "--json"])


def issue_list(fixture: dict[str, Any] | None, repo: str) -> list[dict[str, Any]]:
    if fixture is not None:
        return [issue for issue in fixture.get("issues") or [] if isinstance(issue, dict)]
    data = run_json(
        [
            "gh",
            "issue",
            "list",
            "-R",
            repo,
            "--state",
            "open",
            "--limit",
            "200",
            "--json",
            "number,title,body,labels,updatedAt,url",
        ]
    )
    return [issue for issue in data if isinstance(issue, dict)]


def decision_for_issues(fixture_path: str | None, issues: list[dict[str, Any]], repo: str, labels: dict[str, str]) -> dict[str, Any]:
    args = [
        "python3",
        str(DECISION_SCRIPT),
        "--json",
        "--repo",
        repo,
        "--ready-label",
        labels["ready"],
        "--implement-label",
        labels["implement"],
        "--in-progress-label",
        labels["inProgress"],
        "--blocked-label",
        labels["blocked"],
        "--human-label",
        labels["human"],
        "--needs-info-label",
        labels["needsInfo"],
        "--wontfix-label",
        labels["wontfix"],
    ]
    if fixture_path:
        args.extend(["--fixture", fixture_path])
        return run_json(args)
    return run_json(args, input_text=json.dumps(issues, ensure_ascii=False))


def selected_issue(issues: list[dict[str, Any]], number: int) -> dict[str, Any]:
    for issue in issues:
        if int(issue.get("number") or 0) == number:
            return issue
    return {"number": number, "title": "", "body": "", "url": ""}


def has_implementation_contract(issue: dict[str, Any]) -> bool:
    body = str(issue.get("body") or "")
    return bool(CONTRACT_BRIEF_RE.search(body) and CONTRACT_ACCEPTANCE_RE.search(body))


def is_blocked_planning_issue(issue: dict[str, Any]) -> bool:
    body = str(issue.get("body") or "")
    title = str(issue.get("title") or "")
    return bool(PRD_ONLY_RE.search(f"{title}\n{body}") or TASK_LIST_RE.search(body))


def gate_missing_contract_comment(issue: dict[str, Any]) -> str:
    return "\n".join(
        [
            "実装契約が不足しているため、自動実装の対象から外しました。",
            "",
            "不足しているもの:",
            "- `## Agent Brief` または `## What to build`",
            "- `## Acceptance criteria` または `## 受け入れ条件`",
            "",
            f"Issue 本文を整えたあと、`agent:implement` を付け直してください。対象: #{issue.get('number')}",
        ]
    )


def blocked_comment(issue: dict[str, Any], env: dict[str, str], reason: str) -> str:
    number = int(issue.get("number") or 0)
    return f"""## 何が起きたか
- {reason}
- 確認済み事項:
- Issue #{number} は、単一 Worker に渡せる実装単位ではありません。
- 次に必要な判断: 実装可能な単位の Issue を別に用意するか、この Issue の scope を分割してください。

## 復旧手順
1. 原因を確認する。
   該当なし: promise ファイルは未作成です。
```bash
gh issue view {number} -R {shell_quote(env['githubRepo'])} --comments
python3 {shell_quote(env['automationDir'])}/extract-worker-promise.py --file '<promiseFile>' || true
herdr agent list
herdr pane list
```
2. 残骸（worktree / branch）を確認し、安全に掃除する。
   掃除コマンドは対象が clean / 不要であることを確認してから実行する。
   該当なし: この gate では worktree / branch を作成していません。
```bash
herdr worktree list --cwd {shell_quote(env['repoPath'])} --json
git -C {shell_quote(env['repoPath'])} worktree list
git -C {shell_quote(env['repoPath'])} branch --list {shell_quote(f'agent/issue-{number}-*')}
herdr worktree remove --workspace '<workspaceId>'
git -C {shell_quote(env['repoPath'])} worktree remove '<worktreePath>'
git -C {shell_quote(env['repoPath'])} branch -d '<branch>'
```
3. 原因を解消したあと、issue を再 queue する。
```bash
gh issue edit {number} -R {shell_quote(env['githubRepo'])} --remove-label {shell_quote(env['blockedLabel'])} --add-label {shell_quote(env['implementLabel'])}
```"""


def apply_contract_missing(issue: dict[str, Any], env: dict[str, str], fixture: dict[str, Any] | None) -> None:
    if fixture is not None:
        return
    number = str(issue.get("number"))
    run_text(["gh", "issue", "edit", number, "-R", env["githubRepo"], "--remove-label", env["implementLabel"], "--add-label", env["needsTriageLabel"]])
    run_text(["gh", "issue", "comment", number, "-R", env["githubRepo"], "--body", gate_missing_contract_comment(issue)])


def apply_blocked(issue: dict[str, Any], env: dict[str, str], comment: str, fixture: dict[str, Any] | None) -> None:
    if fixture is not None:
        return
    number = str(issue.get("number"))
    run_text(["gh", "issue", "edit", number, "-R", env["githubRepo"], "--remove-label", env["implementLabel"], "--add-label", env["blockedLabel"]])
    run_text(["gh", "issue", "comment", number, "-R", env["githubRepo"], "--body", comment])


def worker_launch_prompt(issue: dict[str, Any], env: dict[str, str]) -> str:
    number = int(issue.get("number") or 0)
    title = one_line(str(issue.get("title") or "task"))
    url = str(issue.get("url") or f"https://github.com/{env['githubRepo']}/issues/{number}")
    worker_name = f"{env['projectId']}-issue-{number}-worker"
    return f"""Deterministic issue-coordinator driver selected Issue #{number}. Continue only this bounded worker-launch path; do not reselect another issue.

Target:
- GitHub repo: {env['githubRepo']}
- Issue: #{number} {title}
- Issue URL: {url}

Required safety contract:
- Claim before launch: remove `{env['implementLabel']}` and add `{env['inProgressLabel']}`.
- Use a unique Worker name like `{worker_name}`; never use the default `pi` name.
- Create a Herdr worktree and then a dedicated tab with `herdr tab create --workspace <workspaceId> --cwd <worktreePath> --label "{worker_name}" --no-focus`.
- Render the Worker prompt with `src/issue-coordinator-renderers.ts` / `renderIssueWorkerPrompt` semantics, including promise file `<worktreePath>/.pi-looper/promise-<uuid>.json`.
- Start the Worker only through `node {env['automationDir']}/launch-agent.ts --agent "{env['workerAgent']}" --name "$worker_name" --cwd "$worktree_path" --repo-path {shell_quote(env['repoPath'])} --level "$level" --model "{env['workerModel']}" --uuid "$uuid" --prompt-file "$prompt_file" --tab "$tab_id"`.
- The promise file is the only completion authority. When `complete` or `blocked` appears, break polling immediately (`complete|blocked) break`). Do not use Herdr status as completion authority.
- After a complete promise, run validation including `{env['checkCommand']}`, create a reviewable PR, add `{env['reviewLabel']}`, and preserve existing safety rules.

Report only the resulting action and evidence."""


def env_config() -> dict[str, str]:
    return {
        "projectId": os.environ.get("PI_LOOPER_PROJECT_ID", "project"),
        "repoPath": os.environ.get("PI_LOOPER_REPO_PATH", "."),
        "githubRepo": os.environ.get("PI_LOOPER_GITHUB_REPO", ""),
        "baseBranch": os.environ.get("PI_LOOPER_BASE_BRANCH", "origin/main"),
        "automationDir": str(SCRIPT_DIR),
        "checkCommand": os.environ.get("PI_LOOPER_CHECK_COMMAND", "git diff --check"),
        "workerAgent": os.environ.get("PI_LOOPER_WORKER_AGENT", "pi"),
        "workerModel": os.environ.get("PI_LOOPER_WORKER_MODEL", ""),
        "readyLabel": os.environ.get("PI_LOOPER_READY_LABEL", DEFAULT_READY_LABEL),
        "implementLabel": os.environ.get("PI_LOOPER_IMPLEMENT_LABEL", DEFAULT_IMPLEMENT_LABEL),
        "inProgressLabel": os.environ.get("PI_LOOPER_IN_PROGRESS_LABEL", DEFAULT_IN_PROGRESS_LABEL),
        "blockedLabel": os.environ.get("PI_LOOPER_BLOCKED_LABEL", DEFAULT_BLOCKED_LABEL),
        "reviewLabel": os.environ.get("PI_LOOPER_REVIEW_LABEL", DEFAULT_REVIEW_LABEL),
        "humanLabel": os.environ.get("PI_LOOPER_HUMAN_LABEL", "ready-for-human"),
        "needsInfoLabel": os.environ.get("PI_LOOPER_NEEDS_INFO_LABEL", "needs-info"),
        "wontfixLabel": os.environ.get("PI_LOOPER_WONTFIX_LABEL", "wontfix"),
        "needsTriageLabel": os.environ.get("PI_LOOPER_NEEDS_TRIAGE_LABEL", DEFAULT_NEEDS_TRIAGE_LABEL),
    }


def label_config(env: dict[str, str]) -> dict[str, str]:
    return {
        "ready": env["readyLabel"],
        "implement": env["implementLabel"],
        "inProgress": env["inProgressLabel"],
        "blocked": env["blockedLabel"],
        "human": env["humanLabel"],
        "needsInfo": env["needsInfoLabel"],
        "wontfix": env["wontfixLabel"],
    }


def drive(args: argparse.Namespace) -> dict[str, Any]:
    fixture = load_fixture(args.fixture)
    env = env_config()
    if not env["githubRepo"] and fixture is None:
        return result("error", "PI_LOOPER_GITHUB_REPO is required", driverAction="configuration_error")

    plan = cleanup_plan(fixture)
    candidates = plan.get("candidates") or []
    if candidates:
        cleanup = apply_cleanup(plan, fixture)
        return result(
            "done",
            f"completed worker cleanup: {len(candidates)} candidate(s)",
            driverAction="cleanup_applied",
            cleanup=cleanup,
        )

    issues = issue_list(fixture, env["githubRepo"])
    decision = decision_for_issues(args.fixture, issues, env["githubRepo"], label_config(env))
    if not decision.get("selected"):
        return result("skip", "対象 issue なし", driverAction="no_candidate", decision=decision)

    issue = selected_issue(issues, int(decision.get("number") or 0))
    if not has_implementation_contract(issue):
        apply_contract_missing(issue, env, fixture)
        return result(
            "done",
            f"Issue #{issue.get('number')} は契約不足のため needs-triage に移しました",
            driverAction="contract_missing",
            issueNumber=issue.get("number"),
            comment=gate_missing_contract_comment(issue),
        )

    if is_blocked_planning_issue(issue):
        comment = blocked_comment(issue, env, "PRD / 設計 / 親 Issue 型のため、自動実装を見送りました。")
        apply_blocked(issue, env, comment, fixture)
        return result(
            "done",
            f"Issue #{issue.get('number')} は実装単位ではないため blocked にしました",
            driverAction="blocked_comment",
            issueNumber=issue.get("number"),
            comment=comment,
        )

    return result(
        "needs_llm",
        f"Issue #{issue.get('number')} の Worker 起動が必要です",
        driverAction="worker_launch_request",
        issueNumber=issue.get("number"),
        prompt=worker_launch_prompt(issue, env),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", help="Run against a fixture JSON file instead of live GitHub/Herdr state.")
    parser.add_argument("--json", action="store_true", help="Print JSON output. Enabled by default for scheduler use.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    print(json.dumps(drive(args), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps(result("error", str(error), driverAction="exception"), ensure_ascii=False, sort_keys=True))
        raise SystemExit(0)
