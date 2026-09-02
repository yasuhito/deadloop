# Herdr runner

deadloop v0 uses stable Herdr 0.8.0 or newer as its default runner.

## Host state layout

All persistent host state lives under `STATE_DIR` (default: `~/.pi/agent/deadloop/`):

| Path | Purpose |
|---|---|
| `enabled-projects.json` | Enabled projects. Every write records a `lastWriterCodeIdentity` SHA; a schema-invalid file fails closed and stops the host until it is moved aside and `/deadloop-enable` runs again |
| `projects.json` | Local project configuration including role models and automations. Local only, never committed |
| `state.json` | Scheduler tick bookkeeping: per-automation `lastScheduledAt`, `lastResult`, `lastDriverAction`, etc. |
| `runs/<attempt-id>/` | Per-attempt journal: `attempt.json`, prompt, promise file, review history, close receipts |
| `code-snapshots/<sha>/` | Code snapshots bound to specific commits. Doctor reports generations tied to no active identity as manual cleanup candidates |
| `disable-generation.json` | Generation counter incremented by every `/deadloop-disable` |

Uncommitted edits inside the loaded deadloop checkout do not trip the code-identity gate (HEAD-based), but they are live for driver execution because drivers resolve from the same tree.

## Version gate

The Automation host checks Herdr at startup and before every tick, before candidate selection or any side effect.

The gate requires exact stable client and server versions of 0.8.0 or newer. It rejects prereleases, malformed output, older versions, and an unreachable server.

A supported local client with an unreachable server has one recovery-only exception: reconciliation may replace an existing `agent:in-progress` state with `agent:blocked` and a readable explanation. This exception cannot select work or launch, comment on completion, push, ready, or merge. All other mutations require the version gate. `/deadloop-doctor` reports the same condition without changing Herdr. Quiet active automations before running `herdr update --handoff`.

## Attempt workspace lifecycle

A Git worktree is durable branch state. A Herdr attempt workspace is disposable runtime state.

Every role writes an atomic `prepared` attempt journal before its first external mutation, but its GitHub transition is role-specific:

- An explorer or Worker binds its journal to the selected immutable Issue request event, deletes only that request label, and verifies the resulting timeline before adding `agent:in-progress`. A missing label cancels launch; a newer generation remains queued; an ambiguous deletion creates a visible stop. Only proven consumption permits `github_claimed`.
- A reviewer or branch-update launch records the selected PR request event, adds `agent:in-progress`, normalizes baseline managed labels individually, and deletes the selected request last. Only a documented HTTP 200 response plus complete postvalidation permits `github_claimed`. A crash before that phase advance retains `prepared` and blocks reconciliation because restart cannot prove the 200 response.
- Review repair launches from a bound reviewer outcome; it does not consume a PR request label.

After that role-specific transition, every launch follows the same workspace contract:

1. Reconcile retained workspaces: close one a released attempt journal proves stale, and refuse the launch while the execution runtime reports the checkout's agent still present or cannot say. When no canonical checkout exists at all, a pull-request launch prepares it deterministically — fetch, require the exact recorded head, refuse to move a diverged local branch — and creates the checkout through Herdr.
2. Create the first linked worktree, or open an existing linked worktree without `--label`.
3. Require Herdr's response to identify one new workspace, its first tab, root pane, and canonical worktree path. An open response must explicitly report `already_open: false`.
4. Rename only that confirmed fresh workspace.
5. Start the configured agent directly in the root pane:

   ```text
   herdr agent start <name> --kind <kind> --pane <root-pane> -- <native-agent-args...>
   ```

No launch creates another tab, splits a pane, uses `agent start --tab`, retires a same-name completed agent, or reuses a terminal. Internal agent names are launch-unique and follow `dl-<role>-<target>-<hash12>`.

A newly opened workspace can return before its root shell reaches an interactive prompt. When `agent start` returns the exact structured Herdr error code `agent_pane_busy`, the runner retries the identical name, pane, kind, and native arguments every 100 ms within a 5-second monotonic grace period. Herdr reports this code before starting an agent, so this narrow retry cannot duplicate a successful launch. Each `agent start` process also has a 35-second wrapper timeout. Any killed, untyped, malformed, different, or persistent error fails closed and retains the attempt workspace.

## Completion and cleanup

A promise file is transport, not cleanup authority. Only a strong V1 report bound to the attempt journal can proceed to role-specific GitHub confirmation.

- Worker: the exact pushed head, open PR, base, closing reference, review label, and attempt marker must agree. A retry that re-presents the existing result (output revision equal to the input revision) completes on that same proof when GitHub already holds it, and stops once with a reasoned `agent:blocked` stop when it does not. Issue request labels are not completion evidence; a request added while the Worker runs remains queued for a later attempt.
- Reviewer: requested changes or a required human decision may persist without successful required verification. Approval additionally requires the attempt-fixed contract's host-recorded success for the exact reviewed head; the structured result comment, attempt marker, findings/repair marker when applicable, and expected labels must agree.
- Review repair: the pushed or stale head and finalizer/result evidence must agree.
- Branch update: the pushed or PR-head-stale result must agree. A base advance alone is not stale.

