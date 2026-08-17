# ADR 0026: Consume Agent requests with targeted label transitions

## Status

Accepted.

## Decision

Issue and pull-request Agent requests use the execution model from [ADR 0020](0020-stop-proving-work-authority.md). An Agent request says what work is wanted; it does not grant work authority. Deadloop does not create or reconcile a claim comment. The execution runtime alone reports whether an attempt is running, while the attempt journal remains evidence for recovery and never grants permission to act.

Deadloop durably records an attempt before consuming its bound request event and before launching an agent. It consumes only the selected request label with GitHub's targeted label-removal operation instead of replacing the complete managed-label set. A successful removal moves that request toward `agent:in-progress`; a missing label is a cancellation and prevents launch. Requests for other roles and requests added while an attempt runs remain queued for a later attempt. A stopped target holds no request that predates its block, as [ADR 0023](0023-a-blocked-target-holds-no-request.md) requires, while a request added after the block remains a new request.

GitHub does not provide compare-and-swap for label writes. Deadloop therefore binds consumption to the immutable request event ID and verifies the resulting timeline after a targeted mutation. If a different generation raced with consumption, deadloop does not launch and preserves the currently active generation. If the Automation host stops after the GitHub mutation but before durably recording its result, deadloop cannot distinguish its own consumption from a person's cancellation. It fails closed as an ambiguous request-consumption stop, does not restore or consume the request automatically, and leaves a GitHub explanation telling a person to add a new Agent request to continue.

Deadloop may resume the same attempt through proven pre-launch transition phases. Once launch may have begun, it monitors the same attempt only when the execution runtime reports it running; it does not start another agent to resolve uncertain liveness. Cancelling an already running attempt is outside this decision.

## Consequences

The transition is intentionally multi-step rather than falsely atomic. An Automation host interruption can require human recovery, but concurrent labels are not erased by a full replacement, a removed request does not silently launch work, and Issue automation does not recreate the multi-authority claim model removed by ADR 0020.
