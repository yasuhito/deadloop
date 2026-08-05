# Disposable Herdr workspace lifecycle

## Status

Implementation specification derived from deadloop dogfooding on 2026-07-23 and the Herdr 0.7.5 agent automation contract.

This specification supersedes the reviewer-tab lifecycle in `docs/qa2-runtime-lifecycle-spec.md`. That document's project-check isolation and safe merged/closed-worktree cleanup contracts remain in force.

## Problem

Herdr currently makes completed deadloop work look active.

In the observed deadloop session:

- only Issue #121 had a working Worker;
- the completed Workers for Issues #112–#117 and #120 were still visible;
- the PR #143 worktree workspace had accumulated 10 tabs and 16 panes;
- an ordinary completed Worker workspace contained two tabs and three panes: the worktree root shell, a second tab root shell, and the agent pane.

The GitHub and promise state was mostly correct. The runtime presentation was not: durable branch state and disposable agent terminals had the same lifetime.

The current launcher creates a worktree workspace, creates another tab, and starts the agent by splitting that tab. Successful agents remain alive after their completion report, so Herdr continues to show them as idle or done.

Herdr 0.7.5 changes the relevant primitive. `agent start` targets an existing available shell pane and never creates, splits, or moves layout. Workspace and worktree creation return the first tab and root pane for that purpose. Ticket 4 selects these semantics atomically; the human-run installation and Herdr handoff checklist below remains required before operating the merged package.

## Product outcome

Herdr shows work that currently needs attention, not the historical process tree of a PR.

For one deadloop attempt:

- a working Worker, reviewer, repair agent, or branch-update agent is visible in exactly one Herdr workspace, one tab, and one pane;
- a successful attempt disappears from Herdr after its result is durably reflected in GitHub;
- a blocked, inconclusive, or not-yet-persisted attempt remains visible for inspection;
- the Git worktree survives successful attempts until the PR reaches the existing safe cleanup point;
- every later attempt opens the same worktree in a fresh Herdr workspace and fresh PTY.

The durable handoff between attempts is the Git branch, exact revision, structured completion report, and GitHub state. A terminal, shell process, agent process, tab, pane, or native agent session is not a handoff mechanism.

## Scope

This specification covers:

1. requiring stable Herdr 0.7.5 or newer;
2. launching an agent in the root pane returned by worktree create/open;
3. using one disposable Herdr workspace per attempt;
4. closing successful attempt workspaces only after durable completion;
5. preserving blocked or inconclusive workspaces;
6. reclaiming conclusively completed workspaces after an automation-host restart;
7. diagnosing retained workspaces without making `/deadloop-doctor` destructive.

It applies to Issue Workers, PR reviewers, automatic review repairs, and merge-conflict branch-update agents.

## Terms and ownership

### Git worktree

The linked checkout containing the Issue or PR branch. It is durable across attempts and remains until the existing merged/closed-PR cleanup contract permits removal.

### Attempt workspace

The Herdr workspace opened for one exact attempt. It owns that attempt's tab, root pane, PTY, and agent process. It is disposable after completion persistence.

### Completion persistence

The point at which the attempt's structured report has been accepted and the role-specific GitHub outcome has been written and confirmed.

A promise alone is not completion persistence. A GitHub write without a matching terminal completion report is not completion persistence.

### Completion report and attempt binding

The promise file remains the Pi + Herdr transport, but its payload migrates to the versioned normalized completion report required by ADR 0005 and ADR 0006.

Every new report contains:

```ts
type CompletionReportV1 = {
  schemaVersion: 1;
  attemptId: string;
  role: "worker" | "reviewer" | "review-repair" | "branch-update";
  target: {
    repository: string;
    kind: "issue" | "pull-request";
    number: number;
  };
  inputRevision: {
    head: string;
    base?: string;
  };
  status: "complete" | "blocked";
  summary: string;
  result: RoleSpecificResult;
  evidence: RoleSpecificEvidence;
};
```

`RoleSpecificResult` is discriminated by the outcomes in the role-specific completion table. Complete Worker, repair, and branch-update reports include the produced commit as `outputRevision`; reviewer reports include the exact reviewed head and structured outcome/findings. `RoleSpecificEvidence` contains the role's required validation or review evidence. Blocked reports contain a typed reason code, explanation, and recovery or information request.

Binding requires all of the following:

- a launch-unique promise path created in the attempt run directory;
- exact `attemptId`, role, target, repository, and input revision equality with the durable attempt record;
- role-specific output revision and evidence validation;
- role-specific revision checks before GitHub side effects.

