# Feature: Show a reviewer's runtime failure on the pull request and recover by Agent request

When the reviewer agent stops without a completion report, deadloop publishes the stop on the pull request bound to its selection-time head, and restarts only through a new `agent:review` Agent request.

## Scenario: Replace a stopped review's in-progress state with agent:blocked

* Given A pull request under review whose reviewer stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring
* Then deadloop replaces the active review state with agent:blocked

## Scenario: Post one stop explanation for the stopped review

* Given A pull request under review whose reviewer stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring
* Then deadloop posts one stop explanation on the pull request

## Scenario: Bind the stop explanation to the review attempt and its selection-time head

* Given A pull request under review whose reviewer stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring
* Then The stop explanation is bound to the attempt and the exact pull request head

## Scenario: Release the stopped reviewer attempt's ownership as a terminal missing-report failure

* Given A pull request under review whose reviewer stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring
* Then The stopped attempt releases its ownership as a terminal missing-report failure

## Scenario: Name formally observed storage exhaustion as a capacity stop

* Given A pull request under review whose reviewer stopped while deadloop could not read the completion report because the host ran out of storage
* When deadloop applies deterministic attempt monitoring
* Then The capacity stop names the observed storage exhaustion with recovery steps and no local paths

## Scenario: Keep pane output alone from naming a capacity stop

* Given A pull request under review whose reviewer stopped with pane output naming ENOSPC but no formal storage failure
* When deadloop applies deterministic attempt monitoring
* Then The published stop stays a generic technical failure

## Scenario: Requeue a blocked review through a new agent:review Agent request

* Given A pull request blocked by a reviewer runtime failure that gained a new agent:review request after the block
* When deadloop processes the review target after recovery
* Then deadloop consumes the new review request through the recovery view
