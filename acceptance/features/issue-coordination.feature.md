# Feature: Advance a selected Issue to exactly one next action

deadloop checks the selected Issue's implementation contract and role, then safely provides user guidance, waits for a plan to be split, or monitors started implementation.

This prevents implementation of an unprepared Issue and overlapping actions on the same Issue.

## Scenario: Do not delegate a missing implementation contract to the language model

* Given The selected Issue lacks the required implementation contract
* When deadloop decides the selected Issue's next action
* Then deadloop blocks the Issue without using the language model

## Scenario: Do not start work if implementation contract is missing

* Given The selected Issue lacks the required implementation contract
* When deadloop decides the selected Issue's next action
* Then Work on the Issue does not start

## Scenario: Do not start completion monitoring if there is a missing implementation contract

* Given The selected Issue lacks the required implementation contract
* When deadloop decides the selected Issue's next action
* Then Completion monitoring for the Issue does not start

## Scenario: List required items when the implementation contract is missing

* Given The selected Issue lacks the required implementation contract
* When deadloop decides the selected Issue's next action
* Then deadloop lists the implementation-contract items to add to the Issue

## Scenario: Provide guidance on how to requeue after modifying the implementation contract

* Given The selected Issue lacks the required implementation contract
* When deadloop decides the selected Issue's next action
* Then deadloop explains how to requeue the corrected Issue

## Scenario: Wait for a planning Issue to be split into implementable units

* Given The selected Issue is a planning Issue
* When deadloop decides the selected Issue's next action
* Then deadloop explains how to split the plan into implementable Issues

## Scenario: Provide recovery steps for a planning Issue

* Given The selected Issue is a planning Issue
* When deadloop decides the selected Issue's next action
* Then deadloop provides recovery steps after blocking the Issue

## Scenario: Explain how to requeue the split implementable Issues

* Given The selected Issue is a planning Issue
* When deadloop decides the selected Issue's next action
* Then deadloop explains how to add the selection labels to the split Issues

## Scenario: Do not include internal operational information in the blocking comment of Issue for planning

* Given The selected Issue is a planning Issue
* When deadloop decides the selected Issue's next action
* Then The blocking comment are created only as a guide for users.

## Scenario: Do not start work for a planning Issue

* Given The selected Issue is a planning Issue
* When deadloop decides the selected Issue's next action
* Then Work on the Issue does not start

## Scenario: Do not start completion monitoring for a planning Issue

* Given The selected Issue is a planning Issue
* When deadloop decides the selected Issue's next action
* Then Completion monitoring for the Issue does not start

## Scenario: Do not start work for an Issue that only lists child Issues

* Given The selected Issue only lists child Issues
* When deadloop decides the selected Issue's next action
* Then Work on the Issue does not start

## Scenario: Monitor an implementable Issue that references a design document

* Given Selected implementable Issue references design document
* When deadloop decides the selected Issue's next action
* Then Completion monitoring starts for the Issue

## Scenario: Monitor an implementable Issue that references its parent in acceptance criteria

* Given Selected implementable Issue references parent Issue in acceptance criteria
* When deadloop decides the selected Issue's next action
* Then Completion monitoring starts for the Issue

## Scenario: Start work for an implementable Issue

* Given The selected Issue has an implementation contract.
* When deadloop decides the selected Issue's next action
* Then Work on the Issue starts

## Scenario: Do not include internal implementation name in implementable Issue work instructions

* Given The selected Issue has an implementation contract.
* When deadloop decides the selected Issue's next action
* Then The work instructions contain only information needed by the implementation agent

## Scenario: Monitor an implementable Issue after starting work

* Given The selected Issue has an implementation contract.
* When deadloop decides the selected Issue's next action
* Then Completion monitoring starts for the Issue

## Scenario: Do not overlay blocking guidance on implementable Issue

* Given The selected Issue has an implementation contract.
* When deadloop decides the selected Issue's next action
* Then No blocking guidance is created for the Issue
