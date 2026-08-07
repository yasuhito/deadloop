# ADR 0014: CI fallback does not authorize automatic merge

## Status

Accepted

## Decision

Remove the `ciFallback.allowAutoMerge` project setting and the `DEADLOOP_CI_FALLBACK_ALLOW_AUTO_MERGE` automation environment variable.

CI fallback exists only to support local verification and a human handoff when a narrowly classified CI infrastructure failure prevents normal GitHub checks from completing. It does not weaken the automatic-merge gate. Automatic merge continues to require GitHub to report a clean merge state and at least one completed, successful check; missing, pending, failed, or ambiguous checks stop the merge.

## Rationale

The removed setting had no consumer, so accepting and exporting it implied a choice that deadloop did not honor. Giving it effect would create a second, less safe path around the deterministic merge checks and would conflict with the existing monitor contract. Removing it keeps one fail-closed source of truth for automatic-merge eligibility.

## Consequences

Existing `ciFallback.allowAutoMerge` entries become unsupported configuration and should be deleted. CI fallback classification and local commands are unchanged. Operators cannot use fallback results to authorize automatic merge; they must wait for successful GitHub checks or merge manually after human review.
