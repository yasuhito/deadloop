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
  updatedHead?: string;
};

function executable(file: string, content: string): void {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function readHerdrActions(world: RequeuedReviewWorld): string[][] {
  if (!world.log) throw new Error("Herdr action log is missing");
  return fs
    .readFileSync(world.log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

function actionName(args: string[]): string {
  return args
    .slice(0, args[0] === "pane" || (args[0] === "agent" && args[1] === "start") ? 3 : 2)
    .join(" ");
}

function runReviewDriver(world: RequeuedReviewWorld): void {
  if (
    !world.root ||
    !world.bin ||
    !world.worktree ||
    !world.configDir ||
    !world.log ||
    !world.prState
  ) {
    throw new Error("requeued pull request state is missing");
  }
  const result = spawnSync("node", ["extensions/deadloop/automations/pr-reviewer-driver.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${world.bin}:${process.env.PATH}`,
      PI_CODING_AGENT_DIR: world.configDir,
      DEADLOOP_PROJECT_ID: "demo",
      DEADLOOP_REPO_PATH: world.root,
      DEADLOOP_WORKTREE_ROOT: path.join(world.root, "worktrees"),
      DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_GITHUB_REPOSITORY_ID: "R_repo",
      DEADLOOP_AUTOMATION_LOGIN: "deadloop-bot",
      DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS: "deadloop-bot",
      DEADLOOP_ENABLED_AT: "1",
      DEADLOOP_STATE_DIR: path.join(world.configDir, "deadloop"),
      GH_TEST_PR_STATE: world.prState,
      HERDR_TEST_LOG: world.log,
      HERDR_TEST_WORKTREE: world.worktree,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

After("@requeued-pr-review", function (this: RequeuedReviewWorld) {
  if (this.root) fs.rmSync(this.root, { recursive: true, force: true });
});

Given("A blocked pull request has a completed Reviewer and its head changed after repair", function (this: RequeuedReviewWorld) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-requeued-review-"));
  const bin = path.join(root, "bin");
  const worktree = path.join(root, "worktrees", "agent-issue-44-fix");
  const configDir = path.join(root, "config");
  const state = path.join(configDir, "deadloop");
  const log = path.join(root, "herdr.log");
  const prState = path.join(root, "pr-state.json");
  fs.mkdirSync(bin);
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "projects.json"), JSON.stringify({ projects: [{
    id: "demo", repoPath: root, githubRepo: "owner/repo", baseBranch: "origin/main",
  }] }));
  fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify({
    projects: [{
      repoPath: root,
      githubRepo: "owner/repo",
      githubRepositoryId: "R_repo",
      baseBranch: "origin/main",
      automationLogin: "deadloop-bot",
      enabledAt: 1,
      firstEnableAutoMerge: false,
      firstStartPending: false,
      lastObservedAutoMerge: false,
      autoMergeAcknowledged: false,
      enabled: true,
    }],
  }));

  const updatedHead = "feed44".padEnd(40, "0");
  fs.writeFileSync(prState, JSON.stringify([{
    number: 44,
    title: "Updated review",
    url: "https://github.com/owner/repo/pull/44",
    headRefName: "agent/issue-44-fix",
    headRefOid: updatedHead,
    updatedAt: "2026-07-13T00:00:00Z",
    isDraft: false,
    statusCheckRollup: [],
    comments: [],
    reviewRequests: [],
    labels: [{ name: "agent:review" }, { name: "agent:blocked" }],
  }]));

  executable(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prs = () => JSON.parse(fs.readFileSync(process.env.GH_TEST_PR_STATE, "utf8"));
const save = (value) => fs.writeFileSync(process.env.GH_TEST_PR_STATE, JSON.stringify(value));
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify(prs()));
} else if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify(prs()[0]));
} else if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"owner/repo"}));
} else if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("deadloop-bot\\n");
} else if (args[0] === "api" && args.includes("--include")) {
  process.stdout.write("HTTP/2 200\\r\\ndate: Mon, 13 Jul 2026 00:02:00 GMT\\r\\n\\r\\n{}");
} else if (args[0] === "api" && args.some((arg) => arg.endsWith("/events"))) {
  process.stdout.write(JSON.stringify([[{id:4401,event:"labeled",created_at:"2026-07-13T00:00:00Z",label:{name:"agent:review"}}]]));
} else if (args[0] === "api" && !args.includes("PUT") && args.some((arg) => arg.endsWith("/labels"))) {
  process.stdout.write(JSON.stringify([prs()[0].labels]));
} else if (args[0] === "api" && args.includes("POST")) {
  const state = prs();
  const bodyArg = args.find((arg) => arg.startsWith("body=")) || "body=";
  const comment = {id:9901,created_at:"2026-07-13T00:01:00Z",updated_at:"2026-07-13T00:01:00Z",user:{login:"deadloop-bot"},body:bodyArg.slice(5)};
  state[0].comments.push(comment); save(state); process.stdout.write(JSON.stringify(comment));
} else if (args[0] === "api" && args.includes("PUT")) {
  let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => {
    const state = prs(); state[0].labels = JSON.parse(input).labels.map((name) => ({name})); save(state); process.stdout.write(JSON.stringify(state[0].labels));
  });
} else if (args[0] === "api" && args.some((arg) => arg.endsWith("/comments"))) {
  process.stdout.write(JSON.stringify([prs()[0].comments]));
} else if (args[0] === "api" && args.includes("graphql")) {
  const pr = prs()[0];
  process.stdout.write(JSON.stringify([{data:{repository:{pullRequest:{commits:{nodes:[{commit:{oid:pr.headRefOid}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}}]));
} else if (args[0] === "api" && args.includes("Accept: application/vnd.github.diff")) {
  process.stdout.write("diff --git a/file b/file\\n");
} else if (args[0] === "api" && args.find((arg) => arg.startsWith("repos/")) === "repos/owner/repo/pulls/44") {
  const pr = prs()[0];
  process.stdout.write(JSON.stringify({number:44,state:"open",head:{ref:pr.headRefName,sha:pr.headRefOid},base:{ref:"main",sha:"b".repeat(40)}}));
} else if (args[0] === "api") {
  process.stdout.write(JSON.stringify([[]]));
}
`);
  executable(path.join(bin, "git"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
else if (args.includes("rev-parse") && args.some(arg => arg.endsWith("^{commit}"))) process.stdout.write("${"f".repeat(40)}\\n");
else if (args.includes("show") && args.some(arg => arg.endsWith(":deadloop.json"))) process.exit(1);
`);
  executable(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  process.stdout.write("herdr 0.8.0\\n");
} else if (args[0] === "status" && args[1] === "server") {
  process.stdout.write("version: 0.8.0\\n");
} else if (args[0] === "agent" && args[1] === "list") {
  const agents = [{terminal_id:"terminal-old",name:"demo-pr-44-reviewer", agent_status:"done", cwd:process.env.HERDR_TEST_WORKTREE, pane_id:"pane-old"}];
  if (fs.existsSync(process.env.HERDR_TEST_LOG + ".agent")) agents.push(JSON.parse(fs.readFileSync(process.env.HERDR_TEST_LOG + ".agent", "utf8")));
  process.stdout.write(JSON.stringify({result:{agents}}));
} else if (args[0] === "worktree" && args[1] === "list") {
  process.stdout.write(JSON.stringify({result:{worktrees:[{path:process.env.HERDR_TEST_WORKTREE, branch:"agent/issue-44-fix"}]}}));
} else if (args[0] === "worktree" && args[1] === "open") {
  process.stdout.write(JSON.stringify({result:{type:"worktree_opened",already_open:false,workspace:{workspace_id:"workspace-1"},tab:{tab_id:"tab-new",workspace_id:"workspace-1"},root_pane:{pane_id:"pane-new",tab_id:"tab-new",workspace_id:"workspace-1",cwd:process.env.HERDR_TEST_WORKTREE},worktree:{path:process.env.HERDR_TEST_WORKTREE}}}));
} else if (args[0] === "workspace" && args[1] === "list") {
  process.stdout.write(JSON.stringify({result:{workspaces:[]}}));
} else if (args[0] === "workspace" && args[1] === "rename") {
  process.stdout.write("renamed");
} else if (args[0] === "agent" && args[1] === "start") {
  fs.writeFileSync(process.env.HERDR_TEST_LOG + ".agent", JSON.stringify({terminal_id:"terminal-new",name:args[2],agent_status:"working",cwd:process.env.HERDR_TEST_WORKTREE,pane_id:args[args.indexOf("--pane")+1]}));
}
`);

  Object.assign(this, { root, bin, worktree, configDir, log, prState, updatedHead });
});

When("deadloop checks the pull request after agent:blocked is removed", function (this: RequeuedReviewWorld) {
  if (!this.prState) throw new Error("requeued pull request state is missing");
  const pullRequests = JSON.parse(fs.readFileSync(this.prState, "utf8")) as Array<{
    labels: Array<{ name: string }>;
  }>;
  pullRequests[0].labels = pullRequests[0].labels.filter(({ name }) => name !== "agent:blocked");
  fs.writeFileSync(this.prState, JSON.stringify(pullRequests));
  runReviewDriver(this);
});

Then("deadloop starts exactly one Reviewer for the new head", function (this: RequeuedReviewWorld) {
  const actions = readHerdrActions(this).map(actionName);

  assert.equal(actions.filter((action) => action.startsWith("agent start dl-r-44-")).length, 1);
});

Then("deadloop starts a new Reviewer without reusing the completed Reviewer", function (this: RequeuedReviewWorld) {
  const actions = readHerdrActions(this).map(actionName);
  assert.deepEqual({ oldPaneClosed: actions.includes("pane close pane-old"), newStarts: actions.filter((action) => action.startsWith("agent start dl-r-44-")).length }, { oldPaneClosed: false, newStarts: 1 });
});

Then("The Reviewer handoff uses the repaired head", function (this: RequeuedReviewWorld) {
  if (!this.updatedHead) throw new Error("review handoff state is missing");
  const start = readHerdrActions(this)
    .find((args) => args[0] === "agent" && args[1] === "start" && args[2]?.startsWith("dl-r-44-"));
  const promptArgument = start?.at(-1) ?? "";
  const prompt = promptArgument.startsWith("@")
    ? fs.readFileSync(promptArgument.slice(1), "utf8")
    : promptArgument;
  const handedOffHead = prompt.match(/^- Expected PR head: (.+)$/m)?.[1] ?? "";

  assert.equal(handedOffHead, this.updatedHead);
});
