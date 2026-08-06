# Feature: Allow CI fallback verification only for confirmed infrastructure failures

Do not overlook ordinary CI failures; use fallback verification only for a confirmed infrastructure failure.

## Scenario: Do not allow CI fallback verification without explicit configuration

* Given CI fallback verification is not explicitly configured
* When deadloop decides whether CI fallback verification is allowed
* Then CI fallback verification is not allowed

## Scenario: Allow CI fallback verification when every job fails before execution

* Given CI fallback verification is explicitly enabled
* And Every CI job fails immediately before execution
* When deadloop decides whether CI fallback verification is allowed
* Then CI fallback verification is allowed

## Scenario: Classify every job failing before execution as a CI infrastructure failure

* Given CI fallback verification is explicitly enabled
* And Every CI job fails immediately before execution
* When deadloop decides whether CI fallback verification is allowed
* Then The failure is classified as a CI infrastructure failure

## Scenario: Do not allow CI fallback verification for an ordinary test failure

* Given CI fallback verification is explicitly enabled
* And An ordinary test fails in CI
* When deadloop decides whether CI fallback verification is allowed
* Then CI fallback verification is not allowed

## Scenario: Classify an ordinary test failure as an ordinary CI failure

* Given CI fallback verification is explicitly enabled
* And An ordinary test fails in CI
* When deadloop decides whether CI fallback verification is allowed
* Then The failure is classified as an ordinary CI failure

## Scenario: Allow CI fallback verification when billing restrictions prevent CI from running

* Given CI fallback verification is explicitly enabled
* And Billing restrictions prevent CI from running
* When deadloop decides whether CI fallback verification is allowed
* Then CI fallback verification is allowed

## Scenario: Do not allow CI fallback verification when only some CI jobs fail

* Given CI fallback verification is explicitly enabled
* And Only some CI jobs fail
* When deadloop decides whether CI fallback verification is allowed
* Then CI fallback verification is not allowed

## Scenario: Do not allow CI fallback verification when a CI job fails after execution starts

* Given CI fallback verification is explicitly enabled
* And A CI job fails after execution starts
* When deadloop decides whether CI fallback verification is allowed
* Then CI fallback verification is not allowed
