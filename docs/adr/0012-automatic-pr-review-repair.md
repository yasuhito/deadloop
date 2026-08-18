# ADR 0012: Bounded automatic repair of PR review findings

## Status

Accepted. One refinement below no longer holds: a later abandoned active claim on a head that carries repair provenance records `repair_rereview`, not `stale_reclaim`, because [ADR 0020](0020-stop-proving-work-authority.md) removed local attempt journals from the launch decision.

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
  ],
  "advisories": [
    {
      "title": "optional improvement",
      "body": "observation and evidence",
      "path": "optional/repository/path",
      "line": 1
    }
  ],
  "priorRequiredFindings": "none|all_resolved|persisted|regressed|mixed"
}
```

The V1 completion report contains an explicit review outcome. `findings` are the required corrections; `advisories` are optional observations that are published for humans and never repaired. `changes_requested` requires at least one valid structured finding, and `approved` requires none. Actionable code, test, lint, documentation, or repository-contract defects mean the review completed successfully: they use `status=complete,outcome=changes_requested`, not `status=blocked`. `human_required` is reserved for decisions or safety conditions that cannot be repaired within the PR. `status=blocked` describes a technical inability to complete review; it receives one retry for the exact PR head and becomes human-blocked only after that bounded retry fails.

`priorRequiredFindings` is the review agent's judgment, from the native PR history, of how the required findings raised by earlier reviews stand on the reviewed head. deadloop does not re-derive it. Automatic repair stays eligible only on reported repair progress, meaning `none` or `all_resolved`; a `changes_requested` result carrying `persisted`, `regressed`, or `mixed` is handed to a human instead of repaired.

For an eligible `changes_requested`, deadloop binds a repair attempt to the exact PR head and a deterministic fingerprint of normalized findings. It records an HTML comment marker and launches one dedicated worker in the existing same-repository PR worktree and branch. The existing `agent:in-progress` claim remains the only active managed state, and dispatch does not create a newer `agent:review` request generation. The findings are the worker's entire contract, and scope widening is prohibited.

The repair worker cannot push directly. The deterministic finalizer requires the repair commit to contain the selected PR head and requires a clean worktree. Repair breadth is not a safety decision: deadloop does not apply a file-count, line-count, or other quantitative change-size limit.

The finalizer runs the configured checks for every repair and requires an authenticated passed verification record bound to the exact output commit and fixed project-check contract. It may reuse only a fully matching authenticated record; otherwise it runs the fixed check and persists a new authenticated record. It immediately re-reads the open PR's branch and head SHA, then updates that exact existing branch after verifying that the destination still equals the selected PR head. Because that verification and the push are separate operations, the push binds itself to the verified head with `git push --force-with-lease=refs/heads/<branch>:<verified head>`: an expected-object-ID lease is the only force variant deadloop permits, it is permitted only because the repair commit is already proved to contain the verified head so the lease can only fast-forward, any remote change after the verification breaks the lease and stops the push with `stale_head`, and force without a lease stays prohibited. It never changes labels, creates or merges a PR, closes an issue, or deletes a branch. A changed, rewound, or deleted head stops without an update, comment, or label change so the next cycle can re-evaluate it. A successful push changes the head; the completion handler authenticates that output-bound record again and requires the receipt to bind the claimed old head to the observed repaired head before any completion mutation. It then records the result and replaces `agent:in-progress` with a fresh `agent:review` request. The next selection records `repair_rereview`, then claims that request normally. Conflict recovery carries that provenance to its updated head, while a later abandoned active claim remains distinguishable as `stale_reclaim`.

The exact head/review-result pair gets one repair attempt, and each PR gets at most three automatic repair attempts in total. The cumulative count comes from persistent `deadloop:review-repair-attempt` comment markers, so changing findings cannot reset the limit and scheduler restarts do not lose it. If the same findings recur after an attempted repair or the three-attempt cumulative limit is reached, deadloop adds `agent:blocked`, removes `agent:in-progress`, retains `agent:review`, and posts recovery guidance. A review that reports `human_required`, including one that reports no repair progress, is a completed review and is handed to a person instead; see [ADR 0021](0021-a-human-required-review-is-a-completed-review.md). Unsafe targets, exhausted attempts, failed repair launches, and failed/inconclusive repair completions are bounded safety failures and follow the same human-blocked path.

## Consequences

Automatic repair is deliberately narrower than implementation work: it cannot reinterpret the issue or add features. Persistent PR comments make attempt and technical-retry limits survive scheduler restarts. Only a V1 completion report bound to the attempt can authorize the approved or repair path.
