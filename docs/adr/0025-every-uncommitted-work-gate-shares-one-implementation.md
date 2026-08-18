# ADR 0025: Every uncommitted-work gate shares one implementation

## Status

Accepted. Replaces the application scope recorded in [ADR 0024](0024-an-agent-scratch-area-is-not-uncommitted-work.md); the scratch-area definition, the path list, and the rejected alternatives stand.

## Context

[ADR 0024](0024-an-agent-scratch-area-is-not-uncommitted-work.md) landed as `989222e2` and `yasuhito/pi-dictation` PR #42 was retried. The repair agent launched this time — the deterministic dispatch gate passed — and then stopped itself.

```
## Automatic review repair stopped
- Reason: dirty_worktree
- Detail: Repair was not started because the required clean-worktree invariant failed before editing.
```

The whole of the dirt was `.pi/subagents/`, exactly as before. What moved was who stopped: the gate, then the agent the gate had just released.

ADR 0024 counted the gates that read `git status` **in code**. Two more copies of the same rule were written in English, inside the prompts handed to agents:

| location | wording |
|---|---|
| `pr-review-repair-dispatch.ts:434` | `First require a clean worktree and HEAD exactly equal to <head>.` |
| `pr-reviewer-driver.ts:458` | `First require a clean worktree and require HEAD to equal the expected PR head.` |

An agent reading either line runs its own `git status` and cannot know the scratch-area list, so it reaches the answer ADR 0024 exists to prevent.

Three more copies survived because ADR 0024 excluded them by decision: `pr-review-repair-finalize.ts:119`, `pr-review-repair-finalize.ts:131`, and `pr-branch-update-finalize.ts:111`, on the grounds that a finalize gate asks whether deadloop itself left something behind before a push. That ground does not hold. The finalizer's `--repo` is the worktree the worker runs in — the launcher opens the PR branch worktree, and dispatch refuses to proceed unless the named agent's working directory resolves to that same path. The scratch area is present there by construction, so removing the prompt lines alone would have moved the same stop one step later, into `repair worktree is dirty before checks`.

ADR 0024 drew its line by the *question* a gate asks: gates asking about somebody else's unsaved work applied the rule, gates asking about deadloop's own leftovers did not. That line produced two classification errors in one day, because an agent scratch area is neither. It is the launched CLI's bookkeeping, so both questions have the same answer, and a distinction that does not change the answer only creates room to classify wrongly.

## Decision

Every gate that asks whether a worktree holds uncommitted work answers through `hasUncommittedWork` and `UNCOMMITTED_WORK_STATUS_ARGS`. No gate is excluded by the question it is understood to ask.

**The finalize gates are included.** All three read the worker's own worktree, where the launched CLI writes.

**A prompt does not judge uncommitted work.** Both prompt lines are removed rather than rewritten. A clean-worktree test is deterministic, so by the project's own design rule it belongs in a function, not in a prompt; and any restatement — an embedded checker command, or the path list spelled into the prompt — puts a copy of the rule back where the last two were missed.

The removed lines also required HEAD to equal the expected head. That is deterministic too, and it is already enforced three times without an agent's help: dispatch blocks when the worktree head and the PR head disagree, the finalizer requires the expected head to be an ancestor of the pushed commit, and the finalizer re-reads the remote head immediately before pushing.

**One exception, and it is not this question.** Enablement verification scans with `--ignored` to prove a throwaway worktree is pristine. No agent has run there, so no scratch area exists; it asks whether *anything* is present, not whether someone has unsaved work.

**The rule is enforced mechanically.** `src/check-uncommitted-work-judgments.ts` reads the shipped code and fails when a git status invocation is written out instead of shared, or when a prompt-rendering function asks an agent to judge a worktree's cleanliness. A git status invocation is an argument array naming `status` together with one of its output options, which distinguishes it from `herdr status server` and `gh auth status`. Hand-counting missed this rule twice; the count is now the machine's.

**Operator-facing readouts use `--untracked-files=all`.** The blocked-issue recovery steps and the doctor inspection commands showed `git status --short`, whose collapsed `?? .pi/` line is the misreading that started this. Enablement's retained-verification command already carried the explicit form and is unchanged.

## Consequences

The repair worker no longer verifies its starting state before editing. A worker that begins from the wrong revision now spends its run and fails at the finalizer instead of stopping early. Nothing unsafe reaches GitHub: the finalizer's ancestor check and pre-push head re-read still refuse the push.

A window remains open between the dispatch gate and the worker's first edit. It was open before — an agent reading `git status` was never a gate — and closing it properly means strengthening a deterministic check near launch, not asking the agent again.

A new gate that spells out a git status invocation fails `npm test` with the file and line. The guard reads `src/` and `extensions/` only; tests may spell the invocation out, because a test is not a gate.

The banned-phrase list is deadloop's model of how a prompt asks for this judgment, so a new phrasing escapes it, exactly as the path list goes stale when the agent CLI moves. The failure direction is unchanged: a target that stops rather than one that proceeds unsafely.
