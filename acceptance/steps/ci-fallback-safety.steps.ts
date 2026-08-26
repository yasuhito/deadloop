import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

type AnyRecord = Record<string, any>;

const {
  decideCiFallbackMergeGate,
  decideCiFallbackRepair,
} = require("../../src/ci-review-policy.cts");
const { resolveCiEquivalentContract } = require("../../src/ci-equivalent-contract.cts");
const { projectsFromConfig } = require("../../src/core");

type CiFallbackWorld = {
  checks?: unknown[];
  fallbackRecord?: AnyRecord | null;
  headOid?: string;
  baseOid?: string;
  treeOid?: string;
  policyBaseRevision?: string;
  contract?: AnyRecord;
  gateDecision?: AnyRecord;
  contractInput?: AnyRecord;
  resolution?: AnyRecord;
  resolutionError?: Error;
  localConfig?: AnyRecord;
  configError?: Error;
  episode?: AnyRecord | null;
  humanRequestAfterEpisode?: boolean;
  repairDecision?: AnyRecord;
};

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "d".repeat(40);
const CONTRACT = {
  command: "npm ci && npm run check",
  derivation: "npm_convention",
  policySource: { kind: "npm_convention", location: "package-lock.json+package.json#scripts.check" },
};

function passedRecord(world: CiFallbackWorld, overrides: AnyRecord = {}): AnyRecord {
  return {
    version: 1,
    role: "merge_candidate",
    repository: "owner/repo",
    prNumber: 24,
    headOid: world.headOid ?? HEAD,
    baseOid: world.baseOid ?? BASE,
    treeOid: world.treeOid ?? TREE,
    command: (world.contract ?? CONTRACT).command,
    derivation: (world.contract ?? CONTRACT).derivation,
    policySource: (world.contract ?? CONTRACT).policySource,
    policyBaseRevision: world.policyBaseRevision ?? world.baseOid ?? BASE,
    outcome: "passed",
    exitCode: 0,
    logPath: "/state/ci-fallback/demo/logs/verification.log",
    ...overrides,
  };
}

function gateInput(world: CiFallbackWorld): AnyRecord {
  return {
    checks: world.checks ?? [],
    repository: "owner/repo",
    prNumber: 24,
    headOid: world.headOid ?? HEAD,
    baseOid: world.baseOid ?? BASE,
    treeOid: world.treeOid ?? TREE,
    contract: world.contract ?? CONTRACT,
    policyBaseRevision: world.policyBaseRevision ?? world.baseOid ?? BASE,
    fallbackRecord: world.fallbackRecord ?? null,
  };
}

Given("No GitHub checks exist on the merge candidate", function (this: CiFallbackWorld) {
  this.checks = [];
});

Given("One GitHub check is still pending on the merge candidate", function (this: CiFallbackWorld) {
  this.checks = [{ status: "IN_PROGRESS" }];
});

Given("One GitHub check reports no recognizable state", function (this: CiFallbackWorld) {
  this.checks = [{ status: "COMPLETED", conclusion: "MYSTERY" }];
});

Given("Every GitHub check succeeded on the merge candidate", function (this: CiFallbackWorld) {
  this.checks = [{ status: "COMPLETED", conclusion: "SUCCESS" }];
});

Given("At least one GitHub check failed terminally on the merge candidate", function (this: CiFallbackWorld) {
  this.checks = [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }];
});

Given("No CI fallback record exists for this candidate", function () {});

Given(
  "A passed CI fallback verification exists for this repository, PR, head, base, tree, command, derivation, policy source, and policy base revision",
  function (this: CiFallbackWorld) {
    this.fallbackRecord = passedRecord(this);
  },
);

Given("A passed CI fallback verification exists for this candidate", function (this: CiFallbackWorld) {
  this.fallbackRecord = passedRecord(this);
});

Given("The merge proceeds on fresh CI fallback evidence", function (this: CiFallbackWorld) {
  // Fallback evidence only exists after a terminal check failure, so the gate sees that state.
  this.checks = [{ status: "COMPLETED", conclusion: "FAILURE" }];
  this.fallbackRecord = passedRecord(this);
});

Given("A CI fallback verification of exactly this candidate failed", function (this: CiFallbackWorld) {
  this.checks = [{ status: "COMPLETED", conclusion: "FAILURE" }];
  this.fallbackRecord = passedRecord(this, { outcome: "failed", exitCode: 1 });
});

Given("The pull request head has advanced since the verification ran", function (this: CiFallbackWorld) {
  this.checks ??= [{ status: "COMPLETED", conclusion: "FAILURE" }];
  this.headOid = "e".repeat(40);
});

Given("The configured base head has advanced since the verification ran", function (this: CiFallbackWorld) {
  this.checks ??= [{ status: "COMPLETED", conclusion: "FAILURE" }];
  this.baseOid = "9".repeat(40);
});

Given("Trusted-base deadloop.json declares ciEquivalentCommand `make ci`", function (this: CiFallbackWorld) {
  this.contractInput = { repoPolicyCiCommand: "make ci" };
});

Given("No explicit CI-equivalent command is declared", function (this: CiFallbackWorld) {
  this.contractInput ??= {};
});

Given(
  "Trusted base contains package-lock.json and a package.json scripts.check entry",
  function (this: CiFallbackWorld) {
    Object.assign(this.contractInput, { npmLockfilePresent: true, npmCheckScriptPresent: true });
  },
);

Given(
  "Trusted base has neither a lockfile nor a scripts.check entry",
  function () {},
);

