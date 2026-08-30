# Feature: Advance pull request review according to its current state

Use only the pull request's current head, CI, external review, and conflict state to advance safely.
This prevents approval based on stale results, review before CI completes, and loss of approved safety configuration.

## Scenario: Do not start review processing when no pull request is reviewable

* Given No pull request is currently reviewable
* When deadloop decides the pull request's next action
* Then Review processing does not start

## Scenario: Wait while CI is running

* Given The pull request CI is running
* When deadloop decides the pull request's next action
* Then deadloop waits for CI to complete

## Scenario: Start normal review when external review is disabled

* Given A pull request is waiting for review after CI completes
* And External review is configured as disabled
* When deadloop decides the pull request's next action
* Then deadloop starts normal review

## Scenario: Do not replace an old external review request before the request is consumed

* Given External review was requested only for a previous pull request head
* And External review is configured as enabled
* When deadloop decides the pull request's next action
* Then deadloop leaves the external review request untouched before consumption

## Scenario: Do not merge the current pull request using approval for a previous head

* Given An approval result exists for a previous pull request head
* When deadloop completes approval processing for the current pull request
* Then The current pull request is not merged
