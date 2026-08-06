# Feature: Reclaim only stale review claims

A deadloop user can reclaim a review claim only when no agent is active, then resume review of the same pull request.
This avoids taking a claim from an active or updating agent or from an intentionally blocked review, and prevents duplicate processing after reclaim.

## Scenario: Reclaim a stale review claim with no active agent

* Given A stale review claim has no active agent
* When deadloop searches for stale review claims to reclaim
* Then Review of pull request #13 resumes

## Scenario: Do not reclaim a claim while the Reviewer is active

* Given A review claim has an active Reviewer
* When deadloop searches for stale review claims to reclaim
* Then The review claim is not reclaimed

## Scenario: Do not reclaim a claim during the grace period for a branch-update agent

* Given A review claim is in the grace period while a branch-update agent completes
* When deadloop searches for stale review claims to reclaim
* Then The review claim is not reclaimed

## Scenario: Do not reclaim a claim whose completed Reviewer still has an attempt record

* Given A review claim has only a completed Reviewer and its attempt record remains
* When deadloop searches for stale review claims to reclaim
* Then The review claim is not reclaimed

## Scenario: Do not reclaim an intentionally blocked review claim

* Given A review claim is intentionally blocked
* When deadloop searches for stale review claims to reclaim
* Then The review claim is not reclaimed

## Scenario: Do not reclaim a claim again after a new Reviewer becomes active

* Given A reclaimed claim now has an active Reviewer
* When deadloop runs the next selection cycle
* Then The next selection cycle does not start another Reviewer
