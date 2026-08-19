# Feature: Show deadloop status and safe recovery steps to the operator

The operator can inspect Issues, pull requests, worktrees, configuration conditions, and recovery steps for blocked work before choosing the next safe action.

## Scenario: Report when no Issue is waiting for implementation

* Given There is no Issue waiting for implementation.
* When The operator requests deadloop status
* Then Status reports that no Issue is waiting for implementation

## Scenario: Show an Issue whose request carries no triage label

* Given An Issue has the `agent:implement` request without `ready-for-agent`
* When The operator requests deadloop status
* Then Status shows the Issue as waiting for implementation

## Scenario: Do not show an Issue that is waiting for a person as waiting for implementation

* Given An Issue has the `agent:implement` request and `ready-for-human`
* When The operator requests deadloop status
* Then Status reports that no Issue is waiting for implementation

## Scenario: Show an Issue that was handed back to a person

* Given An Issue has the `agent:implement` request and `ready-for-human`
* When The operator requests deadloop status
* Then Status shows the Issue as waiting for a person

## Scenario: Show target Issue

* Given Issue #13 is being implemented
* When The operator requests deadloop status
* Then Status shows the target Issue

## Scenario: Show pull request for review

* Given pull request #21 is waiting for review
* When The operator requests deadloop status
* Then Status shows the pull request awaiting review

## Scenario: Show worktrees that are candidates for cleanup

* Given Worktree remains for merged pull request #20
* When The operator requests deadloop status
* Then Status shows cleanup-candidate worktrees

## Scenario: Show active worktrees

* Given Worktree of Issue #13 in progress is up and running
* When The operator requests deadloop status
* Then Status displays active worktrees

## Scenario: Show code update warning

* Given deadloop Extension code update not reflected in status display
* When The operator requests deadloop status
* Then Status shows the code-update warning

## Scenario: Show the most recent automation decision

* Given Automation selected Issue #12 in most recent run
* When The operator requests deadloop status
* Then Status shows the most recent automation decision

## Scenario: Show the configuration source

* Given The location of the local configuration is unknown, and the repository configuration is read from deadloop.json in origin/main.
* When The operator requests deadloop status
* Then Status shows the configuration source

## Scenario: Show reason in blocking comment for Issue

* Given Issue #11, representing a PRD, design, or parent task, is awaiting implementation.
* When deadloop creates the blocking comment
* Then The blocking comment shows the reason

## Scenario: Show recovery procedure in blocking comment of Issue

* Given Issue #11, representing a PRD, design, or parent task, is awaiting implementation.
* When deadloop creates the blocking comment
* Then The blocking comment shows recovery steps

## Scenario: Show safe requeue method in blocking comment for Issue

* Given Issue #11, representing a PRD, design, or parent task, is awaiting implementation.
* When deadloop creates the blocking comment
* Then The blocking comment shows a safe requeue method

## Scenario: Do not post a draft reason before an active claim

* Given pull request #23 is a draft and waiting for review.
* When deadloop creates the blocking comment
* Then No draft blocking comment is posted before claim

## Scenario: Do not post draft recovery steps before an active claim

* Given pull request #23 is a draft and waiting for review.
* When deadloop creates the blocking comment
* Then No draft blocking comment is posted before claim

## Scenario: Do not consume the draft review request before an active claim

* Given pull request #23 is a draft and waiting for review.
* When deadloop creates the blocking comment
* Then No draft blocking comment is posted before claim

## Scenario: Register the current status display command

* Given The deadloop extension can start
* When The deadloop extension registers public commands
* Then `/deadloop-status` is available
