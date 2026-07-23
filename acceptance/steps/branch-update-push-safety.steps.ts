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

type SafetyWorld = {
  actualHead?: string;
  crossRepository?: boolean;
  commands?: string[][];
  finalizeResult?: Record<string, unknown>;
  temporaryRoots?: string[];
  trustLaunchMarker?: string;
  trustRoot?: string;
};

function finalize(world: SafetyWorld): void {
  const commands: string[][] = [];
  world.commands = commands;
  world.finalizeResult = finalizeBranchUpdate(
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
    },
  );
}

function pushCommand(world: SafetyWorld): string[] | undefined {
  return world.commands?.find((command) => command[0] === "git" && command.includes("push"));
}

function pushed(world: SafetyWorld): boolean {
  return pushCommand(world) !== undefined;
}

function pushedUpdates(world: SafetyWorld): string[] {
  return pushCommand(world)?.filter((argument) => argument.includes(":refs/heads/")) ?? [];
}

function forcePushArguments(world: SafetyWorld): string[] {
  return (
    pushCommand(world)?.filter(
      (argument) => argument === "-f" || argument.startsWith("--force") || argument.startsWith("+"),
    ) ?? []
  );
}

function temporaryRoot(world: SafetyWorld, prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  world.temporaryRoots = [...(world.temporaryRoots ?? []), root];
  return root;
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

Then("完了結果は古い head として観測される", function (this: SafetyWorld) {
  assert.equal(this.finalizeResult?.action, "stale_head");
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

Then("選択された branch だけが push の対象になる", function (this: SafetyWorld) {
  assert.deepEqual(pushedUpdates(this), [`HEAD:refs/heads/${branch}`]);
});

Then("branch は強制せずに push される", function (this: SafetyWorld) {
  assert.deepEqual(forcePushArguments(this), []);
});

After(function (this: SafetyWorld) {
  for (const root of this.temporaryRoots ?? []) fs.rmSync(root, { recursive: true, force: true });
});
