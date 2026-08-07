![deadloop banner](docs/assets/deadloop-banner.webp)

English | [日本語](README.ja.md)

# deadloop

> Build your loop. deadloop runs it. Maximum effort.

**GitHub Issues in, reviewed PRs out.** deadloop watches Issues and automates implementation, pull requests, review, and merge—with safety controls built in.

## Install

Install and activate the Pi package:

```bash
pi install git:github.com/yasuhito/deadloop
```

Optionally install the setup skill for guided configuration:

```bash
npx skills@latest add yasuhito/deadloop
```

## Current status

- v0 is a Pi package / extension.
- The default runner is [Herdr](https://herdr.dev/).

## Configure

### Enable a repository

From a normal Git checkout, explicitly enable the local scheduler:

```text
/deadloop-enable
```

deadloop infers the checkout path, GitHub repository, base branch, and default Herdr worktree root.

Enablement is local state under `~/.pi/agent/deadloop/`. Neither `deadloop.json` nor `projects.json` starts automation by itself.

### Pass the preflight check

Before enabling automation, `/deadloop-enable` creates a journaled temporary Git worktree at the trusted base revision. It runs the explicit required-verification command there, isolated from uncommitted changes in the normal checkout.

If verification fails, automation remains disabled and the command reports the durable log path. This preflight does not create a Herdr workspace or start an agent.

A later enable reuses a successful preflight only when the repository, commit, command, source identity, and base revision all match exactly.

The preflight tries to restore generated runtime artifacts on every exit. If restoration fails, deadloop preserves the quarantine and temporary worktree, records their paths, and reports them through `/deadloop-doctor`.

### Confirm GitHub access and labels

After the preflight succeeds, `/deadloop-enable` verifies GitHub write access. It creates only the standard labels that are missing.

### Keep automatic merge off initially

A newly enabled repository always starts with `autoMerge: false`.

If deadloop finds an existing `autoMerge: true` during enablement, automatic merge remains off. To acknowledge the risk, explicitly change the setting from `false` to `true` after enabling the repository.

This acknowledgement survives disable and re-enable. Keep `autoMerge` set to `false` until you intend to enable automatic merge.

### Disable or re-enable a repository

Use `/deadloop-disable` to stop scheduling. It does not stop active agents or remove GitHub state, worktrees, or run artifacts.

Re-enable each repository after upgrading from an older release.

### Add local overrides only when needed

Copy the example into Pi's local state only when you need overrides such as `autoMerge` or a custom `worktreeRoot`:

```bash
mkdir -p ~/.pi/agent/deadloop
cp ~/.pi/agent/git/github.com/yasuhito/deadloop/extensions/deadloop/projects.example.json ~/.pi/agent/deadloop/projects.json
$EDITOR ~/.pi/agent/deadloop/projects.json
```

`projects.json` contains local paths and rollout choices. Do not commit it.

### Define the required verification command

Whenever possible, define the repository-owned aggregate verification command in trusted `deadloop.json`. For example, use `"checkCommand": "npm run check"`.

Use a local value only as an intentional override.

`/deadloop-status` and `/deadloop-doctor` show the effective required-verification command, its source, the trusted base revision, and any override information.

When deadloop cannot resolve required verification, doctor lists non-authoritative candidates. It finds them in `package.json` verification scripts and individual GitHub Actions `run` steps.

Doctor preserves each candidate's source, working directory, and explicit execution context. It never promotes a candidate or combines candidates into one command.

See the [setup guide](docs/public-package-setup.md) for every available setting.

## Safety controls

`autoMerge` controls whether deadloop merges reviewed PRs automatically.

With `false`, deadloop creates and reviews each PR, then hands the merge to a human.

With `true`, deadloop squash-merges PRs that pass its safety checks and deletes their head branches.

Reviewers can still report requested changes or a required human decision when required verification is missing or failing. Approval, successful human handoff, and merge consideration require a host-recorded successful required-verification result for the current PR head; agent-reported validations remain additional evidence only.

Start with `false`. Enable `true` only after verifying branch protection, CI, permissions, and stop conditions.

## Create labels

Create the standard labels once per repository:

```bash
gh label create ready-for-agent --repo owner/repo --color 0e8a16 || true
gh label create agent:implement --repo owner/repo --color 1d76db || true
gh label create agent:in-progress --repo owner/repo --color fbca04 || true
gh label create agent:review --repo owner/repo --color 5319e7 || true
gh label create agent:reviewing --repo owner/repo --color c2e0c6 || true
gh label create agent:blocked --repo owner/repo --color b60205 || true
gh label create ready-for-human --repo owner/repo --color d93f0b || true
gh label create needs-info --repo owner/repo --color fef2c0 || true
gh label create needs-triage --repo owner/repo --color f9d0c4 || true
```

An issue is eligible only when it has both `ready-for-agent` and `agent:implement`.

## Merge-conflict recovery

When a selected same-repository PR conflicts with the configured base, deadloop can start one guarded branch-update worker.

The worker merges the selected base commit into the existing PR branch. It never rebases.

The worker runs the configured checks. It atomically updates the branch only if the PR head still equals the validated commit, then returns the PR to normal review.

Review labels remain in place during the update. No extra label is required.

Each exact PR-head/base-head pair is attempted at most once.

A stale PR head stops the update without pushing. deadloop re-evaluates the PR on the next cycle.

A failed or unsafe update adds `agent:blocked` with recovery evidence.

See [ADR 0011](docs/adr/0011-pr-merge-conflict-recovery.md) for the safety contract.

## Automatic review repair

When the built-in reviewer reports structured actionable findings, deadloop can start one bounded repair worker on the existing PR branch.

Review labels remain in place during the repair. deadloop does not add a repair label.

The worker receives only the findings.

The finalizer first measures the size of the repair. If the repair is too large, it skips the configured checks, does not push, and hands the PR to a human.

If the repair is within the size limit, the finalizer runs the configured checks. It atomically updates the exact branch only if the branch head still equals the validated commit.

The finalizer never replaces another head or changes GitHub workflow state.

The review result appears in a readable PR comment. The comment identifies the reviewed commit, reasons, findings, and next action.

After a confirmed repair push, deadloop adds a separate result comment. This comment records the changes for each finding, the new commit, the checks, and the handoff to re-review.

A stale or failed repair never receives a success comment.

A changed head starts a fresh review cycle.

A stale head stops the repair without pushing or changing labels.

Repeated findings after the bounded attempt add `agent:blocked` with recovery guidance. deadloop does the same when a human decision is required or when technical or safety retries are exhausted.

See [ADR 0012](docs/adr/0012-automatic-pr-review-repair.md) for details.

## Roll out in phases

1. **Issue coordination only** — Start here for a slow rollout. Humans still review and merge PRs.
2. **Automated PR review** — Use the standard PR reviewer with `autoMerge: false`. Reviewed PRs move to `ready-for-human`. External review requests remain off unless `externalReview.enabled` is `true`.
3. **Optional auto-merge** — Consider `autoMerge: true` only after proving branch protection, CI, review expectations, dry-run or manual approval practices, and stop conditions.

## Run

Start Pi inside the target repository:

```bash
cd /absolute/path/to/target/repo
pi
```

Useful commands:

```text
/deadloop-enable
/deadloop-disable
/deadloop-status
/deadloop-doctor
/deadloop-abandon-attempt <attempt-id>  # only when doctor presents it
```

Operator environment variables:

```bash
DEADLOOP_CONFIG=/path/to/projects.json pi
DEADLOOP_PROJECTS=my-project pi
DEADLOOP=off pi
DEADLOOP_AUTOMATIONS=off pi
DEADLOOP_DEBUG=1 pi
```

## Documentation

- Setup guide: [docs/public-package-setup.md](docs/public-package-setup.md)
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
