import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

process.env.DEADLOOP_REQUIRED_VERIFICATION = JSON.stringify({
  repository: "owner/repo",
  command: "npm test",
  source: { kind: "repo_policy", location: "deadloop.json" },
  baseRevision: "a".repeat(40),
});

const { renderReviewerMonitorPrompt } = require("../src/monitor-prompts.ts");
const { repairLaunchInput } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.ts");
const cumulativeRepairFixture = require("./fixtures/pr-review-repair/cumulative-limit.json");
const trustedCumulativeComments = cumulativeRepairFixture.comments.map((comment: Record<string, unknown>) => ({
  ...comment,
  author: { login: "deadloop-bot" },
}));

const tempDirs: string[] = [];

function executable(file: string, content: string): void {
  const prepared = path.basename(file) === "gh"
    ? content.replace("\n", `\nconst deadloopGhArgs = process.argv.slice(2);\nif (deadloopGhArgs[0] === "api" && deadloopGhArgs[1] === "user") { process.stdout.write("deadloop-bot\\n"); process.exit(0); }\n`)
    : content;
  fs.writeFileSync(file, prepared);
  fs.chmodSync(file, 0o755);
}

function compatibleHerdr(bin: string): void {
  executable(path.join(bin, "herdr"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("herdr 0.7.5\\n");
else if (args[0] === "status" && args[1] === "server") process.stdout.write("version: 0.7.5\\ncompatible: yes\\n");
else if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result:{worktrees:[]}}));
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result:{agents:[]}}));
`);
}

function enableProject(state: string, repoPath: string): void {
  spawnSync("git", ["-C", repoPath, "init", "--quiet"]);
  spawnSync("git", ["-C", repoPath, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify({ projects: [{
    repoPath, githubRepo: "owner/repo", githubRepositoryId: "R_repo", enabledAt: 1,
    firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
    autoMergeAcknowledged: false, enabled: true,
  }] }));
}

function runStaleWorktreeDispatch(
  expectedHead: string,
  currentHead: string,
  options: {
    dirty?: boolean;
    duplicateWorktree?: boolean;
    hasWorktree?: boolean;
    initialHead?: string;
    worktreeHead?: string;
    worktreeName?: string;
  } = {},
): { output: Record<string, unknown>; ghLog: string; herdrLog: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-stale-review-repair-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const worktree = path.join(root, options.worktreeName || "worktree");
  const worktreeHead = options.worktreeHead || currentHead;
  const configDir = path.join(root, "config");
  const state = path.join(configDir, "deadloop");
  const promise = path.join(root, "review-promise.json");
  const ghCount = path.join(root, "gh-count");
  const ghLog = path.join(root, "gh.log");
  const herdrLog = path.join(root, "herdr.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify({
    projects: [{
      repoPath: root, githubRepo: "yasuhito/deadloop", githubRepositoryId: "R_repo", enabledAt: 1,
      firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
      autoMergeAcknowledged: false, enabled: true,
    }],
  }));
  fs.writeFileSync(
    promise,
    JSON.stringify({
      status: "complete",
      outcome: "changes_requested",
      reason: "",
      summary: "The reviewed worktree moved after the selected PR observation.",
      findings: [{ title: "Bound finding", body: "Repair one finding", severity: "major" }],
    }),
  );

  executable(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_GH_LOG, args.join(" ") + "\\n");
if (args[0] === "pr" && args[1] === "view") {
  const count = fs.existsSync(process.env.TEST_GH_COUNT) ? Number(fs.readFileSync(process.env.TEST_GH_COUNT, "utf8")) : 0;
  fs.writeFileSync(process.env.TEST_GH_COUNT, String(count + 1));
  const heads = [process.env.TEST_INITIAL_HEAD, process.env.TEST_CURRENT_HEAD];
  process.stdout.write(JSON.stringify({
    number:143,state:"OPEN",headRefName:"agent/issue-142-deadloop",headRefOid:heads[Math.min(count, heads.length - 1)],isCrossRepository:false,labels:[{name:"agent:review"},{name:"agent:reviewing"}],comments:[]
  }));
} else if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({id:"R_repo"}));
}
`,
  );
  executable(
    path.join(bin, "git"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "-C" && args[2] === "worktree" && args[3] === "list") {
  if (process.env.TEST_HAS_WORKTREE === "true") {
    process.stdout.write("worktree " + process.env.TEST_WORKTREE + "\\0HEAD " + process.env.TEST_WORKTREE_HEAD + "\\0branch refs/heads/agent/issue-142-deadloop\\0\\0");
    if (process.env.TEST_DUPLICATE_WORKTREE === "true") process.stdout.write("worktree /duplicate/worktree\\0HEAD " + process.env.TEST_WORKTREE_HEAD + "\\0branch refs/heads/agent/issue-142-deadloop\\0\\0");
  }
} else if (args[0] === "-C" && args[1] === process.env.TEST_WORKTREE && args[2] === "rev-parse") {
  process.stdout.write(process.env.TEST_WORKTREE_HEAD + "\\n");
} else if (args[0] === "-C" && args[1] === process.env.TEST_WORKTREE && args[2] === "status") {
  process.stdout.write(process.env.TEST_DIRTY === "true" && args.includes("--untracked-files=all") ? "?? untracked.txt\\n" : "");
} else if (args.includes("get-url")) {
  process.stdout.write("https://github.com/yasuhito/deadloop.git\\n");
} else if (args[0] === "check-ref-format") {
  process.exit(0);
}
`,
  );
  executable(
    path.join(bin, "herdr"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.TEST_HERDR_LOG, process.argv.slice(2).join(" ") + "\\n");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("herdr 0.7.5\\n"); process.exit(0); }
if (args[0] === "status" && args[1] === "server") { process.stdout.write("version: 0.7.5\\ncompatible: yes\\n"); process.exit(0); }
if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result:{worktrees:[{path:process.env.TEST_WORKTREE,branch:"agent/issue-243"}]}}));
else if (args[0] === "worktree" && args[1] === "open") process.stdout.write(JSON.stringify({result:{type:"worktree_opened",already_open:false,workspace:{workspace_id:"workspace-1"},tab:{tab_id:"tab-1",workspace_id:"workspace-1"},root_pane:{pane_id:"pane-1",tab_id:"tab-1",workspace_id:"workspace-1",cwd:process.env.TEST_WORKTREE},worktree:{path:process.env.TEST_WORKTREE}}}));
else if (args[0] === "workspace" && args[1] === "list") process.stdout.write(JSON.stringify({result:{workspaces:[]}}));
else if (args[0] === "workspace" && args[1] === "rename") process.stdout.write("renamed");
else process.stdout.write(JSON.stringify({ok:true}));
`,
  );

  const result = spawnSync(
    "node",
    [
      "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
      "--promise",
      promise,
      "--pr",
      "143",
      "--expected-head",
      expectedHead,
      "--branch",
      "agent/issue-142-deadloop",
      "--repo-path",
      root,
      "--github-repo",
      "yasuhito/deadloop",
      "--state-dir",
      state,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PI_CODING_AGENT_DIR: configDir,
        DEADLOOP_PROJECT_ID: "demo",
        DEADLOOP_REPO_PATH: root,
        DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"),
        DEADLOOP_GITHUB_REPO: "yasuhito/deadloop",
        DEADLOOP_ENABLED_AT: "1",
        DEADLOOP_STATE_DIR: state,
        TEST_EXPECTED_HEAD: expectedHead,
        TEST_CURRENT_HEAD: currentHead,
        TEST_DIRTY: String(Boolean(options.dirty)),
        TEST_DUPLICATE_WORKTREE: String(Boolean(options.duplicateWorktree)),
        TEST_GH_COUNT: ghCount,
        TEST_GH_LOG: ghLog,
        TEST_HAS_WORKTREE: String(options.hasWorktree !== false),
        TEST_HERDR_LOG: herdrLog,
        TEST_INITIAL_HEAD: options.initialHead || expectedHead,
        TEST_WORKTREE: worktree,
        TEST_WORKTREE_HEAD: worktreeHead,
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return {
    output: JSON.parse(result.stdout),
    ghLog: fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8") : "",
    herdrLog: fs.existsSync(herdrLog) ? fs.readFileSync(herdrLog, "utf8") : "",
  };
}

function runDispatch(enabled: boolean, compatible = true): { output: Record<string, any>; events: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const worktree = path.join(root, "worktrees", "agent-issue-243");
  const configDir = path.join(root, "config");
  const state = path.join(configDir, "deadloop");
  const promise = path.join(root, "review-promise.json");
  const eventLog = path.join(root, "events.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, "enabled-projects.json"),
    JSON.stringify({
      projects: [{
        repoPath: root,
        githubRepo: "owner/repo",
        githubRepositoryId: "R_repo",
        enabledAt: 1,
        firstEnableAutoMerge: false,
        firstStartPending: false,
        lastObservedAutoMerge: false,
        autoMergeAcknowledged: false,
        enabled,
      }],
    }),
  );
  fs.writeFileSync(
    promise,
    JSON.stringify({
      status: "complete",
      outcome: "changes_requested",
      reason: "",
      summary: "A lint contract finding needs repair.",
      findings: [{ title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }],
    }),
  );

  executable(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${"a".repeat(40)}",isCrossRepository:false,labels:[{name:"agent:review"},{name:"agent:reviewing"}],comments:[]
}));
else if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({id:"R_repo"}));
else fs.appendFileSync(process.env.EVENT_LOG, "github-mutation\\n");
`,
  );
  executable(
    path.join(bin, "git"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
process.exit(0);
`,
  );
  executable(
    path.join(bin, "herdr"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("herdr ${compatible ? "0.7.5" : "0.7.4"}\\n"); process.exit(0); }
if (args[0] === "status" && args[1] === "server") { process.stdout.write("version: ${compatible ? "0.7.5" : "0.7.4"}\\ncompatible: yes\\n"); process.exit(0); }
if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result:{worktrees:[{path:process.env.TEST_WORKTREE,branch:"agent/issue-243"}]}}));
else if (args[0] === "worktree" && args[1] === "open") process.stdout.write(JSON.stringify({result:{type:"worktree_opened",already_open:false,workspace:{workspace_id:"workspace-1"},tab:{tab_id:"tab-1",workspace_id:"workspace-1"},root_pane:{pane_id:"pane-1",tab_id:"tab-1",workspace_id:"workspace-1",cwd:process.env.TEST_WORKTREE},worktree:{path:process.env.TEST_WORKTREE}}}));
else if (args[0] === "workspace" && args[1] === "list") process.stdout.write(JSON.stringify({result:{workspaces:[]}}));
else if (args[0] === "workspace" && args[1] === "rename") process.stdout.write("renamed");
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result:{agents:fs.existsSync(process.env.TEST_AGENT_STATE)?[JSON.parse(fs.readFileSync(process.env.TEST_AGENT_STATE,"utf8"))]:[]}}));
else if (args[0] === "agent" && args[1] === "start") {
  fs.appendFileSync(process.env.EVENT_LOG, "agent-launch\\n");
  fs.writeFileSync(process.env.TEST_AGENT_STATE, JSON.stringify({terminal_id:"terminal-1",name:args[2],agent_status:"working",cwd:process.env.TEST_WORKTREE,pane_id:args[args.indexOf("--pane")+1]}));
  process.stdout.write(JSON.stringify({ok:true}));
}
`,
  );

  const result = spawnSync(
    "node",
    [
      "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
      "--promise",
      promise,
      "--pr",
      "243",
      "--expected-head",
      "a".repeat(40),
      "--branch",
      "agent/issue-243",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PI_CODING_AGENT_DIR: configDir,
        DEADLOOP_PROJECT_ID: "demo",
        DEADLOOP_REPO_PATH: root,
        DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"),
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_ENABLED_AT: "1",
        DEADLOOP_STATE_DIR: state,
        TEST_WORKTREE: worktree,
        TEST_AGENT_STATE: path.join(root, "agent-state.json"),
        EVENT_LOG: eventLog,
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return {
    output: JSON.parse(result.stdout),
    events: fs.existsSync(eventLog) ? fs.readFileSync(eventLog, "utf8").trim().split("\n").filter(Boolean) : [],
  };
}

function runTerminalMutationRace(
  mode: "disable_during_human_block" | "head_change" | "label_change",
): { output: Record<string, any>; mutations: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-terminal-race-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const configDir = path.join(root, "config");
  const state = path.join(configDir, "deadloop");
  const promise = path.join(root, "review-promise.json");
  const ghCount = path.join(root, "gh-count");
  const mutationLog = path.join(root, "mutations.log");
  const enabledFile = path.join(state, "enabled-projects.json");
  fs.mkdirSync(bin);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(enabledFile, JSON.stringify({ projects: [{
    repoPath: root, githubRepo: "owner/repo", githubRepositoryId: "R_repo", enabledAt: 1,
    firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
    autoMergeAcknowledged: false, enabled: true,
  }] }));
  fs.writeFileSync(promise, JSON.stringify(mode === "disable_during_human_block"
    ? { status: "complete", outcome: "human_required", reason: "decision required", summary: "human review" }
    : { status: "blocked", reason: "reviewer failed", summary: "technical failure" }));

  executable(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  const count = fs.existsSync(process.env.TEST_GH_COUNT) ? Number(fs.readFileSync(process.env.TEST_GH_COUNT, "utf8")) : 0;
  fs.writeFileSync(process.env.TEST_GH_COUNT, String(count + 1));
  const changed = count > 0;
  process.stdout.write(JSON.stringify({
    number: 243, state: "OPEN", headRefName: "agent/issue-243",
    headRefOid: changed && process.env.TEST_MODE === "head_change" ? "${"b".repeat(40)}" : "${"a".repeat(40)}",
    isCrossRepository: false,
    labels: changed && process.env.TEST_MODE === "label_change"
      ? [{name:"agent:review"},{name:"agent:reviewing"},{name:"agent:blocked"}]
      : [{name:"agent:review"},{name:"agent:reviewing"}],
    comments: [],
  }));
} else if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({id:"R_repo"}));
} else {
  fs.appendFileSync(process.env.TEST_MUTATION_LOG, args.slice(0, 3).join(" ") + "\\n");
  if (args[0] === "pr" && args[1] === "comment" && process.env.TEST_MODE === "disable_during_human_block") {
    const data = JSON.parse(fs.readFileSync(process.env.TEST_ENABLED_FILE, "utf8"));
    data.projects[0].enabled = false;
    fs.writeFileSync(process.env.TEST_ENABLED_FILE, JSON.stringify(data));
  }
}
`);
  executable(path.join(bin, "git"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
`);
  compatibleHerdr(bin);

  const result = spawnSync("node", [
    "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
    "--promise", promise,
    "--pr", "243",
    "--expected-head", "a".repeat(40),
    "--branch", "agent/issue-243",
  ], {
    cwd: process.cwd(), encoding: "utf8",
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: configDir,
      DEADLOOP_REPO_PATH: root, DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"), DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_ENABLED_AT: "1",
      DEADLOOP_STATE_DIR: state, TEST_ENABLED_FILE: enabledFile, TEST_GH_COUNT: ghCount,
      TEST_MODE: mode, TEST_MUTATION_LOG: mutationLog,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return {
    output: JSON.parse(result.stdout),
    mutations: fs.existsSync(mutationLog) ? fs.readFileSync(mutationLog, "utf8").trim().split("\n").filter(Boolean) : [],
  };
}

async function runConcurrentApprovedRetries(): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-result-concurrent-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const configDir = path.join(root, "config");
  const state = path.join(configDir, "deadloop");
  const promise = path.join(root, "review-promise.json");
  const commentsFile = path.join(root, "comments.json");
  fs.mkdirSync(bin);
  enableProject(state, root);
  fs.writeFileSync(promise, JSON.stringify({
    status: "complete", outcome: "approved", reason: "", summary: "No actionable findings.", findings: [],
  }));
  fs.writeFileSync(commentsFile, "[]");
  executable(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write(JSON.stringify({id:"R_repo"}));
else if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${"a".repeat(40)}",isCrossRepository:false,
  labels:[{name:"agent:review"},{name:"agent:reviewing"}],comments:JSON.parse(fs.readFileSync(process.env.COMMENTS_FILE,"utf8"))
}));
else if (args[0] === "pr" && args[1] === "comment") {
  const comments = JSON.parse(fs.readFileSync(process.env.COMMENTS_FILE,"utf8"));
  comments.push({body:args[args.indexOf("--body")+1]});
  fs.writeFileSync(process.env.COMMENTS_FILE, JSON.stringify(comments));
}
`);
  executable(path.join(bin, "git"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
`);
  compatibleHerdr(bin);
  const args = [
    "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
    "--promise", promise, "--pr", "243", "--expected-head", "a".repeat(40), "--branch", "agent/issue-243",
  ];
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: configDir,
    DEADLOOP_REPO_PATH: root, DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"), DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_ENABLED_AT: "1",
    DEADLOOP_STATE_DIR: state, COMMENTS_FILE: commentsFile,
  };
  await Promise.all([0, 1].map(() => new Promise<void>((resolve, reject) => {
    const child = spawn("node", args, { cwd: process.cwd(), env, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(`dispatch exited ${status}`)));
  })));
  return JSON.parse(fs.readFileSync(commentsFile, "utf8")).length;
}

function runV1ChangesRequestedTwice(options: {
  customConfiguration?: boolean;
  renderedCommand?: boolean;
  attempts?: number;
  injectCumulativeLimitRace?: boolean;
} = {}): {
  launches: number;
  actions: string[];
  reviewerPhase: string;
  repairWorktreePath: string;
  labelsPreserved: string[];
  dispatcherArgsForwarded: boolean;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-v1-repair-sequence-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const worktreeRoot = path.join(root, options.customConfiguration ? "custom repair checkouts" : "worktrees");
  const worktree = path.join(worktreeRoot, "agent-issue-243");
  const labels = options.customConfiguration
    ? { review: "custom:review", reviewing: "custom:reviewing", blocked: "custom:blocked", human: "custom:human" }
    : { review: "agent:review", reviewing: "agent:reviewing", blocked: "agent:blocked", human: "ready-for-human" };
  const liveLabels = [
    { name: labels.review },
    { name: labels.reviewing },
    ...(options.customConfiguration ? [{ name: "ready-for-human" }] : []),
    { name: "team:platform" },
  ];
  const state = path.join(root, "config", "deadloop");
  const reviewerRun = path.join(state, "runs", "reviewer-run");
  const promise = path.join(reviewerRun, "promise.json");
  const attempt = path.join(reviewerRun, "attempt.json");
  const comments = path.join(root, "comments.json");
  const ghViewCount = path.join(root, "gh-view-count");
  const runtime = path.join(root, "runtime.json");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(reviewerRun, { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  spawnSync("git", ["init", "--quiet", repo]);
  spawnSync("git", ["-C", repo, "config", "user.name", "Test"]);
  spawnSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "--quiet", "-m", "fixture"]);
  spawnSync("git", ["-C", repo, "branch", "agent/issue-243"]);
  spawnSync("git", ["-C", repo, "worktree", "add", "--quiet", worktree, "agent/issue-243"]);
  spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  const head = spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(
    comments,
    JSON.stringify(options.injectCumulativeLimitRace ? trustedCumulativeComments.slice(0, 2) : []),
  );
  fs.writeFileSync(runtime, JSON.stringify({ workspace: "reviewer-workspace", agent: null, launches: 0 }));
  fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify({ projects: [{
    repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "R_repo", enabledAt: 1,
    firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
    autoMergeAcknowledged: false, enabled: true,
  }] }));
  const findings = [{ title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }];
  fs.writeFileSync(promise, JSON.stringify({
    schemaVersion: 1, attemptId: "reviewer-attempt", role: "reviewer",
    target: { repository: "owner/repo", kind: "pull-request", number: 243 }, inputRevision: { head },
    status: "complete", summary: "One exact finding", result: { outcome: "changes_requested", reviewedHead: head, findings },
    evidence: { reviewed: ["diff"] },
  }));
  fs.writeFileSync(attempt, JSON.stringify({
    attemptId: "reviewer-attempt", launchUuid: "reviewer-run", project: "demo", repository: "owner/repo",
    role: "reviewer", target: { kind: "pull-request", number: 243 }, inputRevision: { head }, branch: "agent/issue-243",
    worktreePath: worktree, agentName: "dl-r-243-111111111111", workspaceLabel: "reviewer",
    promptFile: path.join(reviewerRun, "prompt.md"), promiseFile: promise, phase: "agent_started",
    lastSuccessfulPhase: "agent_started", workspaceId: "reviewer-workspace", tabId: "reviewer-tab", rootPaneId: "reviewer-pane",
  }));
  executable(path.join(bin, "gh"), `#!/usr/bin/env node
const fs=require("node:fs");const a=process.argv.slice(2);
if(a[0]==="repo") process.stdout.write(JSON.stringify({id:"R_repo"}));
else if(a[0]==="pr"&&a[1]==="view") {
  const count=fs.existsSync(process.env.GH_VIEW_COUNT)?Number(fs.readFileSync(process.env.GH_VIEW_COUNT,"utf8")):0;
  fs.writeFileSync(process.env.GH_VIEW_COUNT,String(count+1));
  const comments=JSON.parse(fs.readFileSync(process.env.COMMENTS,"utf8"));
  if(process.env.INJECT_LIMIT_RACE==="1"&&count===2) {
    comments.push(${JSON.stringify({ ...cumulativeRepairFixture.comments[2], author: { login: "deadloop-bot" } })});
    fs.writeFileSync(process.env.COMMENTS,JSON.stringify(comments));
  }
  process.stdout.write(JSON.stringify({number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:process.env.HEAD,isCrossRepository:false,labels:${JSON.stringify(liveLabels)},comments}));
}
else if(a[0]==="pr"&&a[1]==="comment"){const c=JSON.parse(fs.readFileSync(process.env.COMMENTS,"utf8"));c.push({body:a[a.indexOf("--body")+1],author:{login:"deadloop-bot"}});fs.writeFileSync(process.env.COMMENTS,JSON.stringify(c));}
`);
  executable(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs=require("node:fs");const a=process.argv.slice(2);const f=process.env.RUNTIME;const s=JSON.parse(fs.readFileSync(f,"utf8"));
if(a[0]==="--version") process.stdout.write("herdr 0.7.5\\n");
else if(a[0]==="status") process.stdout.write("version: 0.7.5\\ncompatible: yes\\n");
else if(a[0]==="workspace"&&a[1]==="list") process.stdout.write(JSON.stringify({result:{workspaces:s.workspace?[{workspace_id:s.workspace,pane_count:1,tab_count:1,worktree:{checkout_path:process.env.WORKTREE}}]:[]}}));
else if(a[0]==="workspace"&&a[1]==="close"){s.workspace=null;fs.writeFileSync(f,JSON.stringify(s));}
else if(a[0]==="workspace"&&a[1]==="rename") process.stdout.write("renamed");
else if(a[0]==="worktree"&&a[1]==="list") process.stdout.write(JSON.stringify({result:{worktrees:[{path:process.env.WORKTREE,branch:"agent/issue-243",is_linked_worktree:true,...(s.workspace?{open_workspace_id:s.workspace}:{})}]}}));
else if(a[0]==="worktree"&&a[1]==="open"){s.workspace="repair-workspace";fs.writeFileSync(f,JSON.stringify(s));process.stdout.write(JSON.stringify({result:{type:"worktree_opened",already_open:false,workspace:{workspace_id:s.workspace},tab:{tab_id:"repair-tab",workspace_id:s.workspace},root_pane:{pane_id:"repair-pane",tab_id:"repair-tab",workspace_id:s.workspace,cwd:process.env.WORKTREE},worktree:{path:process.env.WORKTREE}}}));}
else if(a[0]==="agent"&&a[1]==="list") process.stdout.write(JSON.stringify({result:{agents:s.agent?[s.agent]:[]}}));
else if(a[0]==="agent"&&a[1]==="start"){s.launches++;s.agent={terminal_id:"terminal-1",name:a[2],agent_status:"working",cwd:process.env.WORKTREE,pane_id:a[a.indexOf("--pane")+1]};fs.writeFileSync(f,JSON.stringify(s));process.stdout.write("started");}
`);
  const argv = ["extensions/deadloop/automations/pr-review-repair-dispatch.ts", "--promise", promise, "--attempt-record", attempt,
    "--pr", "243", "--expected-head", head, "--branch", "agent/issue-243"];
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: path.join(root, "config"),
    DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: repo, DEADLOOP_WORKTREE_ROOT: worktreeRoot,
    DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_ENABLED_AT: "1", DEADLOOP_STATE_DIR: state,
    DEADLOOP_REVIEW_LABEL: labels.review, DEADLOOP_REVIEWING_LABEL: labels.reviewing,
    DEADLOOP_BLOCKED_LABEL: labels.blocked, DEADLOOP_HUMAN_LABEL: labels.human,
    HEAD: head, COMMENTS: comments, GH_VIEW_COUNT: ghViewCount,
    INJECT_LIMIT_RACE: options.injectCumulativeLimitRace ? "1" : "0", RUNTIME: runtime, WORKTREE: worktree };
  const dispatcherCommand = options.renderedCommand
    ? (() => {
        const prompt = renderReviewerMonitorPrompt({
          prNumber: 243, expectedHeadOid: head, branch: "agent/issue-243",
          automationDir: path.resolve("extensions/deadloop/automations"), promiseFile: promise,
          attemptRecordFile: attempt, actorName: "reviewer", projectId: "demo", repoPath: repo,
          worktreeRoot, githubRepo: "owner/repo", stateDir: state, enabledAt: 1,
          projectCheckCommand: "npm test", workerAgent: "pi", workerModel: "", repairRemote: "origin",
          checkCommand: "npm test", humanLabel: labels.human, reviewLabel: labels.review,
          reviewingLabel: labels.reviewing, blockedLabel: labels.blocked,
        });
        const command = prompt.match(/run the deterministic dispatcher[^`]*:\n  `([^`]+)`/)?.[1];
        if (!command) throw new Error("rendered dispatcher command was not found");
        return command;
      })()
    : "";
  const outputs = Array.from({ length: options.attempts ?? 2 }, () => {
    const result = options.renderedCommand
      ? spawnSync("bash", ["-lc", dispatcherCommand], { cwd: process.cwd(), encoding: "utf8", env })
      : spawnSync("node", argv, { cwd: process.cwd(), encoding: "utf8", env });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  });
  const repairAttempt = fs.readdirSync(path.join(state, "runs"))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(state, "runs", entry, "attempt.json"), "utf8")))
    .find((record) => record.role === "review-repair");
  return {
    launches: JSON.parse(fs.readFileSync(runtime, "utf8")).launches,
    actions: outputs.map((output) => output.driverAction),
    reviewerPhase: JSON.parse(fs.readFileSync(attempt, "utf8")).phase,
    repairWorktreePath: String(repairAttempt?.worktreePath || ""),
    labelsPreserved: outputs[0]?.labelsPreserved || [],
    dispatcherArgsForwarded: !options.renderedCommand || [
      `--worktree-root '${worktreeRoot}'`,
      `--review-label ${labels.review}`,
      `--reviewing-label ${labels.reviewing}`,
      `--blocked-label ${labels.blocked}`,
      `--human-label ${labels.human}`,
    ].every((argument) => dispatcherCommand.includes(argument)),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("review repair dispatch integration", () => {
  it("persists a custom base branch in the review-repair worktree request", () => {
    const input = repairLaunchInput(
      "243", "agent/issue-243", "a".repeat(40), [], "attempt-key",
      { projectId: "demo", baseBranch: "origin/develop", repoPath: "/repo", automationDir: "/automation", stateDir: "/state", worktreeRoot: "/worktrees", githubRepo: "owner/repo", workerAgent: "pi", workerModel: "", requiredVerification: {} },
      "launch-uuid",
    );

    expect(input.worktree.baseBranch).toBe("origin/develop");
  });

  it("persists exact V1 findings, closes the reviewer workspace, and launches one repair without a duplicate", () => {
    const result = runV1ChangesRequestedTwice();

    expect({ launches: result.launches, actions: result.actions, reviewerPhase: result.reviewerPhase }).toEqual({
      launches: 1,
      actions: ["review_repair_monitor_request", "review_repair_monitor_recovered"],
      reviewerPhase: "workspace_closed",
    });
  });

  it("human-blocks when a third attempt appears before a fourth launch", () => {
    const result = runV1ChangesRequestedTwice({ attempts: 1, injectCumulativeLimitRace: true });

    expect({ action: result.actions[0], launches: result.launches }).toEqual({
      action: "review_repair_limit_reached",
      launches: 0,
    });
  });

  it("forwards custom reviewer configuration into repair dispatch and checkout selection", () => {
    const result = runV1ChangesRequestedTwice({ customConfiguration: true, renderedCommand: true, attempts: 1 });

    expect({
      action: result.actions[0],
      dispatcherArgsForwarded: result.dispatcherArgsForwarded,
      labelsPreserved: result.labelsPreserved,
      managedDefaultHumanLabelWasIgnored: result.reviewerPhase,
      repairCheckout: result.repairWorktreePath.endsWith("/custom repair checkouts/agent-issue-243"),
    }).toEqual({
      action: "review_repair_monitor_request",
      dispatcherArgsForwarded: true,
      labelsPreserved: ["custom:review", "custom:reviewing"],
      managedDefaultHumanLabelWasIgnored: "workspace_closed",
      repairCheckout: true,
    });
  });

  it("serializes concurrent approved retries to one review-result comment", async () => {
    expect(await runConcurrentApprovedRetries()).toBe(1);
  });

  it("executes the exact rendered monitor dispatcher command in a clean environment", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-rendered-dispatch-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const state = path.join(root, "config", "deadloop");
    enableProject(state, root);
    const promise = path.join(root, "promise.json");
    fs.mkdirSync(bin);
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify({
      projects: [{
        repoPath: root, githubRepo: "owner/repo", githubRepositoryId: "R_repo", enabledAt: 7,
        firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
        autoMergeAcknowledged: false, enabled: true,
      }],
    }));
    fs.writeFileSync(promise, JSON.stringify({ status: "complete", outcome: "approved", reason: "", summary: "approved", findings: [] }));
    compatibleHerdr(bin);
    executable(path.join(bin, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify(args[0] === "repo"
  ? {id:"R_repo"}
  : {number:143,state:"OPEN",headRefName:"agent/issue-142",headRefOid:"${"a".repeat(40)}",isCrossRepository:false,labels:[{name:"agent:review"},{name:"agent:reviewing"}],comments:[]}));
`);
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 143, expectedHeadOid: "a".repeat(40), branch: "agent/issue-142",
      automationDir: path.resolve("extensions/deadloop/automations"), promiseFile: promise, actorName: "reviewer",
      projectId: "demo", repoPath: root, worktreeRoot: path.join(root, "worktrees"), githubRepo: "owner/repo", stateDir: state, enabledAt: 7,
      projectCheckCommand: "npm test", workerAgent: "pi", workerModel: "", repairRemote: "origin",
      checkCommand: "npm test", humanLabel: "ready-for-human", reviewLabel: "agent:review",
      reviewingLabel: "agent:reviewing", blockedLabel: "agent:blocked",
    });
    const command = prompt.match(/run the deterministic dispatcher[^`]*:\n  `([^`]+)`/)?.[1];
    if (!command) throw new Error("rendered dispatcher command was not found");

    const result = spawnSync("bash", ["-lc", command], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: path.dirname(state), DEADLOOP_REQUIRED_VERIFICATION: process.env.DEADLOOP_REQUIRED_VERIFICATION },
    });

    expect(JSON.parse(result.stdout).action).toBe("done");
  });

  it("rejects an unsupported direct repair dispatch before GitHub mutation or agent launch", () => {
    expect(runDispatch(true, false).events).toEqual([]);
  });

  it("requests LLM monitoring after launching a repair", () => {
    expect(runDispatch(true).output.action).toBe("needs_llm");
  });

  it("identifies the bounded repair monitor action", () => {
    expect(runDispatch(true).output.driverAction).toBe("review_repair_monitor_request");
  });

  it("returns repair monitor input as a generation-bound handoff", () => {
    expect(runDispatch(true).output.monitorHandoff.kind).toBe("repair");
  });

  it("returns the dedicated repair monitor prompt", () => {
    expect(runDispatch(true).output.prompt).toContain("review-repair worker");
  });

  it("returns an error after disable", () => {
    expect(runDispatch(false).output.action).toBe("error");
  });

  it("reports disable as the dispatch failure", () => {
    expect(runDispatch(false).output.summary).toBe("deadloop is disabled for this repository");
  });

  it("does not mutate GitHub or launch a repair after disable", () => {
    expect(runDispatch(false).events).toEqual([]);
  });

  it.each([
    ["8ab3a5f354dccb2d61da7e8385931c8fd5950440", "6c994aad94595aa113e8a35cc2962a9e32a7f6c8"],
    ["6c994aad94595aa113e8a35cc2962a9e32a7f6c8", "ab08360529da29cf16d5ccb109138c9a938e309d"],
  ])("returns a stale review result when the clean worktree advanced from %s", (expectedHead, currentHead) => {
    const result = runStaleWorktreeDispatch(expectedHead, currentHead);

    expect(result.output.driverAction).toBe("review_stale_head");
  });

  it("does not start Herdr when the clean worktree has advanced", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
    );

    expect(result.herdrLog).not.toContain("agent start");
  });

  it("does not mutate GitHub for an advanced clean worktree", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
    );

    expect(result.ghLog.split("\n").filter((line) => line && !line.startsWith("pr view "))).toHaveLength(0);
  });

  it("fails closed when an advanced PR has no owned worktree", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
      { hasWorktree: false },
    );

    expect(result.output.driverAction).toBe("review_repair_worktree_mismatch");
  });

  it("fails closed when an advanced PR does not match the owned worktree", () => {
    const expectedHead = "6c994aad94595aa113e8a35cc2962a9e32a7f6c8";
    const result = runStaleWorktreeDispatch(expectedHead, "ab08360529da29cf16d5ccb109138c9a938e309d", {
      worktreeHead: expectedHead,
    });

    expect(result.output.driverAction).toBe("review_repair_worktree_mismatch");
  });

  it("fails closed when the PR and clean worktree remain mismatched", () => {
    const expectedHead = "6c994aad94595aa113e8a35cc2962a9e32a7f6c8";
    const result = runStaleWorktreeDispatch(expectedHead, expectedHead, {
      worktreeHead: "ab08360529da29cf16d5ccb109138c9a938e309d",
    });

    expect(result.output.driverAction).toBe("review_repair_worktree_mismatch");
  });

  it("finds a branch worktree whose path contains a newline", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
      { worktreeName: "worktree\nodd" },
    );

    expect(result.output.driverAction).toBe("review_stale_head");
  });

  it("does not mutate GitHub when the same stale tuple is dispatched twice", () => {
    const expectedHead = "6c994aad94595aa113e8a35cc2962a9e32a7f6c8";
    const currentHead = "ab08360529da29cf16d5ccb109138c9a938e309d";
    const results = [runStaleWorktreeDispatch(expectedHead, currentHead), runStaleWorktreeDispatch(expectedHead, currentHead)];

    expect(results.flatMap((result) => result.ghLog.split("\n").filter((line) => line && !line.startsWith("pr view ")))).toHaveLength(0);
  });

  it("blocks a dirty worktree when the first PR read is already advanced", () => {
    const expectedHead = "6c994aad94595aa113e8a35cc2962a9e32a7f6c8";
    const currentHead = "ab08360529da29cf16d5ccb109138c9a938e309d";
    const result = runStaleWorktreeDispatch(expectedHead, currentHead, { dirty: true, initialHead: currentHead });

    expect(result.output.driverAction).toBe("review_repair_dirty_worktree");
  });

  it("blocks ambiguous branch worktree ownership", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
      { duplicateWorktree: true },
    );

    expect(result.output.driverAction).toBe("review_repair_ambiguous_worktree");
  });

  it("stops the remaining human-block mutation when disable begins after the comment", () => {
    expect(runTerminalMutationRace("disable_during_human_block").mutations).toEqual(["pr comment 243"]);
  });

  it("does not write a technical-retry comment after the PR head changes", () => {
    expect(runTerminalMutationRace("head_change").mutations).toEqual([]);
  });

  it("does not write a technical-retry comment after the PR labels change", () => {
    expect(runTerminalMutationRace("label_change").mutations).toEqual([]);
  });

  it("blocks an advanced dirty repair worktree", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
      { dirty: true },
    );

    expect(result.output.driverAction).toBe("review_repair_dirty_worktree");
  });

  it("keeps monitoring a launched worker when launch evidence cannot be written", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-evidence-failure-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const worktree = path.join(root, "worktrees", "agent-issue-243");
    const state = path.join(root, "config", "deadloop");
    enableProject(state, root);
    const promise = path.join(root, "review-promise.json");
    const agentStarted = path.join(root, "agent-started");
    fs.mkdirSync(bin);
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "review-repair-launches"), "blocks evidence directory creation");
    fs.writeFileSync(
      promise,
      JSON.stringify({
        status: "complete",
        outcome: "changes_requested",
        reason: "",
        summary: "A lint contract finding needs repair.",
        findings: [{ title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }],
      }),
    );

    executable(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${"a".repeat(40)}",isCrossRepository:false,labels:[{name:"agent:review"},{name:"agent:reviewing"}],comments:[]
}));
else if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({id:"R_repo"}));
`,
    );
    executable(
      path.join(bin, "git"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
process.exit(0);
`,
    );
    executable(
      path.join(bin, "herdr"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("herdr 0.7.5\\n"); process.exit(0); }
if (args[0] === "status" && args[1] === "server") { process.stdout.write("version: 0.7.5\\ncompatible: yes\\n"); process.exit(0); }
if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result:{worktrees:[{path:process.env.TEST_WORKTREE,branch:"agent/issue-243"}]}}));
else if (args[0] === "worktree" && args[1] === "open") process.stdout.write(JSON.stringify({result:{type:"worktree_opened",already_open:false,workspace:{workspace_id:"workspace-1"},tab:{tab_id:"tab-1",workspace_id:"workspace-1"},root_pane:{pane_id:"pane-1",tab_id:"tab-1",workspace_id:"workspace-1",cwd:process.env.TEST_WORKTREE},worktree:{path:process.env.TEST_WORKTREE}}}));
else if (args[0] === "workspace" && args[1] === "list") process.stdout.write(JSON.stringify({result:{workspaces:[]}}));
else if (args[0] === "workspace" && args[1] === "rename") process.stdout.write("renamed");
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result:{agents:fs.existsSync(process.env.AGENT_STARTED)?[JSON.parse(fs.readFileSync(process.env.AGENT_STARTED,"utf8"))]:[]}}));
else if (args[0] === "agent" && args[1] === "start") {
  fs.writeFileSync(process.env.AGENT_STARTED, JSON.stringify({terminal_id:"terminal-1",name:args[2],agent_status:"working",cwd:process.env.TEST_WORKTREE,pane_id:args[args.indexOf("--pane")+1]}));
  process.stdout.write(JSON.stringify({ok:true}));
}
`,
    );

    const result = spawnSync(
      "node",
      [
        "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
        "--promise",
        promise,
        "--pr",
        "243",
        "--expected-head",
        "a".repeat(40),
        "--branch",
        "agent/issue-243",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEADLOOP_PROJECT_ID: "demo",
          DEADLOOP_REPO_PATH: root,
          DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"),
          DEADLOOP_GITHUB_REPO: "owner/repo",
          PI_CODING_AGENT_DIR: path.dirname(state),
          DEADLOOP_ENABLED_AT: "1",
          DEADLOOP_STATE_DIR: state,
          TEST_WORKTREE: worktree,
          AGENT_STARTED: agentStarted,
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);

    expect({
      action: output.action,
      driverAction: output.driverAction,
      monitored: output.prompt.includes("review-repair worker"),
      agentStarted: fs.existsSync(agentStarted),
      evidenceError: Boolean(output.launchEvidenceError),
    }).toEqual({
      action: "needs_llm",
      driverAction: "review_repair_monitor_request",
      monitored: true,
      agentStarted: true,
      evidenceError: true,
    });
  });

  it("monitors a worker when start succeeds but its response fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-start-response-failure-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const worktree = path.join(root, "worktrees", "agent-issue-243");
    const state = path.join(root, "config", "deadloop");
    enableProject(state, root);
    const promise = path.join(root, "review-promise.json");
    const agentStarted = path.join(root, "agent-started");
    const head = "a".repeat(40);
    fs.mkdirSync(bin);
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      promise,
      JSON.stringify({
        status: "complete",
        outcome: "changes_requested",
        reason: "",
        summary: "A lint contract finding needs repair.",
        findings: [{ title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }],
      }),
    );

    executable(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${head}",isCrossRepository:false,labels:[{name:"agent:review"},{name:"agent:reviewing"}],comments:[]
}));
else if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({id:"R_repo"}));
`,
    );
    executable(path.join(bin, "git"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
process.exit(0);
`);
    executable(
      path.join(bin, "herdr"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("herdr 0.7.5\\n"); process.exit(0); }
if (args[0] === "status" && args[1] === "server") { process.stdout.write("version: 0.7.5\\ncompatible: yes\\n"); process.exit(0); }
const started = fs.existsSync(process.env.AGENT_STARTED);
if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result:{worktrees:[{path:process.env.TEST_WORKTREE,branch:"agent/issue-243"}]}}));
else if (args[0] === "worktree" && args[1] === "open") process.stdout.write(JSON.stringify({result:{type:"worktree_opened",already_open:false,workspace:{workspace_id:"workspace-1"},tab:{tab_id:"tab-1",workspace_id:"workspace-1"},root_pane:{pane_id:"pane-1",tab_id:"tab-1",workspace_id:"workspace-1",cwd:process.env.TEST_WORKTREE},worktree:{path:process.env.TEST_WORKTREE}}}));
else if (args[0] === "workspace" && args[1] === "list") process.stdout.write(JSON.stringify({result:{workspaces:[]}}));
else if (args[0] === "workspace" && args[1] === "rename") process.stdout.write("renamed");
else if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result:{worktrees:[{branch:"agent/issue-243",path:process.env.TEST_WORKTREE}]}}));
else if (args[0] === "agent" && args[1] === "list") {
  const runs = fs.readdirSync(process.env.TEST_STATE + "/runs");
  const attempt = JSON.parse(fs.readFileSync(process.env.TEST_STATE + "/runs/" + runs[0] + "/attempt.json", "utf8"));
  process.stdout.write(JSON.stringify({result:{agents:started?[{terminal_id:"terminal-1",name:attempt.agentName,agent_status:"working",cwd:process.env.TEST_WORKTREE,pane_id:"pane-1"}]:[]}}));
}
else if (args[0] === "agent" && args[1] === "start") {
  fs.writeFileSync(process.env.AGENT_STARTED, "yes");
  process.stderr.write("response connection failed");
  process.exit(1);
}
`,
    );

    const { reviewResultFingerprint, repairAttemptKey } = require("../extensions/deadloop/automations/pr-review-repair-state.ts");
    const findings = [{ title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }];
    const attemptKey = repairAttemptKey(head, reviewResultFingerprint(findings));
    const result = spawnSync(
      "node",
      [
        "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
        "--promise",
        promise,
        "--pr",
        "243",
        "--expected-head",
        head,
        "--branch",
        "agent/issue-243",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEADLOOP_PROJECT_ID: "demo",
          DEADLOOP_REPO_PATH: root,
          DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"),
          DEADLOOP_GITHUB_REPO: "owner/repo",
          PI_CODING_AGENT_DIR: path.dirname(state),
          DEADLOOP_ENABLED_AT: "1",
          DEADLOOP_STATE_DIR: state,
          TEST_WORKTREE: worktree,
          AGENT_STARTED: agentStarted,
          TEST_STATE: state,
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);

    expect({
      action: output.action,
      driverAction: output.driverAction,
      recovered: output.launch.recovered,
      launchEvidenceRecorded: fs.existsSync(path.join(state, "review-repair-launches", `demo-pr-243-${attemptKey}.json`)),
    }).toEqual({
      action: "needs_llm",
      driverAction: "review_repair_monitor_request",
      recovered: true,
      launchEvidenceRecorded: true,
    });
  });

  it("recovers a crash-window retry from the active Herdr worker when local launch evidence is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-active-recovery-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const state = path.join(root, "config", "deadloop");
    enableProject(state, root);
    const worktree = path.join(root, "worktrees", "agent-issue-243");
    const promise = path.join(root, "review-promise.json");
    const launchAttempted = path.join(root, "launch-attempted");
    const head = "a".repeat(40);
    const finding = { title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" };
    const { renderRepairMarker, reviewResultFingerprint } = require("../extensions/deadloop/automations/pr-review-repair-state.ts");
    const fingerprint = reviewResultFingerprint([finding]);
    const marker = renderRepairMarker(head, fingerprint);
    const attemptKey = marker.match(/key=([0-9a-f]+)/)?.[1];
    fs.mkdirSync(bin);
    fs.mkdirSync(worktree, { recursive: true });
    const repairRunDir = path.join(state, "runs", "interrupted-launch");
    fs.mkdirSync(repairRunDir, { recursive: true });
    fs.writeFileSync(path.join(repairRunDir, "review-contract.json"), JSON.stringify({ attemptKey, expectedHead: head, findingTitles: [finding.title] }));
    const recoveredAgentName = "dl-rr-243-123456789abc";
    fs.writeFileSync(path.join(repairRunDir, "attempt.json"), JSON.stringify({
      attemptId: attemptKey, launchUuid: "interrupted-launch", project: "demo", repository: "owner/repo", role: "review-repair",
      target: { kind: "pull-request", number: 243 }, inputRevision: { head }, branch: "agent/issue-243",
      worktreePath: worktree, agentName: recoveredAgentName, workspaceLabel: "repair", promptFile: path.join(repairRunDir, "prompt.md"),
      promiseFile: path.join(repairRunDir, "promise.json"), phase: "agent_started", lastSuccessfulPhase: "agent_started",
      workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1",
    }));
    fs.writeFileSync(
      promise,
      JSON.stringify({ status: "complete", outcome: "changes_requested", reason: "", summary: "Repair it.", findings: [finding] }),
    );
    executable(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${head}",isCrossRepository:false,labels:[{name:"agent:reviewing"}],comments:[{body:${JSON.stringify(marker)},author:{login:"deadloop-bot"}}]
}));
else if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({id:"R_repo"}));
`,
    );
    executable(
      path.join(bin, "herdr"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("herdr 0.7.5\\n"); process.exit(0); }
if (args[0] === "status" && args[1] === "server") { process.stdout.write("version: 0.7.5\\ncompatible: yes\\n"); process.exit(0); }
if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result:{worktrees:[{branch:"agent/issue-243",path:process.env.TEST_WORKTREE}]}}));
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result:{agents:[{terminal_id:"terminal-1",name:${JSON.stringify("dl-rr-243-123456789abc")},agent_status:"working",cwd:process.env.TEST_WORKTREE,pane_id:"pane-1"}]}}));
else if (args[0] === "agent" && args[1] === "start") fs.writeFileSync(process.env.LAUNCH_ATTEMPTED, "yes");
`,
    );

    const result = spawnSync(
      "node",
      [
        "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
        "--promise",
        promise,
        "--pr",
        "243",
        "--expected-head",
        head,
        "--branch",
        "agent/issue-243",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEADLOOP_PROJECT_ID: "demo",
          DEADLOOP_REPO_PATH: root,
          DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"),
          DEADLOOP_GITHUB_REPO: "owner/repo",
          PI_CODING_AGENT_DIR: path.dirname(state),
          DEADLOOP_ENABLED_AT: "1",
          DEADLOOP_STATE_DIR: state,
          TEST_WORKTREE: worktree,
          LAUNCH_ATTEMPTED: launchAttempted,
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);

    expect({
      action: output.action,
      driverAction: output.driverAction,
      promiseFile: output.monitorHandoff?.input?.promiseFile,
      launchAttempted: fs.existsSync(launchAttempted),
    }).toEqual({
      action: "needs_llm",
      driverAction: "review_repair_monitor_recovered",
      promiseFile: path.join(repairRunDir, "promise.json"),
      launchAttempted: false,
    });
  });

  it("recovers a marker-only retry when no launch evidence exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-marker-only-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const state = path.join(root, "config", "deadloop");
    enableProject(state, root);
    const promise = path.join(root, "review-promise.json");
    const herdrCalled = path.join(root, "herdr-called");
    const head = "a".repeat(40);
    const finding = { title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" };
    const { renderRepairMarker, reviewResultFingerprint } = require("../extensions/deadloop/automations/pr-review-repair-state.ts");
    const marker = renderRepairMarker(head, reviewResultFingerprint([finding]));
    fs.mkdirSync(bin);
    fs.writeFileSync(
      promise,
      JSON.stringify({ status: "complete", outcome: "changes_requested", reason: "", summary: "Repair it.", findings: [finding] }),
    );
    executable(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${head}",isCrossRepository:false,labels:[{name:"agent:reviewing"}],comments:[{body:${JSON.stringify(marker)},author:{login:"deadloop-bot"}}]
}));
else if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({id:"R_repo"}));
`,
    );
    executable(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("herdr 0.7.5\\n"); process.exit(0); }
