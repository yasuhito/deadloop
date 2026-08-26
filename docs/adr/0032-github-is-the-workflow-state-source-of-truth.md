# ADR 0032: GitHub is the source of truth for workflow state

## Status

Accepted. Supersedes the workflow-state role of local attempt journals and of the `agent:reviewing` label, and unifies [ADR 0018](0018-github-agent-requests-recover-runtime-failures.md), [ADR 0020](0020-stop-proving-work-authority.md), and [ADR 0026](0026-consume-agent-requests-with-targeted-label-transitions.md) under one contract.

## Context

Deadloop treated GitHub labels and the local attempt journal as two parallel workflow-state stores. A finished or retained attempt could keep ownership that GitHub no longer expressed: removing `agent:review` from an Issue or PR while a `report_received` journal remained left candidate selection reporting `reviewer_working` and waiting in silence. The stopped reason was invisible on GitHub, label changes alone could not recover #227, #228, #229, or #236, and no single place said which store decided what.

Matt Pocock's Sandcastle dogfood workflows (see `docs/research/matt-pocock-sandcastle-github-state-model.md`) show that request labels consumed once as GitHub events, `agent:in-progress`, `agent:blocked`, and re-adding a request label to retry are enough to run the whole loop with GitHub as the only observable state. Deadloop adopts that model while keeping its own mutation safety.

## Decision

**Workflow state lives on GitHub.** The Issue / PR state, head revision, labels, comments, and checks are the only workflow state. Local resources — the attempt journal, Herdr workspaces and agents, promises, verification records — are evidence for safe execution, monitoring, and recovery. None of them may silently suppress a live GitHub Agent request, and none may create workflow state that GitHub does not show. An old internal resource is closed safely when it can be; if it cannot be proven safe to close, deadloop leaves the request unconsumed and reflects `agent:blocked` on GitHub with a readable reason and recovery step instead of waiting on internal reasons alone.

**Agent requests are one-shot events.** The request labels are `agent:explore`, `agent:implement`, `agent:review`, and `agent:update-branch`. Each labeled timeline event is one request generation; consumption removes exactly that label after recording the attempt, identified by its immutable event id. Request labels never mean "working" or "owned". Re-adding the same label is the only retry path. Current-state labels are `agent:in-progress` and `agent:blocked`; a blocked target holds no request that predates the block, while a request added later waits. `agent:reviewing` is retired: new writers never add it, and reconciliation treats any surviving occurrence as stale current state to reconcile, not as a request.

The triage set matches Sandcastle (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). `ready-for-agent` is optional triage metadata, never a launch condition. `ready-for-human` marks an Issue that needs human implementation; a PR handed to people becomes ready with no agent workflow label and never carries `ready-for-human`.

**Claims are resolved through the GitHub timeline, not comments.** On one host machine, a repository-ID-scoped OS file lock serializes repository service for the host's whole lifetime, including reconciliation and finalization, so a second local host fails fast. Across machines or identities, every authorized Automation host derives ownership the same way from the same public timeline: an `agent:in-progress` addition authored by any identity listed in the project's authorized automation logins owns the requests it consumed, ordered by GitHub's server-side event order, with exploration outranking implementation at the same boundary. Hosts whose derived owner differs make no mutation. Deadloop posts no claim comment, trusts no hidden marker, and uses no server-time expiry arithmetic; this replaces the comment-marker claim model that earlier tickets tried and removed.

**Reconciliation is stale-proof.** At startup and on every tick, the reconciler compares GitHub's `agent:in-progress` against claims derived from the timeline and liveness reported by the execution runtime alone. A valid claim with a live owner stays untouched; a missing or expired claim with no safe owner becomes a visible `agent:blocked` with a reason and a new-request recovery step; unreachable runtime evidence fails closed. The reconciler never returns an internal-only `no_candidate` or `reviewer_working` that hides a live request, and an attempt that lost its GitHub side performs no GitHub writes even if its workspace still runs.

A claim ends by completion, supersession, stop, or timeout. Expiry is not a silent takeover: a timed-out or failed attempt lands on `agent:blocked` without a queued request, and resuming always requires someone to add a fresh role-appropriate request label.

**Sandcastle compatibility is intentional but bounded.** Shared with Sandcastle: the label vocabulary, one-shot request events consumed by removal, `agent:in-progress` / `agent:blocked`, retry by re-adding a request, per-target serialization, and draft-to-ready human handoff with no leftover agent labels. Deliberately different, preserving deadloop safety:

1. **No force push.** Sandcastle's implementation pushes new branches with force and updates existing ones with a head-SHA lease; deadloop keeps exact-head non-force pushes, and the only lease variant permitted is the expected-object-ID fast-forward lease already defined for repair and branch update.
2. **Required verification.** Sandcastle trusts the agent run; deadloop requires a host-recorded successful required-verification result bound to the exact output revision before push, human handoff, or merge consideration.
3. **Stale reconciliation.** Sandcastle relies on CI concurrency groups; deadloop additionally reconciles GitHub state against claims and execution-runtime liveness every tick, so a crashed host or a stale journal cannot strand a live request.
4. **Distributed claims.** Sandcastle runs inside one GitHub Actions environment; deadloop supports several hosts and identities serving one repository by deriving the same owner from the same timeline, with a local OS lock as the single-host guard.

## Consequences

- Recovery is a GitHub operation: adding a request label restarts work, `/deadloop-doctor` prints that command instead of local ones, and #227, #228, #229, and #236 become reviewable or updatable from their GitHub state after migration.
- The journal shrinks to an evidence ledger for monitoring and recovery; selection reads requests from GitHub only.
- Two machines can safely share one repository because ownership is a pure function of the public timeline plus configured identities.
- Every failure mode still fails closed: ambiguous consumption, unreachable runtime, expired claims, and changed targets stop with visible reasons rather than guessing.