The reader migration follows ADR 0006: it may parse legacy three-field payloads while old attempts drain, but a legacy payload lacks report-level attempt/revision evidence and therefore never authorizes automatic workspace closure or restart reconciliation under this specification. Every legacy workspace is preserved for manual inspection, even when older workflow logs suggest successful validation. New writers emit only V1. The legacy reader is removed after no legacy attempt remains.

A report at another path, a reused path, an unknown schema version, or any binding mismatch is inconclusive and cannot authorize cleanup.

## Herdr version contract

The minimum supported Herdr version is stable 0.7.5.

The automation host performs one global Herdr compatibility preflight before candidate claiming, label transitions, comments, worktree/workspace mutation, or agent launch. Checking only inside `launch-agent.ts` is too late.

The preflight deterministically checks:

1. the client from `herdr --version`;
2. the connected server from `herdr status server`;
3. server `compatible: yes` and absence of `protocol_mismatch`.

Both client and server versions must be stable Semantic Versioning values greater than or equal to 0.7.5. Build metadata is accepted and ignored for precedence. Prerelease versions such as `0.7.5-rc.1` and `0.8.0-beta.1` are rejected. A leading `v`, missing component, extra prose beyond the documented `herdr <semver>` or server `version: <semver>` forms, malformed output, an unreachable server, protocol mismatch, or `compatible` other than `yes` fails closed.

Failure diagnostics show:

- the detected client and server versions or probe failures;
- the minimum supported version;
- `herdr update --handoff` as the update command;
- that active automations must be quiet before migration.

`/deadloop-doctor` reports the same incompatibility. Herdr 0.7.3 compatibility is not required.

## Agent name contract

Herdr 0.7.5 requires a unique live agent name matching `[a-z][a-z0-9_-]{0,31}`.

Deadloop derives the internal name as:

```text
dl-<role>-<target>-<hash12>
```

Where:

- `<role>` is `w` for Worker, `r` for reviewer, `x` for review repair, or `u` for branch update;
- `<target>` is the decimal Issue or PR number, validated as an integer from 1 through 2,147,483,647 before any mutation;
- `<hash12>` is the first 12 lowercase hexadecimal characters of SHA-256 over the canonical repository identity, role, target number, and launch UUID joined with NUL separators.

The bounded target is at most 10 digits, so the resulting name is at most 28 characters. An out-of-range or non-integer target fails before mutation. The human-readable workspace label may remain longer and descriptive; it is not the Herdr agent name.

Before launch, deadloop checks live names. An exact duplicate live name, a generated name that does not satisfy the grammar, or a name collision with a different durable attempt record stops before `agent start`. Deadloop does not retire or replace a same-name agent as part of launch.

## Durable attempt record

A launch has an atomic record in its run directory before the first external mutation. It is bound to at least:

- attempt ID and launch UUID;
- project, canonical repository, and role;
- Issue or PR number;
- branch, base branch when relevant, and input revision;
- intended canonical worktree path or branch identity;
- generated Herdr agent name and human-readable workspace label;
- prompt and unique promise paths;
- lifecycle phase.

After Herdr returns, the record is atomically enriched with the exact workspace, tab, root pane, and canonical worktree path. After successful output validation, it records the output revision when applicable.

Phases progress monotonically through the applicable subset of:

1. `prepared`;
2. `github_claimed`;
3. `workspace_opened`;
4. `agent_started`;
5. `report_received`;
6. `github_persisted`;
7. `workspace_closed`;
8. `abandoned` (only through the explicit guarded launch-failure recovery operation).

A launch error records `launch_failed` together with the last successful phase and available ownership evidence. `launch_failed` alone is inconclusive and is not permission to close an attributed workspace or replay a GitHub claim. A Worker or reviewer attempt may move from `launch_failed` to `abandoned` only after `/deadloop-abandon-attempt` proves the unchanged target and revision, a clean retained worktree, one exact one-tab/one-pane owned workspace, no competing attempt, and no agent in the recorded pane or launch-unique name; closes only that workspace; and confirms the linked worktree remains. The record retains the original launch error and adds timestamped abandonment evidence before the target is requeued. Immediately before the close, the operation atomically writes a launch-bound `workspace_close_started` receipt beside the original journal. If the operation stops after closing the workspace but before recording abandonment, an idempotent retry may continue only when that receipt matches and the recorded workspace and every workspace for the same checkout are absent while the linked worktree remains. A requeued Worker creates a new attempt which opens that exact retained checkout in a fresh workspace; it does not create another linked worktree.

