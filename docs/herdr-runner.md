# Herdr runner

deadloop v0 uses stable Herdr 0.7.5 or newer as its default runner.

## Compatibility gate

The automation host runs a global compatibility preflight at startup and before every scheduler tick. It completes before candidate selection and before any claim, label, comment, worktree, workspace, or agent mutation.

The gate requires:

- exact `herdr <semver>` client output;
- exact stable client and server versions at least 0.7.5;
- `compatible: yes` from `herdr status server`;
- no `protocol_mismatch`.

Prereleases, malformed output, an unreachable server, and protocol mismatches fail closed. `/deadloop-doctor` reports the same condition without changing Herdr. Quiet active automations before running `herdr update --handoff`.

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

Blocked, human-required, legacy, malformed, missing, launch-failed, and ownership-ambiguous attempts remain visible. A retained attempt suppresses another attempt on the same checkout. Restart reconciliation may close only an already-proven successful V1 attempt and is idempotent.

Workspace closure never invokes worktree removal. After the workspace is closed, linked-worktree removal remains restricted to the merged/closed-PR safety gate, including dirty-worktree and closed-unmerged-head protection. Because Herdr 0.7.5 accepts only an open workspace ID for `worktree remove`, the runner verifies one exact closed path/branch identity and uses `git worktree remove <path>` without fabricating a workspace ID.

## Runner boundary

Herdr-specific operations remain runner concerns. The runner seam is `src/runner.ts`; the selected adapter is `src/herdr-runner.ts`. GitHub Issue/PR workflow meaning stays outside the runner so a future runtime can replace Herdr without changing candidate, review, push, or merge policy.
