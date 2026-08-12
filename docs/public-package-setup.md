# Public package setup

This guide is for first-time users installing **deadloop** into a repository they control. Start with the smallest safe loop, then enable more automation only after observing it on real issues.

## 1. Install the package

Install from GitHub:

```bash
pi install git:github.com/yasuhito/deadloop
```

The Pi package installs the extension and its setup skill together.

For a local checkout or development build:

```bash
pi install /absolute/path/to/deadloop
# or, for a one-off trial without changing settings:
pi -e /absolute/path/to/deadloop
```

Pi packages and extensions run with your local user permissions. Install only from source you trust.

## 2. Enable the local scheduler and add optional policy

The current supported host is a Unix-like platform with a compatible `flock` executable, normally from util-linux. It must support the nonblocking file-descriptor locking used by deadloop's repository scheduler. `/deadloop-enable` tests the executable and actual lock behavior before it persists enablement, changes GitHub labels, or starts the scheduler; an unavailable or incompatible implementation fails closed. A portable lock backend is not included yet.

Start Pi from a normal (non-linked) Git checkout and run:

```text
/deadloop-enable
```

The command infers the local checkout, GitHub repository, base branch, and default Herdr worktree root. It first journals ownership and the trusted base revision, creates a detached temporary Git worktree at that exact revision, and runs the resolved required-verification command there. Uncommitted changes in the normal checkout are not included. This preflight creates no Herdr workspace and starts no agent. A failed command leaves scheduling disabled and reports the durable log path under `~/.pi/agent/deadloop/`; only a clean, revision-matched, proven-owned temporary worktree is removed. Repeated enablement reuses only a passed record with an exact repository, target commit, command, source identity, and base-revision match. Timeout, interruption, and runner-start failures have typed outcomes with a null exit code, and deadloop attempts to restore generated runtime artifacts before cleanup is considered. If restoration fails, it retains the quarantine and temporary worktree and records both paths. `/deadloop-doctor` shows the journal, record, log, revision, retained resources, and a read-only confirmation command whenever cleanup cannot be proven safe. The command then checks `gh` authentication and write permission, resolves the authenticated GitHub login, and creates only missing standard labels. Only after a passed verification record and those steps succeed does it save local execution permission under `~/.pi/agent/deadloop/`, including the normalized authenticated login as an explicit authorized automation identity. The reviewer receives that saved identity at runtime, so the default path does not require `projects.json` and does not rely on an implicit "currently logged in" fallback. `deadloop.json` and `projects.json` are optional policy/override files and never start automation merely by existing. A newly enabled repository always starts with `autoMerge: false`; configure auto-merge only after the safety checks in this guide. After the initial safe start, deadloop must observe `autoMerge: false` and then an explicit change to `autoMerge: true` before it acknowledges automatic merge. That acknowledgement survives disable and re-enable. Keep `autoMerge: false` until you intend to enable automatic merge.

Use Pi's user state config only for local overrides such as `autoMerge` or a custom `worktreeRoot`. If you need those overrides, copy the example config to Pi's user state directory and edit it for your repository. If you installed from GitHub, Pi clones the package under `~/.pi/agent/git/github.com/yasuhito/deadloop`:

```bash
mkdir -p ~/.pi/agent/deadloop
cp ~/.pi/agent/git/github.com/yasuhito/deadloop/extensions/deadloop/projects.example.json ~/.pi/agent/deadloop/projects.json
$EDITOR ~/.pi/agent/deadloop/projects.json
```

For a local development checkout, copy from `/absolute/path/to/deadloop/extensions/deadloop/projects.example.json` instead.

`projects.json` is local configuration. It contains local paths and rollout choices, so do **not** commit it. The package includes only `extensions/deadloop/projects.example.json` as a template.

Shared repository policy lives in `deadloop.json` at the target repository root. deadloop reads it only from the trusted `baseBranch` after `git fetch`; a PR branch cannot change the policy used to decide that PR. Local `projects.json` explicit values win over repo policy, so remove a key locally when you want to inherit the shared value.

The built-in required-verification command is `npm run check`. A repository with that script does not need `deadloop.json` or a local `checkCommand` setting.

