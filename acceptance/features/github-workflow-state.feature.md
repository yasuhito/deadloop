# Feature: Treat GitHub as the workflow state source of truth

deadloop reads workflow state only from GitHub: request labels are one-shot events, current state is `agent:in-progress` or `agent:blocked`, and local attempt journals are evidence that neither selects nor suppresses work. Retired labels and legacy states migrate through the same production paths.
This prevents local state from silently overriding what GitHub shows.
## Scenario: Do not treat the retired reviewing label as a review request

* Given A pull request carries the retired `agent:reviewing` label with in-progress state and no live agent
* When deadloop searches for review target
* Then No review target is selected

## Scenario: Keep an owned reviewing pull request out of selection

* Given There is a pull request being reviewed by another agent.
* When deadloop searches for review target
* Then No review target is selected

## Scenario: Select a waiting review request despite a retained finished-attempt journal

* Given A pull request waits for review with a retained journal from its finished attempt
* When deadloop searches for review target
* Then deadloop selects pull request #7 for review

## Scenario: Reclaim a migrating pull request whose reviewing state has no live owner

* Given A migrating pull request carries both the retired reviewing label and a review request with stale in-progress state
* When deadloop searches for review target
* Then The selection reason is stale review claim recovery

## Scenario: Start exploration when exploration and implementation requests wait on one Issue

* Given An Issue carries both an exploration and an implementation request
* When deadloop processes the Issue's queued requests
* Then The explorer starts for the Issue

## Scenario: Consume only the exploration request and keep implementation queued

* Given An Issue carries both an exploration and an implementation request
* When deadloop processes the Issue's queued requests
* Then The implementation request stays queued after exploration consumes its own

## Scenario: Bind the launched exploration to its labeled event

* Given An Issue carries both an exploration and an implementation request
* When deadloop processes the Issue's queued requests
* Then The explorer binds to the exploration request event

## Scenario: Hand off as ready with no agent workflow label

* Given An approved draft pull request is handed to people
* Then The handoff removes every agent workflow label and adds none

## Scenario: Complete the human handoff only for a ready pull request without workflow labels
* Then The human handoff is complete for a ready pull request with no labels left
