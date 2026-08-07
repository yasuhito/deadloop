# Feature: Start a work agent once and monitor it to completion

Start each Issue's work agent exactly once in a dedicated worktree and monitor it safely until its promise file is complete.
This avoids disrupting an active agent or an agent on another worktree and avoids terminating active work prematurely.

## Scenario: Create a dedicated worktree from the base branch for a prepared Issue

* Given An Issue is ready for work
* When deadloop starts the Issue's agent
* Then The agent receives a dedicated Issue worktree from the base branch

## Scenario: Start the agent for a prepared Issue exactly once

* Given An Issue is ready for work
* When deadloop starts the Issue's agent
* Then deadloop starts exactly one new agent

## Scenario: Hand the started agent off to promise-file monitoring

* Given An Issue ready for work has been selected
* When deadloop starts work on the selected Issue
* Then The Issue enters promise-file monitoring

## Scenario: Continue monitoring an agent with recent activity after a report request

* Given The agent has recent activity after being asked for a promise file
* When deadloop evaluates the agent's monitoring state
* Then deadloop continues monitoring the agent

## Scenario: Continue monitoring during the grace period after requesting a promise file

* Given The promise-file request is still within its grace period
* When deadloop evaluates the agent's monitoring state
* Then deadloop continues monitoring the agent

## Scenario: Request a promise file before terminating an agent that has finished activity

* Given An agent has finished activity without writing a promise file
* When deadloop evaluates the agent's monitoring state
* Then deadloop asks the agent to write the promise file

## Scenario: Permit termination only after confirming inactivity and expiry of the grace period

* Given Agent inactivity and expiry of the post-request grace period are confirmed
* When deadloop evaluates the agent's monitoring state
* Then deadloop permits the agent pane to close

## Scenario: Collect missing observations before deciding to terminate

* Given The post-request grace period expired without an observation of the agent pane
* When deadloop evaluates the agent's monitoring state
* Then deadloop collects the missing observation before termination

## Scenario Outline: End monitoring when the promise file is complete regardless of agent state

* Given The <status> agent has finished writing the promise file
* When deadloop evaluates the agent's monitoring state
* Then deadloop ends monitoring according to the promise file

### Examples:

  | status |
  | working |
  | done |
