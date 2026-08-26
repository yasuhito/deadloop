# ADR 0028: deadloop owns operational integrity, not repository policy quality

## Status

Accepted

## Decision

deadloop guarantees operational integrity: the selected target, verified revision, and mutated target remain identical; Agent requests are consumed once; concurrent changes lose an exact-head/base compare-and-swap; disablement and repository locks prevent new unauthorized work; and dirty or ambiguous runtime state is preserved rather than discarded.

Repository owners remain responsible for the substance of repository policy. deadloop does not judge whether tests are strong enough, whether `package.json` scripts or GitHub workflows should change, whether branch protection is appropriate, or whether a repository-owned CI-equivalent command provides adequate coverage. It executes the trusted policy and binds the resulting evidence to the exact revisions, but it does not add an open-ended policy-quality audit.

This extends ADR 0015's cooperative trust model. The supported path protects against fallible output, stale evidence, races, and wrong-target mutations, not an actively hostile same-user agent or an intentionally weakened repository policy.

## Consequences

Exact revision binding, locks, liveness observations, authenticated verification records, dirty-worktree gates, and pre-mutation revalidation remain. Checks that duplicate repository policy, GitHub branch protection, or hypothetical hostile-agent containment should not be added; redundant observations without an intervening external operation may be consolidated.
