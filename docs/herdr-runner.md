# Herdr runner

deadloop v0 uses stable Herdr 0.8.0 or newer as its default runner.

## Version gate

The Automation host checks Herdr at startup and before every tick, before candidate selection or any side effect.

The gate requires exact stable client and server versions of 0.8.0 or newer. It rejects prereleases, malformed output, older versions, and an unreachable server.

A supported local client with an unreachable server has one recovery-only exception: reconciliation may replace an existing `agent:in-progress` state with `agent:blocked` and a readable explanation. This exception cannot select work or launch, comment on completion, push, ready, or merge. All other mutations require the version gate. `/deadloop-doctor` reports the same condition without changing Herdr. Quiet active automations before running `herdr update --handoff`.

## Attempt workspace lifecycle

A Git worktree is durable branch state. A Herdr attempt workspace is disposable runtime state.

Worker, reviewer, review-repair, and branch-update launches all follow the same contract:

1. Write an atomic `prepared` attempt journal in the launch-unique run directory before an external mutation.
2. Persist the role's GitHub claim.
3. If the host stops between those non-atomic writes, re-read the exact target, revision, configured labels, and role marker where applicable. Advance a still-`prepared` journal only when that exact claim is present; otherwise retain it and block scheduling for operator reconciliation. This check does not require a workspace ID.
4. Reconcile retained workspaces and refuse a launch while the checkout is already open or ownership is ambiguous.
5. Create the first linked worktree, or open an existing linked worktree without `--label`.
6. Require Herdr's response to identify one new workspace, its first tab, root pane, and canonical worktree path. An open response must explicitly report `already_open: false`.
7. Rename only that confirmed fresh workspace.
8. Start the configured agent directly in the root pane:

   ```text
   herdr agent start <name> --kind <kind> --pane <root-pane> -- <native-agent-args...>
   ```

No launch creates another tab, splits a pane, uses `agent start --tab`, retires a same-name completed agent, or reuses a terminal. Internal agent names are launch-unique and follow `dl-<role>-<target>-<hash12>`.

A newly opened workspace can return before its root shell reaches an interactive prompt. When `agent start` returns the exact structured Herdr error code `agent_pane_busy`, the runner retries the identical name, pane, kind, and native arguments every 100 ms within a 5-second monotonic grace period. Herdr reports this code before starting an agent, so this narrow retry cannot duplicate a successful launch. Each `agent start` process also has a 35-second wrapper timeout. Any killed, untyped, malformed, different, or persistent error fails closed and retains the attempt workspace.

## Completion and cleanup

A promise file is transport, not cleanup authority. Only a strong V1 report bound to the attempt journal can proceed to role-specific GitHub confirmation.

- Worker: the exact pushed head, open PR, base, closing reference, review label, attempt marker, and non-claimable Issue must agree.
- Reviewer: the exact reviewed head, structured result comment, attempt marker, findings/repair marker when applicable, and expected labels must agree.
- Review repair: the pushed or stale head and finalizer/result evidence must agree.
- Branch update: the pushed or PR-head-stale result must agree. A base advance alone is not stale.

After confirmation, deadloop records `github_persisted`, runs only `herdr workspace close`, confirms the workspace is absent, confirms the linked worktree and branch remain, and records `workspace_closed`. A close timeout or ambiguous result remains cleanup pending and never replays a push, PR creation, comment, label transition, review, or merge.

A Worker completion stop caused by unresolved required verification may close its workspace only after re-reading GitHub and proving that the Issue is open, has `agent:blocked`, has neither `agent:implement` nor `agent:in-progress`, and contains the target-specific fingerprint comment for the exact fixed completion-time verification diagnosis. The host then records `github_persisted` before closing the workspace and retains the linked worktree and branch.

Blocked, malformed, missing, launch-failed, and ownership-ambiguous attempts remain visible. GitHub `agent:in-progress` is reconciled with its bound claim and runtime owner before candidate selection. Expired or unverifiable ownership is made visible as `agent:blocked`; a safely owned stopped workspace may be closed while its linked worktree, report, logs, and journal remain as evidence. Ambiguous ownership is preserved. Restart reconciliation is idempotent, and a local journal without matching GitHub work authority does not suppress a later GitHub request.

A launch-failed Worker or reviewer attempt can be explicitly abandoned only through `/deadloop-abandon-attempt <attempt-id>`, and only when doctor and the operation can independently prove the unchanged GitHub claim and revision, a clean retained worktree, one exact one-tab/one-pane attempt workspace, no other owning attempt, and no agent in the recorded pane or launch-unique name. The guarded operation closes only that workspace, records `abandoned` evidence without discarding the launch error, confirms the linked worktree remains, and then requeues the target. Immediately before closing, it writes a bound `workspace_close_started` receipt beside the original journal. If a previous invocation stopped after the close, a retry may continue only when that receipt matches and both the recorded workspace and any workspace for the same checkout are absent. Missing or changed evidence stops with manual-review guidance and no label-only recovery command. A requeued Worker starts a new attempt by opening the exact retained abandoned checkout in a fresh workspace; it never tries to create a duplicate linked worktree.

Workspace closure never invokes worktree removal. After the workspace is closed, linked-worktree removal remains restricted to the merged/closed-PR safety gate, including dirty-worktree and closed-unmerged-head protection. The runner verifies one exact closed path/branch identity and uses `git worktree remove <path>` without fabricating a workspace ID.

## Runner boundary

Herdr-specific operations remain runner concerns. The runner seam is `src/runner.ts`; the selected adapter is `src/herdr-runner.ts`. GitHub Issue/PR workflow meaning stays outside the runner so a future runtime can replace Herdr without changing candidate, review, push, or merge policy.

The Pi + Herdr support path runs the Automation host and Workers as the same operating-system user. Its deterministic gates protect against fallible-agent output, stale evidence, and mutation races, but Herdr does not provide a filesystem sandbox that contains an actively hostile same-user Worker. See [ADR 0015](adr/0015-worker-trust-boundary.md) for the supported trust boundary.
