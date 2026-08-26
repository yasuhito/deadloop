# Feature: Continue automatic pull request repair only while review history shows progress

Handle review findings and conflicts safely without arbitrary repair-count or changed-file limits, without repeating a failed correction, and without overwriting another change.

## Scenario: Turn a merge conflict into a branch-update request

* Given A pull request has a conflict that can be recovered
* When deadloop checks the pull request
* Then deadloop requests a branch update instead of recovering from local state

## Scenario: Do not start conflict recovery twice for the same pull request head and base

* Given Conflict recovery was already attempted for the same pull request head and base
* When deadloop checks the pull request
* Then deadloop does not start another dedicated conflict-recovery attempt

## Scenario: Block a repeated conflict-recovery request instead of attempting it again

* Given Conflict recovery was already attempted for the same pull request head and base
* When deadloop checks the pull request
* Then deadloop blocks the repeated conflict-recovery request

## Scenario: Explain a repeated conflict-recovery request on the pull request

* Given Conflict recovery was already attempted for the same pull request head and base
* When deadloop checks the pull request
* Then deadloop leaves recovery guidance for the repeated conflict-recovery request

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

## Scenario: Launch no agent from the review request of a conflicted pull request

* Given A pull request has a conflict that can be recovered
* When deadloop checks the pull request
* Then deadloop does not start another dedicated conflict-recovery attempt

## Scenario: Accept an approved review with advisory observations

* Given An approved review contains only advisory observations
* When deadloop validates the review result
* Then The review result is accepted as approved

## Scenario: Reject an approved review with a required finding

* Given An approved review contains a required finding
* When deadloop validates the review result
* Then The approved review result is rejected

## Scenario: Start a dedicated repair attempt for the first actionable review findings

* Given A pull request has actionable review findings for the first time
* When deadloop processes the review result
* Then deadloop starts a dedicated repair attempt

## Scenario: Start a fourth repair when every earlier required finding is resolved

* Given A pull request has three historical repairs and only new required findings
* When deadloop processes the review result
* Then deadloop starts a dedicated repair attempt

## Scenario: Hand a persisted required finding to a person

* Given A prior required finding persists after repair
* When deadloop processes the review result
* Then deadloop leaves no agent workflow label on the pull request

## Scenario: Hand a regressed required finding to a person

* Given A resolved required finding regresses after repair
* When deadloop processes the review result
* Then deadloop leaves no agent workflow label on the pull request

## Scenario: Hand mixed prior and new required findings to a person

* Given Prior and new required findings are mixed after repair
* When deadloop processes the review result
* Then deadloop leaves no agent workflow label on the pull request

## Scenario: Keep posted review comments as chronological history

* Given A prior required finding persists after repair
* When deadloop processes the review result
* Then deadloop does not edit earlier review or repair-result comments

## Scenario: Keep finding identifiers out of human-readable review text

* Given A review result has an internal finding fingerprint
* When deadloop renders the review comment
* Then The human-readable review comment contains no finding fingerprint

## Scenario: Request fresh review when the observed review history changes

* Given A completed review has a recorded pull request history
* When A conversation comment is added after review
* Then The completed review history is stale

## Scenario: Keep English and Japanese public repair documentation aligned

* Given The English and Japanese public documentation
* When The review repair contracts are compared
* Then Both public documents describe the review-history repair contract

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

## Scenario: Leave no waiting request when the same findings remain after repair

* Given The same review findings remain on the new head after repair
* When deadloop processes the review result
* Then deadloop leaves no waiting request on the pull request

## Scenario: Hand the new head to a person when the same findings remain after repair

* Given The same review findings remain on the new head after repair
* When deadloop processes the review result
* Then deadloop leaves no agent workflow label on the pull request

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

## Scenario: Leave no waiting request after a second technical review failure

* Given A pull request already had one technical review failure
* When deadloop processes the review result
* Then deadloop leaves no waiting request on the pull request

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

## Scenario: Push a repair to only the verified existing branch under a verified-head lease

* Given The pull request head selected for repair has been verified
* When deadloop completes the repair
* Then deadloop pushes to the verified branch under a lease on the verified head

## Scenario: Allow a verified repair spanning more than twenty files

* Given A verified repair necessarily changes twenty-one files
* When deadloop completes the repair
* Then deadloop pushes to the verified branch under a lease on the verified head

## Scenario: Do not push a repair whose required verification fails

* Given The pull request head selected for repair has been verified
* When Required verification fails during repair completion
* Then deadloop does not push to the branch

## Scenario: Run repair checks before the final pull request head check

* Given The pull request head selected for repair has been verified
* When deadloop completes the repair
* Then deadloop runs the configured checks before the final pull request head check

## Scenario: Do not push conflict recovery for a pull request from another repository

* Given A pull request from another repository has a conflict
* When deadloop completes conflict recovery
* Then deadloop does not push to the conflict-recovery branch

## Scenario: Push conflict recovery to only the verified existing branch under a verified-head lease

* Given The pull request head selected for conflict recovery has been verified
* When deadloop completes conflict recovery
* Then deadloop pushes to the conflict-recovery branch under a lease on the verified head

## Scenario: Run conflict-recovery checks before the final pull request head check

* Given The pull request head selected for conflict recovery has been verified
* When deadloop completes conflict recovery
* Then deadloop runs the configured checks before the final conflict-recovery pull request head check

## Scenario: Do not push conflict recovery for a stale pull request head

* Given The pull request head selected for conflict recovery has been verified
* When The pull request head changes immediately before push
* Then deadloop does not push to the conflict-recovery branch
