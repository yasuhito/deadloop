# ADR 0012: Bounded automatic repair of PR review findings

## Status

Accepted

## Decision

Reviewer promises keep `status` limited to `complete|blocked`. A completed reviewer may additionally report:

```json
{
  "status": "complete",
  "outcome": "approved|changes_requested|human_required",
  "reason": "",
  "summary": "review summary",
  "findings": [
    {
      "title": "concise defect",
      "body": "required correction and evidence",
      "path": "optional/repository/path",
      "line": 1,
      "severity": "blocker|major|minor"
    }
  ]
}
```

`outcome` and `findings` are optional so existing promise producers remain compatible. `changes_requested` requires at least one valid structured finding. Actionable code, test, lint, documentation, or repository-contract defects mean the review completed successfully: they use `status=complete,outcome=changes_requested`, not `status=blocked`. `human_required` is reserved for decisions or safety conditions that cannot be repaired within the PR. `status=blocked` describes a technical inability to complete review; it receives one retry for the exact PR head and becomes human-blocked only after that bounded retry fails.

For `changes_requested`, deadloop binds a repair attempt to the exact PR head and a deterministic fingerprint of normalized findings. It records an HTML comment marker and launches one dedicated worker in the existing same-repository PR worktree and branch. The existing `agent:in-progress` claim remains the only active managed state, and dispatch does not add `agent:reviewing` or create a newer `agent:review` request generation. The findings are the worker's entire contract, and scope widening is prohibited.

The repair worker cannot push directly. The deterministic finalizer requires the repair commit to contain the selected PR head and requires a clean worktree. Repair breadth is not a safety decision: deadloop does not apply a file-count, line-count, or other quantitative change-size limit.

The finalizer runs the configured checks for every repair and requires an authenticated passed verification record bound to the exact output commit and fixed project-check contract. It may reuse only a fully matching authenticated record; otherwise it runs the fixed check and persists a new authenticated record. It immediately re-reads the open PR's branch and head SHA, then updates that exact existing branch with a normal non-force fast-forward push after verifying that the destination still equals the selected PR head. It never changes labels, creates or merges a PR, closes an issue, or deletes a branch. A changed, rewound, or deleted head stops without an update, comment, or label change so the next cycle can re-evaluate it. A successful push changes the head; the completion handler authenticates that output-bound record again and requires the receipt to bind the claimed old head to the observed repaired head before any completion mutation. It then records the result, removes any legacy `agent:reviewing`, and replaces `agent:in-progress` with a fresh `agent:review` request. The next selection records `repair_rereview`, then claims that request normally. Conflict recovery carries that provenance to its updated head, while a later abandoned active claim remains distinguishable as `stale_reclaim`.

The exact head/review-result pair gets one repair attempt, and each PR gets at most three automatic repair attempts in total. The cumulative count comes from persistent `deadloop:review-repair-attempt` comment markers, so changing findings cannot reset the limit and scheduler restarts do not lose it. If the same findings recur after an attempted repair, the three-attempt cumulative limit is reached, or the reviewer reports `human_required`, deadloop adds `agent:blocked`, removes `agent:reviewing`, retains `agent:review`, and posts recovery guidance. Unsafe targets, exhausted attempts, failed repair launches, and failed/inconclusive repair completions are bounded safety failures and follow the same human-blocked path.

## Consequences

Automatic repair is deliberately narrower than implementation work: it cannot reinterpret the issue or add features. Persistent PR comments make attempt and technical-retry limits survive scheduler restarts. Legacy complete promises continue through the pre-existing approved/handoff path.