Atomic writes must survive a process stop without turning a partial JSON file into an empty attempt. Crash/fault handling is required after the claim, worktree response, record enrichment, and agent-start boundaries.

## Pre-open reconciliation and exclusivity

Herdr 0.7.5 deduplicates `worktree open` by canonical checkout path and may return an already-open workspace. A retained blocked or ambiguous attempt therefore prevents a fresh attempt for that checkout.

Before `worktree create` or `worktree open`, deadloop:

1. lists worktrees/workspaces and resolves canonical checkout ownership;
2. reconciles a matching prior attempt when completion can be proven;
3. refuses the new attempt if any matching workspace remains open.

For an existing checkout, deadloop calls `worktree open` without `--label`, so an already-open workspace cannot be relabelled as a side effect. It requires the response to prove that a new workspace was opened (`already_open` must not be true), then applies the intended workspace label through a separate rename operation. A response indicating reuse, a race that opens the same checkout elsewhere, or missing reuse metadata stops before agent start.

A blocked or ambiguous retained attempt suppresses retries and chained attempts on the same checkout until a human resolves it or deterministic reconciliation can close it.

## Launch contract

A launch follows this sequence:

1. Pass the global Herdr compatibility preflight.
2. Write the `prepared` attempt record.
3. Perform the role's existing GitHub claim and record `github_claimed`.
4. Complete pre-open reconciliation and exclusivity checks.
5. Create the linked worktree for the first attempt, or open the existing linked worktree without a label for a later attempt.
6. For `worktree create`, require a `worktree_created` response containing the exact workspace ID, worktree path, tab ID, and root pane ID. For `worktree open`, require a `worktree_opened` response containing those identities and explicit `already_open: false`.
7. Verify that the root pane belongs to the returned workspace and canonical worktree path; atomically record `workspace_opened`.
8. Rename the newly opened workspace to its descriptive label.
9. Start the configured agent using exactly:

```text
herdr agent start <name> --kind <kind> --pane <root-pane> -- <native-agent-args...>
```

`<native-agent-args>` excludes the executable selected by `--kind`. The configured agent profile still owns model, effort, identity, permission, and prompt arguments.

Deadloop records `agent_started` only after Herdr confirms the expected agent in the same root pane. It does not create a tab, split a pane, target another workspace, or guess a missing pane ID.

An invalid or inconsistent response records `launch_failed` and stops without cleanup guesses.

## Role-specific completion proof

The following table defines the minimum GitHub re-read required before workspace closure. Every `blocked` report remains open even when a blocker comment or label was persisted.

| Role and terminal result | Input revision | Output revision | Required GitHub persistence and confirmation | Close workspace? |
| --- | --- | --- | --- | --- |
| Worker `complete` | trusted base SHA at branch creation | validated worktree HEAD pushed to the selected branch | One open PR has the recorded head branch and output SHA, targets the configured base, contains the Issue closing reference and attempt marker, has `agent:review`, and the Issue is no longer claimable | Yes |
| Worker `blocked` or invalid | trusted base SHA | none or untrusted | A blocker comment/label may be written, but is not completion persistence for cleanup | No |
| Reviewer `approved` | exact PR head | unchanged | PR head still equals input; the head-bound review-result marker records `approved`; review ownership labels match the approved next-state policy | Yes |
| Reviewer `changes_requested` | exact PR head | unchanged | PR head still equals input; the head-bound review comment contains all structured findings and the bounded repair-attempt marker; labels match repair-in-progress policy | Yes, before repair opens a new workspace |
| Reviewer `human_required` or `blocked` | exact PR head | unchanged | Human guidance may be persisted, but the workspace remains evidence | No |
| Review repair `repair_pushed` | exact PR head before repair | new validated commit | Current PR head equals the recorded output SHA and differs from input; the repair-result marker records both SHAs and validation result | Yes |
| Review repair `stale_head` | exact PR head before repair | current remote PR head | Current PR head differs from input; no repair push or success claim is made | Yes |
| Review repair `blocked` or invalid | exact PR head before repair | none or untrusted | Recovery guidance may be persisted, but the workspace remains evidence | No |
| Branch update `branch_update_pushed` | exact PR head and base head | new validated commit | Current PR head equals output, differs from input, and the branch-update result marker records input head, base head, output head, and validation result | Yes |
| Branch update `stale_head` | exact PR head and selected base head | current remote PR head | Current PR head differs from the input PR head; no update push or success claim is made. An advanced base alone is not stale for this attempt | Yes |
| Branch update `blocked` or invalid | exact PR head and base head | none or untrusted | Recovery guidance may be persisted, but the workspace remains evidence | No |

