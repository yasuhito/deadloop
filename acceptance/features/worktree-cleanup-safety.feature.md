# Feature: Select only completed worktrees that are safe to clean up

The runner selects only completed worktrees as cleanup candidates and preserves worktrees that have changes or cannot be verified.
This prevents deadloop from accidentally deleting another task or an unfinished pull request.

## Scenario: Select a clean worktree for a merged pull request as a cleanup candidate

* Given A deadloop worktree is merged and clean
* When deadloop starts cleanup
* Then The worktree is selected as a cleanup candidate

## Scenario: Do not select a worktree with changes as a cleanup candidate

* Given A merged deadloop worktree has changes
* When deadloop starts cleanup
* Then The worktree is not selected as a cleanup candidate

## Scenario: Preserve a tracked file during cleanup

* Given A merged deadloop worktree contains a tracked file
* When deadloop starts cleanup
* Then The tracked file remains in the worktree

## Scenario: Do not select a worktree from another repository as a cleanup candidate

* Given A merged deadloop worktree belongs to another repository
* When deadloop starts cleanup
* Then The worktree is not selected as a cleanup candidate

## Scenario: Do not select the worktree of an unmerged pull request as a cleanup candidate

* Given A deadloop worktree belongs to an unmerged pull request
* When deadloop starts cleanup
* Then The worktree is not selected as a cleanup candidate
