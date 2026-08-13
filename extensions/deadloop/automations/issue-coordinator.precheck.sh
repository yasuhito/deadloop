#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

cd "${DEADLOOP_REPO_PATH:?}"

cleanup_json=""
if cleanup_json="$(node "$SCRIPT_DIR/cleanup-completed-worker-worktrees.ts" --plan --json 2>/dev/null)"; then
  if node -e 'const fs = require("node:fs"); const data = JSON.parse(fs.readFileSync(0, "utf8")); process.exit(data.candidates?.length ? 0 : 1);' <<<"$cleanup_json"; then
    exit 0
  fi
fi

repo="${DEADLOOP_GITHUB_REPO:?}"
ready_label="${DEADLOOP_READY_LABEL:-ready-for-agent}"
explore_label="${DEADLOOP_EXPLORE_LABEL:-agent:explore}"
implement_label="${DEADLOOP_IMPLEMENT_LABEL:-agent:implement}"},{
in_progress_label="${DEADLOOP_IN_PROGRESS_LABEL:-agent:in-progress}"
blocked_label="${DEADLOOP_BLOCKED_LABEL:-agent:blocked}"
human_label="${DEADLOOP_HUMAN_LABEL:-ready-for-human}"
needs_info_label="${DEADLOOP_NEEDS_INFO_LABEL:-needs-info}"
wontfix_label="${DEADLOOP_WONTFIX_LABEL:-wontfix}"

gh issue list -R "$repo" --state open --limit 200 --json number,title,body,labels,updatedAt \
  | node "$SCRIPT_DIR/issue-coordinator-decisions.ts" \
      --repo "$repo" \
      --ready-label "$ready_label" \
      --explore-label "$explore_label" \
      --implement-label "$implement_label" \
      --in-progress-label "$in_progress_label" \
      --blocked-label "$blocked_label" \
      --human-label "$human_label" \
      --needs-info-label "$needs_info_label" \
      --wontfix-label "$wontfix_label" \
      --exit-code >/dev/null
