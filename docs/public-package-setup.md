# Public package setup

This guide is for first-time users installing `pi-looper` into a repository they control. Start with the smallest safe loop, then enable more automation only after you have observed it on real issues.

## 1. Install the package

Install from GitHub:

```bash
pi install git:github.com/yasuhito/pi-looper
```

For a local checkout or development build:

```bash
pi install /absolute/path/to/pi-looper
# or, for a one-off trial without changing settings:
pi -e /absolute/path/to/pi-looper
```

Pi packages and extensions run with your local user permissions. Install only from source you trust.

## 2. Create local configuration

Copy the example config to Pi's user state directory and edit it for your repository. If you installed from GitHub, Pi clones the package under `~/.pi/agent/git/github.com/yasuhito/pi-looper`:

```bash
mkdir -p ~/.pi/agent/pi-looper
cp ~/.pi/agent/git/github.com/yasuhito/pi-looper/extensions/pi-looper/projects.example.json ~/.pi/agent/pi-looper/projects.json
$EDITOR ~/.pi/agent/pi-looper/projects.json
```

For a local development checkout, copy from `/absolute/path/to/pi-looper/extensions/pi-looper/projects.example.json` instead.

`projects.json` is local configuration. It contains local paths, repository names, and rollout choices, so do **not** commit it. The package includes only `extensions/pi-looper/projects.example.json` as a template.

Key fields:

- `repoPath` — absolute path to the target repository checkout.
- `githubRepo` — GitHub repository in `owner/name` form.
- `baseBranch` — branch or remote ref used as the worktree base, usually `origin/main`.
- `worktreeRoot` — directory where the Herdr runner may create worker worktrees.
- `checkCommand` — verification command workers and reviewers must pass before handoff.
- `autoMerge` — keep `false` until the repository has proven safeguards. Only `true` allows the PR reviewer automation to squash merge and delete the head branch after its gates pass.
- `workerInstructions` — repository-specific instructions injected into worker prompts.
- `labels` — GitHub labels used to coordinate issue and PR state.
- `automations` — scheduled automation entries and their prompt/precheck files.

By default pi-looper reads `~/.pi/agent/pi-looper/projects.json`. Use `PI_LOOPER_CONFIG=/path/to/projects.json` only when you intentionally want a different config file.

## 3. Create required labels

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

An issue is eligible for the issue coordinator only when it has both:

- `ready-for-agent`
- `agent:implement`

Main control labels:

- `agent:in-progress` — implementation automation is working on the issue.
- `agent:review` — PR is ready for automated review.
- `agent:reviewing` — PR reviewer automation is currently processing the PR.
- `agent:blocked` — stop automated processing.
- `ready-for-human` — handoff to a human reviewer.
- `needs-info` — the issue or PR needs more information before automation can continue.

## 4. Roll out in safe phases

### Phase 1: Issue coordination only

Start with only `generic-issue-coordinator` enabled in `automations`. It picks an eligible issue, starts a Herdr worktree with a Pi worker, verifies the result, and creates a PR. Humans still review and merge.

Use this phase to check that issue contracts are clear, worker instructions are sufficient, and `checkCommand` catches failures.

### Phase 2: Add PR reviewer, still no auto-merge

Add `generic-pr-reviewer` only after Phase 1 is reliable. Keep:

```json
"autoMerge": false
```

With auto-merge disabled, the reviewer automation can gather external review context, start a review agent session, request fixes, and hand the PR to `ready-for-human` instead of merging.

### Phase 3: Consider auto-merge

Only consider:

```json
"autoMerge": true
```

after you have branch protection, CI, review expectations, dry-run/manual approval practices, and clear stop conditions. `autoMerge: true` permits the PR reviewer automation to squash merge and delete the head branch when its gates pass. It is intentionally opt-in.

## 5. Run pi-looper from the target repository

pi-looper acts only when Pi's current directory is `repoPath` or inside it:

```bash
cd /absolute/path/to/your/repo
pi
```

## Verification commands

Use these commands before trusting a package change or when validating this repository itself:

```bash
npm test
npm run lint
bash -n extensions/pi-looper/automations/*.sh
python3 -m py_compile extensions/pi-looper/automations/*.py
npm pack --dry-run
```

`npm pack --dry-run` should show only the public package contents. It must not include `extensions/pi-looper/projects.json`, cache files, Herdr worktrees, `.pi-subagents/`, `node_modules/`, or other local artifacts.

## Package contents

The published package is controlled by `package.json` `files`. It intentionally includes:

- root user docs and metadata: `README.md`, `AGENTS.md`, `LICENSE`
- public docs under `docs/`
- the Pi extension entrypoint
- automation prompts and deterministic helper scripts
- `extensions/pi-looper/projects.example.json`
- TypeScript source under `src/`

It intentionally excludes local runtime config and generated state:

- `extensions/pi-looper/projects.json`
- `~/.pi/agent/pi-looper/projects.json`
- Herdr worktrees and runner state
- dependency folders, caches, logs, and Python bytecode