Markers are deterministic hidden metadata attached to the human-readable PR/Issue comment or PR body. They include the attempt ID, role, input revision, terminal outcome, and output revision when one exists. They support idempotent confirmation but do not replace readable comments.

## Successful attempt closure

After the table's terminal proof succeeds, deadloop:

1. atomically records `github_persisted`;
2. invokes a distinct runner operation `closeWorkspace(workspaceId)`, backed only by `herdr workspace close`;
3. never invokes `worktree remove` as attempt cleanup;
4. re-reads Herdr to confirm the workspace is absent;
5. re-reads Git to confirm the linked worktree path and expected branch still exist;
6. records `workspace_closed`.

Workspace closure is cleanup only. A timeout, protocol error, ambiguous response, or failed postcondition leaves the attempt at `github_persisted` with cleanup pending. It must not repeat a push, PR creation, comment, label transition, review, or merge.

## Blocked or inconclusive attempts

The attempt workspace remains open when any of these is true:

- the completion report is `blocked` or reviewer outcome is `human_required`;
- the promise is absent, malformed, stale, reused, or bound to another run directory;
- configured checks fail;
- required GitHub persistence fails or cannot be confirmed;
- the runner response or workspace ownership is ambiguous;
- agent launch fails after a workspace may have been created.

The retained workspace is evidence. Herdr agent status alone cannot authorize closure, push, label changes, review persistence, or merge.

## Chained attempts

Worker, reviewer, review repair, and branch update never share a Herdr workspace, pane, PTY, shell, or native agent session.

After the earlier attempt reaches `workspace_closed`, the later attempt opens the same linked worktree in a newly created workspace. It must receive different workspace and root pane IDs while resolving to the same canonical worktree and branch.

There is no fast-path exception for immediately chained attempts. A retained prior workspace blocks the later launch.

## PR completion

When a PR is merged or closed, the existing safe worktree cleanup rules continue to apply. Removing an attempt workspace and removing a linked Git worktree are distinct operations.

`worktree remove` remains reserved for the merged/closed-PR cleanup decision and retains all existing dirty-worktree and closed-unmerged-head protections.

## Restart reconciliation

On automation-host startup, and before another launch for the same checkout, deadloop reconciles retained attempt workspaces.

It may close one only when all of these are proven:

- workspace identity matches the durable attempt record;
- the launch-unique promise is terminal and passes role/revision binding;
- the role-specific table confirms the current GitHub result;
- the outcome permits closure;
- no newer live attempt owns the workspace;
- `closeWorkspace` cannot remove the linked worktree.

If GitHub persistence succeeded but the host stopped before recording `github_persisted`, reconciliation may advance the record only through the same table predicate. If proof is unavailable, it leaves the workspace unchanged.

Reconciliation is idempotent. A missing workspace after `github_persisted` is treated as already closed only after confirming the linked worktree still exists. Workflow side effects are never replayed for cleanup.

## Doctor behavior

`/deadloop-doctor` remains read-only.

For each retained attempt workspace, it reports one of:

- active attempt;
- intentionally retained blocker or human-required outcome;
- missing or malformed completion report;
- GitHub persistence not confirmed;
- launch failed after partial mutation;
- cleanup pending after confirmed persistence;
- ownership mismatch;
- unsupported or protocol-incompatible Herdr client/server.

Doctor may print deterministic recovery guidance or identify the next reconciliation cycle. It does not close panes, workspaces, or worktrees. For a safely classifiable launch-failed Worker or reviewer attempt it may print `/deadloop-abandon-attempt <attempt-id>`; if any prerequisite cannot be proven it prints manual-review guidance and no label-only recovery command.

## User-visible acceptance scenarios

Required public scenarios:

