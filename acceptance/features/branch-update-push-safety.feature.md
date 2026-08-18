# Feature: Constrain branch updates and pushes safely

To protect a pull request author's changes, stop an update if the target changes during processing or the worktree is no longer safe.

## Scenario: Do not update the branch when the pull request head changes immediately before push

* Given The pull request head was verified before the update
* When The pull request head changes after the project check
* Then The branch is not pushed

## Scenario: Report a pull request head changed immediately before push as stale

* Given The pull request head was verified before the update
* When The pull request head changes after the project check
* Then The completion result reports a stale head

## Scenario: Do not update the branch of a pull request from another repository

* Given The pull request head was verified before the update
* And The pull request comes from another repository
* When deadloop attempts to complete the branch update
* Then The branch is not pushed

## Scenario: Do not update the branch when tracked changes appear after the project check

* Given The pull request head was verified before the update
* When Tracked changes appear in the worktree after the project check
* Then The branch is not pushed

## Scenario: Do not start a work agent in an untrusted worktree

* Given The worktree has not been trusted
* When deadloop attempts to start a Claude work agent
* Then The work agent is not started

## Scenario: Push an updatable pull request to only the selected branch

* Given The pull request head was verified before the update
* When deadloop attempts to complete the branch update
* Then Only the selected branch is pushed

## Scenario: Push an updatable pull request with no force variant other than a verified-head lease

* Given The pull request head was verified before the update
* When deadloop attempts to complete the branch update
* Then The branch is pushed under a lease on the verified head and no other force variant
