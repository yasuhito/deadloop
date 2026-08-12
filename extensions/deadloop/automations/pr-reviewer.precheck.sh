#!/usr/bin/env bash
set -euo pipefail

cd "${DEADLOOP_REPO_PATH:?}"

repo="${DEADLOOP_GITHUB_REPO:?}"
project_id="${DEADLOOP_PROJECT_ID:-}"
state_dir="${DEADLOOP_STATE_DIR:-${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}/deadloop}"
review_label="${DEADLOOP_REVIEW_LABEL:-agent:review}"
in_progress_label="${DEADLOOP_IN_PROGRESS_LABEL:-agent:in-progress}"
human_label="${DEADLOOP_HUMAN_LABEL:-ready-for-human}"
blocked_label="${DEADLOOP_BLOCKED_LABEL:-agent:blocked}"
auto_merge="${DEADLOOP_AUTO_MERGE:-0}"
external_review_enabled="${DEADLOOP_EXTERNAL_REVIEW_ENABLED:-0}"
external_review_wait_seconds="${DEADLOOP_EXTERNAL_REVIEW_WAIT_SECONDS:-1800}"
automation_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

prs_json="$(mktemp)"
agents_json="$(mktemp)"
trap 'rm -f "${prs_json}" "${agents_json}"' EXIT

gh pr list -R "${repo}" --state open --limit 100 \
  --json number,updatedAt,headRefName,headRefOid,isCrossRepository,isDraft,labels,statusCheckRollup,comments,reviewRequests \
  > "${prs_json}"

# A retained GitHub claim is not reselected while its attempt still owns work,
# so pass the live Herdr agent list as a safety check. If Herdr is unreachable,
# fall back to an empty list and let reconciliation decide the next safe state.
herdr agent list > "${agents_json}" 2>/dev/null || printf '{"result":{"agents":[]}}' > "${agents_json}"

args=(
  --input "${prs_json}"
  --agents "${agents_json}"
  --project-id "${project_id}"
  --state-dir "${state_dir}"
  --github-repo "${repo}"
  --review-label "${review_label}"
  --in-progress-label "${in_progress_label}"
  --human-label "${human_label}"
  --blocked-label "${blocked_label}"
  --auto-merge "${auto_merge}"
  --external-review-enabled "${external_review_enabled}"
  --external-review-wait-seconds "${external_review_wait_seconds}"
  --exit-code
)
if [ -n "${DEADLOOP_NOW:-}" ]; then
  args+=(--now "${DEADLOOP_NOW}")
fi

node "${automation_dir}/pr-reviewer-decisions.ts" "${args[@]}" >/dev/null
