# Feature: Show the required verification contract alongside existing configuration

Users can keep existing string-based verification paths while seeing the required verification contract resolved from local configuration and trusted shared policy, or the reason it is blocked.

## Scenario: Local required verification takes precedence over shared policy

* Given Local configuration has `npm run local-check` and shared policy has `npm run shared-check`
* When required verification is resolved
* Then The effective command is `npm run local-check`

## Scenario: Report differing local and shared values as an override

* Given Local configuration has `npm run local-check` and shared policy has `npm run shared-check`
* When required verification is resolved
* Then The shared-policy value remains in the override information

## Scenario: Treat different values at the same precedence as a conflict

* Given The same local precedence contains different required verification values
* When required verification is resolved
* Then The blocked reason is `source_conflict`

## Scenario: Block when no source is available

* Given No required verification source is available
* When required verification is resolved
* Then The blocked reason is `no_source`

## Scenario: Block an explicitly empty command because it has no target

* Given Shared policy contains an empty required verification command
* When required verification is resolved
* Then The blocked reason is `zero_targets`

## Scenario: Do not infer and reject the contents of a nonempty explicit command

* Given Shared policy contains `true`
* When required verification is resolved
* Then The effective command is `true`

## Scenario: Preserve the contract binding in the resolution

* Given Shared policy contains `npm run check`
* When required verification is resolved
* Then The resolution includes the command, source, base revision, and repository

## Scenario: Status and doctor show the same resolution from a repository subdirectory

* Given Shared policy contains `npm run check`
* When Status and doctor are requested from a repository subdirectory
* Then Both required verification displays are identical
