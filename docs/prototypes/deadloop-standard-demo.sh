#!/usr/bin/env bash
# PROTOTYPE — capture and replay evidence for the deadloop standard demo.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  DEADLOOP_DEMO_REPO=owner/repo DEADLOOP_DEMO_ISSUE=123 deadloop-standard-demo.sh capture queued
  DEADLOOP_DEMO_REPO=owner/repo DEADLOOP_DEMO_ISSUE=123 deadloop-standard-demo.sh capture working
  DEADLOOP_DEMO_REPO=owner/repo DEADLOOP_DEMO_ISSUE=123 DEADLOOP_DEMO_PR=456 deadloop-standard-demo.sh capture reviewed
  DEADLOOP_DEMO_REPO=owner/repo DEADLOOP_DEMO_ISSUE=123 DEADLOOP_DEMO_PR=456 deadloop-standard-demo.sh capture handoff
  deadloop-standard-demo.sh replay [evidence-directory]
  deadloop-standard-demo.sh record [evidence-directory] [output.cast]
  deadloop-standard-demo.sh render [input.cast] [output-directory]

The capture commands query a public, disposable test repository. They save only selected
GitHub fields; do not use private repository names or confidential Issue/PR titles.
EOF
}

command=${1:-}
evidence_dir=${DEADLOOP_DEMO_DIR:-/tmp/deadloop-demo-evidence}

capture() {
  local stage=${1:?stage is required}
  local repo=${DEADLOOP_DEMO_REPO:?set DEADLOOP_DEMO_REPO=owner/repo}
  local issue=${DEADLOOP_DEMO_ISSUE:?set DEADLOOP_DEMO_ISSUE=number}
  local auto_merge=${DEADLOOP_DEMO_AUTO_MERGE:-false}
  [[ $auto_merge == false ]] || { echo 'The standard demo requires DEADLOOP_DEMO_AUTO_MERGE=false' >&2; exit 1; }
  mkdir -p "$evidence_dir"
  printf 'false\n' >"$evidence_dir/auto-merge.txt"

  gh issue view "$issue" --repo "$repo" \
    --json number,title,url,state,labels,updatedAt >"$evidence_dir/$stage-issue.json"

  if [[ -n ${DEADLOOP_DEMO_PR:-} ]]; then
    gh pr view "$DEADLOOP_DEMO_PR" --repo "$repo" \
      --json number,title,url,state,isDraft,headRefName,headRefOid,commits,statusCheckRollup,labels,updatedAt \
      >"$evidence_dir/$stage-pr.json"
  fi

  printf '%s\n' "$(date -u +%FT%TZ)" >"$evidence_dir/$stage-captured-at.txt"
  printf 'Captured %s evidence in %s\n' "$stage" "$evidence_dir"
}

heading() {
  printf '\033[2J\033[H\033[1;36mdeadloop\033[0m  GitHub Issues in, reviewed PRs out.\n\n'
  printf '\033[1m%s\033[0m\n\n' "$1"
}

label_names() {
  jq -r '[.labels[].name] | join(", ")' "$1"
}

has_label() {
  jq -e --arg label "$2" 'any(.labels[]; .name == $label)' "$1" >/dev/null
}

safe_summary() {
  jq -r '"#\(.number)  \(.title | gsub("[\\u0000-\\u001f\\u007f]"; " "))\n\(.url)"' "$1"
}

validate_evidence() {
  local dir=$1
  local queued="$dir/queued-issue.json"
  local working="$dir/working-issue.json"
  local reviewed_pr="$dir/reviewed-pr.json"
  local handoff_pr="$dir/handoff-pr.json"
  local file
  for file in "$queued" "$working" "$reviewed_pr" "$handoff_pr" "$dir/auto-merge.txt"; do
    [[ -f $file ]] || { printf 'Missing evidence: %s\n' "$file" >&2; return 1; }
  done
  [[ $(<"$dir/auto-merge.txt") == false ]] || { echo 'Demo policy must set autoMerge=false' >&2; return 1; }
  has_label "$queued" ready-for-agent || { echo 'Queued Issue lacks ready-for-agent' >&2; return 1; }
  has_label "$queued" agent:implement || { echo 'Queued Issue lacks agent:implement' >&2; return 1; }
  has_label "$working" agent:in-progress || { echo 'Working Issue lacks agent:in-progress' >&2; return 1; }
  jq -e '.state == "OPEN" and (.isDraft | not) and (.headRefOid | length > 0)' "$reviewed_pr" >/dev/null \
    || { echo 'Reviewed PR must be open, non-draft, and have a head SHA' >&2; return 1; }
  jq -e '(.statusCheckRollup | length) > 0 and all(.statusCheckRollup[]; ((.conclusion // .state) as $s | ["SUCCESS", "NEUTRAL", "SKIPPED"] | index($s)))' "$reviewed_pr" >/dev/null \
    || { echo 'Reviewed PR checks are absent, pending, or unsuccessful' >&2; return 1; }
  jq -e '.state == "OPEN" and (.isDraft | not)' "$handoff_pr" >/dev/null \
    || { echo 'Handoff PR must be open and non-draft' >&2; return 1; }
  has_label "$handoff_pr" ready-for-human || { echo 'Handoff PR lacks ready-for-human' >&2; return 1; }
  [[ $(jq -r .number "$reviewed_pr") == "$(jq -r .number "$handoff_pr")" ]] \
    || { echo 'Reviewed and handoff snapshots refer to different PRs' >&2; return 1; }
  [[ $(jq -r .headRefOid "$reviewed_pr") == "$(jq -r .headRefOid "$handoff_pr")" ]] \
    || { echo 'Reviewed and handoff snapshots have different head SHAs' >&2; return 1; }
}

