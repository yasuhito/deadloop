# ADR 0019: Release work authority only for a new Agent request

## Status

Accepted

## Context

Work authority is the state that says which attempt holds a pull request's current work. Deadloop derives it by reconciling the GitHub Agent request, the claim, and the labels against the local attempt journals and the execution-runtime observation. The reconciler already blocks a pull request whenever it cannot prove that authority.

It could not, however, prove the opposite: that a retained attempt no longer holds it. Two shapes made every recovery impossible.

A pull request with more than one retained attempt was classified as ambiguous from the count alone, before any evidence was read. A retained attempt with no saved claim was classified as missing, which blocks. Because a new attempt adds a journal of its own, any pull request carrying one retained attempt blocked the moment its request was claimed.

PRs #227, #228, and #229 — the pull requests [GitHub Agent requests are the source of truth for workflow state](https://github.com/yasuhito/deadloop/issues/238) was written for — each carried a stopped reviewer attempt in `report_received`. Their execution-runtime workspaces were gone and their worktrees remained. Adding the Agent request that #238 defines as the only recovery route moved each of them straight back to `agent:blocked`.

The mechanism for the opposite proof already existed: the `authority_released` phase, and a `release_for_request` transition for an attempt a newer request had superseded. Only the policy that reaches them was missing.

## Decision

A retained attempt loses work authority when deadloop can prove it cannot act on the current work, and only then.

Two proofs qualify, and each requires the execution runtime to report the attempt stopped:

- Its input revision is not the pull request's current head. Every GitHub mutation deadloop performs is guarded by the exact head, so such an attempt can no longer produce a valid completion for the current head.
- Its saved claim names an Agent request event that is no longer the current one. A newer request superseded it.

A stopped runtime alone never qualifies: a live attempt that paused looks the same.

The runtime reports an attempt stopped when the agent this attempt's journal names is not working
and no agent this attempt cannot be told apart from occupies its checkout. Nothing else takes part:
not the journal's phase, not the receipt beside it, not the workspace, which can stay open long
after the agent it held has finished. [ADR 0020](0020-stop-proving-work-authority.md) leaves the
execution runtime as the only authority on this question, and evidence on disk never grants
permission to act. An attempt the runtime cannot describe this way keeps its authority.

Deadloop releases work authority only while a new Agent request is waiting. Without a request, a retained attempt keeps its authority until the pull request closes. This keeps the release a step of taking over work rather than an unrequested discard of local state.

The release happens where that takeover happens: in the claim, once the request has been won and
before the new attempt's journal exists. The reconciler is not the place. It observes only pull
requests already carrying the active claim state, by which point the request it would look for has
been consumed, so it never sees the waiting request this decision depends on. Releasing in the claim
also means the reconciler never observes the ambiguous state that blocked PRs #227, #228, and #229.

A release posts no comment. It is not a stop and asks nothing of a person, and the claim comment that follows it shows on GitHub that the pull request moved. The attempt journal and its worktree stay as evidence; only the authority claim is dropped.

Evidence that proves nothing still blocks. A pull request whose retained attempts cannot all be resolved by the two proofs, and one whose journal cannot be parsed, keep the existing `agent:blocked` transition with its explanation.

This decision covers pull requests. The Issue side has no equivalent reconciler yet; [Issue explore and implement requests](https://github.com/yasuhito/deadloop/issues/242) decides whether the same rule applies there.

## Consequences

The three pull requests #238 was written for become recoverable through the Agent request that #238 defines, with no local state surgery and no operator command.

Deadloop keeps failing closed on everything it cannot prove, so a pull request can still block for a reason a person must read. The two proofs widen what deadloop can prove; they do not weaken what it requires.

Because a release is silent, a reader who wants to know why a pull request resumed reads the claim comment and the retained journals rather than a release notice.
