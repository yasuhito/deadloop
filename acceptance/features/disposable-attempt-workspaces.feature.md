# Feature: Use a fresh pane for every attempt

Safely hand a worktree to the next attempt without leaving the completed agent's pane active.

## Scenario: Show a running agent in only one workspace and one pane

* Given A new work attempt can start
* When deadloop starts the agent
* Then The agent appears in exactly one workspace and one pane

## Scenario: Reopen an abandoned Worker's worktree for a new attempt

* Given A Worker's worktree remains after its launch failure was abandoned with evidence
* When deadloop starts the requeued Worker
* Then deadloop opens the same worktree in a fresh workspace

## Scenario: Close only the workspace of the agent that handed off the PR

* Given The agent's PR and completion report agree
* When deadloop reconciles the completed attempt
* Then The agent's workspace is gone and the worktree remains

## Scenario: Open the same worktree in a fresh workspace for the Reviewer

* Given The Worker's workspace was closed safely
* When deadloop starts the Reviewer in a fresh workspace
* Then The Reviewer uses a separate fresh workspace

## Scenario: Do not reuse the Reviewer's pane for repair and branch-update agents

* Given The review result was saved to GitHub and the Reviewer workspace was closed
* When deadloop starts the repair agent and branch-update agent
* Then Each agent uses a fresh workspace

## Scenario: Preserve a blocked attempt for investigation

* Given The agent blocked its work for a safety reason
* When deadloop reconciles the completed attempt
* Then deadloop preserves the agent's workspace and worktree

## Scenario: Do not close a workspace for a malformed completion report

* Given The agent's completion report is malformed
* When deadloop reconciles the completed attempt
* Then deadloop preserves the agent's workspace and worktree

## Scenario: Do not close a workspace when GitHub persistence cannot be confirmed

* Given The agent's result cannot be confirmed on GitHub
* When deadloop reconciles the completed attempt
* Then deadloop preserves the agent's workspace and worktree

## Scenario: Stop before candidate selection when Herdr is unsupported

* Given The automation host is connected to an unsupported Herdr
* When deadloop starts an automation cycle
* Then deadloop stops without changing GitHub or a workspace

## Scenario: Do not retry while a retained workspace remains under investigation

* Given A workspace retained for investigation remains on the same worktree
* When deadloop considers starting the next agent
* Then deadloop does not start a new agent on the same worktree

## Scenario: Reclaim a persisted success safely after restart

* Given The automation host stopped after persisting the result to GitHub
* When deadloop reconciles the attempt after restart
* Then deadloop closes only the persisted workspace and leaves the worktree

## Scenario: Preserve a workspace whose owner cannot be identified after restart

* Given The workspace owner cannot be identified after restart
* When deadloop reconciles the attempt after restart
* Then deadloop does not close a workspace with an unknown owner

## Scenario: Remove only worktrees that pass post-PR safety checks

* Given The PR is complete and its worktree is clean and untracked by Herdr
* When deadloop cleans up the PR worktree
* Then Only a worktree that passes the safety checks is selected for removal