if (args[0] === "status" && args[1] === "server") { process.stdout.write("version: 0.7.5\\ncompatible: yes\\n"); process.exit(0); }
if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result:{worktrees:[]}}));
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result:{agents:[]}}));
else if (args[0] === "agent" && args[1] === "start") fs.writeFileSync(process.env.HERDR_CALLED, "yes");
`);

    const result = spawnSync(
      "node",
      [
        "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
        "--promise",
        promise,
        "--pr",
        "243",
        "--expected-head",
        head,
        "--branch",
        "agent/issue-243",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEADLOOP_PROJECT_ID: "demo",
          DEADLOOP_REPO_PATH: root,
          DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"),
          DEADLOOP_GITHUB_REPO: "owner/repo",
          PI_CODING_AGENT_DIR: path.dirname(state),
          DEADLOOP_ENABLED_AT: "1",
          DEADLOOP_STATE_DIR: state,
          HERDR_CALLED: herdrCalled,
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);

    expect({ driverAction: output.driverAction, launchAttempted: fs.existsSync(herdrCalled) }).toEqual({
      driverAction: "review_repair_dispatch_interrupted",
      launchAttempted: false,
    });
  });

  it("human-blocks when the attempt comment succeeds but label mutation fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-label-failure-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const state = path.join(root, "config", "deadloop");
    enableProject(state, root);
    const promise = path.join(root, "review-promise.json");
    const editCount = path.join(root, "edit-count");
    const herdrCalled = path.join(root, "herdr-called");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      promise,
      JSON.stringify({
        status: "complete",
        outcome: "changes_requested",
        reason: "",
        summary: "A lint contract finding needs repair.",
        findings: [{ title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }],
      }),
    );

    executable(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${"a".repeat(40)}",isCrossRepository:false,labels:[{name:"agent:review"},{name:"agent:reviewing"}],comments:[]
}));
else if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({id:"R_repo"}));
if (args[0] === "pr" && args[1] === "edit") {
  const count = fs.existsSync(process.env.EDIT_COUNT) ? Number(fs.readFileSync(process.env.EDIT_COUNT, "utf8")) : 0;
  fs.writeFileSync(process.env.EDIT_COUNT, String(count + 1));
  if (count === 0) process.exit(1);
}
`,
    );
    executable(
      path.join(bin, "herdr"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("herdr 0.7.5\\n");
else if (args[0] === "status" && args[1] === "server") process.stdout.write("version: 0.7.5\\ncompatible: yes\\n");
else if (args[0] === "agent" && args[1] === "start") fs.writeFileSync(process.env.HERDR_CALLED, "yes");
`,
    );

    const result = spawnSync(
      "node",
      [
        "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
        "--promise",
        promise,
        "--pr",
        "243",
        "--expected-head",
        "a".repeat(40),
        "--branch",
        "agent/issue-243",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEADLOOP_PROJECT_ID: "demo",
          DEADLOOP_REPO_PATH: root,
          DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"),
          DEADLOOP_GITHUB_REPO: "owner/repo",
          PI_CODING_AGENT_DIR: path.dirname(state),
          DEADLOOP_ENABLED_AT: "1",
          DEADLOOP_STATE_DIR: state,
          EDIT_COUNT: editCount,
          HERDR_CALLED: herdrCalled,
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);

    expect({ driverAction: output.driverAction, launchAttempted: fs.existsSync(herdrCalled) }).toEqual({
      driverAction: "review_repair_launch_failed",
      launchAttempted: false,
    });
  });
});
