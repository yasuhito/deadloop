import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import {
  resolveRequiredVerification,
  type RequiredVerificationResolution,
  type RequiredVerificationSource,
} from "../../src/required-verification";
import {
  observeDoctor,
  observeStatus,
  resolveSelectedProject,
} from "../support/public-configuration-adapter";

const revision = "b".repeat(40);

type VerificationWorld = {
  localSources?: RequiredVerificationSource[];
  sharedSources?: RequiredVerificationSource[];
  resolution?: RequiredVerificationResolution;
  status?: string;
  doctor?: string;
};

function local(command: string, location = "/state/projects.json#demo"): RequiredVerificationSource {
  return { kind: "local", location, command };
}

function shared(command: string): RequiredVerificationSource {
  return { kind: "repo_policy", location: "deadloop.json", command };
}

Given(
  "Local configuration has `npm run local-check` and shared policy has `npm run shared-check`",
  function (this: VerificationWorld) {
    this.localSources = [local("npm run local-check")];
    this.sharedSources = [shared("npm run shared-check")];
  },
);

Given("The same local precedence contains different required verification values", function (this: VerificationWorld) {
  this.localSources = [local("npm test", "/first"), local("npm run check", "/second")];
});

Given("No required verification source is available", function (this: VerificationWorld) {
  this.localSources = [];
  this.sharedSources = [];
});

Given("Shared policy contains an empty required verification command", function (this: VerificationWorld) {
  this.sharedSources = [shared("")];
});

Given("Shared policy contains `true`", function (this: VerificationWorld) {
  this.sharedSources = [shared("true")];
});

Given("Shared policy contains `npm run check`", function (this: VerificationWorld) {
  this.sharedSources = [shared("npm run check")];
});

When("required verification is resolved", function (this: VerificationWorld) {
  this.resolution = resolveRequiredVerification({
    repository: "owner/repo",
    baseRevision: revision,
    localSources: this.localSources || [],
    sharedSources: this.sharedSources || [],
  });
});

When("Status and doctor are requested from a repository subdirectory", function (this: VerificationWorld) {
  const project = resolveSelectedProject({
    env: { DEADLOOP_CONFIG: "/state/projects.json" },
    files: { "/state/projects.json": {} },
    policy: { checkCommand: "npm run check" },
  });
  this.status = observeStatus(project, "/repo/subdir");
  this.doctor = observeDoctor(project, "/repo/subdir");
});

function contract(world: VerificationWorld) {
  if (world.resolution?.status !== "resolved") throw new Error("required verification was not resolved");
  return world.resolution.contract;
}

Then("The effective command is `npm run local-check`", function (this: VerificationWorld) {
  assert.equal(contract(this).command, "npm run local-check");
});

Then("The effective command is `true`", function (this: VerificationWorld) {
  assert.equal(contract(this).command, "true");
});

Then("The shared-policy value remains in the override information", function (this: VerificationWorld) {
  assert.deepEqual(contract(this).override, {
    source: { kind: "repo_policy", location: "deadloop.json" },
    command: "npm run shared-check",
  });
});

Then("The blocked reason is `{word}`", function (this: VerificationWorld, reason: string) {
  assert.equal(this.resolution?.status === "blocked" ? this.resolution.reason : undefined, reason);
});

Then("The resolution includes the command, source, base revision, and repository", function (this: VerificationWorld) {
  assert.deepEqual(contract(this), {
    repository: "owner/repo",
    command: "npm run check",
    source: { kind: "repo_policy", location: "deadloop.json" },
    baseRevision: revision,
  });
});

Then("Both required verification displays are identical", function (this: VerificationWorld) {
  const line = (report: string | undefined) => report?.split("\n").find((candidate) => candidate.startsWith("requiredVerification:"));
  const expected = `requiredVerification: resolved; command="npm run check"; source=repo_policy:deadloop.json; baseRevision=${revision}; override=none`;
  assert.deepEqual([line(this.status), line(this.doctor)], [expected, expected]);
});
