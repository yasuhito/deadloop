# Feature: Select only an Issue that is ready to start

deadloop checks Agent requests, GitHub dependencies, and Issue state and selects only an Issue that can be started safely.
This prevents duplicate work on an Issue that is closed, unrequested, in progress, blocked, or has unfinished dependencies.

## Scenario: Select an implementation request without a triage label

* Given An eligible Issue has the `agent:implement` request without `ready-for-agent`
* When deadloop selects a work target
* Then Issue #1 is selected for work

## Scenario: Do not select an Issue without an implementation request

* Given An Issue lacks the required implementation request
* When deadloop selects a work target
* Then The unprepared Issue is not selected for work

## Scenario: Do not select an Issue already in progress

* Given An Issue in progress has the `agent:in-progress` label
* When deadloop selects a work target
* Then The Issue in progress is not selected for work

## Scenario: Do not select a blocked Issue for work

* Given A blocked Issue has the `agent:blocked` label
* When deadloop selects a work target
* Then The blocked Issue is not selected for work

## Scenario: Do not select an Issue with an unfinished GitHub dependency

* Given An Issue with all required public labels has an unfinished dependency on GitHub
* When deadloop selects a work target
* Then The Issue with an unfinished GitHub dependency is not selected for work

## Scenario: Do not select an Issue with an unfinished dependency in another repository

* Given An Issue with all required public labels has an unfinished dependency on another repository
* When deadloop selects a work target
* Then The Issue with an unfinished GitHub dependency is not selected for work

## Scenario: Select an Issue whose GitHub dependencies are all closed

* Given An eligible Issue whose GitHub dependencies are all closed
* When deadloop selects a work target
* Then Issue #2 is selected for work

## Scenario: Select an Issue whose only dependency is a closed Issue in another repository

* Given An eligible Issue whose only GitHub dependency is a closed Issue in another repository
* When deadloop selects a work target
* Then Issue #2 is selected for work

## Scenario: Select an Issue that mentions Blocked by in its body without a GitHub dependency

* Given An eligible Issue whose body mentions Blocked by without a GitHub dependency
* When deadloop selects a work target
* Then Issue #2 is selected for work
