# Feature: Start a work agent once and monitor it deterministically to completion

Start each Issue's work agent exactly once in a dedicated worktree and monitor it with the shared deterministic attempt monitor until its completion report settles.
This avoids disrupting an active agent or an agent on another worktree and avoids terminating active work prematurely.

## Scenario: Create a dedicated worktree from the base branch for a prepared Issue

* Given An Issue is ready for work
* When deadloop starts the Issue's agent
* Then The agent receives a dedicated Issue worktree from the base branch

## Scenario: Start the agent for a prepared Issue exactly once

* Given An Issue is ready for work
* When deadloop starts the Issue's agent
* Then deadloop starts exactly one new agent

## Scenario: Hand the started Worker off to deterministic attempt monitoring

* Given An Issue ready for work has been selected
* When deadloop starts work on the selected Issue
* Then The driver registers model-free deterministic monitoring for the Issue

## Scenario: Keep the started Worker's monitoring off the Automation host model

* Given An Issue ready for work has been selected
* When deadloop starts work on the selected Issue
* Then deadloop queues no host-model prompt for the Issue

## Scenario: Bind the monitored attempt to the consumed request generation

* Given An Issue ready for work has been selected
* When deadloop starts work on the selected Issue
* Then The monitor handoff carries the consumed request generation

## Scenario: Keep the launched attempt's monitoring handoff on disk beside its journal

* Given An Issue ready for work has been selected
* When deadloop starts work on the selected Issue
* Then The driver records a durable launch handoff beside the attempt journal

## Scenario: Keep a working runtime active on quiet output through the shared directive interface

* Given A monitored Issue Worker whose runtime reports working status past its last observation
* When the deterministic monitor evaluates the attempt
* Then deadloop continues the attempt as working

## Scenario: Stop an idle runtime that ended without a completion report instead of nudging it

* Given A monitored Issue Worker whose runtime ended terminally without writing a report
* When the deterministic monitor evaluates the attempt
* Then deadloop records a missing report without sending any monitor prompt

## Scenario: Keep every launched role monitored without the Automation host model

* Given Deterministic monitoring registered for a Worker, explorer, reviewer, branch-update, and repair attempt
* When deadloop monitors every role across repeated scheduler ticks
* Then deadloop queues no host-model prompt for any role
