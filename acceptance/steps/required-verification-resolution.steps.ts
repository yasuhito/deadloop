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
  "ローカルに `npm run local-check`、共有方針に `npm run shared-check` がある",
  function (this: VerificationWorld) {
    this.localSources = [local("npm run local-check")];
    this.sharedSources = [shared("npm run shared-check")];
  },
);

Given("同じローカル優先順位に異なる必須検証がある", function (this: VerificationWorld) {
  this.localSources = [local("npm test", "/first"), local("npm run check", "/second")];
});

Given("必須検証の情報源がない", function (this: VerificationWorld) {
  this.localSources = [];
  this.sharedSources = [];
});

Given("共有方針に空の必須検証がある", function (this: VerificationWorld) {
  this.sharedSources = [shared("")];
});

Given("共有方針に `true` がある", function (this: VerificationWorld) {
  this.sharedSources = [shared("true")];
});

Given("共有方針に `npm run check` がある", function (this: VerificationWorld) {
  this.sharedSources = [shared("npm run check")];
});

When("必須検証を解決する", function (this: VerificationWorld) {
  this.resolution = resolveRequiredVerification({
    repository: "owner/repo",
    baseRevision: revision,
    localSources: this.localSources || [],
    sharedSources: this.sharedSources || [],
  });
});

When("状態表示と doctor を要求する", function (this: VerificationWorld) {
  const project = resolveSelectedProject({
    env: { DEADLOOP_CONFIG: "/state/projects.json" },
    files: { "/state/projects.json": {} },
    policy: { checkCommand: "npm run check" },
  });
  this.status = observeStatus(project);
  this.doctor = observeDoctor(project);
});

function contract(world: VerificationWorld) {
  if (world.resolution?.status !== "resolved") throw new Error("required verification was not resolved");
  return world.resolution.contract;
}

Then("実効コマンドは `npm run local-check` である", function (this: VerificationWorld) {
  assert.equal(contract(this).command, "npm run local-check");
});

Then("実効コマンドは `true` である", function (this: VerificationWorld) {
  assert.equal(contract(this).command, "true");
});

Then("共有方針の値は上書き情報に残る", function (this: VerificationWorld) {
  assert.deepEqual(contract(this).override, {
    source: { kind: "repo_policy", location: "deadloop.json" },
    command: "npm run shared-check",
  });
});

Then("停止理由は `{word}` である", function (this: VerificationWorld, reason: string) {
  assert.equal(this.resolution?.status === "blocked" ? this.resolution.reason : undefined, reason);
});

Then("解決結果はコマンド、情報源、基準コミット、リポジトリを含む", function (this: VerificationWorld) {
  assert.deepEqual(contract(this), {
    repository: "owner/repo",
    command: "npm run check",
    source: { kind: "repo_policy", location: "deadloop.json" },
    baseRevision: revision,
  });
});

Then("両方の必須検証表示は同じである", function (this: VerificationWorld) {
  const line = (report: string | undefined) => report?.split("\n").find((candidate) => candidate.startsWith("requiredVerification:"));
  const expected = `requiredVerification: resolved; command="npm run check"; source=repo_policy:deadloop.json; baseRevision=${revision}; override=none`;
  assert.deepEqual([line(this.status), line(this.doctor)], [expected, expected]);
});
