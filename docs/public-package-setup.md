# Public package setup

This guide is for first-time users installing **deadloop** into a repository they control. Start with the smallest safe loop, then enable more automation only after observing it on real issues.

## 1. Install the package

Install from GitHub:

```bash
pi install git:github.com/yasuhito/deadloop
```

If you prefer to start from the Agent Skills ecosystem, install the setup skill first:

```bash
npx skills@latest add yasuhito/deadloop
```

The Skills CLI installs a `deadloop` setup skill for agents. It does not activate the Pi extension by itself, so run `pi install git:github.com/yasuhito/deadloop` as the package activation step.

For a local checkout or development build:

```bash
pi install /absolute/path/to/deadloop
# or, for a one-off trial without changing settings:
pi -e /absolute/path/to/deadloop
```

Pi packages and extensions run with your local user permissions. Install only from source you trust.

## 2. Create repository policy and optional local configuration

For the zero-local-config path, commit `deadloop.json` at the target repository root on the trusted base branch. Start Pi from that checkout and deadloop infers the local checkout path, GitHub repository, base branch, and default Herdr worktree root from the current git repository.

Use Pi's user state config only for local overrides such as `autoMerge`, a custom `worktreeRoot`, or repositories that do not carry `deadloop.json`. If you need those overrides, copy the example config to Pi's user state directory and edit it for your repository. If you installed from GitHub, Pi clones the package under `~/.pi/agent/git/github.com/yasuhito/deadloop`:

```bash
mkdir -p ~/.pi/agent/deadloop
cp ~/.pi/agent/git/github.com/yasuhito/deadloop/extensions/deadloop/projects.example.json ~/.pi/agent/deadloop/projects.json
$EDITOR ~/.pi/agent/deadloop/projects.json
```

For a local development checkout, copy from `/absolute/path/to/deadloop/extensions/deadloop/projects.example.json` instead.

`projects.json` is local configuration. It contains local paths and rollout choices, so do **not** commit it. The package includes only `extensions/deadloop/projects.example.json` as a template.

Shared repository policy lives in `deadloop.json` at the target repository root. deadloop reads it only from the trusted `baseBranch` after `git fetch`; a PR branch cannot change the policy used to decide that PR. Local `projects.json` explicit values win over repo policy, so remove a key locally when you want to inherit the shared value.

If a project uses `workerAgent: "claude"` or `reviewerAgent: "claude"`, run `claude` interactively once from the target repository root and accept Claude Code workspace trust before enabling the automation.

Key fields:

- `repoPath` — absolute path to the target repository checkout. Optional when the current git repository has `deadloop.json` on the trusted base branch.
- `githubRepo` — GitHub repository in `owner/name` form. Inferred from the `origin` remote for implicit `deadloop.json` projects.
- `baseBranch` — branch or remote ref used as the worktree base, usually `origin/main`. Inferred from the current branch upstream for implicit `deadloop.json` projects.
- `worktreeRoot` — directory where the Herdr runner may create worker worktrees. Defaults to `~/.herdr/worktrees/<repo>/` for implicit `deadloop.json` projects.
- `checkCommand` — optional verification command workers and reviewers must pass before handoff. Omit this for the standard convention: run `git diff --check`, then `npm run check` when it exists, otherwise the existing `test`, `lint`, and `typecheck` package scripts.
- `autoMerge` — keep `false` until the repository has proven safeguards. Only `true` allows the PR reviewer automation to squash merge and delete the head branch after its gates pass.
- `workerInstructionFiles` — optional list of repository instruction files to mention in worker prompts. Omit this to use the standard convention: `AGENTS.md`, `CONTEXT.md`, `README.md`, plus relevant docs.
- `workerInstructions` — legacy escape hatch for replacing the generated worker instruction text. Prefer repository docs plus `workerInstructionFiles` over long inline strings.
- `workerAgent` — worker CLI agent type. Allowed values are `"pi"` and `"claude"`; the default is `"pi"`.
- `workerModel` — optional worker model passed through verbatim in the format understood by the selected `workerAgent`.
- `reviewerAgent` — reviewer CLI agent type. Allowed values are `"pi"` and `"claude"`; the default is `"pi"`.
- `reviewerModel` — optional reviewer model passed through verbatim.
- `labels` — GitHub labels used to coordinate issue and PR state. Omit this when using the standard labels.
- `automations` — scheduled automation entries and their prompt/precheck files. Omit this to use the standard issue coordinator and PR reviewer. Set an explicit array only when customizing or disabling the standard automation set. Optional `driverFile` entries run bundled deterministic automation scripts after precheck and before sending any prompt; the driver can return `skip`, `done`, `needs_llm`, or `error` JSON to avoid unnecessary LLM context.

Repo policy may set only shared, reviewable policy keys: `workerAgent`, `workerModel`, `reviewerAgent`, `reviewerModel`, `checkCommand`, `workerInstructionFiles`, `workerInstructions`, `workerLaunchPolicy`, `labels`, and `id` / `name` / `promptFile` / `precheckFile` / `driverFile` for automations. Keep `enabled`, `repoPath`, `githubRepo`, `baseBranch`, `worktreeRoot`, `autoMerge`, `schedule`, and `precheckTimeoutSeconds` local or inferred. Invalid JSON or disallowed keys stop that project safely and appear in `/deadloop-status` and `/deadloop-doctor`.

By default deadloop reads `~/.pi/agent/deadloop/projects.json`. Use `DEADLOOP_CONFIG=/path/to/projects.json` only when you intentionally want a different config file.

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

## 4. Roll out in safe phases

### Phase 1: Issue coordination only

Start by operating only the issue coordinator. The standard automation set includes both the issue coordinator and PR reviewer, so set `automations` explicitly only if you want to temporarily disable the PR reviewer during rollout. The issue coordinator's deterministic driver handles no-op, cleanup, and gate cases before any LLM prompt is sent; when implementation is needed it starts a Herdr worktree with a worker. Humans still review and merge.

### Phase 2: Add PR reviewer, still no auto-merge

Use the standard `pr-reviewer` only after Phase 1 is reliable. Keep:

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

## 5. Run deadloop from the target repository

deadloop acts only when Pi's current directory is `repoPath` or inside it:

```bash
cd /absolute/path/to/your/repo
pi
```

Useful commands:

```text
/deadloop-status
/deadloop-doctor
```

## Verification commands

Use these commands before trusting a package change or when validating this repository itself:

```bash
npm test
npm run lint
npm run typecheck
bash -n extensions/deadloop/automations/*.sh
npm pack --dry-run
```

`npm pack --dry-run` should show only the public package contents. It must not include `extensions/deadloop/projects.json`, cache files, Herdr worktrees, `.pi-subagents/`, `node_modules/`, or other local artifacts.

## Package contents

The published package is controlled by `package.json` `files`. It intentionally includes:

- root user docs and metadata: `README.md`, `AGENTS.md`, `LICENSE`
- public docs under `docs/`
- the Pi extension entrypoint under `extensions/deadloop/`
- the Agent Skills setup skill under `skills/`
- automation prompts and deterministic helper scripts
- `extensions/deadloop/projects.example.json`
- TypeScript source under `src/`

It intentionally excludes local runtime config and generated state:

- `extensions/deadloop/projects.json`
- `~/.pi/agent/deadloop/projects.json`
- Herdr worktrees and runner state
- dependency folders, caches, logs, and bytecode
