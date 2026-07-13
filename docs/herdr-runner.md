# Herdr runner

deadloop v0 uses the Herdr runner.

## Responsibilities

- Create Herdr worktrees.
- Start Pi worker-agent and review-agent sessions.
- Check completion reports from promise files written by worker agents. Prompts and promise files live in deadloop's state directory, outside target worktrees.
- Retire a finished same-name agent before a deterministic relaunch, but refuse to close working, ambiguous, or wrong-worktree candidates.
- After merge / close, clean up unnecessary workspaces and linked worktrees with deterministic helper scripts. Cleanup removes `.deadloop` / `.pi-subagents` only when they contain no tracked files and the worktree is still otherwise clean; otherwise it preserves the worktree and stops safely.

## Requirements

- `herdr` CLI.
- `gh` CLI.
- Read and write access to the target GitHub repository.
- A local working tree for the target repository.

## Future runners

Herdr-specific operations are treated as runner concerns. The runner seam in the code lives in `src/runner.ts`, and the Herdr implementation lives in `src/herdr-runner.ts`. If future versions add tmux or another terminal / workspace management tool, GitHub Issue / PR state management should stay in deadloop.
