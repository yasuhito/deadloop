# ADR 0024: An agent scratch area is not uncommitted work

## Status

Accepted. Replaces the runtime path list recorded in [ADR 0010](0010-runtime-artifact-isolation.md). The application scope in this decision is replaced by [ADR 0025](0025-every-uncommitted-work-gate-shares-one-implementation.md); the definition, the path list, and the rejected alternatives stand.

## Context

Deadloop launches an agent CLI with the target worktree as its working directory. The CLI writes its own bookkeeping there. On 2026-08-14 that stopped the loop on `yasuhito/pi-dictation` PR #42: the review returned `changes_requested`, and automatic repair refused to start.

```
$ git -C ~/.herdr/worktrees/pi-dictation/agent-issue-34-... status --short
?? .pi/
```

```json
{"driverAction":"review_repair_dirty_worktree",
 "summary":"PR #42 repair worktree is dirty; marked blocked"}
```

The whole of the dirt was `.pi/subagents/`, the artifacts and missions of Pi's own subagents. The agent's tool blocked the agent's next task.

Deadloop already held this rule, in three places, with three different meanings, and every one of them had drifted from what Pi writes today:

| location | mechanism | tracked path under the same prefix |
|---|---|---|
| `cleanup-completed-worker-worktrees.ts` | regex over `git status` lines, accepts `??` only | still blocks |
| `run-worker-required-verification.ts` | pathspec `:(exclude)` | hidden |
| `project-check.ts` (ADR 0010 quarantine) | move out, run, move back | refuses to hide |

All three listed `.deadloop` and `.pi-subagents`. Seven of the nine gates that read `git status` to ask "does someone else have unsaved work here" never had the rule at all — among them the repair dispatch above, the branch-update decision, and the checkout alignment that runs immediately before every launch.

Four measurements settled the shape of the fix:

1. **Pi moved.** Pi 0.84.1 writes `.pi/subagents/`. Worktrees last written in July hold `.pi-subagents/` (`qa2` Jul 18, `qa2-love2d` Jul 24); `pi-dictation` Aug 13 holds `.pi/subagents/`.
2. **`.pi/` is not a scratch directory.** `.pi/settings.json`, `.pi/skills/`, `.pi/extensions/`, `.pi/prompts/`, and `.pi/themes/` are project resources meant to be shared and committed. `qa2-love2d` tracks `.pi/` today.
3. **Deadloop's own launch flag creates two more.** `AGENT_PROFILES.pi.permissionArgs` passes `--approve` so Pi cannot pause on its project-trust dialog. Trusting a project makes Pi install missing project packages, into `.pi/npm/` and `.pi/git/`.
4. **Git has no per-worktree exclude file.** Writing `.git/worktrees/<name>/info/exclude` has no effect; only `$GIT_COMMON_DIR/info/exclude` is read, and for `~/.herdr/worktrees/pi-dictation/agent-issue-34-...` that resolves to `/home/yasuhito/Work/pi-dictation/.git` — the operator's own checkout.

## Decision

An agent scratch area is not uncommitted work.

An agent scratch area is an untracked directory that the launched agent CLI creates inside the target worktree for its own bookkeeping. It is neither an artifact of the target repository nor something the operator manages. One list names them, shared by every gate that consults it: `.pi/subagents`, `.pi/npm`, `.pi/git`.

**Untracked only.** The rule is justified by "nobody owns this", so ownership ends it. A tracked path under a scratch prefix is uncommitted work and blocks, which is what `cleanup-completed-worker-worktrees.ts` already did and what `run-worker-required-verification.ts` did not. The pathspec form cannot express this and is replaced.

**Applied to everything that asks about someone else's unsaved work.** The gates: repair dispatch, the branch-update decision, the Issue coordinator's reuse of an abandoned checkout, attempt abandonment, checkout alignment, worktree cleanup, required verification. The ADR 0010 quarantine, which asks the same question of the same paths. And the host's own worktree-status snapshot, which `/deadloop-status`, `/deadloop-doctor`, and the local recovery guidance all read — otherwise the loop repairs a pull request while the operator asking about the same worktree is told it is changed, which is the original confusion moved one layer out.

Not applied to the two finalize gates, which ask whether deadloop itself left something behind before a push, nor to enablement verification, whose `--ignored` scan exists to prove a throwaway worktree is pristine.

**Read with `--untracked-files=all`.** Git collapses a fully untracked directory to a single `?? .pi/` line, which cannot be told apart from a change to `.pi/settings.json`. Cleanup's `git status --short` moves to the explicit form.

**`.git/info/exclude` was rejected.** It is the obvious fix and it is not worktree-local; by measurement 4 it writes into the repository the operator works in, silently changing what `git status` shows them in their own checkout. Deadloop does not edit an operator's repository configuration to make its own gate pass.

**A target repository's `.gitignore` was rejected.** It asks the operator to absorb, in their repository's settings, a directory deadloop caused to exist. Deadloop's gates therefore never depend on a target repository's ignore settings. Deadloop's own `.gitignore` is a separate matter — it is this repository's housekeeping, not a gate.

**`.deadloop` and `.pi-subagents` are dropped.** Prompts and promises have lived outside the worktree since ADR 0010, under `<stateDir>/runs/<uuid>/`, and no current prompt directs an agent to write into `.deadloop/`. No currently released Pi writes `.pi-subagents/`. Both are past formats.

## Consequences

Required verification's gate tightens. A tracked modification under a scratch path used to vanish into the pathspec and now blocks.

Worktrees written before this change hold `.pi-subagents/` and now read as dirty. Cleanup leaves them, and checkout alignment refuses to reuse them, so a pre-existing worktree needs its old scratch directory removed before an attempt can open it again. The failure is toward stopping, and the cost is one manual removal.

The quarantine now moves a subdirectory of `.pi/` instead of a top-level directory. Moving `.pi/` whole would carry the project's own Pi settings, skills, and extensions out of the worktree for the duration of the check.

`pr-review-comments.ts` keeps its own broader `.pi` pattern. It answers a different question — whether a path is internal enough to redact from a public comment — where over-redaction is the safe direction.

The list is deadloop's model of what an external CLI writes, so it goes stale when that CLI moves, as it did here. It is one table now, and the symptom of staleness is a target that stops rather than one that proceeds unsafely.
