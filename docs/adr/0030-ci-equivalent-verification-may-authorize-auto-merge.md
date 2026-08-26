# ADR 0030: CI-equivalent verification may authorize normal automatic merge

## Status

Accepted; supersedes ADR 0014

## Decision

GitHub checks are one source of health evidence, not the sole authority. When checks are absent, deadloop treats their absence as non-failure. While any check is pending, deadloop waits. After every check finishes, a failure may be replaced by successful CI-equivalent verification of the prospective merge tree, bound to the exact PR head, base, resulting tree, command, policy source, and policy base revision. A changed head or base invalidates the record.

The repository owner supplies the complete CI-equivalent command in trusted-base `deadloop.json`. Without an explicit command, a trusted-base `package-lock.json` plus `package.json` `scripts.check` establishes the convention `npm ci && npm run check`; otherwise fallback is unavailable. deadloop neither composes this command with required verification nor judges the quality of repository-owned scripts. It performs only a normal GitHub merge and never uses admin or ruleset bypass; GitHub refusal stops the merge.

Enablement validates configuration and capabilities but does not synchronously run repository verification. Required verification runs against produced revisions. Only after it fails does deadloop run the same contract on the fixed trusted base to diagnose a pre-existing base failure. A failed base/contract pair suppresses new agent launches without consuming Agent requests until the base or contract changes.

If CI-equivalent verification fails while the same command succeeds on the base, deadloop may launch one existing repair-path worker for that fallback episode. A changed head remains part of the same episode; a second fallback failure stops instead of launching another repair. If the base also fails, no PR repair starts.

## Consequences

CI-equivalent success may support human handoff or, when ordinary auto-merge policy permits, automatic merge. It is recorded as fallback success, never as CI success. The legacy `ciFallback.enabled`, `mode`, `localCommands`, and `allowAutoMerge` settings are removed without compatibility handling. Verification-policy quality, workflow edits, package scripts, and branch-protection choices remain repository-owner responsibilities under ADR 0028.