To use another command, define it as shared policy in `deadloop.json` and commit the file to the repository's base branch:

```json
{
  "checkCommand": "your verification command"
}
```

`/deadloop-status` and `/deadloop-doctor` show the effective command, source identity, trusted base revision, and any local override. An explicitly empty command is shown as `zero_targets`, differing values at the same priority as `source_conflict`, and a command without trusted base revision evidence as `missing_base_revision`. A non-empty override is accepted as written and judged by its eventual exit status rather than by command-name heuristics.

`/deadloop-doctor` also reports `package.json` aggregate scripts (`check`, `verify`, `validate`, or `ci`), individual test/lint/type-check scripts, and each GitHub Actions `run` step as diagnostic candidates. Every candidate retains its manifest or workflow location, declared working directory, and explicit execution context such as environment, shell, runner/container, matrix, services, and preceding setup actions. Candidates never replace the built-in command or an explicit override.

If a project uses `workerAgent: "claude"` or `reviewerAgent: "claude"`, run `claude` interactively once from the target repository root and accept Claude Code workspace trust before enabling the automation.

Key fields:

- `repoPath` — absolute path to the target repository checkout. `/deadloop-enable` infers it from the current primary checkout; set it in `projects.json` only as a local override.
- `githubRepo` — GitHub repository in `owner/name` form. `/deadloop-enable` infers it from the canonical `origin` fetch and push URLs; set it in `projects.json` only as a local override.
- `baseBranch` — branch or remote ref used as the worktree base, usually the current branch upstream or the verified GitHub default branch when no upstream exists. `/deadloop-enable` infers it; set it in `projects.json` only as a local override.
- `worktreeRoot` — directory where the Herdr runner may create worker worktrees. `/deadloop-enable` defaults it to `~/.herdr/worktrees/<sanitized-checkout-name>-<12-character-identity-hash>/`; the hash is derived from the canonical checkout path and GitHub repository identity. Set it in `projects.json` only to use another local path.
- `checkCommand` — aggregate verification command. It defaults to `npm run check`. Set it in trusted shared `deadloop.json` when the repository needs another command; use a local value only as a deliberate non-shareable override.
- `autoMerge` — keep `false` until the repository has proven safeguards. Only `true` allows the PR reviewer automation to squash merge and delete the head branch after its gates pass.
- `externalReview` — optional external review service gate. It is disabled by default; set `{ "enabled": true }` only for repositories where the built-in CodeRabbit/Copilot request path is available.
- `workerInstructionFiles` — optional list of repository instruction files to mention in worker prompts. Omit this to use the standard convention: `AGENTS.md`, `CONTEXT.md`, `README.md`, plus relevant docs.
- `workerInstructions` — legacy escape hatch for replacing the generated worker instruction text. Prefer repository docs plus `workerInstructionFiles` over long inline strings.
- `workerAgent` — worker CLI agent type. Allowed values are `"pi"` and `"claude"`; the default is `"pi"`.
- `workerModel` — optional worker model passed through verbatim in the format understood by the selected `workerAgent`.
- `reviewerAgent` — reviewer CLI agent type. Allowed values are `"pi"` and `"claude"`; the default is `"pi"`.
- `automationLogins` — additional GitHub logins authorized to publish cross-host claim comments for other Automation hosts in the same trusted fleet. Leave this empty unless you have verified both the GitHub identity and who controls it; never copy an unfamiliar third-party login into this allowlist. `/deadloop-enable` verifies and stores this host's authenticated login separately in local enablement state, then combines it with these optional local entries at runtime. Reviewer claims still fail closed unless the authenticated runtime login appears in that explicit combined allowlist.
- `reviewerModel` — optional reviewer model passed through verbatim.
- `labels` — GitHub labels used to coordinate issue and PR state. Omit this when using the standard labels.
- `automations` — scheduled automation entries and their prompt/precheck files. Omit this to use the standard issue coordinator and PR reviewer. Set an explicit array only when customizing or disabling the standard automation set. Optional `driverFile` entries run bundled deterministic automation scripts after precheck and before sending any prompt; the driver can return `skip`, `done`, `needs_llm`, or `error` JSON to avoid unnecessary LLM context. Reviewer entries may set `maxRuntimeSeconds` and `shutdownGraceSeconds`; review-claim authority is derived from those normalized execution limits.

