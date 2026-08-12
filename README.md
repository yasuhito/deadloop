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
- The supported host platform currently requires a Unix-like system with a compatible `flock` executable (normally provided by util-linux) and nonblocking file-descriptor locks. `/deadloop-enable` verifies this capability before enabling automation.

## Configure

You need an authenticated `gh` CLI, a running compatible [Herdr](https://herdr.dev/) server, and a repository-level command that runs all required checks.

1. Add the verification command to `deadloop.json` in the repository root:

   ```json
   {
     "checkCommand": "npm run check"
   }
   ```

   Replace `npm run check` with the command that runs your repository's tests and other required checks. Commit and push `deadloop.json` to the repository's base branch before continuing; deadloop reads shared policy from that branch.

2. Start Pi from the repository's normal Git checkout:

   ```bash
   cd /absolute/path/to/your/repo
   pi
   ```

3. Enable deadloop:

   ```text
   /deadloop-enable
   ```

4. To send an Issue to deadloop, add both labels:

   - `ready-for-agent`
   - `agent:implement`

That is enough to start. deadloop creates any missing standard labels during enablement and leaves automatic merge off. It implements eligible Issues, opens PRs, reviews them, and hands reviewed PRs to a human.

## What enablement does

`/deadloop-enable` infers the repository, base branch, and Herdr worktree location. It then:

1. runs the configured verification command in a temporary worktree;
2. verifies GitHub authentication and write access;
3. creates any missing standard labels; and
4. saves local permission to run the scheduler under `~/.pi/agent/deadloop/`.

If a check fails, deadloop remains disabled and reports what to fix. Use `/deadloop-doctor` for more detail.

Configuration files alone never start automation. `/deadloop-disable` stops new work without stopping active agents or deleting GitHub state, worktrees, or run artifacts. Re-enable each repository after upgrading from an older release.

## Advanced configuration

The default setup does not require a local configuration file. Create one only when you need overrides such as `autoMerge`, a custom `worktreeRoot`, or additional trusted automation hosts:

```bash
mkdir -p ~/.pi/agent/deadloop
cp ~/.pi/agent/git/github.com/yasuhito/deadloop/extensions/deadloop/projects.example.json ~/.pi/agent/deadloop/projects.json
$EDITOR ~/.pi/agent/deadloop/projects.json
```

`projects.json` contains local paths and rollout choices. Do not commit it. Prefer the repository-owned `deadloop.json` for the shared verification command and other reviewable policy.

See the [setup guide](docs/public-package-setup.md) for all settings and detailed enablement behavior.

## Safety controls

`autoMerge` controls whether deadloop merges reviewed PRs automatically.

With `false`, deadloop creates and reviews each PR, then hands the merge to a human.

With `true`, deadloop squash-merges PRs that pass its safety checks and deletes their head branches.

Start with `false`. Enable `true` only after verifying branch protection, CI, permissions, and stop conditions.

## Merge-conflict recovery

During the current GitHub-claim bootstrap, branch-update mutations stop without side effects. They remain unavailable until the `agent:update-branch` handoff tracked by #241 is implemented. The existing non-force, exact-head, required-verification, and normal-merge safety contracts remain required; this temporary stop does not remove them.

The guarded branch-update behavior below describes the retained safety contract, not a currently reachable mutation path.

The worker merges the selected base commit into the existing PR branch. It never rebases.

The worker runs the configured checks. It atomically updates the branch only if the PR head still equals the validated commit, then returns the PR to normal review.

Review labels remain in place during the update. No extra label is required.

Each exact PR-head/base-head pair is attempted at most once.

A stale PR head stops the update without pushing. deadloop re-evaluates the PR on the next cycle.

A failed or unsafe update adds `agent:blocked` with recovery evidence.

See [ADR 0011](docs/adr/0011-pr-merge-conflict-recovery.md) for the safety contract.

## Automatic review repair

When the built-in reviewer reports structured actionable findings, deadloop can start one bounded repair worker on the existing PR branch.

During repair, deadloop preserves the active `agent:in-progress` claim without adding another workflow label. It does not create a new `agent:review` request generation until repair completion, and it removes any legacy `agent:reviewing` label when leaving the repair state.

The worker receives only the findings.

The finalizer runs the configured checks for every repair, regardless of how many files changed. It atomically updates the exact branch only if the branch head still equals the validated commit.

The finalizer never replaces another head or changes GitHub workflow state.

The review result appears in a readable PR comment. The comment identifies the reviewed commit, reasons, findings, and next action.

Each review is also bound to a complete, paginated observation of the PR's commit sequence, exact diff, conversation comments, submitted reviews, and inline review comments. Any addition, edit, deletion, head/base change, or diff change releases the active review claim and requires a fresh review; comment text is treated only as untrusted evidence.

After a confirmed repair push, deadloop adds a separate result comment. This comment records the changes for each finding, the new commit, the checks, and the handoff to re-review.

A stale or failed repair never receives a success comment.

A changed head starts a fresh review cycle.

A stale head stops the repair without pushing or changing labels.

Repeated findings after the bounded attempt add `agent:blocked` with recovery guidance. deadloop does the same when a human decision is required or when technical or safety retries are exhausted.

See [ADR 0012](docs/adr/0012-automatic-pr-review-repair.md) for details.

## Roll out in phases

1. **Issue coordination only** — Start here for a slow rollout. Humans still review and merge PRs.
2. **Automated PR review** — Use the standard PR reviewer with `autoMerge: false`. Reviewed PRs move to `ready-for-human`. During the current bootstrap, external-review mutations stop without side effects until they are connected under an active review claim; enabling `externalReview` does not bypass that stop.
3. **Optional auto-merge** — Consider `autoMerge: true` only after proving branch protection, CI, review expectations, dry-run or manual approval practices, and stop conditions.

## Operator commands

Run these commands from the Pi session in the target repository:

```text
/deadloop-enable
/deadloop-disable
/deadloop-status
/deadloop-doctor
/deadloop-abandon-attempt <attempt-id>  # only when doctor presents it
/deadloop-complete-github-state-migration updated-hosts-stopped  # one-time GitHub-state deployment gate
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
