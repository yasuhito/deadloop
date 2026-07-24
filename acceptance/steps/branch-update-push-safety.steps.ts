import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { After, Given, Then, When } from "@cucumber/cucumber";

const { finalizeBranchUpdate } = require("../../extensions/deadloop/automations/pr-branch-update-finalize.ts");
const { decideBranchUpdateLive } = require("../../extensions/deadloop/automations/pr-branch-update-decision.ts");
const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const candidate = "cccccccccccccccccccccccccccccccccccccccc";
const branch = "agent/issue-31";
const pushUrl = "https://github.com/owner/repo.git";

type SafetyWorld = {
  actualHead?: string;
  changeHeadAfterChecks?: boolean;
  crossRepository?: boolean;
  commands?: string[][];
  decisionResult?: Record<string, unknown>;
  decisionRepo?: string;
  expectedHeadRef?: string;
  finalizeResult?: Record<string, unknown>;
  temporaryRoots?: string[];
  trackedChangesAfterChecks?: boolean;
  trustLaunchMarker?: string;
  trustRoot?: string;
};

function finalize(world: SafetyWorld): void {
  const commands: string[][] = [];
  let configuredCheckCompleted = false;
  world.commands = commands;
  world.finalizeResult = finalizeBranchUpdate(
    {
      repo: "/worktree",
      projectRepo: "/project",
      githubRepo: "owner/repo",
      pr: "31",
      branch,
      expectedHead: head,
      expectedBase: base,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      enabledAt: 1,
      checkCommand: "npm test",
    },
    {
      assertEnabled: () => ({ githubRepo: "owner/repo", githubRepositoryId: "R_repo" }),
      run: (args: string[]) => {
        commands.push(args);
        if (args[0] === "node" && args[1]?.endsWith("/run-project-check.ts")) {
          configuredCheckCompleted = true;
          if (world.changeHeadAfterChecks) world.actualHead = base;
        }
        if (args.includes("get-url")) return { status: 0, stdout: `${pushUrl}\n`, stderr: "" };
        if (args.includes("ls-remote")) {
          return { status: 0, stdout: `${head}\trefs/heads/${branch}\n`, stderr: "" };
        }
        if (args.includes("--git-common-dir")) return { status: 0, stdout: "/common\n", stderr: "" };
        if (args.includes("symbolic-ref")) return { status: 0, stdout: `${branch}\n`, stderr: "" };
        if (args[0] === "gh" && args[1] === "repo") {
          return { status: 0, stdout: JSON.stringify({ id: "R_repo" }), stderr: "" };
        }
        if (args[0] === "gh") {
          if (!configuredCheckCompleted) throw new Error("PR head queried before the configured check completed");
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
        if (args.includes("status") && args.includes("--porcelain")) {
          return { status: 0, stdout: world.trackedChangesAfterChecks ? " M tracked-file.ts\n" : "", stderr: "" };
        }
        if (args.at(-1) === "HEAD" && args.includes("rev-parse")) {
          return { status: 0, stdout: `${candidate}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );
}

function pushCommands(world: SafetyWorld): string[][] {
  return (world.commands ?? []).filter((command) => command[0] === "git" && command.includes("push"));
}

function pushTargets(world: SafetyWorld): string[][] {
  return pushCommands(world).map((command) =>
    command
      .slice(command.indexOf("push") + 1)
      .filter(
        (argument) =>
          !argument.startsWith("-") ||
          argument === "--all" ||
          argument === "--follow-tags" ||
          argument === "--mirror" ||
          argument === "--tags",
      )
      .map((argument) => argument.replace(/^\+/, "")),
  );
}

function successfulPushForceOptions(world: SafetyWorld): string[][] {
  if (world.finalizeResult?.action !== "pushed") return [];
  return pushCommands(world).map((command) =>
    command.filter(
      (argument) =>
        argument === "-f" || argument === "--mirror" || argument.startsWith("--force") || argument.startsWith("+"),
    ),
  );
}

function temporaryRoot(world: SafetyWorld, prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  world.temporaryRoots = [...(world.temporaryRoots ?? []), root];
  return root;
}

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout.trim();
}

function prepareDecisionRepo(world: SafetyWorld): string {
  const repo = temporaryRoot(world, "deadloop-branch-decision-");
  git(repo, ["init", "--initial-branch=work"]);
  git(repo, ["config", "user.name", "Acceptance Test"]);
  git(repo, ["config", "user.email", "acceptance@example.com"]);
  fs.writeFileSync(path.join(repo, "initial.txt"), "initial\n");
  git(repo, ["add", "initial.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["branch", "expected-head"]);
  git(repo, ["branch", "base"]);
  fs.writeFileSync(path.join(repo, "work.txt"), "work\n");
  git(repo, ["add", "work.txt"]);
  git(repo, ["commit", "-m", "work"]);
  git(repo, ["checkout", "base"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["checkout", "work"]);
  world.decisionRepo = repo;
  return repo;
}

Given("更新前に確認した pull request head がある", function (this: SafetyWorld) {
  this.actualHead = head;
  this.crossRepository = false;
});

Given("自動チェック後に pull request head が変わる", function (this: SafetyWorld) {
  this.changeHeadAfterChecks = true;
});

Given("pull request が別リポジトリから作られている", function (this: SafetyWorld) {
  this.crossRepository = true;
});

Given("自動チェック後に作業場所へ追跡中の変更がある", function (this: SafetyWorld) {
  this.trackedChangesAfterChecks = true;
});

Given("branch 更新の選定前から作業場所に未コミットの変更がある", function (this: SafetyWorld) {
  const repo = prepareDecisionRepo(this);
  fs.writeFileSync(path.join(repo, "work.txt"), "uncommitted\n");
});

Given("選定対象の pull request head が事前確認した head と異なる", function (this: SafetyWorld) {
  prepareDecisionRepo(this);
  this.expectedHeadRef = "expected-head";
});

When("deadloop が branch 更新方法を選定する", function (this: SafetyWorld) {
  if (!this.decisionRepo) throw new Error("branch decision precondition is missing");
  this.decisionResult = decideBranchUpdateLive(this.decisionRepo, "work", "base", this.expectedHeadRef);
});

When("deadloop が branch 更新を完了しようとする", function (this: SafetyWorld) {
  try {
    finalize(this);
  } catch (error) {
    if (this.trackedChangesAfterChecks && error instanceof Error && error.message.includes("worktree is dirty")) return;
    throw error;
  }
});

Then("branch への push は行われない", function (this: SafetyWorld) {
  assert.deepEqual(pushCommands(this), []);
});

Then("完了結果は古い head として観測される", function (this: SafetyWorld) {
  assert.equal(this.finalizeResult?.action, "stale_head");
});

Then("branch 更新方法は作業場所の変更を理由に停止となる", function (this: SafetyWorld) {
  assert.deepEqual(
    { action: this.decisionResult?.action, reason: this.decisionResult?.reason },
    { action: "blocked", reason: "dirty_worktree" },
  );
});

Then("branch 更新方法は古い head を理由に停止となる", function (this: SafetyWorld) {
  assert.deepEqual(
    { action: this.decisionResult?.action, reason: this.decisionResult?.reason },
    { action: "blocked", reason: "stale_head" },
  );
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
  assert.deepEqual(pushTargets(this), [[pushUrl, `${candidate}:refs/heads/${branch}`]]);
});

Then("branch は強制せずに push される", function (this: SafetyWorld) {
  assert.deepEqual(successfulPushForceOptions(this), [[]]);
});

After(function (this: SafetyWorld) {
  for (const root of this.temporaryRoots ?? []) fs.rmSync(root, { recursive: true, force: true });
});
