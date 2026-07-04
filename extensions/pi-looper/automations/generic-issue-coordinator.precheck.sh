#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

cd "${PI_LOOPER_REPO_PATH:-${HEADR_REPO_PATH:?}}"

cleanup_json=""
if cleanup_json="$(python3 "$SCRIPT_DIR/cleanup-completed-worker-worktrees.py" --plan --json 2>/dev/null)"; then
  if python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("candidates") else 1)' <<<"$cleanup_json"; then
    exit 0
  fi
fi

python3 - <<'PY'
import json
import os
import re
import subprocess
import sys

repo = os.environ.get("PI_LOOPER_GITHUB_REPO") or os.environ["HEADR_GITHUB_REPO"]
ready_label = os.environ.get("PI_LOOPER_READY_LABEL") or os.environ.get("HEADR_READY_LABEL", "ready-for-agent")
implement_label = os.environ.get("PI_LOOPER_IMPLEMENT_LABEL") or os.environ.get("HEADR_IMPLEMENT_LABEL", "agent:implement")
in_progress_label = os.environ.get("PI_LOOPER_IN_PROGRESS_LABEL") or os.environ.get("HEADR_IN_PROGRESS_LABEL", "agent:in-progress")
blocked_label = os.environ.get("PI_LOOPER_BLOCKED_LABEL") or os.environ.get("HEADR_BLOCKED_LABEL", "agent:blocked")
human_label = os.environ.get("PI_LOOPER_HUMAN_LABEL") or os.environ.get("HEADR_HUMAN_LABEL", "ready-for-human")
needs_info_label = os.environ.get("PI_LOOPER_NEEDS_INFO_LABEL") or os.environ.get("HEADR_NEEDS_INFO_LABEL", "needs-info")
wontfix_label = os.environ.get("PI_LOOPER_WONTFIX_LABEL") or os.environ.get("HEADR_WONTFIX_LABEL", "wontfix")

owner, name = repo.split("/", 1)


def gh_json(*args):
    return json.loads(subprocess.check_output(["gh", *args], text=True))


def issue_blocked_by_numbers(number):
    try:
        data = gh_json(
            "api", "graphql",
            "-f", f"owner={owner}",
            "-f", f"name={name}",
            "-F", f"number={number}",
            "-f", "query=query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { issue(number:$number) { blockedBy(first:20) { nodes { number } } } } }",
        )
    except subprocess.CalledProcessError:
        return []
    nodes = (((data.get("data") or {}).get("repository") or {}).get("issue") or {}).get("blockedBy", {}).get("nodes", [])
    return [int(node["number"]) for node in nodes if node.get("number") is not None]


def body_dependency_numbers(body):
    body = body or ""
    dependencies = set(int(value) for value in re.findall(r"(?:Depends on|Blocked by|依存:|ブロック:)\s*#(\d+)", body))
    for match in re.finditer(r"(?ims)^##\s*(?:Blocked by|Depends on|依存|ブロック)\b.*?(?=^##|\Z)", body):
        section = match.group(0)
        if re.search(r"(?im)^\s*none\s*(?:-|$)", section):
            continue
        dependencies.update(int(value) for value in re.findall(r"#(\d+)", section))
    return dependencies


def dependencies_closed(issue):
    dependencies = body_dependency_numbers(issue.get("body") or "")
    dependencies.update(issue_blocked_by_numbers(issue["number"]))
    for dependency in sorted(dependencies):
        data = gh_json("issue", "view", str(dependency), "-R", repo, "--json", "state")
        if (data.get("state") or "OPEN").upper() != "CLOSED":
            return False
    return True


issues = gh_json("issue", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", "number,title,body,labels,updatedAt")
skip_labels = {in_progress_label, blocked_label, needs_info_label, human_label, wontfix_label}
for issue in issues:
    labels = {label["name"] for label in issue.get("labels", [])}
    if {ready_label, implement_label} <= labels and not (labels & skip_labels) and dependencies_closed(issue):
        sys.exit(0)

sys.exit(1)
PY
