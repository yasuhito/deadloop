---
name: deadloop
description: Install and operate deadloop, a Pi package/extension that loops GitHub issues through implementation, PR review, verification, and optional merge using Herdr-managed agents. Use when a user asks to install deadloop, configure issue/PR automation, or understand the npx skills setup path.
---

# deadloop

deadloop is a Pi package and extension, not only an Agent Skill. Installing this skill with the Skills CLI gives an agent the setup instructions, but it does **not** by itself activate the Pi extension.

## Install path

If the user installed this skill with:

```bash
npx skills@latest add yasuhito/deadloop
```

then continue by installing the Pi package in Pi:

```bash
pi install git:github.com/yasuhito/deadloop
```

For a one-off test, use:

```bash
pi -e git:github.com/yasuhito/deadloop
```

For a local checkout:

```bash
pi install /absolute/path/to/deadloop
```

## Configure safely

1. Start Pi from the target repository's normal Git checkout:

   ```bash
   cd /absolute/path/to/target/repo
   pi
   ```

2. Explicitly enable deadloop in Pi:

   ```text
   /deadloop-enable
   ```

   Enablement verifies GitHub write access and creates any missing standard labels. It starts with `autoMerge: false`.

3. Optionally copy `projects.example.json` to `~/.pi/agent/deadloop/projects.json` only when the user needs overrides such as a custom worktree root. Manual label creation is also optional.

## Rollout guidance

- Phase 1: enable only `issue-coordinator`; humans review and merge PRs.
- Phase 2: add `pr-reviewer` with `autoMerge: false`.
- Phase 3: consider `autoMerge: true` only after branch protection, CI, review expectations, and stop conditions are proven.

## Safety notes

- deadloop writes GitHub comments and labels.
- The extension and its automations run with local user permissions.
- Do not commit `extensions/deadloop/projects.json` or `~/.pi/agent/deadloop/projects.json`.
- Review the package source before installing it in a repository with write access.
