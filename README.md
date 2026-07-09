# deadloop

**GitHub Issues in, reviewed PRs out.** deadloop runs a guarded engineering loop for coding agents: it watches labeled GitHub Issues, starts implementation agents, verifies their work, opens PRs, reviews PRs, and can optionally merge only after explicit safety gates pass.

## Current status

- v0 is a Pi package / extension.
- The default runner is [Herdr](https://herdr.dev/).
- The public name, package name, commands, config paths, and environment variables are **deadloop**.

## Safety first

Install only from source you trust. deadloop can write GitHub Issue / PR comments, change labels, create PRs, and, when `autoMerge: true` is explicitly enabled, squash-merge PRs and delete head branches.

Start with `autoMerge: false` in a test repository or a repository with known branch protection and permissions.

## Install

Install the Pi package:

```bash
pi install git:github.com/yasuhito/deadloop
```

If you start from the Agent Skills ecosystem, install the setup skill first:

```bash
npx skills@latest add yasuhito/deadloop
```

The Skills CLI installs agent instructions only. It does **not** activate the Pi extension; run the `pi install` command above to enable deadloop in Pi.

For local development:

```bash
pi install /absolute/path/to/deadloop
# or for a one-off run
pi -e /absolute/path/to/deadloop
```

## Configure

For the zero-local-config path, commit `deadloop.json` at the target repository root on the trusted base branch, then start Pi from that checkout. deadloop infers `repoPath`, the GitHub repository, and a default Herdr worktree root from the current git repository.

Use `~/.pi/agent/deadloop/projects.json` only for local overrides such as `autoMerge`, custom `worktreeRoot`, or managing repositories that do not carry `deadloop.json`. Copy the example configuration and edit it when you need those overrides:

```bash
mkdir -p ~/.pi/agent/deadloop
cp ~/.pi/agent/git/github.com/yasuhito/deadloop/extensions/deadloop/projects.example.json ~/.pi/agent/deadloop/projects.json
$EDITOR ~/.pi/agent/deadloop/projects.json
```

For a local checkout, copy from:

```text
/absolute/path/to/deadloop/extensions/deadloop/projects.example.json
```

`projects.json` is local configuration. Do not commit it.

Local project fields include:

- `repoPath` — absolute path to the target repository checkout. Optional when the current git repository has `deadloop.json` on the trusted base branch.
- `githubRepo` — GitHub repository in `owner/name` form. Inferred from the `origin` remote for implicit `deadloop.json` projects.
- `baseBranch` — branch or remote ref used as the worktree base, usually `origin/main`. Inferred from the current branch upstream for implicit `deadloop.json` projects.
- `worktreeRoot` — directory where Herdr may create worktrees. Defaults to `~/.herdr/worktrees/<repo>/` for implicit `deadloop.json` projects.
- `autoMerge` — keep `false` until the repository has proven safeguards.

Shared repository policy lives in `deadloop.json` on the trusted base branch. Standard labels, worker instruction files (`AGENTS.md`, `CONTEXT.md`, `README.md`), and the issue coordinator / PR reviewer automations are defaults, so omit those sections unless you are customizing them. Local `projects.json` values win over repo policy.

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

## Roll out in phases

1. **Issue coordination only** — start here if you want a slow rollout; humans still review and merge PRs.
2. **Automated PR review** — use the standard PR reviewer with `autoMerge: false`; reviewed PRs hand off to `ready-for-human`.
3. **Optional auto-merge** — consider `autoMerge: true` only after branch protection, CI, review expectations, dry-run/manual approval practices, and stop conditions are proven.

## Run

Start Pi inside the target repository:

```bash
cd /absolute/path/to/target/repo
pi
```

Useful commands:

```text
/deadloop-status
/deadloop-doctor
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

```bash
npm test
npm run lint
npm run typecheck
bash -n extensions/deadloop/automations/*.sh
npm pack --dry-run
```
