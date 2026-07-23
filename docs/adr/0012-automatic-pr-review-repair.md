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

For `changes_requested`, deadloop binds a repair attempt to the exact PR head and a deterministic fingerprint of normalized findings. It records an HTML comment marker and launches one dedicated worker in the existing same-repository PR worktree and branch. `agent:review` and `agent:reviewing` remain present; there is no new label. The findings are the worker's entire contract, and scope widening is prohibited.

The repair worker cannot push directly. The deterministic finalizer requires the repair commit to contain the selected PR head, requires a clean worktree, runs the configured checks, immediately re-reads the open PR's branch and head SHA, and atomically updates that exact existing branch only if its remote head still equals the validated commit. It never replaces another head, changes labels, creates or merges a PR, closes an issue, or deletes a branch. A stale head stops without an update, comment, or label change so the next cycle can re-evaluate it. A successful push changes the head and starts a new review cycle.

The exact head/review-result pair gets one repair attempt. If the same findings recur after an attempted repair, or the reviewer reports `human_required`, deadloop adds `agent:blocked`, removes `agent:reviewing`, retains `agent:review`, and posts recovery guidance. Unsafe targets, exhausted attempts, failed repair launches, and failed/inconclusive repair completions are bounded safety failures and follow the same human-blocked path.

## Consequences

Automatic repair is deliberately narrower than implementation work: it cannot reinterpret the issue or add features. Persistent PR comments make attempt and technical-retry limits survive scheduler restarts. Legacy complete promises continue through the pre-existing approved/handoff path.
