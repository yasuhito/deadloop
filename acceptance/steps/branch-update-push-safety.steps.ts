import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { After, Given, Then, When } from "@cucumber/cucumber";

const {
  finalizeBranchUpdate,
} = require("../../extensions/deadloop/automations/pr-branch-update-finalize.ts");

const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const branch = "agent/issue-31";

type BranchPush = {
  repo: string;
  remote: string;
  updates: { source: string; destination: string }[];
  mode: "normal";
};

type SafetyWorld = {
  actualHead?: string;
  branchPushes?: BranchPush[];
  crossRepository?: boolean;
  commands?: string[][];
  branchUpdateInput?: { cleanWorktree: boolean; headMatchesExpected: boolean };
  branchUpdateResult?: Record<string, unknown>;
  temporaryRoots?: string[];
  trustLaunchMarker?: string;
  trustRoot?: string;
};

function finalize(world: SafetyWorld): void {
  const commands: string[][] = [];
  world.commands = commands;
  finalizeBranchUpdate(
    {
      repo: "/worktree",
      githubRepo: "owner/repo",
      pr: "31",
      branch,
      expectedHead: head,
      expectedBase: base,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      checkCommand: "npm test",
    },
    {
      run: (args: string[]) => {
        commands.push(args);
        if (args[0] === "gh") {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              isCrossRepository: world.crossRepository ?? false,
              headRefName: branch,
              headRefOid: world.actualHead ?? head,
            }),
            stderr: "",
          };
        }
        if (args.at(-1) === "HEAD" && args.includes("rev-parse")) {
          return { status: 0, stdout: "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      pushBranch: (push: BranchPush) => {
        world.branchPushes = [...(world.branchPushes ?? []), push];
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );
}

function pushed(world: SafetyWorld): boolean {
  return (world.branchPushes?.length ?? 0) > 0;
}

function temporaryRoot(world: SafetyWorld, prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  world.temporaryRoots = [...(world.temporaryRoots ?? []), root];
  return root;
}

function runBranchUpdate(world: SafetyWorld): void {
  if (!world.branchUpdateInput) throw new Error("branch update precondition is missing");
  const root = temporaryRoot(world, "deadloop-branch-update-");
  const fixturePath = path.join(root, "fixture.json");
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      prs: [
        {
          number: 31,
          title: "Conflicting PR",
          headRefName: branch,
          headRefOid: head,
          isCrossRepository: false,
          isDraft: false,
          labels: [{ name: "agent:review" }],
          statusCheckRollup: [],
          comments: [],
          reviewRequests: [],
          mergeStateStatus: "CONFLICTING",
        },
      ],
      agents: { result: { agents: [] } },
      branchUpdate: {
        ahead: 1,
        behind: 1,
        conflictFree: true,
        ...world.branchUpdateInput,
        baseOid: base,
      },
    }),
  );
  const result = spawnSync(
    "node",
    ["extensions/deadloop/automations/pr-reviewer-driver.ts", "--fixture", fixturePath],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DEADLOOP_PROJECT_ID: "acceptance" } },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  world.branchUpdateResult = JSON.parse(result.stdout);
}

Given("更新前に確認した pull request head がある", function (this: SafetyWorld) {
  this.actualHead = head;
  this.crossRepository = false;
});

Given("自動チェック後に pull request head が変わる", function (this: SafetyWorld) {
  this.actualHead = base;
});

Given("pull request が別リポジトリから作られている", function (this: SafetyWorld) {
  this.crossRepository = true;
});

When("deadloop が branch 更新を完了しようとする", function (this: SafetyWorld) {
  finalize(this);
});

Then("branch への push は行われない", function (this: SafetyWorld) {
  assert.equal(pushed(this), false);
});

Given("更新対象の作業場所に未コミットの変更がある", function (this: SafetyWorld) {
  this.branchUpdateInput = { cleanWorktree: false, headMatchesExpected: true };
});

Given("選択した pull request head が更新前に変わっている", function (this: SafetyWorld) {
  this.branchUpdateInput = { cleanWorktree: true, headMatchesExpected: false };
});

When("deadloop が branch 更新を開始しようとする", function (this: SafetyWorld) {
  runBranchUpdate(this);
});

Then("branch 更新の作業エージェントは起動されない", function (this: SafetyWorld) {
  assert.equal(this.branchUpdateResult?.launch, undefined);
});

Given("作業場所の信頼が承認されていない", function (this: SafetyWorld) {
  this.trustRoot = temporaryRoot(this, "deadloop-untrusted-");
  const binDir = path.join(this.trustRoot, "bin");
  this.trustLaunchMarker = path.join(this.trustRoot, "herdr-started");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(this.trustRoot, ".claude.json"), '{"projects":{}}\n');
  fs.writeFileSync(path.join(this.trustRoot, "prompt.md"), "Implement the issue.\n");
  fs.writeFileSync(
    path.join(binDir, "herdr"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(this.trustLaunchMarker)}, "started");\n`,
    { mode: 0o755 },
  );
});

When("deadloop が Claude の作業エージェントを起動しようとする", function (this: SafetyWorld) {
  if (!this.trustRoot) throw new Error("trust precondition is missing");
  spawnSync(
    "node",
    [
      "extensions/deadloop/automations/launch-agent.ts",
      "--agent",
      "claude",
      "--name",
      "agent-issue-31",
      "--cwd",
      this.trustRoot,
      "--repo-path",
      this.trustRoot,
      "--level",
      "low",
      "--prompt-file",
      path.join(this.trustRoot, "prompt.md"),
      "--uuid",
      "branch-update-safety",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: this.trustRoot, PATH: `${path.join(this.trustRoot, "bin")}:${process.env.PATH}` },
    },
  );
});

Then("作業エージェントは起動されない", function (this: SafetyWorld) {
  assert.equal(fs.existsSync(this.trustLaunchMarker ?? ""), false);
});

Then("自動チェックは pull request head 確認より先に実行される", function (this: SafetyWorld) {
  const checkIndex = this.commands?.findIndex((command) => command[0] === "node") ?? -1;
  const headQueryIndex = this.commands?.findIndex((command) => command[0] === "gh") ?? -1;
  assert.ok(checkIndex >= 0 && checkIndex < headQueryIndex);
});

Then("選択された branch だけが push の対象になる", function (this: SafetyWorld) {
  assert.deepEqual(
    this.branchPushes?.flatMap((push) => push.updates.map((update) => update.destination)) ?? [],
    [`refs/heads/${branch}`],
  );
});

Then("branch は強制せずに push される", function (this: SafetyWorld) {
  assert.deepEqual(this.branchPushes?.map((push) => push.mode) ?? [], ["normal"]);
});

After(function (this: SafetyWorld) {
  for (const root of this.temporaryRoots ?? []) fs.rmSync(root, { recursive: true, force: true });
});
