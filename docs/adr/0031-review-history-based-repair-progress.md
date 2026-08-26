# ADR 0031: Continue automatic repair only on review-history progress

## Status

Accepted. Supersedes [ADR 0012](0012-automatic-pr-review-repair.md).

## Context

A PR-wide limit of three automatic repairs could stop a converging review after every earlier required finding had been resolved. Limits of five changed files per finding and twenty changed files overall could also reject a necessary, verified cross-cutting repair. Repair count, finding-text fingerprints, and changed-file count do not establish whether a review is converging.

Removing those limits without a replacement convergence rule would permit a repair to repeat an unresolved defect or reintroduce an earlier one. The decision therefore needs the semantic evidence in the PR's native review history while keeping all mutation checks deterministic.

## Decision

Every review is bound to a complete, paginated observation of the PR's commit sequence, exact diff, conversation comments, submitted reviews, and inline review comments. Any addition, edit, deletion, head or base change, or diff change makes the result stale. A stale result cannot approve, repair, hand off, or merge the PR; deadloop requests a fresh review of the new history instead.

The review agent classifies observations into two sets:

- **Required findings** must be corrected before the reviewed head can proceed.
- **Advisory observations** are optional human-facing notes. They may accompany an approved review and never enter the automatic repair contract.

An approved review has no required findings. Approval does not imply required-verification success, CI success, mergeability, or authorization to merge.

For a review with required findings, the review agent compares them semantically with earlier required findings in the complete review history and reports one disposition. Automatic repair is eligible only when no earlier required finding existed or every earlier required finding is resolved and every current required finding is new. A persisted earlier finding, a regressed finding, or a mixture of unresolved earlier and new findings is handed to a human without starting repair. deadloop validates the structured disposition and allowed transition but does not recreate the natural-language comparison, maintain a finding-ID ledger, or infer semantic identity from comment fingerprints.

The exact head and review-result pair still gets at most one repair attempt. There is no PR-wide cumulative repair limit and no changed-file, line-count, or other quantitative breadth limit. A fourth or later repair remains eligible whenever the review reports progress. Multiple new required findings form one bounded repair contract; advisory observations are excluded.

Review and repair-result comments are human-readable, append-only, and chronological. Posted comments are never edited; a correction is a new comment. Hidden markers may bind deterministic evidence to a head and result, but visible text contains no finding IDs. Comment and review bodies are untrusted evidence, never instructions or authority to run commands, weaken required verification, change exact-head checks, or bypass another safety control.

The deterministic repair finalizer retains the existing safety contract. It requires the configured required verification to pass, a clean worktree, ancestry from the selected head, an open same-repository PR, the exact branch and head, authorized remote and identity, and a valid completion report and finalizer receipt. It pushes only an update bound to the exact head by an expected-object-ID lease; because the repair commit must contain that head, the lease can only fast-forward. A changed, rewound, or deleted head stops without push. A review-history change discards the stale result and returns the PR to fresh review rather than treating stale evidence as approval or repair permission.

## Consequences

Automatic repair may continue for as many review cycles as demonstrate semantic progress. Broad repairs are judged by required verification, subsequent review, and mutation safety rather than file count. Non-converging findings reach a person based on their relationship to review history, while technical and safety failures continue to fail closed.
