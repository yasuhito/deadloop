import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { After, Given, Then, When } from "@cucumber/cucumber";

type RequeuedReviewWorld = {
  root?: string;
  bin?: string;
  worktree?: string;
  configDir?: string;
  log?: string;
  prState?: string;
  pullRequest?: Record<string, unknown>;
  updatedHead?: string;
};

function executable(file: string, content: string): void {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

After("@requeued-pr-review", function (this: RequeuedReviewWorld) {
  if (this.root) fs.rmSync(this.root, { recursive: true, force: true });
});

Given("修正で head が変わり終了済みのレビュー担当が残る pull request がある", function (this: RequeuedReviewWorld) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-requeued-review-"));
  const bin = path.join(root, "bin");
  const worktree = path.join(root, "worktree");
  const configDir = path.join(root, "config");
  const state = path.join(configDir, "deadloop");
  const log = path.join(root, "herdr.log");
  const prState = path.join(root, "pr-state.json");
  fs.mkdirSync(bin);
  fs.mkdirSync(worktree);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify({
    projects: [{
      repoPath: root,
      githubRepo: "owner/repo",
      githubRepositoryId: "R_repo",
      enabledAt: 1,
      firstEnableAutoMerge: false,
      firstStartPending: false,
      lastObservedAutoMerge: false,
      autoMergeAcknowledged: false,
      enabled: true,
    }],
  }));

  const pullRequest = {
    number: 44,
    title: "Updated review",
    url: "https://github.com/owner/repo/pull/44",
    headRefName: "agent/issue-44-fix",
    headRefOid: "dead43",
    updatedAt: "2026-07-13T00:00:00Z",
    isDraft: false,
    statusCheckRollup: [],
    comments: [],
    reviewRequests: [],
  };
  fs.writeFileSync(prState, JSON.stringify([{
    ...pullRequest,
    labels: [{ name: "agent:review" }, { name: "agent:blocked" }],
  }]));

  executable(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(fs.readFileSync(process.env.GH_TEST_PR_STATE, "utf8"));
} else if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({id:"R_repo"}));
}
`);
  executable(path.join(bin, "git"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
`);
  executable(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "agent" && args[1] === "list") {
  process.stdout.write(JSON.stringify({result:{agents:[{
    name:"demo-pr-44-reviewer", agent_status:"Done", cwd:process.env.HERDR_TEST_WORKTREE, pane_id:"pane-old"
  }]}}));
} else if (args[0] === "worktree" && args[1] === "open") {
  process.stdout.write(JSON.stringify({workspace_id:"workspace-1", path:process.env.HERDR_TEST_WORKTREE}));
} else if (args[0] === "tab" && args[1] === "create") {
  process.stdout.write(JSON.stringify({tab_id:"tab-new"}));
}
`);

  Object.assign(this, { root, bin, worktree, configDir, log, prState, pullRequest, updatedHead: "feed44" });
});

When("deadloop が再投入された pull request を確認する", function (this: RequeuedReviewWorld) {
  if (
    !this.root ||
    !this.bin ||
    !this.worktree ||
    !this.configDir ||
    !this.log ||
    !this.prState ||
    !this.pullRequest ||
    !this.updatedHead
  ) {
    throw new Error("requeued pull request state is missing");
  }
  const runDriver = (): void => {
    const result = spawnSync("node", ["extensions/deadloop/automations/pr-reviewer-driver.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${this.bin}:${process.env.PATH}`,
        PI_CODING_AGENT_DIR: this.configDir,
        DEADLOOP_PROJECT_ID: "demo",
        DEADLOOP_REPO_PATH: this.root,
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_ENABLED_AT: "1",
        DEADLOOP_STATE_DIR: path.join(this.configDir, "deadloop"),
        GH_TEST_PR_STATE: this.prState,
        HERDR_TEST_LOG: this.log,
        HERDR_TEST_WORKTREE: this.worktree,
      },
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  };

  runDriver();
  fs.writeFileSync(this.prState, JSON.stringify([{
    ...this.pullRequest,
    headRefOid: this.updatedHead,
    labels: [{ name: "agent:review" }],
  }]));
  runDriver();
});

Then("新しい head のレビュー担当を一人だけ起動する", function (this: RequeuedReviewWorld) {
  if (!this.log) throw new Error("Herdr action log is missing");
  const actions = fs
    .readFileSync(this.log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .map((args) => args.slice(0, args[0] === "pane" || (args[0] === "agent" && args[1] === "start") ? 3 : 2).join(" "));

  assert.equal(actions.filter((action) => action === "agent start demo-pr-44-reviewer").length, 1);
});

Then("レビュー担当への引き継ぎに修正後の head を使う", function (this: RequeuedReviewWorld) {
  if (!this.log || !this.updatedHead) throw new Error("review handoff state is missing");
  const start = fs
    .readFileSync(this.log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .find((args) => args[0] === "agent" && args[1] === "start" && args[2] === "demo-pr-44-reviewer");
  const promptArgument = start?.at(-1) ?? "";
  const prompt = promptArgument.startsWith("@")
    ? fs.readFileSync(promptArgument.slice(1), "utf8")
    : promptArgument;
  const handedOffHead = prompt.match(/^- Expected PR head: (.+)$/m)?.[1] ?? "";

  assert.equal(handedOffHead, this.updatedHead);
});
