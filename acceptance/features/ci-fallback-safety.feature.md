# Feature: Replace failed GitHub checks with CI-equivalent verification of the exact merge candidate

GitHub checks are one health signal, never the sole authority. Absence is non-failure; pending waits; unknown stops. A terminal failure is replaced only by fresh CI-equivalent verification bound to the exact head, base, tree, command, and policy — recorded as CI fallback, never as CI success.

## Scenario: Treat absent GitHub checks as non-failure

* Given No GitHub checks exist on the merge candidate
* When deadloop decides the merge gate
* Then The merge proceeds because checks are absent

## Scenario: Wait while any check is pending

* Given One GitHub check is still pending on the merge candidate
* When deadloop decides the merge gate
* Then deadloop waits instead of starting CI fallback verification

## Scenario: Stop when a check state is unknown

* Given One GitHub check reports no recognizable state
* When deadloop decides the merge gate
* Then deadloop stops with an unknown-check-state stop

## Scenario: Authorize a merge directly from successful checks

* Given Every GitHub check succeeded on the merge candidate
* When deadloop decides the merge gate
* Then The merge proceeds on CI success without fallback evidence

## Scenario: Require fallback verification for failed checks without evidence

* Given At least one GitHub check failed terminally on the merge candidate
* And No CI fallback record exists for this candidate
* When deadloop decides the merge gate
* Then deadloop stops asking for CI-equivalent verification of the prospective merge tree

## Scenario: Merge on fresh fallback evidence bound to the exact candidate

* Given At least one GitHub check failed terminally on the merge candidate
* And A passed CI fallback verification exists for this repository, PR, head, base, tree, command, derivation, policy source, and policy base revision
* When deadloop decides the merge gate
* Then The merge proceeds on CI fallback evidence

## Scenario: Never report CI fallback evidence as CI success

* Given The merge proceeds on fresh CI fallback evidence
* When deadloop reports the basis of the merge
* Then The basis is CI fallback rather than CI success

## Scenario: Invalidate fallback evidence after the head advances

* Given A passed CI fallback verification exists for this candidate
* And The pull request head has advanced since the verification ran
* When deadloop decides the merge gate
* Then deadloop stops because the persisted fallback evidence is stale

## Scenario: Invalidate fallback evidence after the base advances

* Given A passed CI fallback verification exists for this candidate
* And The configured base head has advanced since the verification ran
* When deadloop decides the merge gate
* Then deadloop stops because the persisted fallback evidence is stale

## Scenario: Stop with a typed failure when fresh fallback evidence records failure

* Given A CI fallback verification of exactly this candidate failed
* When deadloop decides the merge gate
* Then deadloop stops with a CI-fallback-failed stop instead of re-running verification

## Scenario: Resolve one explicit CI-equivalent command from trusted-base policy

* Given Trusted-base deadloop.json declares ciEquivalentCommand `make ci`
* When deadloop resolves the CI-equivalent verification contract
* Then The contract command is `make ci` derived from explicit repo policy

## Scenario: Resolve the npm convention when trusted base has a lockfile and scripts.check

* Given No explicit CI-equivalent command is declared
* And Trusted base contains package-lock.json and a package.json scripts.check entry
* When deadloop resolves the CI-equivalent verification contract
* Then The contract command is `npm ci && npm run check`

## Scenario: Leave fallback unavailable for repositories without a resolvable convention

* Given No explicit CI-equivalent command is declared
* And Trusted base has neither a lockfile nor a scripts.check entry
* When deadloop resolves the CI-equivalent verification contract
* Then The contract is unavailable so CI fallback never runs

## Scenario: Reject legacy CI fallback settings without compatibility handling

* Given projects.json configures removed legacy ciFallback settings
* When deadloop loads the configuration
* Then Configuration loading fails naming the removed settings

## Scenario: Reject an explicit empty CI-equivalent command as configuration error

* Given Trusted-base deadloop.json declares ciEquivalentCommand as an empty string
* When deadloop resolves the CI-equivalent verification contract
* Then Resolution fails naming the explicit empty command

## Scenario: Permit one automatic repair per fallback episode

* Given An episode recorded zero repairs for this base-and-command pair
* When deadloop decides whether another CI fallback repair may start
* Then The repair starts inside the same episode

## Scenario: Block a second repair within the same episode

* Given An episode already used its one repair for this base-and-command pair
* And No human Agent request arrived after the episode started
* When deadloop decides whether another CI fallback repair may start
* Then The second repair is blocked

## Scenario: Start a new episode after a later human Agent request

* Given An episode already used its one repair for this base-and-command pair
* But A human added an Agent request after the episode started
* When deadloop decides whether another CI fallback repair may start
* Then A new episode allows the repair again
