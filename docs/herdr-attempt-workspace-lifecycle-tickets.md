# Disposable Herdr workspace implementation tickets

Source specification: `docs/herdr-attempt-workspace-lifecycle-spec.md`.

Tickets 0–3 are agent-ready implementation work but are not queued automatically by this plan. Ticket 4 is queued only after its operator gate is complete. The post-merge migration is a human-run checklist, not an implementation ticket.

Every implementation ticket must finish with:

```bash
npm test
npm run lint
npm run typecheck
bash -n extensions/deadloop/automations/*.sh
npm pack --dry-run
git status --short
```

The final status must contain only intended source changes and existing unrelated untracked files. Each test case has at most one assertion or expectation.

## Ticket 0 — Establish attempt identity and the atomic lifecycle journal

**Depends on:** none

### Goal

Create the one canonical identity contract shared by completion reports, launch records, and reconciliation without changing the selected Herdr 0.7.3 runtime path.

### Files and areas

- new focused module under `src/` for attempt identity, V1 report base types, and lifecycle records;
- atomic JSON persistence under the existing run directory;
- focused fixtures and tests;
- `CONTEXT.md` only if a new domain term is required.

### Red/green slices

1. Reject mismatched attempt, role, target, repository, and input revision bindings.
2. Persist `prepared` before any modeled external mutation.
3. Enforce monotonic phase transitions and retain the last successful phase on `launch_failed`.
4. Recover a complete prior record after interrupted atomic replacement; reject malformed state without overwriting it.
5. Prove a V1 report writer's identity validates against its persisted attempt record.

### Out of scope

- Herdr command changes;
- scheduler/startup registration;
- GitHub comments or labels;
- workspace closure;
- changing current promise writers.

### Acceptance

A single exported contract owns attempt IDs, V1 report identity fields, and journal phases. Atomic journal tests pass, while the current 0.7.3 launch command log and automation selection remain byte-for-byte unchanged in a regression fixture.

## Ticket 1 — Write and validate V1 completion reports

**Depends on:** Ticket 0

### Goal

Migrate all new completion writers to the ADR 0006 V1 normalized report while safely draining legacy promises.

### Files and areas

- `extract-worker-promise.ts` and completion-report parsing/validation modules;
- Worker, reviewer, review-repair, and branch-update prompt/rendering paths;
- role-specific report fixtures and tests;
- ADR 0003/0006 cross-references where migration status changes.

### Red/green slices

1. Parse and validate the V1 common identity fields against Ticket 0's journal.
2. Require Worker output revision and validation evidence.
3. Require reviewer exact reviewed head, typed outcome, and structured findings when applicable.
4. Require repair and branch-update input/output revisions and finalizer evidence.
5. Require typed blocked reason and recovery/information guidance.
6. Continue parsing legacy three-field reports only as weak evidence; prove they never authorize cleanup.
7. Switch every new writer to V1 and add unknown-version/mismatch fixtures.

### Out of scope

- workspace creation or closure;
- Herdr 0.7.5 commands;
- changing review, repair, push, or merge policy;
- automatic cleanup of any legacy workspace.

### Acceptance

Every new role writes a bound V1 report that validates against its journal. Unknown, mismatched, malformed, and legacy reports cannot become strong cleanup evidence. The selected live launch/runtime behavior remains unchanged.

## Ticket 2 — Add dormant Herdr 0.7.5 adapter primitives

**Depends on:** Ticket 0

### Goal

Implement and test the new Herdr interface behind unselected modules so it can land safely while the live host still runs 0.7.3.

### Files and areas

- `src/runner.ts`, `src/herdr-runner.ts`, and focused compatibility/preflight modules;
- `src/agent-profiles.cjs` and launcher argument construction without selecting it in live automation;
- runner fixtures and tests;
- doctor finding data, not startup registration.

### Red/green slices

1. Parse stable client/server SemVer and reject prerelease, malformed, incompatible, and protocol-mismatch probes.
2. Derive the bounded `dl-<role>-<target>-<hash12>` agent name and reject invalid/colliding inputs.
3. Accept only `worktree_created` for create and `worktree_opened` with `already_open:false` for open.
4. Return and cross-check workspace, tab, root pane, and canonical worktree path.
5. Build exact `agent start <name> --kind <kind> --pane <pane> -- <native args>` argv without the executable in native args.
6. Add distinct `closeWorkspace`, backed only by `herdr workspace close`, plus postcondition observations.
7. Prove no new module is called from scheduler, startup, current `launch-agent`, or cleanup paths.

