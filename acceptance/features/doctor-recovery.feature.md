# Feature: Guide safe recovery of blocked Issues and worktrees with doctor

Operators can check blocked work simply by viewing `/deadloop-doctor`, clean up only safe targets, and avoid mistakenly treating normal work as a problem.

## Scenario: Show the command to requeue the blocked Issue

* Given An Issue has `agent:blocked`
* When The operator runs doctor
* Then doctor shows a command to requeue the Issue

## Scenario: Show the latest blocking reason for an Issue

* Given A blocking reason is recorded for an Issue with `agent:blocked`
* When The operator runs doctor
* Then doctor displays the latest blocking reason

## Scenario: Show the command to check the worktree of a stale in-progress Issue.

* Given A worktree exists for an Issue with `agent:in-progress` whose updates stopped more than 24 hours ago
* When The operator runs doctor
* Then doctor shows a command to inspect changes in the stale worktree

## Scenario: Do not report a recently updated in-progress Issue as a problem

* Given An actively worked Issue with `agent:in-progress` was updated recently
* When The operator runs doctor
* Then doctor shows no findings

## Scenario: Show command to clean up orphan worktrees that have no changes

* Given A clean orphaned worktree exists
* When The operator runs doctor
* Then doctor shows a command to clean up the worktree

## Scenario: Show confirmation command for orphaned worktrees that are being changed

* Given An orphaned worktree has changes
* When The operator runs doctor
* Then doctor shows a command to inspect the worktree with changes

## Scenario: Do not report an open pull request worktree as a problem

* Given A worktree is linked to an open pull request
* When The operator runs doctor
* Then doctor shows no findings

## Scenario: Show the command to enqueue a prepared Issue that has not been submitted

* Given An Issue has only `ready-for-agent`
* When The operator runs doctor
* Then doctor shows a command to enqueue the Issue

## Scenario: Show a command to inspect an Issue that needs triage

* Given An Issue has `needs-triage`
* When The operator runs doctor
* Then doctor shows a command to inspect the Issue

## Scenario: Show a command to requeue an Issue that needs triage

* Given An Issue has `needs-triage`
* When The operator runs doctor
* Then doctor shows a command to requeue the Issue that needs triage

## Scenario: Show precheck file when precheck is not available

* Given A record says the precheck is unavailable
* When The operator runs doctor
* Then doctor shows a command to inspect the precheck file

## Scenario: Show the precheck file when there is no precheck file

* Given A record says the precheck file is missing
* When The operator runs doctor
* Then doctor shows a command to inspect the precheck file

## Scenario: Show repeated instances of the same automation failure

* Given A record contains repeated instances of the same automation failure
* When The operator runs doctor
* Then doctor shows the recurring automation failure

## Scenario: Do not report a normal idle wait as a problem

* Given A record contains a normal idle wait with no work
* When The operator runs doctor
* Then doctor shows no findings

## Scenario: Show stalled automation attempts

* Given Automation has been stuck for at least three attempts
* When The operator runs doctor
* Then doctor shows the stuck automation

## Scenario: Do not show recently attempted normal automations as problems

* Given There is a recent normal automation attempt
* When The operator runs doctor
* Then doctor shows no findings

## Scenario: Show a command to open an untrusted Claude worktree

* Given A Claude worktree is not trusted
* When The operator runs doctor
* Then doctor shows a command to open the Claude worktree

## Scenario: Do not report a trusted Claude worktree as a problem

* Given A Claude worktree is trusted
* When The operator runs doctor
* Then doctor shows no findings

## Scenario: Show a command to open an untrusted Claude review worktree

* Given A Claude review worktree is not trusted
* When The operator runs doctor
* Then doctor shows a command to open the Claude worktree

## Scenario: Do not show worktrees that only use Pi as trust issues

* Given A worktree uses only Pi
* When The operator runs doctor
* Then doctor shows no findings

## Scenario: Show an inspection command when Claude trust configuration cannot be read

* Given Claude trust configuration cannot be read for a worktree
* When The operator runs doctor
* Then doctor shows a command to inspect Claude trust configuration

## Scenario: Show a command to release an inactive review claim

* Given A pull request has `agent:in-progress` but no active review agent
* When The operator runs doctor
* Then doctor shows a command to release the review claim

## Scenario: Do not show incomplete release commands for review claims with held attempts

* Given A pull request has `agent:in-progress` and a retained launch-failed attempt
* When The operator runs doctor
* Then doctor does not show a command that releases only the review claim

## Scenario: Do not display incomplete release commands when held attempt records are corrupted

* Given A pull request has `agent:in-progress` and ownership of its retained attempt record cannot be determined
* When The operator runs doctor
* Then doctor does not show a command that releases only the review claim

## Scenario: Do not report a claim with an active review agent as a problem

* Given A pull request has `agent:in-progress` and an active review agent
* When The operator runs doctor
* Then doctor shows no findings

## Scenario: Show a command to inspect an implementation worktree with no active Worker

* Given An Issue with `agent:in-progress` has a worktree but no active Worker
* When The operator runs doctor
* Then doctor shows a command to inspect commits in the worktree

## Scenario: Do not report unclaimed targets as problems

* Given An Issue and a pull request have no claim labels
* When The operator runs doctor
* Then doctor shows no findings

## Scenario: Explicitly report no findings when no problem exists

* Given A deadloop project has no problems
* When The operator runs doctor
* Then doctor explicitly reports no findings

## Scenario: Show the source of imported configuration

* Given A deadloop project has no problems
* When The operator runs doctor
* Then doctor shows the configuration source
