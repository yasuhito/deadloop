# Feature: Resume review of an updated pull request exactly once

When a pull request head changes after repair or conflict recovery, deadloop replaces only a completed Reviewer and resumes normal review exactly once.
This prevents duplicate launches that retain the previous head's Reviewer and avoids terminating an active Reviewer by mistake.

`@requeued-pr-review`
## Scenario: Resume normal review of the updated pull request exactly once

* Given A blocked pull request has a completed Reviewer and its head changed after repair
* When deadloop checks the pull request after agent:blocked is removed
* Then deadloop starts exactly one Reviewer for the new head

`@requeued-pr-review`
## Scenario: Resume with a new Reviewer instead of reusing the completed Reviewer

* Given A blocked pull request has a completed Reviewer and its head changed after repair
* When deadloop checks the pull request after agent:blocked is removed
* Then deadloop starts a new Reviewer without reusing the completed Reviewer

`@requeued-pr-review`
## Scenario: Hand the updated pull request head to the Reviewer

* Given A blocked pull request has a completed Reviewer and its head changed after repair
* When deadloop checks the pull request after agent:blocked is removed
* Then The Reviewer handoff uses the repaired head

`@requeued-pr-review`
## Scenario: Record the history the completed review will be judged against

* Given A blocked pull request has a completed Reviewer and its head changed after repair
* When deadloop checks the pull request after agent:blocked is removed
* Then The recorded review history holds the claim comment the launch posted