### Out of scope

- requiring Herdr 0.7.5 in the live host;
- changing the current 0.7.3 argv;
- public compatibility toggles;
- tab/pane/workspace cleanup in production;
- `worktree remove` changes.

### Acceptance

Adapter tests prove every 0.7.5 contract. A regression test proves the selected 0.7.3 command sequence and automation registration are unchanged after this ticket.

## Ticket 3 — Build the dormant disposable-attempt orchestrator

**Depends on:** Ticket 1, Ticket 2

### Goal

Implement the complete close/preserve decision and fresh-workspace orchestration as an unselected seam, without touching the live scheduler or 0.7.3 launch path.

### Files and areas

- a focused attempt-workspace lifecycle module under `src/`;
- role-specific GitHub completion predicates;
- reconciliation and read-only doctor finding functions;
- fixtures for all four roles and cleanup failures;
- no automation registration or selected-path edits.

### Red/green slices

1. Implement each row of the specification's Worker completion table.
2. Implement reviewer approved, changes-requested, human-required, and blocked decisions.
3. Implement repair pushed, stale-head, blocked, and invalid decisions.
4. Implement branch-update pushed, PR-head-stale, blocked, and invalid decisions while allowing the selected base to advance.
5. Reconcile before open; preserve/reject blocked or ambiguous existing workspace ownership without relabelling it.
6. Require no newer live owner before closure.
7. Record `github_persisted`, call only `closeWorkspace`, and confirm Herdr workspace absence.
8. Confirm the linked worktree path and branch still exist after closure.
9. Treat timeout/ambiguous close as cleanup pending and prove no push, PR creation, comment, label, review, or merge is replayed.
10. Make restart reconciliation idempotent and always preserve legacy reports.
11. Produce read-only doctor findings for every retention reason.

### Mandatory dormant guard

This ticket must not change:

- automation registration or scheduler/startup hooks;
- current `launch-agent.ts` selection;
- current 0.7.3 `agent start --tab` argv;
- any live cleanup path;
- current prompts or operator commands.

The module is callable only from tests/fixtures until Ticket 4. A regression test compares the selected launch and command log before/after Tickets 0–3 and expects no change.

### Out of scope

- runtime activation;
- Herdr update;
- candidate selection or retry changes;
- merge/push policy changes;
- destructive doctor behavior.

### Acceptance

Every completion-table outcome has one focused decision test. Closure additionally proves no newer owner, workspace absence, worktree/branch preservation, and cleanup-pending idempotency. The live 0.7.3 scheduler and command log remain unchanged.

## Operator gate before Ticket 4 is queued

Ticket 4 must not receive `agent:implement` until an operator completes and records this checklist:

1. Set the effective deadloop project configuration to `autoMerge: false`.
2. Re-read `/deadloop-status` or the deterministic effective configuration and record evidence that `autoMerge` is false.
3. Confirm Ticket 4's future PR will require an explicit human merge.
4. Keep Herdr 0.7.3 running while Ticket 4 is implemented and reviewed; Tickets 0–3 guarantee the old selected path remains intact.

After Ticket 4's PR reaches human handoff, but before merging it:

5. Run `/deadloop-disable` or the documented host stop path so no new Issue or PR attempts can launch.
6. Re-read GitHub and Herdr and wait for every active attempt to become terminal or intentionally blocked.
7. Preserve blocked/ambiguous attempts and record their locations.
8. Verify `autoMerge: false` again.

Prose or an unused label is not sufficient. If effective `autoMerge: false` cannot be proven, Ticket 4 is not queued or merged.

## Ticket 4 — Atomically activate disposable Herdr attempt workspaces

**Depends on:** Ticket 3 and completion of the operator gate above

### Goal

Switch every launch role to the already-tested 0.7.5 lifecycle in one human-merged activation PR, remove the old tab lifecycle, and synchronize the operational contract.

### Files and areas

