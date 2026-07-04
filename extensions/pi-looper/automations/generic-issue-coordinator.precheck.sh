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

repo="${PI_LOOPER_GITHUB_REPO:-${HEADR_GITHUB_REPO:?}}"
ready_label="${PI_LOOPER_READY_LABEL:-${HEADR_READY_LABEL:-ready-for-agent}}"
implement_label="${PI_LOOPER_IMPLEMENT_LABEL:-${HEADR_IMPLEMENT_LABEL:-agent:implement}}"
in_progress_label="${PI_LOOPER_IN_PROGRESS_LABEL:-${HEADR_IN_PROGRESS_LABEL:-agent:in-progress}}"
blocked_label="${PI_LOOPER_BLOCKED_LABEL:-${HEADR_BLOCKED_LABEL:-agent:blocked}}"
human_label="${PI_LOOPER_HUMAN_LABEL:-${HEADR_HUMAN_LABEL:-ready-for-human}}"
needs_info_label="${PI_LOOPER_NEEDS_INFO_LABEL:-${HEADR_NEEDS_INFO_LABEL:-needs-info}}"
wontfix_label="${PI_LOOPER_WONTFIX_LABEL:-${HEADR_WONTFIX_LABEL:-wontfix}}"

gh issue list -R "$repo" --state open --limit 200 --json number,title,body,labels,updatedAt \
  | python3 "$SCRIPT_DIR/generic-issue-coordinator-decisions.py" \
      --repo "$repo" \
      --ready-label "$ready_label" \
      --implement-label "$implement_label" \
      --in-progress-label "$in_progress_label" \
      --blocked-label "$blocked_label" \
      --human-label "$human_label" \
      --needs-info-label "$needs_info_label" \
      --wontfix-label "$wontfix_label" \
      --exit-code >/dev/null
