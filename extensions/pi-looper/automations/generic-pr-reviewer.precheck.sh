#!/usr/bin/env bash
set -euo pipefail

cd "${PI_LOOPER_REPO_PATH:-${HEADR_REPO_PATH:?}}"

python3 - <<'PY'
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

repo = os.environ.get("PI_LOOPER_GITHUB_REPO") or os.environ["HEADR_GITHUB_REPO"]
review_label = os.environ.get("PI_LOOPER_REVIEW_LABEL") or os.environ.get("HEADR_REVIEW_LABEL", "agent:review")
reviewing_label = os.environ.get("PI_LOOPER_REVIEWING_LABEL") or os.environ.get("HEADR_REVIEWING_LABEL", "agent:reviewing")
human_label = os.environ.get("PI_LOOPER_HUMAN_LABEL") or os.environ.get("HEADR_HUMAN_LABEL", "ready-for-human")
blocked_label = os.environ.get("PI_LOOPER_BLOCKED_LABEL") or os.environ.get("HEADR_BLOCKED_LABEL", "agent:blocked")
external_review_wait_seconds = int(
    os.environ.get("PI_LOOPER_EXTERNAL_REVIEW_WAIT_SECONDS")
    or os.environ.get("HERDR_LOOPER_EXTERNAL_REVIEW_WAIT_SECONDS")
    or os.environ.get("HEADR_EXTERNAL_REVIEW_WAIT_SECONDS", "1800")
)
marker_re = re.compile(r"<!--\s*pi-looper:external-review-request\s+head=([0-9a-fA-F]+)\s*-->")


def gh_json(*args):
    return json.loads(subprocess.check_output(["gh", *args], text=True))


def parse_time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def seconds_since(value):
    parsed = parse_time(value)
    if parsed is None:
        return None
    return (datetime.now(timezone.utc) - parsed).total_seconds()


def has_stale_external_request(pr):
    head = pr.get("headRefOid") or ""
    newest_marker_age = None
    for comment in pr.get("comments") or []:
        body = comment.get("body") or ""
        for match in marker_re.finditer(body):
            if head and match.group(1) != head:
                continue
            age = seconds_since(comment.get("createdAt"))
            if age is None:
                continue
            newest_marker_age = age if newest_marker_age is None else min(newest_marker_age, age)
    if newest_marker_age is not None:
        return newest_marker_age >= external_review_wait_seconds

    # Backstop for review requests that predate the marker convention.
    age = seconds_since(pr.get("updatedAt"))
    return age is not None and age >= external_review_wait_seconds


prs = gh_json(
    "pr", "list", "-R", repo, "--state", "open", "--limit", "100",
    "--json", "number,updatedAt,headRefOid,isDraft,labels,statusCheckRollup,comments,reviewRequests"
)

blocked_labels = {reviewing_label, blocked_label}
candidate_labels = {review_label, human_label}
for pr in prs:
    labels = {label["name"] for label in pr.get("labels", [])}
    if not (labels & candidate_labels):
        continue
    if labels & blocked_labels:
        continue
    if pr.get("isDraft"):
        sys.exit(0)

    requests = pr.get("reviewRequests") or []
    copilot_requested = False
    for request in requests:
        login = (request.get("login") or (request.get("requestedReviewer") or {}).get("login") or "").lower()
        if "copilot" in login:
            copilot_requested = True
            break
    if copilot_requested and not has_stale_external_request(pr):
        continue

    checks = pr.get("statusCheckRollup") or []
    check_pending = False
    for check in checks:
        status = (check.get("status") or check.get("state") or "").upper()
        if status in {"QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING"}:
            check_pending = True
            break
    if check_pending:
        continue

    coderabbit_processing = False
    for comment in pr.get("comments") or []:
        author = ((comment.get("author") or {}).get("login") or "").lower()
        if author != "coderabbitai":
            continue
        body = (comment.get("body") or "").lower()
        if "currently processing" in body or "review in progress" in body:
            coderabbit_processing = True
            break
    if coderabbit_processing and not has_stale_external_request(pr):
        continue

    sys.exit(0)

sys.exit(1)
PY
