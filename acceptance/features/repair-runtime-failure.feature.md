# Feature: Show a repair attempt's runtime failure on the pull request and recover by Agent request

When the repair worker stops without a completion report, deadloop publishes the stop on the pull request bound to its selection-time head and the review-finding contract it was repairing, keeps the stopped worktree for inspection, and restarts only through a new `agent:implement` Agent request.

## Scenario: Replace a stopped repair's in-progress state with agent:blocked

* Given A pull request under automatic repair whose repair worker stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring to the stopped repair
* Then deadloop replaces the active repair state with agent:blocked

## Scenario: Post one stop explanation for the stopped repair

* Given A pull request under automatic repair whose repair worker stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring to the stopped repair
* Then deadloop posts one stop explanation for the stopped repair

## Scenario: Bind the stop explanation to the repair contract and its selection-time head

* Given A pull request under automatic repair whose repair worker stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring to the stopped repair
* Then The stop explanation is bound to the repair attempt key and the exact pull request head

## Scenario: Release the stopped repair attempt's ownership as a terminal missing-report failure

* Given A pull request under automatic repair whose repair worker stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring to the stopped repair
* Then The stopped attempt releases its ownership as a terminal missing-report failure and keeps its worktree

## Scenario: Name formally observed storage exhaustion as a capacity stop

* Given A pull request under automatic repair whose repair worker stopped while deadloop could not read the completion report because the host ran out of storage
* When deadloop applies deterministic attempt monitoring to the stopped repair
* Then The capacity stop names the observed storage exhaustion with recovery steps and no local paths on the repair PR

## Scenario: Keep pane output alone from naming a capacity stop

* Given A pull request under automatic repair whose repair worker stopped with pane output naming ENOSPC but no formal storage failure
* When deadloop applies deterministic attempt monitoring to the stopped repair
* Then The published stop stays a generic technical failure for the repair

## Scenario: Requeue a blocked repair through a new agent:implement Agent request

* Given A blocked repair runtime failure that gained a new agent:implement request after the block
* When deadloop processes the pull request request queue after recovery
* Then deadloop relaunches the stopped repair contract through a new repair monitor handoff