Repo policy may set only shared, reviewable policy keys: `workerAgent`, `workerModel`, `reviewerAgent`, `reviewerModel`, `checkCommand`, `externalReview`, `workerInstructionFiles`, `workerInstructions`, `workerLaunchPolicy`, `labels`, and `id` / `name` / `promptFile` / `precheckFile` / `driverFile` / `maxRuntimeSeconds` / `shutdownGraceSeconds` for automations. The legacy project-level `enabled` field is ignored; only `/deadloop-enable` and `/deadloop-disable` control scheduling. Keep `repoPath`, `githubRepo`, `baseBranch`, `worktreeRoot`, `autoMerge`, `schedule`, and `precheckTimeoutSeconds` local or inferred. Invalid JSON or disallowed keys stop that project safely and appear in `/deadloop-status` and `/deadloop-doctor`.

Per-launch prompts and promise reports live under `~/.pi/agent/deadloop/runs/`, not in the target worktree. The configured project check runs through deadloop's isolation wrapper: untracked `.deadloop` and `.pi-subagents` directories are temporarily hidden, and restoration is attempted on every exit path. A restoration failure retains and reports the quarantine and temporary worktree for inspection. Tracked files are never hidden; validation fails closed if either runtime directory contains one.

By default deadloop reads `~/.pi/agent/deadloop/projects.json`. Use `DEADLOOP_CONFIG=/path/to/projects.json` only when you intentionally want a different config file.

## 3. Standard labels

`/deadloop-enable` creates only missing standard labels and never changes an existing label. To prepare them manually instead, use:

```bash
gh label create ready-for-agent --repo owner/repo --color 0e8a16 || true
gh label create ready-for-human --repo owner/repo --color d93f0b || true
gh label create wontfix --repo owner/repo --color ffffff || true
gh label create needs-info --repo owner/repo --color fef2c0 || true
gh label create needs-triage --repo owner/repo --color f9d0c4 || true
gh label create agent:explore --repo owner/repo --color 0052cc || true
gh label create agent:implement --repo owner/repo --color 1d76db || true
gh label create agent:review --repo owner/repo --color 5319e7 || true
gh label create agent:reviewing --repo owner/repo --color c2e0c6 || true
gh label create agent:update-branch --repo owner/repo --color 006b75 || true
gh label create agent:in-progress --repo owner/repo --color fbca04 || true
gh label create agent:blocked --repo owner/repo --color b60205 || true
```

`agent:reviewing` remains a compatibility label for older workflow state and branch-update paths. Review claims and repair authorization require `agent:in-progress`; new review flows never add `agent:reviewing`.

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

With auto-merge disabled, the reviewer automation starts a review agent session, requests fixes when needed, and hands the PR to `ready-for-human` instead of merging. External review requests are disabled by default; enable `externalReview` only in repositories where the external service is installed and allowed.

Automatic branch updates are currently unavailable. deadloop detects merge conflicts but does not update the branch until #241 connects the `agent:update-branch` request to its worker. External-review mutations are also currently unavailable; enabling `externalReview` does not make them available. The existing branch-update contracts—normal merge rather than rebase, required verification, exact-head authorization, and non-force push—remain mandatory.

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
/deadloop-enable
/deadloop-disable
/deadloop-status
/deadloop-doctor
/deadloop-abandon-attempt <attempt-id>  # only when doctor presents it
```

`/deadloop-disable` removes local execution permission, stops the scheduler and releases its lock without killing active agents or deleting GitHub state, worktrees, or run artifacts. Another session owning the lock notices the removal on its next polling tick. To migrate from releases that activated from configuration files, run `/deadloop-enable` once in each repository.

Use `/deadloop-abandon-attempt` only when `/deadloop-doctor` prints the exact command. It is limited to launch-failed Worker and reviewer attempts whose unchanged target, clean revision, owned disposable workspace, and empty recorded pane can all be proven. Otherwise doctor requires manual review and does not suggest removing only the claim label.

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
