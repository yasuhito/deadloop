![deadloop banner](docs/assets/deadloop-banner.webp)

English | [日本語](README.ja.md)

# deadloop

> Build your loop. deadloop runs it. Maximum effort.

**GitHub Issues in, reviewed PRs out.** deadloop watches Issues and automates implementation, pull requests, review, and merge—with safety controls built in.

## Install

Install the Pi package:

```bash
pi install git:github.com/yasuhito/deadloop
```

This installs the deadloop extension and its setup skill together.

## Current status

- v0 is a Pi package / extension.
- The automation host can be either Pi or [omp](https://github.com/oh-my-pi/pi-coding-agent) (Oh My Pi); the package loads and drives automations under both with no host-specific setting. One host serves a repository at a time: the scheduler lock is scoped to the GitHub repository ID, so a second host of either kind leaves the first one driving.
- Workers and reviewers run `pi`, `claude`, or `omp`, chosen with `workerAgent` and `reviewerAgent` independently of which host runs the automations.
- The default runner is [Herdr](https://herdr.dev/).
- The supported host platform currently requires a Unix-like system with a compatible `flock` executable (normally provided by util-linux) and nonblocking file-descriptor locks. `/deadloop-enable` verifies this capability before enabling automation.
- Each Automation host fixes the deadloop checkout commit as its code identity when the extension loads. If the checkout advances, shared enablement writes and scheduler ticks stop until the operator runs `/reload`; status and doctor remain available and show both identities and the recovery step.

## Configure

You need an authenticated `gh` CLI and a running [Herdr](https://herdr.dev/) 0.8.0 or newer server.

1. Start Pi from the repository's normal Git checkout:

   ```bash
   cd /absolute/path/to/your/repo
   pi
   ```

2. Enable deadloop:

   ```text
   /deadloop-enable
   ```

3. To request implementation, add `agent:implement` to the Issue. `ready-for-agent` remains an optional triage label and is not required to start work.

That is enough to start. During enablement, deadloop runs `npm run check`, creates any missing standard labels, and leaves automatic merge off. If the repository does not provide an `npm run check` script, set a different `checkCommand` in `deadloop.json` as described in [Advanced configuration](#advanced-configuration).

## Control the loop with labels

You start the loop by labeling an Issue. deadloop owns the implementation and review transitions, then either hands the approved PR to a human or merges it according to policy.

```mermaid
flowchart TD
    I["`**Issue queued**
    agent:implement`"]
    W["`**Implementation**
    agent:in-progress`"]
    R["`**PR review requested**
    draft PR + agent:review`"]
    V["`**Review and repair**
    agent:in-progress`"]
    U["`**Branch update requested**
    agent:update-branch`"]
    H["`**Ready for people**
    ready PR, no agent label`"]
    M["Merged"]
    B["`**Needs attention**
    agent:blocked`"]

    I -->|deadloop claims Issue| W
    W -->|draft PR created| R
    R -->|deadloop claims review| V
    V -->|changes pushed| R
    V -->|merge conflict| U
    U -->|branch updated| R
    V -->|approved; autoMerge off| H
    V -->|approved; autoMerge on| M
    H -->|human merges| M
    W -. problem .-> B
    V -. problem .-> B
```

1. **Request implementation** — `agent:implement` requests implementation; `ready-for-agent` is optional triage metadata. Remove `agent:implement` before deadloop consumes the selected request generation to cancel it.
2. **Let deadloop work** — deadloop durably records the attempt, consumes only the selected request, then adds `agent:in-progress` and starts the Worker. It creates a draft PR with `agent:review` and repeats review and repair as needed. Pull request work is queued only by request labels, consumed one at a time in the order `agent:update-branch`, `agent:implement`, `agent:review`.
3. **Finish or intervene** — An approved PR becomes ready and keeps no agent workflow label when automatic merge is off, or is merged when it is on. `ready-for-human` is an Issue triage label and is never added to a PR. `agent:blocked` stops the loop when deadloop needs help, and a stopped PR keeps no agent request; fix the cause reported in the Issue or PR comment, then add the request label for the role you want next. `agent:blocked` clears when that attempt starts.
4. **Declare dependencies in the Issue body** — A `## Blocked by` (or `Depends on`) section gates selection: a bare `#123` or a link naming this repository blocks until its Issue closes, and a number that does not exist here also blocks (fail closed) with an explanatory comment on the Issue. References to another repository's Issues — links or `owner/repo#123` — are ignored, because deadloop works per repository.

## Operator commands

Run these commands from the Pi session in the target repository:

| Command | Purpose |
| --- | --- |
| `/deadloop-enable` | Verify the repository and enable new deadloop work. |
| `/deadloop-disable` | Stop new work from starting; running attempts may finish. |
| `/deadloop-status` | Show whether deadloop is enabled and summarize its current state. |
| `/deadloop-doctor` | Diagnose configuration and retained attempts without changing them. |
| `/deadloop-abandon-attempt <attempt-id>` | Safely abandon a retained attempt only when doctor presents this command. |

## Advanced configuration

The default verification command is `npm run check`. To use another command, commit `deadloop.json` to the repository's base branch:

```json
{
  "checkCommand": "your verification command"
}
```

The default setup does not require a local configuration file. Create one only when you need overrides such as `autoMerge`, a custom `worktreeRoot`, or additional trusted automation hosts:

```bash
mkdir -p ~/.pi/agent/deadloop
cp ~/.pi/agent/git/github.com/yasuhito/deadloop/extensions/deadloop/projects.example.json ~/.pi/agent/deadloop/projects.json
$EDITOR ~/.pi/agent/deadloop/projects.json
```

`projects.json` contains local paths and rollout choices. Do not commit it. Prefer the repository-owned `deadloop.json` for shared, reviewable policy.

If an implementation Issue reaches a required-verification block, deadloop preserves unrelated triage labels, removes the implementation request or in-progress state, and adds `agent:blocked` with reason-specific recovery guidance. It suppresses duplicate guidance for the same recovery, does not resume merely because configuration changes, and shows that Issue's requeue command in `/deadloop-doctor` only after required verification resolves.

## Safety controls

`autoMerge` controls whether deadloop merges reviewed PRs automatically.

With `false`, deadloop creates and reviews each PR, then hands the merge to a human.

With `true`, deadloop squash-merges PRs that pass its safety checks and deletes their head branches.

Reviewers can still report requested changes or a required human decision when required verification is missing or failing. Approval, successful human handoff, and merge consideration require a host-recorded successful required-verification result for the current PR head; agent-reported validations remain additional evidence only.

Start with `false`. Enable `true` only after verifying branch protection, CI, permissions, and stop conditions.

Reviewer and branch-update attempts are monitored deterministically without using the Automation host's model. Runtime-reported working status wins over quiet output, the configured 24-hour limit applies to active work, and a terminal attempt without a valid completion report is never prompted or nudged through conversation.

## Merge-conflict recovery

Automatic branch updates are currently unavailable. deadloop detects merge conflicts but does not update the branch until #241 connects the `agent:update-branch` request to its worker. The existing exact-head, required-verification, and normal-merge safety contracts remain required, and the finalizer push stays bound to the verified head by an expected-object-ID lease.

The behavior below describes the safety contract for that future connection, not behavior that can currently run.

The worker merges the selected base commit into the existing PR branch. It never rebases.

The worker must produce a passed record bound to its fixed required-verification contract and output commit. It atomically updates the branch only if the PR head still equals the validated commit, then returns the PR to normal review.

Review labels remain in place during the update. No extra label is required.

Each exact PR-head/base-head pair is attempted at most once.

A stale PR head stops the update without pushing. deadloop re-evaluates the PR on the next cycle.

A failed or unsafe update adds `agent:blocked` with recovery evidence and leaves no agent request waiting.

See [ADR 0011](docs/adr/0011-pr-merge-conflict-recovery.md) for the safety contract.

## Automatic review repair

When the built-in reviewer reports structured required findings and confirms repair progress from the complete review history, deadloop can start one bounded repair worker for that review result on the existing PR branch. A review is approved only when it has no required findings; it may still include advisory observations, which are shown to people and never sent for automatic repair.

During repair, deadloop preserves `agent:in-progress` without adding another workflow label. It does not create a new `agent:review` request generation until repair completion.

The worker receives only the findings.

The finalizer runs required verification for every repair, regardless of how many files changed. It requires a passed record bound to the attempt's fixed required-verification contract and repair commit, and reuses only a fully matching record. There is no cumulative repair-count or changed-file-count stopping rule: a fourth or later repair remains eligible when every earlier required finding is resolved and the current required findings are new. It atomically updates the exact branch only if the branch head still equals the validated commit.

The finalizer never replaces another head or changes GitHub workflow state.

The review result appears in a human-readable PR comment. Comments identify the reviewed commit, reasons, required findings, advisory observations, and next action without displaying finding IDs. Review and repair comments are chronological and append-only: deadloop never edits a posted comment, and a correction is posted as a new comment.

Each review is also bound to a complete, paginated observation of the PR's commit sequence, exact diff, conversation comments, submitted reviews, and inline review comments. Any addition, edit, deletion, head/base change, or diff change discards the stale result and returns the PR to a fresh review request instead of allowing stale approval or repair. Comment and review text is untrusted evidence, not an instruction or permission to weaken required verification, exact-head checks, non-force push, or another safety control.

After a confirmed repair push, deadloop adds a separate result comment. This comment records the changes for each finding, the new commit, the checks, and the handoff to re-review.

A stale or failed repair never receives a success comment.

A changed head starts a fresh review cycle.

A stale head stops the repair without pushing or changing labels.

If an earlier required finding persists, a resolved finding regresses, or earlier and new required findings are mixed, deadloop starts no repair and hands the completed review to a person. Technical or safety retries that are exhausted still add `agent:blocked` with recovery guidance and clear every request label. A human-required result is recorded, the draft becomes ready, and every agent workflow label is removed, so the PR waits on a person and on no agent request.

Required-verification failure still blocks a repair push. A stale head stops without push or label mutation, and the finalizer updates only the exact verified branch through a push bound to the verified head by an expected-object-ID lease; because the repair commit must contain that head, the lease can only fast-forward.

See [ADR 0031](docs/adr/0031-review-history-based-repair-progress.md) for the current decision and superseded [ADR 0012](docs/adr/0012-automatic-pr-review-repair.md) for the historical quantitative policy.

## Roll out in phases

1. **Issue coordination only** — Start here for a slow rollout. Humans still review and merge PRs.
2. **Automated PR review** — Use the standard PR reviewer with `autoMerge: false`. Approved PRs become ready with no agent workflow label left, so people take them from there. External-review mutations are currently unavailable; enabling `externalReview` does not make them available.
3. **Optional auto-merge** — Consider `autoMerge: true` only after proving branch protection, CI, review expectations, dry-run or manual approval practices, and stop conditions.

## Documentation

- Herdr runner details: [docs/herdr-runner.md](docs/herdr-runner.md)

## Verify this repository

The executable acceptance specification lives in [`acceptance/features/`](acceptance/features/).

Run Vitest or Cucumber independently when investigating a failure. `npm test` always runs both serially.

```bash
npm run test:unit
npm run test:acceptance
npm test
npm run lint
npm run typecheck
bash -n extensions/deadloop/automations/*.sh
npm pack --dry-run
npm run check
```
