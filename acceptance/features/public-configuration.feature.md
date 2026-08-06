# Feature: Apply public configuration safely to launches, status, and automation decisions

A deadloop user can observe which configuration source was selected, how an agent is launched, and whether dangerous automation is enabled.

## Scenario: Use the configuration file specified by an environment variable in status

* Given Environment, user, and bundled scopes contain different configuration
* And `DEADLOOP_CONFIG` selects the environment configuration
* When deadloop status is requested
* Then Status shows the environment configuration file

## Scenario: Prefer user configuration over bundled configuration in status

* Given Environment, user, and bundled scopes contain different configuration
* And `DEADLOOP_CONFIG` is not specified
* When deadloop status is requested
* Then Status shows the user configuration file

## Scenario: Use bundled configuration in status when user configuration is absent

* Given Only bundled configuration is available
* When deadloop status is requested
* Then Status shows the bundled configuration file

## Scenario: Show the two default automations when automation configuration is omitted

* Given Local configuration is empty
* When deadloop status is requested
* Then Status shows two default automations

## Scenario: Show no enabled automation when automation configuration is empty

* Given Local configuration contains no automations
* When deadloop status is requested
* Then Status shows no enabled automation

## Scenario: Launch a Worker with pi when agent configuration is omitted

* Given Local configuration is empty
* When A Worker launch is requested
* Then The Worker launch command is pi

## Scenario: Launch a Reviewer with pi when agent configuration is omitted

* Given Local configuration is empty
* When A Reviewer launch is requested
* Then The Reviewer launch command is pi

## Scenario: Launch the configured Worker agent

* Given Local configuration specifies claude and `worker-local-model` for Worker
* When A Worker launch is requested
* Then The Worker is launched with the configured agent type

## Scenario: Launch the configured Worker model

* Given Local configuration specifies claude and `worker-local-model` for Worker
* When A Worker launch is requested
* Then The Worker is launched with the configured model

## Scenario: Launch the configured Reviewer agent

* Given Local configuration specifies claude and `reviewer-local-model` for Reviewer
* When A Reviewer launch is requested
* Then The Reviewer is launched with the configured agent type

## Scenario: Launch the configured Reviewer model

* Given Local configuration specifies claude and `reviewer-local-model` for Reviewer
* When A Reviewer launch is requested
* Then The Reviewer is launched with the configured model

## Scenario: Fill an omitted Worker agent type from shared policy

* Given Shared policy specifies a Worker agent type and model and local configuration is empty
* When A Worker launch is requested
* Then The Worker is launched with the shared-policy agent type

## Scenario: Fill an omitted Worker model from shared policy

* Given Shared policy specifies a Worker agent type and model and local configuration is empty
* When A Worker launch is requested
* Then The Worker is launched with the shared-policy model

## Scenario: Prefer the local Worker agent type over shared policy

* Given Local configuration and shared policy specify different Worker agent types and models
* When A Worker launch is requested
* Then The Worker is launched with the local agent type

## Scenario: Prefer the local Worker model over shared policy

* Given Local configuration and shared policy specify different Worker agent types and models
* When A Worker launch is requested
* Then The Worker is launched with the local model

## Scenario: Fill an omitted Reviewer agent type from shared policy

* Given Shared policy specifies a Reviewer agent type and model and local configuration is empty
* When A Reviewer launch is requested
* Then The Reviewer is launched with the shared-policy agent type

## Scenario: Fill an omitted Reviewer model from shared policy

* Given Shared policy specifies a Reviewer agent type and model and local configuration is empty
* When A Reviewer launch is requested
* Then The Reviewer is launched with the shared-policy model

## Scenario: Prefer the local Reviewer agent type over shared policy

* Given Local configuration and shared policy specify different Reviewer agent types and models
* When A Reviewer launch is requested
* Then The Reviewer is launched with the local agent type

## Scenario: Prefer the local Reviewer model over shared policy

* Given Local configuration and shared policy specify different Reviewer agent types and models
* When A Reviewer launch is requested
* Then The Reviewer is launched with the local model

## Scenario: Preserve disabled automation from an empty shared-policy automation list

* Given Shared policy contains no automations and local configuration is empty
* When deadloop status is requested
* Then Status shows no enabled automation

## Scenario: Show shared-policy automation omitted from local configuration

* Given Shared policy contains automation and local configuration is empty
* When deadloop status is requested
* Then Status shows the shared-policy automation

## Scenario: Show automatic merge as disabled when configuration is omitted

* Given Local configuration is empty
* When deadloop status is requested
* Then Status shows automatic merge as disabled

## Scenario: Disallow CI fallback verification when configuration is omitted

* Given Local configuration is empty
* When CI fallback permission is determined from public configuration
* Then Public configuration does not allow CI fallback verification

## Scenario: Show external review as disabled when configuration is omitted

* Given Local configuration is empty
* When deadloop status is requested
* Then Status shows external review as disabled

## Scenario: Show automatic merge as enabled only when explicitly enabled locally

* Given Local configuration explicitly enables automatic merge
* When deadloop status is requested
* Then Status shows automatic merge as enabled

## Scenario: Show external review inherited from shared policy

* Given Shared policy enables external review and local configuration is empty
* When deadloop status is requested
* Then Status shows external review as enabled
