# Feature: Safely proceed with the pull request review process

deadloop selects only reviewable pull requests and handles them safely according to external-review and draft state.
This prevents duplicate and early reviews of pull requests that are being prepared, are blocked, or are being processed by another agent.

## Scenario: Select a pull request waiting for review

* Given There is a pull request waiting for review.
* When deadloop searches for review target
* Then deadloop selects pull request #7 for review

## Scenario: If automatic merge is disabled, do not select a pull request that is ready for human review.

* Given There is a pull request ready for human review.
* And Automatic merge is disabled
* When deadloop searches for review target
* Then No review target is selected

## Scenario: If automatic merge is enabled, select a pull request that is ready for human review.

* Given There is a pull request ready for human review.
* And automatic merge is enabled
* When deadloop searches for review target
* Then deadloop selects pull request #42 for review

## Scenario: Do not select a pull request that only has labels that are not subject to review.

* Given There is a pull request that only has labels that are not subject to review.
* When deadloop searches for review target
* Then No review target is selected

## Scenario: Do not select a pull request while CI is running

* Given A pull request has CI running
* When deadloop searches for review target
* Then No review target is selected

## Scenario: Select a pull request after its external-review wait expires

* Given There is a pull request whose waiting period for external review has expired.
* And External review is enabled
* When deadloop searches for review target
* Then deadloop selects pull request #9 for review

## Scenario: If external review is disabled, select a pull request waiting for external review.

* Given There is a pull request waiting for external review
* And External review is disabled
* When deadloop searches for review target
* Then deadloop selects pull request #10 for review

## Scenario: Do not select a pull request being processed by an external reviewer

* Given pull request is being processed by an external reviewer
* And External review is enabled
* When deadloop searches for review target
* Then No review target is selected

## Scenario: Do not select a pull request that is being processed by another external reviewer

* Given pull request is being processed by another external reviewer
* And External review is enabled
* When deadloop searches for review target
* Then No review target is selected

## Scenario: Do not request external review before an active claim

* Given There is a pull request waiting for review.
* And External review is enabled
* When deadloop decides how to handle external reviews
* Then deadloop leaves external-review request state untouched before claim

## Scenario: Do not mutate while waiting for external review before an active claim

* Given There is a pull request waiting for external review
* And External review is enabled
* When deadloop decides how to handle external reviews
* Then deadloop waits for external review without mutation

## Scenario: Start normal review when external review waiting period expires

* Given There is a pull request whose waiting period for external review has expired.
* And External review is enabled
* When deadloop decides how to handle external reviews
* Then deadloop starts the Reviewer for normal review

## Scenario: Do not start review for a draft pull request

* Given There is a draft pull request
* When deadloop selects and processes the review target
* Then deadloop does not start the Reviewer

## Scenario: Do not post draft recovery state before an active claim

* Given There is a draft pull request
* When deadloop tries to start a review
* Then deadloop leaves the draft pull request untouched before claim

## Scenario: Reclaim a stale review claim and select its pull request

* Given There is a pull request under review with no active agents.
* When deadloop searches for review target
* Then deadloop selects pull request #13 for review

## Scenario: Record stale review claim recovery as the selection reason

* Given There is a pull request under review with no active agents.
* When deadloop searches for review target
* Then The selection reason is stale review claim recovery

## Scenario: Record repair re-review as the selection reason

* Given There is a pull request waiting for re-review after repair
* When deadloop searches for review target
* Then The selection reason is repair re-review

## Scenario: Do not treat an attempt abandoned with evidence as owning the pull request

* Given There is a pull request waiting for review with an abandoned attempt with evidence.
* When deadloop searches for review target
* Then deadloop selects pull request #7 for review

## Scenario: Do not select a pull request that is being reviewed by another agent

* Given There is a pull request being reviewed by another agent.
* When deadloop searches for review target
* Then No review target is selected

## Scenario: Do not select a blocked pull request

* Given There is a blocked pull request
* When deadloop searches for review target
* Then No review target is selected

## Scenario: Select only a reviewable pull request from multiple candidates

* Given Reviewable and unreviewable pull requests are both available
* When deadloop searches for review target
* Then deadloop selects pull request #15 for review

## Scenario: Do not select a pull request again after another agent starts its review

* Given There is a pull request waiting for review.
* And Another agent has started the review after selection.
* When The next selection cycle begins
* Then No review target is selected
