# Feature: Select an explicit Issue Agent request

deadloop selects `agent:explore` or `agent:implement` without requiring the `ready-for-agent` triage label.
It still prevents duplicate work on a closed or in-progress Issue and keeps implementation dependencies gated.

## Scenario: Select a prepared Issue for work

* Given An eligible Issue has the `ready-for-agent` and `agent:implement` labels
* When deadloop selects a work target
* Then Issue #1 is selected for work

## Scenario: Do not select a closed Issue for work

* Given An Issue with all required public labels is closed
* When deadloop searches for a work target
* Then The closed Issue is not selected for work

## Scenario: Select implementation without the triage label

* Given An unprepared Issue lacks required public labels
* When deadloop selects a work target
* Then Issue #3 is selected for work

## Scenario: Do not select an Issue already in progress

* Given An Issue in progress has the `agent:in-progress` label
* When deadloop selects a work target
* Then The Issue in progress is not selected for work

## Scenario Outline: Do not select an Issue with an unfinished dependency in its body

* Given An Issue with all required public labels has an unfinished dependency in the "<location>"
* When deadloop selects a work target
* Then The Issue with an unfinished dependency is not selected for work

### Examples:

  | location |
  | dependency section |
  | end |

## Scenario: Select an Issue with a completed dependency in its body

* Given An eligible Issue has a completed dependency in its body
* When deadloop selects a work target
* Then Issue #2 is selected for work

## Scenario: Do not select an Issue with an unfinished GitHub dependency

* Given An Issue with all required public labels has an unfinished dependency on GitHub
* When deadloop selects a work target
* Then The Issue with an unfinished GitHub dependency is not selected for work