Given("projects.json configures removed legacy ciFallback settings", function (this: CiFallbackWorld) {
  this.localConfig = { projects: [{ githubRepo: "owner/repo", ciFallback: { enabled: true } }] };
});

Given("Trusted-base deadloop.json declares ciEquivalentCommand as an empty string", function (this: CiFallbackWorld) {
  this.contractInput = { repoPolicyCiCommand: "   " };
});

Given("An episode recorded zero repairs for this base-and-command pair", function (this: CiFallbackWorld) {
  this.episode = { episodeKey: "cifb-current", repairsUsed: 0 };
  this.humanRequestAfterEpisode = false;
});

Given("An episode already used its one repair for this base-and-command pair", function (this: CiFallbackWorld) {
  this.episode = { episodeKey: "cifb-current", repairsUsed: 1 };
  this.humanRequestAfterEpisode = false;
});

Given("No human Agent request arrived after the episode started", function () {});

Given("A human added an Agent request after the episode started", function (this: CiFallbackWorld) {
  this.humanRequestAfterEpisode = true;
});

When("deadloop decides the merge gate", function (this: CiFallbackWorld) {
  this.gateDecision = decideCiFallbackMergeGate(gateInput(this));
});

When("deadloop reports the basis of the merge", function (this: CiFallbackWorld) {
  this.gateDecision = decideCiFallbackMergeGate(gateInput(this));
});

When("deadloop resolves the CI-equivalent verification contract", function (this: CiFallbackWorld) {
  try {
    this.resolution = resolveCiEquivalentContract(this.contractInput ?? {});
  } catch (error) {
    this.resolutionError = error as Error;
  }
});

When("deadloop loads the configuration", function (this: CiFallbackWorld) {
  try {
    projectsFromConfig(this.localConfig);
  } catch (error) {
    this.configError = error as Error;
  }
});

When("deadloop decides whether another CI fallback repair may start", function (this: CiFallbackWorld) {
  this.repairDecision = decideCiFallbackRepair({
    episode: this.episode ?? null,
    humanRequestAfterEpisode: Boolean(this.humanRequestAfterEpisode),
    expectedEpisodeKey: "cifb-current",
  });
});

Then("The merge proceeds because checks are absent", function (this: CiFallbackWorld) {
  assert.equal((this.gateDecision as AnyRecord).basis, "no_checks");
});

Then("deadloop waits instead of starting CI fallback verification", function (this: CiFallbackWorld) {
  assert.equal((this.gateDecision as AnyRecord).reason, "checks_pending");
});

Then("deadloop stops with an unknown-check-state stop", function (this: CiFallbackWorld) {
  assert.equal((this.gateDecision as AnyRecord).reason, "unknown_check_state");
});

Then("The merge proceeds on CI success without fallback evidence", function (this: CiFallbackWorld) {
  assert.equal((this.gateDecision as AnyRecord).basis, "ci_success");
});

Then("deadloop stops asking for CI-equivalent verification of the prospective merge tree", function (this: CiFallbackWorld) {
  assert.equal((this.gateDecision as AnyRecord).reason, "ci_fallback_required");
});

Then("The merge proceeds on CI fallback evidence", function (this: CiFallbackWorld) {
  assert.equal((this.gateDecision as AnyRecord).basis, "ci_fallback");
});

Then("The basis is CI fallback rather than CI success", function (this: CiFallbackWorld) {
  const basis = String((this.gateDecision as AnyRecord).basis);
  assert.deepEqual({ basis }, { basis: "ci_fallback" });
});

Then("deadloop stops because the persisted fallback evidence is stale", function (this: CiFallbackWorld) {
  assert.equal((this.gateDecision as AnyRecord).reason, "ci_fallback_stale");
});

Then("deadloop stops with a CI-fallback-failed stop instead of re-running verification", function (this: CiFallbackWorld) {
  assert.equal((this.gateDecision as AnyRecord).reason, "ci_fallback_failed");
});

Then("The contract command is `make ci` derived from explicit repo policy", function (this: CiFallbackWorld) {
  const resolution = this.resolution as AnyRecord;
  assert.deepEqual(
    { command: resolution.command, derivation: resolution.derivation },
    { command: "make ci", derivation: "explicit_repo_policy" },
  );
});

Then("The contract command is `npm ci && npm run check`", function (this: CiFallbackWorld) {
  assert.equal((this.resolution as AnyRecord).command, "npm ci && npm run check");
});

Then("The contract is unavailable so CI fallback never runs", function (this: CiFallbackWorld) {
  assert.deepEqual((this.resolution as AnyRecord), { status: "unavailable", reason: "no_contract" });
});

Then("Configuration loading fails naming the removed settings", function (this: CiFallbackWorld) {
  assert.match(String((this.configError as Error)?.message), /legacy CI fallback/);
});

Then("Resolution fails naming the explicit empty command", function (this: CiFallbackWorld) {
  assert.match(String((this.resolutionError as Error)?.message), /configuration error/);
});

Then("The repair starts inside the same episode", function (this: CiFallbackWorld) {
  assert.deepEqual(this.repairDecision, { action: "repair_allowed", episodeReset: false });
});

Then("The second repair is blocked", function (this: CiFallbackWorld) {
  assert.deepEqual(this.repairDecision, { action: "repair_blocked", reason: "second_failure_in_episode" });
});

Then("A new episode allows the repair again", function (this: CiFallbackWorld) {
  assert.deepEqual(this.repairDecision, { action: "repair_allowed", episodeReset: true });
});
