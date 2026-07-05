#!/usr/bin/env bash
set -euo pipefail

cd "${PI_LOOPER_REPO_PATH:?}"

repo="${PI_LOOPER_GITHUB_REPO:?}"
review_label="${PI_LOOPER_REVIEW_LABEL:-agent:review}"
reviewing_label="${PI_LOOPER_REVIEWING_LABEL:-agent:reviewing}"
human_label="${PI_LOOPER_HUMAN_LABEL:-ready-for-human}"
blocked_label="${PI_LOOPER_BLOCKED_LABEL:-agent:blocked}"
auto_merge="${PI_LOOPER_AUTO_MERGE:-0}"
external_review_wait_seconds="${PI_LOOPER_EXTERNAL_REVIEW_WAIT_SECONDS:-1800}"
automation_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

args=(
  "${automation_dir}/pr-reviewer-decisions.py"
  --review-label "${review_label}"
  --reviewing-label "${reviewing_label}"
  --human-label "${human_label}"
  --blocked-label "${blocked_label}"
  --auto-merge "${auto_merge}"
  --external-review-wait-seconds "${external_review_wait_seconds}"
  --exit-code
)
if [ -n "${PI_LOOPER_NOW:-}" ]; then
  args+=(--now "${PI_LOOPER_NOW}")
fi

gh pr list -R "${repo}" --state open --limit 100 \
  --json number,updatedAt,headRefOid,isDraft,labels,statusCheckRollup,comments,reviewRequests \
  | python3 "${args[@]}" >/dev/null
