# ADR 0020: Stop proving work authority; guard the mutation and exclude locally

## Status

Accepted. Supersedes [ADR 0019](0019-work-authority-release-for-a-new-agent-request.md).

## Context

Deadloop decides which attempt may work on a pull request by reconciling five independently moving observations: the GitHub Agent request timeline, a claim marker written into a pull-request comment, the local attempt journal, the execution runtime's report of the attempt, and the pull request's head commit. Authority is a derived value, recomputed on every pass, and every unprovable combination fails closed.

Deriving ownership from independent observations makes the state space their product. `src/pr-work-authority-reconciliation.ts` types seven claim observations and four runtime observations, and turns them into eight block reasons; the repository as a whole carries 62 distinct `reason` codes. Each unvisited cell of that product is one defect, and closing it does not shrink the product.

Thirteen stop defects from the last sixty days were classified by which observations disagreed. Nine broke on two or more axes at once; only four were explainable by a single axis. Of the nine, four — [#286](https://github.com/yasuhito/deadloop/issues/286), [#283](https://github.com/yasuhito/deadloop/issues/283), [#281](https://github.com/yasuhito/deadloop/issues/281), [#279](https://github.com/yasuhito/deadloop/issues/279) — record the same pull request, #227, as their reproduction. One model was exposed four times. The four single-axis defects were each fixed once and have not recurred.

#286 is the clearest shape: a writing role succeeds by moving the head its claim recorded, so its own success makes its claim's revision stale and the reconciler stops the pull request before the completion handler runs. Authority and revision currency were bound to one key.

Two comparable systems were read as primary sources.

OpenAI Symphony names one authority and it is not the tracker. Its specification requires a "single authoritative orchestrator state for dispatch, retries, and reconciliation", describes that state as "single authoritative in-memory state owned by the orchestrator", and requires that the orchestrator "serializes state mutations through one authority to avoid duplicate dispatch". Its GitHub adapter exposes only `fetch_issues_by_states` and `fetch_issues_by_ids` to the control plane; the only writes are a generic REST tool handed to the coding agent. Symphony discards ownership on restart by design: recovery is "tracker-driven and filesystem-driven (without a durable orchestrator DB)" and "exact in-memory scheduler state is not restored".

Sandcastle has no tracker. One process's scope owns a run, durable state is the commits on a branch, and its own ADR 0007 designs per-worktree lock files that are still unimplemented at `e99f832`.

Neither reference system writes ownership to the tracker. Deadloop is the only one that does, and that is the axis nine of thirteen defects live on.

Deadloop's requirement genuinely differs in one respect. Symphony can discard ownership because re-dispatch is cheap: the workspace is per-issue and reused, and a repeat is one more agent turn. A deadloop attempt pushes, moves labels, comments, and merges, so a duplicate dispatch is not free. That difference is real, and it is why deadloop cannot simply copy the discard.

It is not, however, a reason to write ownership to GitHub. Deadloop already holds the primitive that makes ownership unnecessary at the point where it would do damage. `pushConditionally` reads the remote ref, refuses to push unless it still equals the expected head, pushes an immutable candidate that Git will reject as a non-fast-forward, and re-reads on failure to report `stale_head`. That is a compare-and-swap. `merge-reviewed-pr.cts` takes an exact expected head. The dangerous operations are already safe without knowing who owns the work.

## Decision

Deadloop stops deriving work authority. The concept, and the reconciliation that produced it, are removed.

Four mechanisms replace it. Each answers exactly one question, and none is checked against another.

**Safety — compare-and-swap at the mutation.** Every GitHub mutation that can destroy work is conditional on the exact head it was planned against. Push and merge already are. A second attempt that reaches the mutation loses the swap and stops as `stale_head`, which needs no knowledge of who owns the pull request.

**Exclusion — an operating-system lock, held locally.** The dispatch decision takes a non-blocking `flock` scoped to one target under the state directory. Deadloop already requires `flock` for scheduler ownership (`src/scheduler-lock.cjs`); this narrows its grain from the repository to the target. The lock covers the decision to launch, not the attempt's lifetime.

**Liveness — the execution runtime, alone.** Whether an attempt is still running is answered by the execution runtime and by nothing else. There is no second record to disagree with it, which is what removes the `claim_ambiguous` against `runtime_ambiguous` class of defect entirely.

The lock cannot carry liveness. An agent runs in a Herdr session outside the Automation host's process tree, so a host restart releases the kernel lock while the agent keeps writing. Liveness and exclusion are therefore separate mechanisms with separate lifetimes, and conflating them would rebuild the problem this decision removes.

**Evidence — the attempt journal and the finalizer receipt.** They record what happened and are read to explain and to clean up. They never grant permission to act.

Removed: the claim comment marker and its parsing, `authoritySeconds` and the GitHub server-time comparison, comment-edit detection, the classification of claim observations, and the reconciliation of claim observations against runtime observations.

Unchanged on GitHub: Agent request labels remain the source of truth for what work is wanted, exactly as [ADR 0018](0018-github-agent-requests-recover-runtime-failures.md) decided. `agent:blocked` and the human handoff remain the output a person reads. GitHub stays the centre for which work exists and whether it is still wanted; it stops being the centre for who holds it.

Labels are not compare-and-swappable, because GitHub's labels API has no conditional update. Deadloop binds a request's consumption to its request event id, so a duplicate consumption is detectable and repairable after the fact rather than prevented by a lock held across a network round trip. This is a deliberate acceptance, not an oversight: a lock that spans a remote call would have to survive the caller's death, which is the property that made the claim marker complicated.

Reconciliation survives on one axis. A pull request carrying `agent:in-progress` whose attempt the runtime reports stopped, and whose completion handler did not run, returns to a request state or blocks with an explanation. There is no claim to classify.

## Consequences

The product of claim observations and runtime observations disappears. #286, #283, #281, #273, and #267 become classes that cannot recur, because the disagreement each of them reports requires two authorities to disagree.

Deadloop no longer answers "who owns this pull request". An operator who wants that answer reads the execution runtime and the attempt journals, which is where the evidence was all along.

A duplicate dispatch becomes possible in the window the lock does not cover: an Automation host restart while an agent is still working. Compare-and-swap stops it from damaging the branch, and the runtime observation stops it at the next dispatch. It can still waste one agent run and post a duplicate pull-request comment. That is the cost this decision accepts in exchange for removing the product.

Failing closed is unchanged in spirit and much narrower in surface. Deadloop still refuses to act on what it cannot observe; there are simply far fewer things it must observe.

ADR 0019 is superseded. Releasing work authority for a new Agent request is moot once no authority is held.
