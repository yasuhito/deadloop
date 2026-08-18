# Feature: Connect pull request work through GitHub Agent requests

GitHub request labels are the only queue for pull request work, and deadloop consumes exactly one of
them at a time in a fixed order. This keeps the next action visible on GitHub and prevents a review,
a repair, and a branch update from racing each other on the same head.

## Scenario: Process the branch update before every other pending request

* Given A pull request carries branch-update, repair, and review requests
* When deadloop chooses the request to consume
* Then deadloop chooses the branch-update request

## Scenario: Process the repair before a pending review request

* Given A pull request carries repair and review requests
* When deadloop chooses the request to consume
* Then deadloop chooses the repair request

## Scenario: Consume only the review request when it is the only one waiting

* Given A pull request carries only a review request
* When deadloop chooses the request to consume
* Then deadloop chooses the review request

## Scenario: Launch no agent for a branch-update request that is no longer needed

* Given A pull request carries a branch-update request but no longer conflicts
* When deadloop processes the pull request request queue
* Then deadloop launches no agent for the obsolete request

## Scenario: Explain an obsolete branch-update request on the pull request

* Given A pull request carries a branch-update request but no longer conflicts
* When deadloop processes the pull request request queue
* Then deadloop explains why the obsolete request was consumed

## Scenario: Return an obsolete branch-update request to normal review

* Given A pull request carries a branch-update request but no longer conflicts
* When deadloop processes the pull request request queue
* Then deadloop requests a review of the current head
