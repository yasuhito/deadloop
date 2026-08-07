# Feature: Bound automatic pull request repair and conflict recovery to one attempt

Handle review findings and conflicts safely without repeating the same change or overwriting another change.

## Scenario: Start one dedicated conflict-recovery attempt for a conflicted pull request

* Given A pull request has a conflict that can be recovered
* When deadloop checks the pull request
* Then deadloop starts a dedicated conflict-recovery attempt

## Scenario: Do not start conflict recovery twice for the same pull request head and base

* Given Conflict recovery was already attempted for the same pull request head and base
* When deadloop checks the pull request
* Then deadloop does not start another dedicated conflict-recovery attempt

## Scenario: Keep the pull request under review after a repeated conflict-recovery request

* Given Conflict recovery was already attempted for the same pull request head and base
* When deadloop checks the pull request
* Then deadloop keeps the pull request under review

## Scenario: Escalate a repeated conflict-recovery request for human handling

* Given Conflict recovery was already attempted for the same pull request head and base
* When deadloop checks the pull request
* Then deadloop escalates the pull request for human handling

## Scenario: Leave recovery guidance after a repeated conflict-recovery request

* Given Conflict recovery was already attempted for the same pull request head and base
* When deadloop checks the pull request
* Then deadloop leaves recovery guidance

## Scenario: Return a pull request with a conflict-recovery head update to normal review

* Given Conflict recovery changed the pull request head
* When deadloop checks the pull request
* Then deadloop returns the pull request to normal review

## Scenario: Start re-review after conflict recovery changes a repaired pull request head

* Given Conflict recovery changed a repaired pull request head
* When deadloop checks the pull request
* Then deadloop returns the pull request to normal review

## Scenario: Preserve the selection reason after conflict recovery changes a repaired pull request head

* Given Conflict recovery changed a repaired pull request head
* When deadloop checks the pull request
* Then The selection reason after conflict recovery is repair re-review

## Scenario: Preserve review state during conflict recovery

* Given A pull request has a conflict that can be recovered
* When deadloop checks the pull request
* Then deadloop preserves the review state

## Scenario: Start a dedicated repair attempt for the first actionable review findings

* Given A pull request has actionable review findings for the first time
* When deadloop processes the review result
* Then deadloop starts a dedicated repair attempt

## Scenario: Preserve review state during repair

* Given A pull request is being repaired for review findings
* When deadloop starts the review repair
* Then deadloop preserves the review state

## Scenario: Return a pull request with a repaired head to normal review

* Given A repair push changed the pull request head
* When deadloop checks the pull request
* Then deadloop returns the pull request to normal review

## Scenario: Do not start the same repair twice on the new head

* Given The same review findings remain on the new head after repair
* When deadloop processes the review result
* Then deadloop does not start another dedicated repair attempt

## Scenario: Keep the new head under review when the same findings remain after repair

* Given The same review findings remain on the new head after repair
* When deadloop processes the review result
* Then deadloop keeps the pull request under review

## Scenario: Escalate the new head for human handling when the same findings remain after repair

* Given The same review findings remain on the new head after repair
* When deadloop processes the review result
* Then deadloop escalates the pull request for human handling

## Scenario: Leave recovery guidance when the same findings remain after repair

* Given The same review findings remain on the new head after repair
* When deadloop processes the review result
* Then deadloop leaves recovery guidance

## Scenario: Retry the first technical review failure exactly once

* Given A pull request has its first technical review failure
* When deadloop processes the review result
* Then deadloop retries the review exactly once

## Scenario: Do not escalate the first technical review failure for human handling

* Given A pull request has its first technical review failure
* When deadloop processes the review result
* Then deadloop does not escalate the pull request for human handling

## Scenario: Do not retry a second technical review failure

* Given A pull request already had one technical review failure
* When deadloop processes the review result
* Then deadloop does not start normal review

## Scenario: Keep the pull request under review after a second technical review failure

* Given A pull request already had one technical review failure
* When deadloop processes the review result
* Then deadloop keeps the pull request under review

## Scenario: Escalate a second technical review failure for human handling

* Given A pull request already had one technical review failure
* When deadloop processes the review result
* Then deadloop escalates the pull request for human handling

## Scenario: Leave recovery guidance after a second technical review failure

* Given A pull request already had one technical review failure
* When deadloop processes the review result
* Then deadloop leaves recovery guidance

## Scenario: Do not push a repair for a stale pull request head

* Given The pull request head selected for repair has been verified
* When The pull request head changes immediately before push
* Then deadloop does not push to the branch

## Scenario: Do not push a repair that changes too many files for its findings

* Given A repair changes six files for one finding
* When deadloop completes the repair
* Then deadloop does not push to the branch

## Scenario: Hand a repair that changes too many files to a human

* Given A repair changes six files for one finding
* When deadloop completes the repair
* Then deadloop requires human review for the repair

## Scenario: Push a repair whose changed-file count is within the limit

* Given A repair changes five files for one finding
* When deadloop completes the repair
* Then deadloop pushes with an exact-head lease to the verified branch

## Scenario: Push a repair with an exact-head lease to only the verified existing branch

* Given The pull request head selected for repair has been verified
* When deadloop completes the repair
* Then deadloop pushes with an exact-head lease to the verified branch

## Scenario: Run repair checks before the final pull request head check

* Given The pull request head selected for repair has been verified
* When deadloop completes the repair
* Then deadloop runs the configured checks before the final pull request head check

## Scenario: Do not push conflict recovery for a pull request from another repository

* Given A pull request from another repository has a conflict
* When deadloop completes conflict recovery
* Then deadloop does not push to the conflict-recovery branch

## Scenario: Push conflict recovery with an exact-head lease to only the verified existing branch

* Given The pull request head selected for conflict recovery has been verified
* When deadloop completes conflict recovery
* Then deadloop pushes with an exact-head lease to the conflict-recovery branch

## Scenario: Run conflict-recovery checks before the final pull request head check

* Given The pull request head selected for conflict recovery has been verified
* When deadloop completes conflict recovery
* Then deadloop runs the configured checks before the final conflict-recovery pull request head check

## Scenario: Do not push conflict recovery for a stale pull request head

* Given The pull request head selected for conflict recovery has been verified
* When The pull request head changes immediately before push
* Then deadloop does not push to the conflict-recovery branch
