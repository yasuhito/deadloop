# ADR 0015: Worker trust boundary in the same operating-system account

## Status

Accepted

## Context

The Pi + Herdr support path runs the Automation host and its Workers as the same operating-system user. Herdr does not provide a filesystem sandbox or a separate user for an agent process. File ownership and modes such as `0700` and `0600` therefore separate runtime state from ordinary repository content, but they do not prevent a Worker from deliberately searching for and replacing another file owned by that user.

The required-verification gates protect decisions from stale state, malformed or mismatched completion reports, accidental replacement of attempt-local data, concurrent GitHub changes, and verification results that are not bound to the selected output commit. They must not be described as an operating-system security boundary that contains a hostile same-user process.

## Decision

A Worker is an instruction-following but fallible Agent program. Prompts prohibit direct push, pull-request creation, label changes, Issue closure, merge, and modification of deadloop runtime state other than the launch-specific completion-report path. Deterministic host gates independently re-observe repository and GitHub state before success mutations and reject missing, stale, malformed, or mismatched evidence.

Host-persisted records outside the launch-specific run directory are authoritative within this cooperation model. A separate launch-contract snapshot protects against accidental or isolated replacement of `attempt.json`; it does not claim to resist a Worker that deliberately uses its same-user filesystem access to replace both copies.

The first-class Pi + Herdr support path does not claim protection from an actively hostile Worker that searches for host runtime state, reads same-user credentials, or intentionally modifies files outside its assigned worktree and completion-report path. Supporting that threat model requires an execution runtime with an enforceable isolation boundary, such as a separate operating-system identity or a filesystem sandbox. That work is separate from required-verification workflow gates.

## Consequences

- Documentation and code comments must not describe file modes or duplicate host files as protection from a hostile same-user process.
- Tests cover observable workflow failures, accidental or isolated state replacement, stale policy, revision binding, and mutation races.
- A test that grants the Worker arbitrary same-user access to every host record is outside this support path's current security contract.
- If hostile-agent containment becomes a product requirement, deadloop must add and validate an isolated execution-runtime capability before advertising that guarantee.
