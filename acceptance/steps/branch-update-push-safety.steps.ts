import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { After, Given, Then, When } from "@cucumber/cucumber";

const {
  decideBranchUpdate,
} = require("../../extensions/deadloop/automations/pr-branch-update-decision.ts");
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
  decision?: { action: string; reason: string };
  dirtyWorktree?: boolean;
  selectedHeadIsCurrent?: boolean;
  trustRoot?: string;
  launcherResult?: ReturnType<typeof spawnSync>;
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
    },
  );
}

function pushed(world: SafetyWorld): boolean {
  return Boolean(world.commands?.some((command) => command.includes("push")));
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
  this.dirtyWorktree = true;
});

Given("選択した pull request head が更新前に変わっている", function (this: SafetyWorld) {
  this.selectedHeadIsCurrent = false;
});

When("deadloop が branch 更新を判断する", function (this: SafetyWorld) {
  this.decision = decideBranchUpdate(1, 1, true, !this.dirtyWorktree, this.selectedHeadIsCurrent ?? true);
});

Then("branch 更新は停止される", function (this: SafetyWorld) {
  assert.equal(this.decision?.action, "blocked");
});

Given("作業場所の信頼が承認されていない", function (this: SafetyWorld) {
  this.trustRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-untrusted-"));
  fs.writeFileSync(path.join(this.trustRoot, ".claude.json"), '{"projects":{}}\n');
  fs.writeFileSync(path.join(this.trustRoot, "prompt.md"), "Implement the issue.\n");
});

When("deadloop が Claude の作業エージェントを起動しようとする", function (this: SafetyWorld) {
  if (!this.trustRoot) throw new Error("trust precondition is missing");
  this.launcherResult = spawnSync(
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
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, HOME: this.trustRoot } },
  );
});

Then("作業エージェントは起動されない", function (this: SafetyWorld) {
  assert.match(String(this.launcherResult?.stdout ?? ""), /"error":"workspace_trust_unaccepted"/);
});

Then("自動チェックは pull request head 確認より先に実行される", function (this: SafetyWorld) {
  const checkIndex = this.commands?.findIndex((command) => command[0] === "node") ?? -1;
  const headQueryIndex = this.commands?.findIndex((command) => command[0] === "gh") ?? -1;
  assert.ok(checkIndex >= 0 && checkIndex < headQueryIndex);
});

Then("選択された branch だけへ非強制で push される", function (this: SafetyWorld) {
  assert.deepEqual(this.commands?.filter((command) => command.includes("push")), [
    ["git", "-C", "/worktree", "push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`],
  ]);
});

After(function (this: SafetyWorld) {
  if (this.trustRoot) fs.rmSync(this.trustRoot, { recursive: true, force: true });
});
