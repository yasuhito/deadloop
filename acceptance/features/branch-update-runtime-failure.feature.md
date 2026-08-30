# Feature: Show a branch update's runtime failure on the pull request and recover by Agent request

When the branch-update worker stops without a completion report, deadloop publishes the stop on the pull request bound to its attempt, the selection-time head, and the selected base, keeps the mid-update worktree evidence, and restarts only through a new `agent:update-branch` Agent request.

## Scenario: Replace a stopped update's in-progress state with agent:blocked

* Given A pull request under branch update whose update worker stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring to the stopped update
* Then deadloop replaces the active update state with agent:blocked

## Scenario: Post one stop explanation for the stopped update

* Given A pull request under branch update whose update worker stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring to the stopped update
* Then deadloop posts one stop explanation for the stopped update

## Scenario: Bind the stop explanation to the update attempt, its selection-time head, and the selected base

* Given A pull request under branch update whose update worker stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring to the stopped update
* Then The stop explanation is bound to the update attempt, the exact pull request head, and the selected base

## Scenario: Release the stopped update attempt's ownership as a terminal missing-report failure

* Given A pull request under branch update whose update worker stopped without writing a completion report
* When deadloop applies deterministic attempt monitoring to the stopped update
* Then The stopped update releases its ownership as a terminal missing-report failure and keeps its worktree

## Scenario: Name formally observed storage exhaustion as a capacity stop

* Given A pull request under branch update whose update worker stopped while deadloop could not read the completion report because the host ran out of storage
* When deadloop applies deterministic attempt monitoring to the stopped update
* Then The capacity stop names the observed storage exhaustion with recovery steps and no local paths on the update PR

## Scenario: Keep pane output alone from naming a capacity stop

* Given A pull request under branch update whose update worker stopped with pane output naming ENOSPC but no formal storage failure
* When deadloop applies deterministic attempt monitoring to the stopped update
* Then The published update stop stays a generic technical failure

## Scenario: Restart a published update failure through a new agent:update-branch Agent request

* Given A pull request blocked by a published branch-update runtime failure that gained a new agent:update-branch request after the block
* When deadloop processes the pull request queue after the update block
* Then deadloop relaunches the stopped update contract through a new branch-update monitor handoff