After confirmation, deadloop records `github_persisted`, runs only `herdr workspace close`, confirms the workspace is absent, confirms the linked worktree and branch remain, and records `workspace_closed`. An older retained attempt for the same worktree blocks closure only while its recorded workspace is still listed by the execution runtime; an absent old workspace cannot strand the current attempt. A close timeout or ambiguous result remains cleanup pending, reports the closure result instead of an earlier successful label transition, and never replays a push, PR creation, comment, label transition, review, or merge.

Settlement without an in-flight completion report closes the workspace too (#395). When a retained monitor handoff settles — its journal already released the attempt, or its monitored pull request closed — the host closes the attempt's still-open workspace with the same ownership proof the completion chain uses. The closure records its bounded outcome beside the journal (`settled-workspace-cleanup.json`); a failed close also records its reason in the host activity log. For an `authority_released` journal that still owns an open workspace, the host's journal reconciliation attempts that closure exactly once — the receipt is the once-only marker, and the patrol records that receipt itself when the closure command errors before writing one, so a failure is never retried on the next tick. Every non-closing outcome is published to the host activity log as `settled_workspace_closure`. A `github_persisted` journal stays owned by the completion chain, which retries its closure on every tick until the workspace is absent. In both cases `/deadloop-doctor` presents the closure command on the `cleanup_pending` finding after a failed attempt.

A Worker completion stop caused by unresolved required verification may close its workspace only after re-reading GitHub and proving that the Issue is open, has `agent:blocked`, has neither `agent:implement` nor `agent:in-progress`, and contains the target-specific fingerprint comment for the exact fixed completion-time verification diagnosis. The host then records `github_persisted` before closing the workspace and retains the linked worktree and branch.

Blocked, malformed, missing, launch-failed, and runtime-ambiguous attempts remain visible. GitHub `agent:in-progress` is reconciled with the attempt journal and execution runtime before candidate selection. The runtime alone answers liveness; an unreachable, stopped, or ambiguous attempt becomes visible as `agent:blocked`. A launch that fails before its agent starts removes exactly the workspace, worktree, and branch it created before its journal records `launch_failed`; a launch whose start command already ran, and everything the launch did not create, is preserved. A launch-failed journal is never evidence that blocks a newer Agent request: when a request event is newer than the recorded failure, reconciliation releases the failed claim, closes what the runtime proves stopped, and explains each distinct failure set once with a fingerprinted comment. Issue implementation Workers, explorers, PR reviewers, review-repair workers, and branch-update attempts are monitored deterministically from the exact runtime turn, bound report, active-work accounting, and configured limit. These roles never send an Automation-host monitor prompt. A terminal turn without a valid completion report enters the recognized model-availability wait or the existing safe stop; a runtime-reported working turn remains active through quiet output until its active-work limit. The first wait or stop posts one explanation. A safely identified stopped workspace may be closed while its linked worktree, report, logs, and journal remain as evidence. Restart reconciliation is idempotent, and a local journal does not grant permission to suppress a later GitHub request.

A launch-failed Worker or reviewer attempt can be explicitly abandoned only through `/deadloop-abandon-attempt <attempt-id>`, and only when doctor and the operation can independently prove the unchanged GitHub target and revision, a clean retained worktree, one exact one-tab/one-pane attempt workspace, no other owning attempt, and no agent in the recorded pane or launch-unique name. The guarded operation closes only that workspace, records `abandoned` evidence without discarding the launch error, confirms the linked worktree remains, and then requeues the target. Immediately before closing, it writes a bound `workspace_close_started` receipt beside the original journal. If a previous invocation stopped after the close, a retry may continue only when that receipt matches and both the recorded workspace and any workspace for the same checkout are absent. Missing or changed evidence stops with manual-review guidance, and doctor names the retreat or removal commands for whatever the failed launch left behind. A requeued Worker starts a new attempt by opening the exact retained abandoned checkout in a fresh workspace; when no stopped-journal checkout exists and a same-name branch or worktree is left behind, the launcher picks the next free suffixed branch name instead of failing against the leftover; it never tries to create a duplicate linked worktree.

Workspace closure never invokes worktree removal. After the workspace is closed, linked-worktree removal remains restricted to the merged/closed-PR safety gate, including dirty-worktree and closed-unmerged-head protection. The runner verifies one exact closed path/branch identity and uses `git worktree remove <path>` without fabricating a workspace ID.

## Runner boundary

Herdr-specific operations remain runner concerns. The runner seam is `src/runner.ts`; the selected adapter is `src/herdr-runner.cts`. GitHub Issue/PR workflow meaning stays outside the runner so a future runtime can replace Herdr without changing candidate, review, push, or merge policy.

The Pi + Herdr support path runs the Automation host and Workers as the same operating-system user. Its deterministic gates protect against fallible-agent output, stale evidence, and mutation races, but Herdr does not provide a filesystem sandbox that contains an actively hostile same-user Worker. See [ADR 0015](adr/0015-worker-trust-boundary.md) for the supported trust boundary.
