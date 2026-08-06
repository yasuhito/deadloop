# Feature: Perform only the next action required by a deterministic automation decision

Automation users expect deterministic results not to start unnecessary agents and expect exactly one appropriate request only when judgment is required.

## Scenario: Do not send a prompt when no action is required

* Given Automation determines that no action is required
* When deadloop runs the automation
* Then deadloop does not send a prompt

## Scenario: Do not send a prompt when processing is complete

* Given Automation reports that processing is complete
* When deadloop runs the automation
* Then deadloop does not send a prompt

## Scenario: Send only the decision prompt when judgment is required

* Given Automation requires judgment
* When deadloop runs the automation
* Then deadloop sends only the decision prompt

## Scenario: Do not send a prompt for an invalid automation response

* Given Automation returns an invalid response
* When deadloop runs the automation
* Then deadloop does not send a prompt

## Scenario: Do not send a prompt when automation fails

* Given Automation has failed
* When deadloop runs the automation
* Then deadloop does not send a prompt

## Scenario: Do not send a prompt when automation reports a stop

* Given Automation reports a stop
* When deadloop runs the automation
* Then deadloop does not send a prompt

## Scenario: Send the normal prompt when no deterministic driver is configured

* Given Automation has no deterministic driver configured
* When deadloop runs the automation
* Then deadloop sends the normal prompt