replay() {
  local dir=${1:-$evidence_dir}
  local queued="$dir/queued-issue.json"
  local working="$dir/working-issue.json"
  local reviewed_pr="$dir/reviewed-pr.json"
  local handoff_pr="$dir/handoff-pr.json"
  validate_evidence "$dir"

  heading '1 / 4 — Queue one small Issue'
  printf 'Issue '; safe_summary "$queued"
  printf '\nlabels: %s\n' "$(label_names "$queued")"
  printf '\nTwo explicit labels make the Issue eligible. Automatic merge is off.\n'
  sleep 15

  heading '2 / 4 — deadloop owns the guarded run'
  jq -r '"Issue #\(.number)  state: \(.state)"' "$working"
  printf 'labels: %s\n' "$(label_names "$working")"
  printf '\nHerdr gives the Worker an owned worktree.\n'
  printf 'deadloop re-checks GitHub state, runs verification, and creates the PR.\n'
  printf 'If ownership or completion cannot be proven, the loop stops safely.\n'
  sleep 18

  heading '3 / 4 — Verify the PR and run deadloop review'
  printf 'PR '; safe_summary "$reviewed_pr"
  jq -r '"\ncommits: \(.commits | length)\nchecks:  \([.statusCheckRollup[]? | .conclusion // .state // "pending"] | join(", "))\nhead:    \(.headRefOid[0:12])"' "$reviewed_pr"
  printf '\nChecks are successful and bound to this PR head.\n'
  sleep 18

  heading '4 / 4 — Stop for a human'
  jq -r '"PR #\(.number)  state: \(.state)  draft: \(.isDraft)"' "$handoff_pr"
  printf 'labels: %s\n' "$(label_names "$handoff_pr")"
  printf '\n\033[1;32mready-for-human\033[0m means deadloop review finished for the same head.\n'
  printf 'Automatic merge is disabled. A person reviews and decides whether to merge.\n\n'
  printf '\033[2mEvidence captured from a real disposable repository; idle time reenacted.\033[0m\n'
  sleep 14

  heading 'GitHub Issues in, reviewed PRs out.'
  printf 'A guarded engineering loop for coding agents.\n\n'
  printf 'Try it safely with autoMerge disabled:\n'
  printf '\033[4mhttps://github.com/yasuhito/deadloop\033[0m\n\n'
  printf '\033[2mThis 75-second video is an evidence replay, not the processing time.\033[0m\n'
  sleep 10
}

record() {
  local dir=${1:-$evidence_dir}
  local output=${2:-/tmp/deadloop-standard-demo.cast}
  command -v asciinema >/dev/null || { echo 'record requires asciinema' >&2; exit 1; }
  asciinema rec --overwrite --cols 96 --rows 24 \
    --command "$(printf '%q ' "$0" replay "$dir")" "$output"
  printf 'Recorded %s\n' "$output"
}

render() {
  local input=${1:-/tmp/deadloop-standard-demo.cast}
  local output_dir=${2:-/tmp/deadloop-standard-demo}
  command -v agg >/dev/null || { echo 'render requires agg' >&2; exit 1; }
  command -v ffmpeg >/dev/null || { echo 'render requires ffmpeg' >&2; exit 1; }
  mkdir -p "$output_dir"
  agg --font-size 18 "$input" "$output_dir/deadloop-demo.gif"
  ffmpeg -y -i "$output_dir/deadloop-demo.gif" -movflags faststart \
    -pix_fmt yuv420p "$output_dir/deadloop-demo.mp4" >/dev/null 2>&1
  printf 'Rendered %s and %s\n' \
    "$output_dir/deadloop-demo.gif" "$output_dir/deadloop-demo.mp4"
}

case "$command" in
  capture) capture "${2:-}" ;;
  replay) replay "${2:-$evidence_dir}" ;;
  record) record "${2:-$evidence_dir}" "${3:-/tmp/deadloop-standard-demo.cast}" ;;
  render) render "${2:-/tmp/deadloop-standard-demo.cast}" "${3:-/tmp/deadloop-standard-demo}" ;;
  *) usage; exit 1 ;;
esac