- automation-host startup and scheduler entry points;
- `src/agent-launch-flow.ts`, launcher, runner selection, and all four role dispatch paths;
- `extensions/deadloop/automations/*.prompt.md` and recovery comments;
- `docs/herdr-runner.md`;
- reviewer lifecycle section of `docs/qa2-runtime-lifecycle-spec.md`, marked superseded;
- `extensions/deadloop/README.md`;
- ADR 0004 and a new disposable-workspace lifecycle ADR;
- Japanese Cucumber features/steps and integration fixtures.

### Red/green activation checkpoints

1. At host startup and before every automation tick, reject unsupported client/server/protocol state before candidate selection.
2. Prove rejection occurs before each mutation class: Issue/PR claim, label, comment, worktree/workspace, and agent launch.
3. Select direct root-pane launch for Worker and close only after Worker PR persistence.
4. Select fresh reviewer workspace and close after approved/changes-requested persistence.
5. Select a separate repair workspace and verify pushed/stale/blocked handling.
6. Select a separate branch-update workspace and preserve ADR 0011 base-advance semantics.
7. Delete old tab creation, split launch, same-name done-agent retirement, and tab-replacement instructions.
8. Run the public Japanese Cucumber scenarios and all repository verification commands.
9. Review documentation against implementation and review the final diff against this specification.

### Safety invariants

This ticket does not change:

- candidate eligibility;
- review outcome or repair-attempt limits;
- conflict recovery limits;
- normal-push and force-push prohibition;
- merge gates or `autoMerge` meaning;
- safe worktree-removal conditions;
- promise completion authority;
- `/deadloop-doctor` read-only behavior.

### Acceptance

One active attempt has one workspace, one tab, and one pane. Successful V1-backed attempts disappear while their worktree remains. Blocked, human-required, legacy, malformed, launch-failed, and ambiguous attempts remain. No selected `agent start --tab`, `tab create`, or split-pane launch path remains.

### Merge rule

The PR is handed to a human under proven `autoMerge: false`. It must not be merged by deadloop. The human proceeds directly into the migration checklist below.

## Human-run migration and verification checklist

This is not an agent implementation ticket and is never labelled `agent:implement`.

### Preconditions

- Ticket 4 PR is approved and waiting for explicit human merge.
- Effective `autoMerge: false` is recorded.
- New launches are disabled.
- No active attempt is unaccounted for.
- A copy of `herdr --version`, `herdr status server`, `/deadloop-status`, `/deadloop-doctor`, and `git status --short` is saved.

### Activation

1. Human-merge Ticket 4.
2. Install/reload the merged deadloop package while launches remain disabled.
3. Run `herdr update --handoff` and require stable version 0.7.5 or newer for both client and server with compatible protocol.
4. Restart/reload the deadloop automation host.
5. Run `/deadloop-doctor`; stop if version, ownership, legacy, or ambiguous-workspace findings are unsafe.
6. Enable deadloop with `autoMerge: false` and queue one disposable, non-merging smoke Issue.
7. Observe Worker completion: its workspace disappears and its linked worktree remains.
8. Observe reviewer completion or human handoff in a different fresh workspace.
9. Run the complete repository verification commands.
10. Reclaim only V1-backed historical workspaces proven safe by reconciliation; preserve all legacy/ambiguous workspaces.
11. Resume normal scheduling. Re-enable `autoMerge` only through a separate explicit operator decision.

### Stop and rollback conditions

Stop without further launches if:

- client/server versions or protocol disagree;
- the first attempt creates an extra tab or pane;
- a successful close removes the linked worktree;
- a blocked/ambiguous workspace disappears;
- GitHub side effects repeat;
- doctor cannot prove ownership.

Before the first new attempt, rollback means reinstalling the previous deadloop revision and Herdr binary/session backup. After an attempt starts, preserve its workspace/worktree and diagnose forward; do not downgrade a live session or rewrite branch history.

### Evidence

Record command outputs, smoke Issue/PR URLs, workspace counts before/during/after, worktree path preservation, and residual manual cleanup. Normal automation resumes only after this evidence is reviewed.

## Execution order

```text
Ticket 0
  ├─ Ticket 1
  └─ Ticket 2
       Ticket 1 + Ticket 2
              ↓
           Ticket 3
              ↓
      operator gate and autoMerge=false
              ↓
           Ticket 4 (human merge)
              ↓
      human migration checklist
```
