# Feature: Perform only the next action required by a deterministic automation decision

Automation users expect deterministic results not to start unnecessary agents and expect exactly one appropriate action per tick.

## Scenario: Record that no action is required

* Given Automation determines that no action is required
* When deadloop runs the automation
* Then deadloop records the driver skip result

## Scenario: Record that processing is complete

* Given Automation reports that processing is complete
* When deadloop runs the automation
* Then deadloop records the driver done result

## Scenario: Record an invalid automation response as a failure

* Given Automation returns an invalid response
* When deadloop runs the automation
* Then deadloop records the driver invalid JSON failure

## Scenario: Record an automation failure

* Given Automation has failed
* When deadloop runs the automation
* Then deadloop records the driver error failure

## Scenario: Record an automation stop as an error

* Given Automation reports a stop
* When deadloop runs the automation
* Then deadloop records the driver error failure

## Scenario: Reject an automation without a deterministic driver

* Given Automation has no deterministic driver configured
* When deadloop loads the project configuration
* Then deadloop reports a configuration error