1. A Worker is visible as one active workspace containing one tab and one pane.
2. After the Worker creates and persists its PR, no Worker workspace remains visible while the linked worktree still exists.
3. A reviewer opens the same worktree in a newly created workspace.
4. A review repair opens another fresh workspace rather than inheriting the reviewer terminal.
5. A blocked or human-required attempt remains visible with its worktree intact.
6. A missing or malformed promise leaves the workspace intact.
7. GitHub persistence failure leaves the workspace intact.
8. A retained blocked or ambiguous workspace suppresses a new attempt and is not relabelled.
9. Restart reconciliation closes a conclusively persisted successful workspace.
10. Restart reconciliation preserves an ambiguous workspace.
11. An unsupported client, server, prerelease, or protocol mismatch prevents a launch before external side effects.
12. PR completion removes the worktree only through the existing safe cleanup gate.

Scenarios use the repository's Japanese Cucumber vocabulary and avoid exposing Herdr IDs, promise paths, hidden markers, hashes, or internal lifecycle enum names as public product language.

## Deterministic test requirements

Tests cover:

- client and server stable SemVer comparison, malformed output, prereleases, build metadata, and protocol mismatch;
- version rejection before GitHub claim, worktree, workspace, or agent mutations;
- agent-name grammar, the 32-character boundary, maximum and over-width target numbers, invalid project-derived text isolation, deterministic hashing, collision refusal, and duplicate live names;
- pre-launch record creation and atomic monotonic transitions;
- fault injection after GitHub claim, worktree response, record enrichment, and agent start;
- accepting only `worktree_created` for create and `worktree_opened` for open, rejecting missing or wrong response discriminators;
- parsing workspace, tab, root pane, and canonical path from `worktree_created`, and additionally parsing explicit `already_open: false` from `worktree_opened`;
- refusal when identities disagree or an existing workspace owns the checkout;
- omission of `--label` from an existing-worktree open call and no relabelling on reuse refusal;
- exact Herdr 0.7.5 agent-start argv, including positional name, kind, pane, and native args without executable;
- no `tab create` or `pane split` during launch;
- every row of the role-specific completion table, including the rule that all blocked reports remain open;
- unconditional preservation of every legacy three-field promise during migration;
- `closeWorkspace` using only `herdr workspace close`;
- successful GitHub persistence before workspace closure;
- post-closure proof that the workspace is absent and worktree remains;
- cleanup-pending behavior after close timeout or ambiguous response, without workflow replay;
- fresh workspace and pane IDs for chained attempts using the same worktree;
- idempotent restart reconciliation;
- doctor findings for every retained-workspace reason;
- preservation of existing dirty-worktree and closed-unmerged-branch safety rules.

Each test case follows the repository rule of at most one assertion or expectation.

## Documentation change boundary

The implementation updates all instructions that currently describe dedicated reviewer tabs, `tab create`, done-agent replacement, or tab reuse, including:

- `docs/herdr-runner.md`;
- the reviewer lifecycle section of `docs/qa2-runtime-lifecycle-spec.md`, marking it superseded rather than silently contradictory;
- `extensions/deadloop/README.md`;
- automation prompts and recovery comments;
- the runner and launcher ADRs or a new lifecycle ADR.

Project-check isolation and safe worktree removal documentation remain unchanged except for cross-references.

## Migration and rollout

The migration does not change Herdr while deadloop agents are active.

Recommended deployment order:

1. finish or intentionally block all current attempts;
2. stop new deadloop launches;
3. land and install the deadloop implementation targeting Herdr 0.7.5;
4. run `herdr update --handoff`;
5. restart or reload the automation host;
6. run `/deadloop-doctor` and one non-merging smoke Issue;
7. resume normal automation only after the smoke attempt closes its workspace and retains its worktree as specified.

Existing completed workspaces backed by a valid, bound V1 completion report may be reclaimed only when reconciliation proves their role-specific completion persistence. Every workspace backed by a legacy three-field promise remains preserved for manual inspection and is never automatically reclaimed. Other ambiguous historical workspaces also remain for manual inspection.

## Out of scope

- adding a headless workspace or non-terminal process to Herdr;
- patching or forking Herdr;
- supporting Herdr 0.7.3 and 0.7.5 simultaneously;
- reusing a shell, PTY, agent process, native agent session, tab, or workspace across attempts;
- running two agents concurrently in the same worktree;
- changing candidate selection, review policy, repair limits, push policy, or merge policy;
- weakening promise completion authority;
- changing safe conditions for linked-worktree removal;
- making `/deadloop-doctor` destructive.

## Source references

- [Herdr v0.7.5 release](https://github.com/ogulcancelik/herdr/releases/tag/v0.7.5)
- [Herdr agent automation](https://herdr.dev/docs/agent-automation/)
- [Herdr socket API](https://herdr.dev/docs/socket-api/)
