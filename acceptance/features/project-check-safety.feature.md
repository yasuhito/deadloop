# Feature: Restore runtime artifacts after a project check

Isolate untracked runtime artifacts only during verification and preserve their evidence regardless of how the check ends.
Do not isolate tracked artifacts; fail closed instead.

## Scenario: Isolate untracked runtime artifacts so recursive verification succeeds

* Given A project is configured for deadloop project checks
* And The project contains untracked runtime artifacts
* When deadloop runs recursive verification
* Then Recursive verification succeeds

## Scenario: Restore the completion report after a successful project check

* Given A project is configured for deadloop project checks
* And The project contains untracked runtime artifacts
* When deadloop runs a successful project check
* Then The completion report is restored with its original contents

## Scenario: Fail recursive verification for an invalid tracked product file

* Given A project is configured for deadloop project checks
* And The project contains untracked runtime artifacts
* And The project contains an invalid tracked file
* When deadloop runs recursive verification
* Then Recursive verification fails

## Scenario: Do not run a project check when an agent scratch area contains a tracked file

* Given A project is configured for deadloop project checks
* And An agent scratch area contains a tracked file
* When deadloop attempts to start a project check
* Then deadloop does not run the project check

## Scenario: Fail closed when an agent scratch area contains a tracked file

* Given A project is configured for deadloop project checks
* And An agent scratch area contains a tracked file
* When deadloop attempts to start a project check
* Then The project check returns a failure result

## Scenario: Restore the completion report after a failed project check

* Given A project is configured for deadloop project checks
* And The project contains untracked runtime artifacts
* When deadloop runs a failing project check
* Then The completion report is restored with its original contents

## Scenario: Restore diagnostic information after a timed-out project check

* Given A project is configured for deadloop project checks
* And The project contains untracked runtime artifacts
* When deadloop runs a project check that times out
* Then The diagnostic information is restored with its original contents

## Scenario: Terminate a timed-out project check that ignores the termination request

* Given A project is configured for deadloop project checks
* And The project contains untracked runtime artifacts
* When deadloop times out a project check that ignores termination requests
* Then The timed-out project check terminates promptly

## Scenario: Restore diagnostic information after forcibly terminating a timed-out project check

* Given A project is configured for deadloop project checks
* And The project contains untracked runtime artifacts
* When deadloop times out a project check that ignores termination requests
* Then The diagnostic information is restored with its original contents

## Scenario: Restore diagnostic information after interrupting the CLI

* Given A project is configured for deadloop project checks
* And The project contains untracked runtime artifacts
* When The deadloop project-check CLI is interrupted
* Then The diagnostic information is restored with its original contents

## Scenario: Report an interrupted project check as interrupted

* Given A project is configured for deadloop project checks
* And The project contains untracked runtime artifacts
* When deadloop interrupts the project check
* Then The project check is reported as interrupted
