import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const { dispatcherArgs } = require("../extensions/deadloop/automations/complete-deterministic-pr-attempt.cts");
const { assertReviewerDispatchAttemptBinding, blockedClaimMove, requireManagedPr } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.cts");
const { repairLaunchInput } = require("../extensions/deadloop/automations/pr-review-repair-launch.cts");

function decodeMarkerPayload(body: string): Record<string, unknown> | null {
  const data = body.match(/deadloop:review-repair-attempt key=[0-9a-f]+ head=[0-9a-f]+ review=[0-9a-f]+ data=([A-Za-z0-9_-]+) -->/)?.[1];
  if (!data) return null;
  return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
}
const {
  persistHostVerificationEvidence,
  requiredVerificationBinding,
  workerRequiredVerificationPath,
  writeWorkerContractSnapshot,
} = require("../src/worker-required-verification-runtime.cjs");
const cumulativeRepairFixture = require("./fixtures/pr-review-repair/cumulative-limit.json");
const trustedCumulativeComments = cumulativeRepairFixture.comments.map((comment: Record<string, unknown>) => ({
  ...comment,
  author: { login: "deadloop-bot" },
}));

const tempDirs: string[] = [];

function executable(file: string, content: string): void {
  const prepared = path.basename(file) === "gh"
    ? content.replace("\n", `\nconst deadloopGhArgs = process.argv.slice(2);\nif (deadloopGhArgs[0] === "api" && deadloopGhArgs[1] === "user") { const login = process.env.TEST_AUTH_LOGIN_FILE && require("node:fs").existsSync(process.env.TEST_AUTH_LOGIN_FILE) ? require("node:fs").readFileSync(process.env.TEST_AUTH_LOGIN_FILE, "utf8").trim() : (process.env.TEST_AUTH_LOGIN || "deadloop-bot"); process.stdout.write(login + "\\n"); process.exit(0); }\n`)
    : path.basename(file) === "git"
      ? content.replace("\n", `\nconst deadloopGitArgs = process.argv.slice(2);\nif ((deadloopGitArgs.includes("rev-parse") && deadloopGitArgs.some((arg) => arg.endsWith("^{commit}"))) || (deadloopGitArgs.includes("show") && deadloopGitArgs.some((arg) => arg.endsWith(":deadloop.json")))) {\n  const result = require("node:child_process").spawnSync("/usr/bin/git", deadloopGitArgs, {encoding:"utf8"});\n  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || ""); process.exit(result.status ?? 1);\n}\n`)
      : content;
  fs.writeFileSync(file, prepared);
  fs.chmodSync(file, 0o755);
}

function supportedHerdr(bin: string): void {
  executable(path.join(bin, "herdr"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("herdr 0.8.0\\n");
else if (args[0] === "status" && args[1] === "server") process.stdout.write("version: 0.8.0\\n");
else if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result:{worktrees:[]}}));
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result:{agents:[]}}));
`);
}

function writeSavedReviewerAuthority(
  state: string,
  promise: string,
  head: string,
  targetNumber = 243,
  repository = "owner/repo",
  worktreePath = path.dirname(promise),
  branch = `agent/issue-${targetNumber}`,
): string {
  const runDir = path.join(state, "runs", `reviewer-${targetNumber}`);
  const attempt = path.join(runDir, "attempt.json");
  fs.mkdirSync(runDir, { recursive: true });
  const raw = JSON.parse(fs.readFileSync(promise, "utf8"));
  const base = {
    schemaVersion: 1, attemptId: `reviewer-${targetNumber}`, role: "reviewer",
    target: { repository, kind: "pull-request", number: targetNumber }, inputRevision: { head },
    summary: String(raw.summary || "review result"), evidence: { reviewed: ["PR diff"] },
  };
  const report = raw.status === "blocked"
    ? { ...base, status: "blocked", result: { reason: String(raw.reason || "reviewer failed"), explanation: String(raw.summary || "reviewer failed"), recovery: "Retry the review." } }
    : {
      ...base,
      status: "complete",
      result: {
        outcome: String(raw.outcome || "changes_requested"),
        reviewedHead: head,
        findings: Array.isArray(raw.findings) ? raw.findings : [],
        ...(String(raw.outcome || "changes_requested") === "changes_requested"
          ? { priorRequiredFindings: String(raw.priorRequiredFindings || "all_resolved") }
          : {}),
      },
    };
  fs.writeFileSync(promise, JSON.stringify(report));
  const worktreeHead = spawnSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const requiredVerification = {
    repository, command: "true",
    source: { kind: "local", location: `${path.join(state, "projects.json")}#project=demo` }, baseRevision: worktreeHead || head,
  };
  fs.writeFileSync(attempt, JSON.stringify({
    attemptId: `reviewer-${targetNumber}`, launchUuid: `reviewer-${targetNumber}`, project: "demo", repository, role: "reviewer",
    target: { kind: "pull-request", number: targetNumber }, inputRevision: { head }, branch,
    worktreePath, agentName: "reviewer", workspaceLabel: "reviewer", promptFile: path.join(runDir, "prompt.md"),
    promiseFile: promise, phase: "workspace_closed", lastSuccessfulPhase: "workspace_closed", requestEventId: "22",
    requiredVerification, baseBranch: "origin/master",
  }));
  if (path.dirname(promise) === runDir) {
    const attemptValue = JSON.parse(fs.readFileSync(attempt, "utf8"));
    writeWorkerContractSnapshot(runDir, attemptValue);
    persistHostVerificationEvidence(workerRequiredVerificationPath(attempt), {
      version: 1, binding: requiredVerificationBinding(requiredVerification, head), outcome: "passed", exitCode: 0,
      startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1, logPath: path.join(runDir, "required-verification.log"),
    });
    fs.writeFileSync(path.join(state, "projects.json"), JSON.stringify({ projects: [{
      id: "demo", repoPath: worktreePath, githubRepo: repository, baseBranch: "origin/master", checkCommand: "true",
    }] }));
  }
  return attempt;
}

/**
 * Every reviewer launch fixes a required-verification contract, so a fixture whose attempt record
 * is written inline fixes the same contract the harness policy currently resolves to.
 */
function fixReviewerContract(state: string, repoPath: string, attemptFile: string, baseBranch = "origin/master"): void {
  const attempt = JSON.parse(fs.readFileSync(attemptFile, "utf8"));
  const baseRevision = spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", `${baseBranch}^{commit}`], { encoding: "utf8" }).stdout.trim();
  const configFile = path.join(state, "projects.json");
  const configured = (JSON.parse(fs.readFileSync(configFile, "utf8")).projects as Array<Record<string, unknown>>)
    .find((project) => project.id === attempt.project && project.githubRepo === attempt.repository);
  attempt.baseBranch = baseBranch;
  attempt.requiredVerification = configured?.checkCommand === undefined
    ? { repository: attempt.repository, command: "npm run check", source: { kind: "default", location: "deadloop" }, baseRevision }
    : {
      repository: attempt.repository,
      command: configured.checkCommand,
      source: { kind: "local", location: `${configFile}#project=${attempt.project}` },
      baseRevision,
    };
  fs.writeFileSync(attemptFile, JSON.stringify(attempt));
  writeWorkerContractSnapshot(path.dirname(attemptFile), JSON.parse(fs.readFileSync(attemptFile, "utf8")));
}

/** Real git for every command except the trusted-policy fetch, which no fixture remote can serve. */
function passthroughGit(bin: string): void {
  executable(path.join(bin, "git"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if ((args[0] === "-C" ? args[2] : args[0]) === "fetch") process.exit(0);
const result = require("node:child_process").spawnSync("/usr/bin/git", args, { encoding: "utf8" });
process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`);
}

function enableProject(state: string, repoPath: string): void {
  spawnSync("git", ["-C", repoPath, "init", "--quiet"]);
  spawnSync("git", ["-C", repoPath, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", repoPath, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "fixture\n");
  fs.writeFileSync(path.join(repoPath, "deadloop.json"), "{}\n");
  spawnSync("git", ["-C", repoPath, "add", "README.md", "deadloop.json"]);
  spawnSync("git", ["-C", repoPath, "commit", "--quiet", "-m", "fixture"]);
  spawnSync("git", ["-C", repoPath, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  spawnSync("git", ["-C", repoPath, "update-ref", "refs/remotes/origin/master", "HEAD"]);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify({ lastWriterCodeIdentity: "a".repeat(40), projects: [{
    repoPath, githubRepo: "owner/repo", githubRepositoryId: "R_repo", baseBranch: "origin/master", automationLogin: "deadloop-bot", enabledAt: 1,
    firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
    autoMergeAcknowledged: false, enabled: true,
  }] }));
  fs.writeFileSync(path.join(state, "projects.json"), JSON.stringify({ projects: [{
    id: "demo", repoPath, githubRepo: "owner/repo", baseBranch: "origin/master",
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
    worktreeStatus?: string;
  } = {},
): { output: Record<string, unknown>; ghLog: string; herdrLog: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-stale-review-repair-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const worktree = path.join(root, options.worktreeName || "worktree");
  const worktreeHead = options.worktreeHead || currentHead;
  const configDir = path.join(root, "config");
  const state = path.join(configDir, "deadloop");
  const promise = path.join(state, "runs", "reviewer-143", "promise.json");
  const ghCount = path.join(root, "gh-count");
  const ghLog = path.join(root, "gh.log");
  const herdrLog = path.join(root, "herdr.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.dirname(promise), { recursive: true });
  spawnSync("git", ["-C", root, "init", "--quiet"]);
  spawnSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", root, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  fs.writeFileSync(path.join(root, "deadloop.json"), "{}\n");
  spawnSync("git", ["-C", root, "add", "README.md", "deadloop.json"]);
  spawnSync("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
  spawnSync("git", ["-C", root, "update-ref", "refs/remotes/origin/master", "HEAD"]);
  fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify({ lastWriterCodeIdentity: "a".repeat(40), 
    projects: [{
      repoPath: root, githubRepo: "yasuhito/deadloop", githubRepositoryId: "R_repo", baseBranch: "origin/master", automationLogin: "deadloop-bot", enabledAt: 1,
      firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
      autoMergeAcknowledged: false, enabled: true,
    }],
  }));
  fs.writeFileSync(path.join(state, "projects.json"), JSON.stringify({ projects: [{
    id: "demo", repoPath: root, githubRepo: "yasuhito/deadloop", baseBranch: "origin/master",
  }] }));
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
  const attempt = writeSavedReviewerAuthority(
    state,
    promise,
    expectedHead,
    143,
    "yasuhito/deadloop",
    worktree,
    "agent/issue-142-deadloop",
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
    number:143,state:"OPEN",headRefName:"agent/issue-142-deadloop",headRefOid:heads[Math.min(count, heads.length - 1)],isCrossRepository:false,labels:[{name:"agent:in-progress"}],comments:[]
  }));
} else if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"yasuhito/deadloop"}));
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
  process.stdout.write(!args.includes("--untracked-files=all") ? "" : (process.env.TEST_WORKTREE_STATUS || (process.env.TEST_DIRTY === "true" ? "?? untracked.txt\\n" : "")));
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
if (args[0] === "--version") { process.stdout.write("herdr 0.8.0\\n"); process.exit(0); }
if (args[0] === "status" && args[1] === "server") { process.stdout.write("version: 0.8.0\\n"); process.exit(0); }
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
      "extensions/deadloop/automations/pr-review-repair-dispatch.cts",
      "--promise",
      promise,
      "--attempt-record",
      attempt,
      "--request-event-id",
      "22",
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
        DEADLOOP_WORKER_MODEL: "test-worker-model",
        DEADLOOP_REPAIR_MODEL: "test-repair-model",
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
        TEST_WORKTREE_STATUS: options.worktreeStatus || "",
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

function runDispatch(enabled: boolean, supported = true): { output: Record<string, any>; events: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const worktree = path.join(root, "worktrees", "agent-issue-243");
  const configDir = path.join(root, "config");
  const state = path.join(configDir, "deadloop");
  const runDir = path.join(state, "runs", "reviewer");
  const promise = path.join(runDir, "promise.json");
  const attempt = path.join(runDir, "attempt.json");
  const eventLog = path.join(root, "events.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  enableProject(state, root);
  if (!enabled) {
    const stateValue = JSON.parse(fs.readFileSync(path.join(state, "enabled-projects.json"), "utf8"));
    stateValue.projects[0].enabled = false;
    fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify(stateValue));
  }
  const findings = [{ title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }];
  fs.writeFileSync(promise, JSON.stringify({
    schemaVersion: 1, attemptId: "reviewer", role: "reviewer", status: "complete",
    target: { repository: "owner/repo", kind: "pull-request", number: 243 }, inputRevision: { head: "a".repeat(40) },
    summary: "A lint contract finding needs repair.", result: { outcome: "changes_requested", reviewedHead: "a".repeat(40), findings, priorRequiredFindings: "none" },
    evidence: { reviewed: ["diff"] },
  }));
  fs.writeFileSync(attempt, JSON.stringify({
    attemptId: "reviewer", launchUuid: "reviewer", project: "demo", repository: "owner/repo", role: "reviewer",
    target: { kind: "pull-request", number: 243 }, inputRevision: { head: "a".repeat(40) }, branch: "agent/issue-243",
    worktreePath: worktree, agentName: "reviewer", workspaceLabel: "reviewer", promptFile: path.join(runDir, "prompt.md"),
    promiseFile: promise, phase: "workspace_closed", lastSuccessfulPhase: "workspace_closed", requestEventId: "22",
  }));
  fixReviewerContract(state, root, attempt);

  executable(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${"a".repeat(40)}",isCrossRepository:false,labels:[{name:"agent:in-progress"}],comments:[]
}));
else if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"owner/repo"}));
else if (args[0] === "api" && args[1] === "user") process.stdout.write("deadloop-bot\\n");
else if (args[0] === "api" && args.includes("--method") && args.includes("POST")) { fs.appendFileSync(process.env.EVENT_LOG, "github-mutation\\n"); process.stdout.write(JSON.stringify(["agent:in-progress"])); }
else fs.appendFileSync(process.env.EVENT_LOG, "github-mutation\\n");
`,
  );
  executable(
    path.join(bin, "git"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
// The repair checkout already carries the expected head, so alignment finds nothing to do.
else if (args.includes("rev-parse") && args.includes("HEAD")) process.stdout.write("${"a".repeat(40)}\\n");
process.exit(0);
`,
  );
  executable(
    path.join(bin, "herdr"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("herdr ${supported ? "0.8.0" : "0.7.9"}\\n"); process.exit(0); }
if (args[0] === "status" && args[1] === "server") { process.stdout.write("version: ${supported ? "0.8.0" : "0.7.9"}\\\n"); process.exit(0); }
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
      "extensions/deadloop/automations/pr-review-repair-dispatch.cts",
      "--promise",
      promise,
      "--attempt-record",
      attempt,
      "--request-event-id",
      "22",
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
        DEADLOOP_WORKER_MODEL: "test-worker-model",
        DEADLOOP_REPAIR_MODEL: "test-repair-model",
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

/**
 * One approved dispatch racing a change that lands during its last live PR read: either the PR head
 * or the trusted required-verification policy.
 */
function runApprovedAuthorizationRace(
  race: { headChangeAfter?: number; policyChangeAfter?: number },
): { output: Record<string, unknown>; comments: unknown[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-approved-head-race-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const configDir = path.join(root, "config");
  const state = path.join(configDir, "deadloop");
  const runDir = path.join(state, "runs", "reviewer-243");
  fs.mkdirSync(runDir, { recursive: true });
  const promise = path.join(runDir, "promise.json");
  const commentsFile = path.join(root, "comments.json");
  const viewsFile = path.join(root, "views.txt");
  fs.mkdirSync(bin);
  enableProject(state, root);
  fs.writeFileSync(promise, JSON.stringify({
    status: "complete", outcome: "approved", reason: "", summary: "No actionable findings.", findings: [],
  }));
  const attempt = writeSavedReviewerAuthority(state, promise, "a".repeat(40), 243, "owner/repo", root);
  fs.writeFileSync(commentsFile, "[]");
  executable(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"owner/repo"}));
else if (args[0] === "pr" && args[1] === "view") {
  const views = fs.existsSync(process.env.VIEWS_FILE) ? Number(fs.readFileSync(process.env.VIEWS_FILE, "utf8")) : 0;
  fs.writeFileSync(process.env.VIEWS_FILE, String(views + 1));
  const head = views >= Number(process.env.HEAD_CHANGE_AFTER) ? "${"c".repeat(40)}" : "${"a".repeat(40)}";
  if (views === Number(process.env.POLICY_CHANGE_AFTER)) {
    const policy = JSON.parse(fs.readFileSync(process.env.POLICY_FILE, "utf8"));
    policy.projects[0].checkCommand = "false";
    fs.writeFileSync(process.env.POLICY_FILE, JSON.stringify(policy));
  }
  process.stdout.write(JSON.stringify({
    number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:head,isCrossRepository:false,
    labels:[{name:"agent:in-progress"}],comments:JSON.parse(fs.readFileSync(process.env.COMMENTS_FILE,"utf8"))
  }));
}
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
  supportedHerdr(bin);
  const result = spawnSync("node", [
    "extensions/deadloop/automations/pr-review-repair-dispatch.cts",
    "--promise", promise, "--attempt-record", attempt, "--request-event-id", "22",
    "--pr", "243", "--expected-head", "a".repeat(40), "--branch", "agent/issue-243",
  ], { cwd: process.cwd(), encoding: "utf8", env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: configDir,
    DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: root, DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"), DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_ENABLED_AT: "1",
    DEADLOOP_STATE_DIR: state, COMMENTS_FILE: commentsFile, VIEWS_FILE: viewsFile,
    HEAD_CHANGE_AFTER: String(race.headChangeAfter ?? Number.MAX_SAFE_INTEGER),
    POLICY_CHANGE_AFTER: String(race.policyChangeAfter ?? -1),
    POLICY_FILE: path.join(state, "projects.json"),
  } });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return {
    output: JSON.parse(result.stdout),
    comments: JSON.parse(fs.readFileSync(commentsFile, "utf8")),
  };
}

async function runConcurrentApprovedRetries(): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-result-concurrent-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const configDir = path.join(root, "config");
  const state = path.join(configDir, "deadloop");
  const promise = path.join(state, "runs", "reviewer-243", "promise.json");
  const commentsFile = path.join(root, "comments.json");
  fs.mkdirSync(bin);
  enableProject(state, root);
  fs.mkdirSync(path.dirname(promise), { recursive: true });
  fs.writeFileSync(promise, JSON.stringify({
    status: "complete", outcome: "approved", reason: "", summary: "No actionable findings.", findings: [],
  }));
  const attempt = writeSavedReviewerAuthority(state, promise, "a".repeat(40), 243, "owner/repo", root);
  fs.writeFileSync(commentsFile, "[]");
  executable(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"owner/repo"}));
else if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${"a".repeat(40)}",isCrossRepository:false,
  labels:[{name:"agent:in-progress"}],comments:JSON.parse(fs.readFileSync(process.env.COMMENTS_FILE,"utf8"))
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
  supportedHerdr(bin);
  const args = [
    "extensions/deadloop/automations/pr-review-repair-dispatch.cts",
    "--promise", promise, "--attempt-record", attempt, "--request-event-id", "22", "--pr", "243", "--expected-head", "a".repeat(40), "--branch", "agent/issue-243",
  ];
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: configDir,
    DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: root, DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"), DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_ENABLED_AT: "1",
    DEADLOOP_STATE_DIR: state, COMMENTS_FILE: commentsFile,
  };
  await Promise.all([0, 1].map(() => new Promise<void>((resolve, reject) => {
    const child = spawn("node", args, { cwd: process.cwd(), env, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(`dispatch exited ${status}`)));
  })));
  return JSON.parse(fs.readFileSync(commentsFile, "utf8")).length;
}

type RepairRequestRun = {
  comments: number;
  launches: number;
  actions: string[];
  staleReasons: (string | undefined)[];
  reviewerPhase: string;
  labelMoves: string[];
  finalLabels: string[];
  persistedComments: Array<{ body?: string }>;
  dispatcherArgsForwarded: boolean;
};

function runV1ChangesRequestedTwice(options: {
  customConfiguration?: boolean;
  renderedCommand?: boolean;
  attempts?: number;
  injectCumulativeLimitRace?: boolean;
  injectBlockingHistoryRace?: boolean;
  policyRaceAfterViews?: number;
  historyRequired?: boolean;
  advisories?: Record<string, unknown>[];
} = {}): RepairRequestRun {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-v1-repair-sequence-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const worktreeRoot = path.join(root, options.customConfiguration ? "custom repair checkouts" : "worktrees");
  const worktree = path.join(worktreeRoot, "agent-issue-243");
  const labels = options.customConfiguration
    ? { review: "custom:review", blocked: "custom:blocked", implement: "custom:implement", updateBranch: "custom:update-branch" }
    : { review: "agent:review", blocked: "agent:blocked", implement: "agent:implement", updateBranch: "agent:update-branch" };
  const liveLabels = [
    { name: "agent:in-progress" },
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
  const prLabels = path.join(root, "pr-labels.json");
  const mutationsLog = path.join(root, "mutations.log");
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
  spawnSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/master", "HEAD"]);
  const head = spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(
    comments,
    JSON.stringify(options.injectCumulativeLimitRace || options.injectBlockingHistoryRace ? trustedCumulativeComments.slice(0, 2) : []),
  );
  if (options.injectBlockingHistoryRace) {
    const conversationComments = trustedCumulativeComments.slice(0, 2).map((comment, index) => ({
      id: String(index + 1), nodeId: "", author: "deadloop-bot", body: String(comment.body), createdAt: "x", updatedAt: "x",
    }));
    const history = {
      pullRequest: { number: 243, state: "open", headRef: "agent/issue-243", headSha: head, baseRef: "main", baseSha: "b".repeat(40) },
      commits: [{ sha: head }], diff: { sha256: createHash("sha256").update("diff\n").digest("hex"), bytes: 5 },
      conversationComments, submittedReviews: [], inlineReviewComments: [],
    };
    fs.writeFileSync(path.join(reviewerRun, "pr-review-history.json"), JSON.stringify({
      schemaVersion: 1, repository: "owner/repo", pullRequestNumber: 243, observedAt: "2026-01-01T00:00:00.000Z",
      revision: createHash("sha256").update(`${JSON.stringify(history)}\n`).digest("hex"), history, evidence: { exactDiff: "diff\n" },
    }));
  }
  fs.writeFileSync(runtime, JSON.stringify({ workspace: "reviewer-workspace", agent: null, launches: 0 }));
  fs.writeFileSync(prLabels, JSON.stringify(liveLabels.map((label) => label.name)));
  fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify({ lastWriterCodeIdentity: "a".repeat(40), projects: [{
    repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "R_repo", baseBranch: "origin/master", automationLogin: "deadloop-bot", enabledAt: 1,
    firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
    autoMergeAcknowledged: false, enabled: true,
  }] }));
  fs.writeFileSync(path.join(state, "projects.json"), JSON.stringify({ projects: [{
    id: "demo", repoPath: repo, githubRepo: "owner/repo", baseBranch: "origin/master", labels,
    workerModel: "test-worker-model", reviewerModel: "test-review-model",
  }] }));
  const findings = [{ title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }];
  fs.writeFileSync(promise, JSON.stringify({
    schemaVersion: 1, attemptId: "reviewer-attempt", role: "reviewer",
    target: { repository: "owner/repo", kind: "pull-request", number: 243 }, inputRevision: { head },
    status: "complete", summary: "One exact finding",
    result: {
      outcome: "changes_requested", reviewedHead: head, findings, priorRequiredFindings: "none",
      ...(options.advisories ? { advisories: options.advisories } : {}),
    },
    evidence: { reviewed: ["diff"] },
  }));
  fs.writeFileSync(attempt, JSON.stringify({
    attemptId: "reviewer-attempt", launchUuid: "reviewer-run", project: "demo", repository: "owner/repo",
    role: "reviewer", target: { kind: "pull-request", number: 243 }, inputRevision: { head }, branch: "agent/issue-243",
    worktreePath: worktree, agentName: "dl-r-243-111111111111", workspaceLabel: "reviewer",
    promptFile: path.join(reviewerRun, "prompt.md"), promiseFile: promise, phase: "agent_started",
    lastSuccessfulPhase: "agent_started", workspaceId: "reviewer-workspace", tabId: "reviewer-tab", rootPaneId: "reviewer-pane",
    ...(options.historyRequired || options.injectBlockingHistoryRace ? { reviewHistoryRequired: true } : {}),
    requestEventId: "22",
  }));
  fixReviewerContract(state, repo, attempt);
  passthroughGit(bin);
  executable(path.join(bin, "gh"), `#!/usr/bin/env node
const fs=require("node:fs");const a=process.argv.slice(2);const f=process.env.POLICY_FILE;
const readLabels=()=>JSON.parse(fs.readFileSync(process.env.PR_LABELS,"utf8"));
const writeLabels=(names)=>fs.writeFileSync(process.env.PR_LABELS,JSON.stringify(names));
if(a[0]==="repo") process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"owner/repo"}));
else if(a[0]==="pr"&&a[1]==="view") {
  const count=fs.existsSync(process.env.GH_VIEW_COUNT)?Number(fs.readFileSync(process.env.GH_VIEW_COUNT,"utf8")):0;
  fs.writeFileSync(process.env.GH_VIEW_COUNT,String(count+1));
  const stored=readLabels();
  const comments=JSON.parse(fs.readFileSync(process.env.COMMENTS,"utf8"));
  if(count===Number(process.env.POLICY_RACE_AFTER_VIEWS)) {
    const policy=JSON.parse(fs.readFileSync(f,"utf8"));
    policy.projects[0].checkCommand="false";
    fs.writeFileSync(f,JSON.stringify(policy));
  }
  if(process.env.INJECT_LIMIT_RACE==="1"&&count===2||process.env.INJECT_BLOCKING_HISTORY_RACE==="1"&&count===1) {
    comments.push(${JSON.stringify({ ...cumulativeRepairFixture.comments[2], author: { login: "deadloop-bot" } })});
    fs.writeFileSync(process.env.COMMENTS,JSON.stringify(comments));
  }
  process.stdout.write(JSON.stringify({number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:process.env.HEAD,isCrossRepository:false,labels:stored.map((name)=>({name})),comments}));
}
else if(a[0]==="pr"&&a[1]==="comment"){const c=JSON.parse(fs.readFileSync(process.env.COMMENTS,"utf8"));c.push({body:a[a.indexOf("--body")+1],author:{login:"deadloop-bot"}});fs.writeFileSync(process.env.COMMENTS,JSON.stringify(c));fs.appendFileSync(process.env.MUTATIONS_LOG,"comment\\n");}
else if(a[0]==="pr"&&a[1]==="edit"){
  const removes=a.filter((v,i)=>a[i-1]==="--remove-label");
  const adds=a.filter((v,i)=>a[i-1]=="--add-label");
  let names=readLabels();
  for(const label of removes) names=names.filter((name)=>name!==label);
  for(const label of adds) names.push(label);
  writeLabels(names);
  fs.appendFileSync(process.env.MUTATIONS_LOG,"edit "+removes.map((l)=>"-"+l).join(" ")+" "+adds.map((l)=>"+"+l).join(" ")+"\\n");
}
else if(a[0]==="api"&&a.includes("--method")&&a.includes("POST")){
  const names=readLabels();const body=JSON.parse(fs.readFileSync(0,"utf8"));
  for(const label of body.labels) names.push(label);
  writeLabels(names);
  fs.appendFileSync(process.env.MUTATIONS_LOG,"add +"+body.labels.join(",")+"\\n");process.stdout.write(JSON.stringify(names));}
else if(a[0]==="api"&&a.includes("graphql")) process.stdout.write(JSON.stringify([{data:{repository:{pullRequest:{commits:{nodes:[{commit:{oid:process.env.HEAD}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}}]));
else if(a[0]==="api"&&a[1].includes("/pulls/243")&&a.includes("-H")) process.stdout.write("diff\\n");
else if(a[0]==="api"&&a[1].endsWith("/pulls/243")) process.stdout.write(JSON.stringify({number:243,state:"open",head:{ref:"agent/issue-243",sha:process.env.HEAD},base:{ref:"main",sha:"${"b".repeat(40)}"}}));
else if(a[0]==="api"&&a.some((value)=>value.includes("/issues/243/comments"))) {const c=JSON.parse(fs.readFileSync(process.env.COMMENTS,"utf8"));process.stdout.write(JSON.stringify([c.map((comment,index)=>({id:index+1,body:comment.body,user:comment.author,created_at:"x",updated_at:"x"}))]));}
else if(a[0]==="api") process.stdout.write(JSON.stringify([[]]));
`);
  executable(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs=require("node:fs");const a=process.argv.slice(2);const f=process.env.RUNTIME;const s=JSON.parse(fs.readFileSync(f,"utf8"));
if(a[0]=="--version") process.stdout.write("herdr 0.8.0\\n");
else if(a[0]==="status") process.stdout.write("version: 0.8.0\\n");
else if(a[0]==="workspace"&&a[1]==="list") process.stdout.write(JSON.stringify({result:{workspaces:s.workspace?[{workspace_id:s.workspace,pane_count:1,tab_count:1,worktree:{checkout_path:process.env.WORKTREE}}]:[]}}));
else if(a[0]==="workspace"&&a[1]==="close"){s.workspace=null;fs.writeFileSync(f,JSON.stringify(s));}
else if(a[0]==="workspace"&&a[1]==="rename") process.stdout.write("renamed");
else if(a[0]==="worktree"&&a[1]==="list") process.stdout.write(JSON.stringify({result:{worktrees:[{path:process.env.WORKTREE,branch:"agent/issue-243",is_linked_worktree:true,...(s.workspace?{open_workspace_id:s.workspace}:{})}]}}));
else if(a[0]==="worktree"&&a[1]==="open"){s.workspace="repair-workspace";fs.writeFileSync(f,JSON.stringify(s));process.stdout.write(JSON.stringify({result:{type:"worktree_opened",already_open:false,workspace:{workspace_id:s.workspace},tab:{tab_id:"repair-tab",workspace_id:s.workspace},root_pane:{pane_id:"repair-pane",tab_id:"repair-tab",workspace_id:s.workspace,cwd:process.env.WORKTREE},worktree:{path:process.env.WORKTREE}}}));}
else if(a[0]==="agent"&&a[1]==="list") process.stdout.write(JSON.stringify({result:{agents:s.agent?[s.agent]:[]}}));
else if(a[0]==="agent"&&a[1]==="start"){s.launches++;s.agent={terminal_id:"terminal-1",name:a[2],agent_status:"working",cwd:process.env.WORKTREE,pane_id:a[a.indexOf("--pane")+1]};fs.writeFileSync(f,JSON.stringify(s));process.stdout.write("started");}
`);
  const argv = ["extensions/deadloop/automations/pr-review-repair-dispatch.cts", "--promise", promise, "--attempt-record", attempt,
    "--request-event-id", "22", "--pr", "243", "--expected-head", head, "--branch", "agent/issue-243"];
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: path.join(root, "config"),
    DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: repo, DEADLOOP_WORKTREE_ROOT: worktreeRoot,
    DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_ENABLED_AT: "1", DEADLOOP_STATE_DIR: state,
    DEADLOOP_WORKER_MODEL: "test-worker-model", DEADLOOP_REPAIR_MODEL: "test-repair-model",
    DEADLOOP_BLOCKED_LABEL: labels.blocked, DEADLOOP_IMPLEMENT_LABEL: labels.implement,
    DEADLOOP_UPDATE_BRANCH_LABEL: labels.updateBranch,
    HEAD: head, COMMENTS: comments, GH_VIEW_COUNT: ghViewCount,
    INJECT_LIMIT_RACE: options.injectCumulativeLimitRace ? "1" : "0",
    INJECT_BLOCKING_HISTORY_RACE: options.injectBlockingHistoryRace ? "1" : "0", RUNTIME: runtime, WORKTREE: worktree,
    PR_LABELS: prLabels, MUTATIONS_LOG: mutationsLog,
    POLICY_RACE_AFTER_VIEWS: String(options.policyRaceAfterViews ?? -1), POLICY_FILE: path.join(state, "projects.json") };
  const deterministicDispatcherArgs = options.renderedCommand
    ? dispatcherArgs({
        prNumber: 243, expectedHeadOid: head, branch: "agent/issue-243", promiseFile: promise,
        attemptRecordFile: attempt, projectId: "demo", repoPath: repo, worktreeRoot,
        githubRepo: "owner/repo", stateDir: state, enabledAt: 1, requestEventId: "22",
        projectCheckCommand: "npm test", workerAgent: "pi", workerModel: "test-worker-model", repairModel: "test-repair-model", repairRemote: "origin",
        implementLabel: labels.implement, updateBranchLabel: labels.updateBranch, reviewLabel: labels.review,
        inProgressLabel: "agent:in-progress", blockedLabel: labels.blocked,
      }, { requestEventId: "22" })
    : [];
  const outputs = Array.from({ length: options.attempts ?? 2 }, () => {
    const result = options.renderedCommand
      ? spawnSync("node", ["extensions/deadloop/automations/pr-review-repair-dispatch.cts", ...deterministicDispatcherArgs], { cwd: process.cwd(), encoding: "utf8", env })
      : spawnSync("node", argv, { cwd: process.cwd(), encoding: "utf8", env });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  });
  const reviewerAttempt = JSON.parse(fs.readFileSync(attempt, "utf8"));
  return {
    comments: JSON.parse(fs.readFileSync(comments, "utf8")).length,
    launches: JSON.parse(fs.readFileSync(runtime, "utf8")).launches,
    actions: outputs.map((output) => output.driverAction),
    staleReasons: outputs.map((output) => output.staleReason),
    reviewerPhase: reviewerAttempt.phase,
    labelMoves: fs.existsSync(mutationsLog)
      ? fs.readFileSync(mutationsLog, "utf8").trim().split("\n").filter(Boolean)
      : [],
    finalLabels: JSON.parse(fs.readFileSync(prLabels, "utf8")),
    persistedComments: JSON.parse(fs.readFileSync(comments, "utf8")),
    dispatcherArgsForwarded: !options.renderedCommand || [
      "--review-label", labels.review,
      "--in-progress-label", "agent:in-progress",
      "--blocked-label", labels.blocked,
      "--implement-label", labels.implement,
      "--update-branch-label", labels.updateBranch,
    ].every((argument) => deterministicDispatcherArgs.includes(argument)),
  };
}


function runHumanRequiredHistoryRace(
  options: { blockDuringRelease?: boolean; stableHistory?: boolean; draft?: boolean } = {},
): { action: string; mutations: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-human-history-race-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const state = path.join(root, "config", "deadloop");
  const run = path.join(state, "runs", "reviewer-run");
  const promise = path.join(run, "promise.json");
  const attempt = path.join(run, "attempt.json");
  const historyFile = path.join(run, "pr-review-history.json");
  const historyReads = path.join(root, "history-reads");
  const mutations = path.join(root, "mutations.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(run, { recursive: true });
  enableProject(state, root);
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const history = {
    pullRequest: { number: 243, state: "open", headRef: "agent/issue-243", headSha: head, baseRef: "main", baseSha: base },
    commits: [{ sha: head }],
    diff: { sha256: createHash("sha256").update("diff\n").digest("hex"), bytes: 5 },
    conversationComments: [],
    submittedReviews: [],
    inlineReviewComments: [],
  };
  fs.writeFileSync(historyFile, JSON.stringify({
    schemaVersion: 1, repository: "owner/repo", pullRequestNumber: 243, observedAt: "2026-01-01T00:00:00.000Z",
    revision: createHash("sha256").update(`${JSON.stringify(history)}\n`).digest("hex"), history, evidence: { exactDiff: "diff\n" },
  }));
  fs.writeFileSync(promise, JSON.stringify({
    schemaVersion: 1, attemptId: "reviewer-attempt", role: "reviewer",
    target: { repository: "owner/repo", kind: "pull-request", number: 243 }, inputRevision: { head },
    status: "complete", summary: "A human decision is required.",
    result: { outcome: "human_required", reviewedHead: head, findings: [] }, evidence: { reviewed: ["diff"] },
  }));
  fs.writeFileSync(attempt, JSON.stringify({
    attemptId: "reviewer-attempt", launchUuid: "reviewer-run", project: "demo", repository: "owner/repo",
    role: "reviewer", target: { kind: "pull-request", number: 243 }, inputRevision: { head }, branch: "agent/issue-243",
    worktreePath: root, agentName: "reviewer", workspaceLabel: "reviewer", promptFile: path.join(run, "prompt.md"),
    promiseFile: promise, phase: "agent_started", lastSuccessfulPhase: "agent_started", reviewHistoryRequired: true,
    requestEventId: "22",
  }));
  fixReviewerContract(state, root, attempt);
  executable(path.join(bin, "gh"), `#!/usr/bin/env node
const fs=require("node:fs");const a=process.argv.slice(2);
if(a[0]==="repo") process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"owner/repo"}));
else if(a[0]==="pr"&&a[1]==="view") {const blocked=process.env.BLOCK_FLAG&&fs.existsSync(process.env.BLOCK_FLAG);process.stdout.write(JSON.stringify({number:243,state:"OPEN",isDraft:process.env.DRAFT==="1",headRefName:"agent/issue-243",headRefOid:process.env.HEAD,isCrossRepository:false,labels:blocked?[{name:"agent:in-progress"},{name:"agent:blocked"}]:[{name:"agent:in-progress"}],comments:[]}));}
else if(a[0]==="api"&&a.includes("graphql")) process.stdout.write(JSON.stringify([{data:{repository:{pullRequest:{commits:{nodes:[{commit:{oid:process.env.HEAD}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}}]));
else if(a[0]==="api"&&a[1].includes("/pulls/243")&&a.includes("-H")) process.stdout.write("diff\\n");
else if(a[0]==="api"&&a[1].endsWith("/pulls/243")) process.stdout.write(JSON.stringify({number:243,state:"open",head:{ref:"agent/issue-243",sha:process.env.HEAD},base:{ref:"main",sha:process.env.BASE}}));
else if(a[0]==="api"&&a.some((value)=>value.includes("/issues/243/comments"))) {const n=fs.existsSync(process.env.READS)?Number(fs.readFileSync(process.env.READS,"utf8")):0;fs.writeFileSync(process.env.READS,String(n+1));const raced=n===Number(process.env.RACE_AT)?[{id:1,user:{login:"deadloop-bot"},body:"deterministic result",created_at:"x",updated_at:"x"},{id:2,user:{login:"human"},body:"racing comment",created_at:"x",updated_at:"x"}]:[];process.stdout.write(JSON.stringify([raced]));}
else if(a[0]==="api") process.stdout.write(JSON.stringify([[]]));
else if(a[0]==="pr"&&a[1]==="comment") {fs.appendFileSync(process.env.MUTATIONS,a.join(" ")+"\\n");if(process.env.BLOCK_AFTER_COMMENT==="1")fs.writeFileSync(process.env.BLOCK_FLAG,"1");process.stdout.write("https://github.com/owner/repo/pull/243#issuecomment-1\\n");}
else {fs.appendFileSync(process.env.MUTATIONS,a.join(" ")+"\\n");}
`);
  executable(path.join(bin, "git"), `#!/usr/bin/env node
const a=process.argv.slice(2);if(a.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
`);
  supportedHerdr(bin);
  const result = spawnSync("node", [
    "extensions/deadloop/automations/pr-review-repair-dispatch.cts", "--promise", promise, "--attempt-record", attempt,
    "--request-event-id", "22", "--pr", "243", "--expected-head", head, "--branch", "agent/issue-243",
  ], { cwd: process.cwd(), encoding: "utf8", env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: path.join(root, "config"),
    DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: root, DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_ENABLED_AT: "1", DEADLOOP_STATE_DIR: state,
    HEAD: head, BASE: base, READS: historyReads, MUTATIONS: mutations,
    RACE_AT: options.stableHistory ? "-1" : "2", DRAFT: options.draft ? "1" : "0",
    BLOCK_FLAG: path.join(root, "block-flag"), BLOCK_AFTER_COMMENT: options.blockDuringRelease ? "1" : "0",
  }});
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return {
    action: JSON.parse(result.stdout).driverAction,
    mutations: fs.existsSync(mutations)
      ? fs.readFileSync(mutations, "utf8").trim().split("\n").filter((line) => line.startsWith("pr "))
      : [],
  };
}

type AcceptedResultSequence = {
  actions: string[];
  checkpointNotes: (string | undefined)[];
  comments: number;
  finalLabels: string[];
};

/**
 * A reviewer dispatch that saved its exact result comment and accepted history, then a replay of
 * the same pending completion after the recorded interruption. `replay` mutates the fake GitHub
 * state between the two runs the way the named interruption would; `resetLabels` simulates a
 * downstream transition that never landed.
 */
function runAcceptedResultSequence(options: {
  outcome: "approved" | "changes_requested" | "human_required";
  replay?:
    | "none"
    | "add_comment"
    | "edit_result"
    | "delete_result"
    | "add_review"
    | "add_inline"
    | "change_head"
    | "change_base"
    | "change_diff"
    | "reset_labels";
  tamperAccepted?: "extra_comment";
}): AcceptedResultSequence {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-accepted-result-checkpoint-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "agent-issue-243");
  const state = path.join(root, "config", "deadloop");
  const reviewerRun = path.join(state, "runs", "reviewer-run");
  const promise = path.join(reviewerRun, "promise.json");
  const attempt = path.join(reviewerRun, "attempt.json");
  const commentsFile = path.join(root, "comments.json");
  const reviewsFile = path.join(root, "reviews.json");
  const inlineFile = path.join(root, "inline.json");
  const labelsFile = path.join(root, "labels.json");
  const prStateFile = path.join(root, "pr-state.json");
  const runtime = path.join(root, "runtime.json");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(reviewerRun, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  spawnSync("git", ["init", "--quiet", repo]);
  spawnSync("git", ["-C", repo, "config", "user.name", "Test"]);
  spawnSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "commit", "--quiet", "-m", "fixture"]);
  spawnSync("git", ["-C", repo, "branch", "agent/issue-243"]);
  spawnSync("git", ["-C", repo, "worktree", "add", "--quiet", worktree, "agent/issue-243"]);
  spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  spawnSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/master", "HEAD"]);
  const head = spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(commentsFile, "[]");
  fs.writeFileSync(reviewsFile, "[]");
  fs.writeFileSync(inlineFile, "[]");
  fs.writeFileSync(labelsFile, JSON.stringify(["agent:in-progress"]));
  fs.writeFileSync(prStateFile, JSON.stringify({ head, base: "b".repeat(40), diff: "diff\n", isDraft: false }));
  const originalHistory = {
    pullRequest: { number: 243, state: "open", headRef: "agent/issue-243", headSha: head, baseRef: "main", baseSha: "b".repeat(40) },
    commits: [{ sha: head }],
    diff: { sha256: createHash("sha256").update("diff\n").digest("hex"), bytes: 5 },
    conversationComments: [],
    submittedReviews: [],
    inlineReviewComments: [],
  };
  fs.writeFileSync(path.join(reviewerRun, "pr-review-history.json"), JSON.stringify({
    schemaVersion: 1, repository: "owner/repo", pullRequestNumber: 243, observedAt: "2026-01-01T00:00:00.000Z",
    revision: createHash("sha256").update(`${JSON.stringify(originalHistory)}\n`).digest("hex"), history: originalHistory, evidence: { exactDiff: "diff\n" },
  }));
  fs.writeFileSync(runtime, JSON.stringify({ workspace: "reviewer-workspace", agent: null, launches: 0 }));
  fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify({ lastWriterCodeIdentity: "a".repeat(40), projects: [{
    repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "R_repo", baseBranch: "origin/master", automationLogin: "deadloop-bot", enabledAt: 1,
    firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
    autoMergeAcknowledged: false, enabled: true,
  }] }));
  fs.writeFileSync(path.join(state, "projects.json"), JSON.stringify({ projects: [{
    id: "demo", repoPath: repo, githubRepo: "owner/repo", baseBranch: "origin/master",
  }] }));
  const result = {
    outcome: options.outcome,
    reviewedHead: head,
    findings: [],
    ...(options.outcome === "changes_requested"
      ? { findings: [{ title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }], priorRequiredFindings: "none" }
      : {}),
  };
  fs.writeFileSync(promise, JSON.stringify({
    schemaVersion: 1, attemptId: "reviewer-attempt", role: "reviewer",
    target: { repository: "owner/repo", kind: "pull-request", number: 243 }, inputRevision: { head },
    status: "complete", summary: "Review result summary",
    result, evidence: { reviewed: ["diff"] },
  }));
  fs.writeFileSync(attempt, JSON.stringify({
    attemptId: "reviewer-attempt", launchUuid: "reviewer-run", project: "demo", repository: "owner/repo",
    role: "reviewer", target: { kind: "pull-request", number: 243 }, inputRevision: { head }, branch: "agent/issue-243",
    worktreePath: worktree, agentName: "dl-r-243-111111111111", workspaceLabel: "reviewer",
    promptFile: path.join(reviewerRun, "prompt.md"), promiseFile: promise, phase: "workspace_closed",
    lastSuccessfulPhase: "workspace_closed", workspaceId: "reviewer-workspace", tabId: "reviewer-tab", rootPaneId: "reviewer-pane",
    reviewHistoryRequired: true, requestEventId: "22",
  }));
  fixReviewerContract(state, repo, attempt);
  const attemptValue = JSON.parse(fs.readFileSync(attempt, "utf8"));
  persistHostVerificationEvidence(workerRequiredVerificationPath(attempt), {
    version: 1, binding: requiredVerificationBinding(attemptValue.requiredVerification, head), outcome: "passed", exitCode: 0,
    startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1, logPath: path.join(reviewerRun, "required-verification.log"),
  });
  passthroughGit(bin);
  executable(path.join(bin, "gh"), `#!/usr/bin/env node
const fs=require("node:fs");const a=process.argv.slice(2);
const read=(file,fallback)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):fallback;
const prState=()=>read(process.env.PR_STATE,{});
if(a[0]==="repo") process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"owner/repo"}));
else if(a[0]==="api"&&a[1]==="user") process.stdout.write("deadloop-bot\\n");
else if(a[0]==="pr"&&a[1]==="view") process.stdout.write(JSON.stringify({number:243,state:"OPEN",isDraft:prState().isDraft,headRefName:"agent/issue-243",headRefOid:prState().head,isCrossRepository:false,labels:read(process.env.LABELS,[]).map((name)=>({name})),comments:read(process.env.COMMENTS,[])}));
else if(a[0]==="pr"&&a[1]==="comment"){
  const list=read(process.env.COMMENTS,[]);const id=list.reduce((max,c)=>Math.max(max,Number(c.id||0)),0)+1;
  list.push({id:String(id),author:{login:"deadloop-bot"},body:a[a.indexOf("--body")+1]});
  fs.writeFileSync(process.env.COMMENTS,JSON.stringify(list));
  process.stdout.write("https://github.com/owner/repo/pull/243#issuecomment-"+id+"\\n");
}
else if(a[0]==="pr"&&a[1]==="edit"){
  const removes=a.filter((v,i)=>a[i-1]==="--remove-label");const adds=a.filter((v,i)=>a[i-1]==="--add-label");
  let names=read(process.env.LABELS,[]);
  for(const label of removes) names=names.filter((name)=>name!==label);
  for(const label of adds) if(!names.includes(label)) names.push(label);
  fs.writeFileSync(process.env.LABELS,JSON.stringify(names));
}
else if(a[0]==="api"&&a.includes("--method")&&a.includes("POST")){
  const body=JSON.parse(fs.readFileSync(0,"utf8"));const names=read(process.env.LABELS,[]);
  for(const label of body.labels||[]) if(!names.includes(label)) names.push(label);
  fs.writeFileSync(process.env.LABELS,JSON.stringify(names));process.stdout.write(JSON.stringify(names));
}
else if(a[0]==="api"&&a.includes("graphql")) process.stdout.write(JSON.stringify([{data:{repository:{pullRequest:{commits:{nodes:[{commit:{oid:prState().head}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}}]));
else if(a[0]==="api"&&a[1].includes("/pulls/243")&&a.includes("-H")) process.stdout.write(prState().diff);
else if(a[0]==="api"&&a[1].endsWith("/pulls/243")) process.stdout.write(JSON.stringify({number:243,state:"open",head:{ref:"agent/issue-243",sha:prState().head},base:{ref:"main",sha:prState().base}}));
else if(a[0]==="api"&&a.some((value)=>value.includes("/issues/243/comments"))) process.stdout.write(JSON.stringify([read(process.env.COMMENTS,[]).map((comment)=>({id:comment.id,node_id:"n"+comment.id,body:comment.body,user:comment.author,created_at:"x",updated_at:"x"}))]));
else if(a[0]==="api"&&a.some((value)=>value.includes("/pulls/243/reviews"))) process.stdout.write(JSON.stringify([read(process.env.REVIEWS,[])]));
else if(a[0]==="api"&&a.some((value)=>value.includes("/pulls/243/comments"))) process.stdout.write(JSON.stringify([read(process.env.INLINE,[])]));
else if(a[0]==="api") process.stdout.write(JSON.stringify([[]]));
`);
  executable(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs=require("node:fs");const a=process.argv.slice(2);const s=JSON.parse(fs.readFileSync(process.env.RUNTIME,"utf8"));
if(a[0]==="--version") process.stdout.write("herdr 0.8.0\\n");
else if(a[0]==="status") process.stdout.write("version: 0.8.0\\n");
else if(a[0]==="workspace"&&a[1]==="list") process.stdout.write(JSON.stringify({result:{workspaces:s.workspace?[{workspace_id:s.workspace,pane_count:1,tab_count:1,worktree:{checkout_path:process.env.WORKTREE}}]:[]}}));
else if(a[0]==="workspace"&&a[1]==="close"){s.workspace=null;fs.writeFileSync(process.env.RUNTIME,JSON.stringify(s));}
else if(a[0]==="worktree"&&a[1]==="list") process.stdout.write(JSON.stringify({result:{worktrees:[{path:process.env.WORKTREE,branch:"agent/issue-243",is_linked_worktree:true,...(s.workspace?{open_workspace_id:s.workspace}:{})}]}}));
else process.stdout.write(JSON.stringify({ok:true}));
`);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: path.join(root, "config"),
    DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: repo, DEADLOOP_WORKTREE_ROOT: path.join(root, "worktrees"),
    DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_ENABLED_AT: "1", DEADLOOP_STATE_DIR: state,
    DEADLOOP_WORKER_MODEL: "test-worker-model", DEADLOOP_REPAIR_MODEL: "test-repair-model",
    HEAD: head, COMMENTS: commentsFile, REVIEWS: reviewsFile, INLINE: inlineFile, LABELS: labelsFile,
    PR_STATE: prStateFile, RUNTIME: runtime, WORKTREE: worktree,
  };
  const argv = ["extensions/deadloop/automations/pr-review-repair-dispatch.cts", "--promise", promise, "--attempt-record", attempt,
    "--request-event-id", "22", "--pr", "243", "--expected-head", head, "--branch", "agent/issue-243"];
  const run = (): Record<string, any> => {
    const result = spawnSync("node", argv, { cwd: process.cwd(), encoding: "utf8", env });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const actions: string[] = [];
  const checkpointNotes: (string | undefined)[] = [];
  actions.push(String(run().driverAction));
  checkpointNotes.push(undefined);
  const applyReplay = () => {
    switch (options.replay) {
      case "add_comment": {
        const list = JSON.parse(fs.readFileSync(commentsFile, "utf8"));
        list.push({ id: "99", author: { login: "human" }, body: "an unrelated later comment" });
        fs.writeFileSync(commentsFile, JSON.stringify(list));
        break;
      }
      case "edit_result": {
        const list = JSON.parse(fs.readFileSync(commentsFile, "utf8"));
        list[0].body = `${list[0].body} edited`;
        fs.writeFileSync(commentsFile, JSON.stringify(list));
        break;
      }
      case "delete_result":
        fs.writeFileSync(commentsFile, "[]");
        break;
      case "add_review":
        fs.writeFileSync(reviewsFile, JSON.stringify([{ id: "9", user: { login: "human" }, body: "LGTM", state: "APPROVED", commit_id: head, submitted_at: "x", created_at: "x", updated_at: "x" }]));
        break;
      case "add_inline":
        fs.writeFileSync(inlineFile, JSON.stringify([{ id: "10", user: { login: "human" }, body: "nit", path: "src/a.ts", commit_id: head, original_commit_id: head, line: 1, original_line: 1, side: "RIGHT", start_line: null, start_side: "", in_reply_to_id: null, created_at: "x", updated_at: "x" }]));
        break;
      case "change_head":
        fs.writeFileSync(prStateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(prStateFile, "utf8")), head: "c".repeat(40) }));
        break;
      case "change_base":
        fs.writeFileSync(prStateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(prStateFile, "utf8")), base: "d".repeat(40) }));
        break;
      case "change_diff":
        fs.writeFileSync(prStateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(prStateFile, "utf8")), diff: "changed diff\n" }));
        break;
      case "reset_labels":
        fs.writeFileSync(labelsFile, JSON.stringify(["agent:in-progress"]));
        break;
      default:
        break;
    }
    if (options.tamperAccepted === "extra_comment") {
      const acceptedFile = path.join(reviewerRun, "pr-review-history-accepted.json");
      const accepted = JSON.parse(fs.readFileSync(acceptedFile, "utf8"));
      accepted.history.conversationComments.push({ id: "77", nodeId: "n77", author: "human", body: "never happened", createdAt: "x", updatedAt: "x" });
      accepted.revision = createHash("sha256").update(`${JSON.stringify(accepted.history)}\n`).digest("hex");
      fs.writeFileSync(acceptedFile, JSON.stringify(accepted));
    }
  };
  applyReplay();
  const second = run();
  actions.push(String(second.driverAction));
  checkpointNotes.push(typeof second.resultCheckpoint === "string" ? second.resultCheckpoint : undefined);
  return {
    actions,
    checkpointNotes,
    comments: JSON.parse(fs.readFileSync(commentsFile, "utf8")).length,
    finalLabels: JSON.parse(fs.readFileSync(labelsFile, "utf8")),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("review repair dispatch attempt", () => {
  const record = {
    project: "demo",
    repository: "owner/repo",
    requestEventId: "22",
    role: "reviewer",
    target: { kind: "pull-request", number: 243 },
    inputRevision: { head: "a".repeat(40) },
    branch: "agent/issue-243",
  };

  it("rejects a saved reviewer attempt for another pull request", () => {
    expect(() => assertReviewerDispatchAttemptBinding(record, {
      projectId: "demo",
      githubRepo: "owner/repo",
      pr: "244",
      expectedHead: "a".repeat(40),
      branch: "agent/issue-243",
      requestEventId: "22",
    })).toThrow("does not match");
  });

  it("rejects a saved reviewer attempt for another branch", () => {
    expect(() => assertReviewerDispatchAttemptBinding(record, {
      projectId: "demo",
      githubRepo: "owner/repo",
      pr: "243",
      expectedHead: "a".repeat(40),
      branch: "agent/issue-244",
      requestEventId: "22",
    })).toThrow("does not match");
  });

  it("rejects a saved reviewer attempt for another request generation", () => {
    expect(() => assertReviewerDispatchAttemptBinding(record, {
      projectId: "demo",
      githubRepo: "owner/repo",
      pr: "243",
      expectedHead: "a".repeat(40),
      branch: "agent/issue-243",
      requestEventId: "23",
    })).toThrow("does not match");
  });
});

describe("review repair dispatch integration", () => {
  it("persists a custom base branch in the review-repair worktree request", () => {
    const input = repairLaunchInput(
      "243", "agent/issue-243", "a".repeat(40), [], "attempt-key",
      { projectId: "demo", baseBranch: "origin/develop", repoPath: "/repo", automationDir: "/automation", stateDir: "/state", worktreeRoot: "/worktrees", githubRepo: "owner/repo", workerAgent: "pi", workerModel: "", remote: "origin", checkCommand: "true", enabledAt: 1, requiredVerification: {}, inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked" },
      "launch-uuid",
    );

    expect(input.worktree.baseBranch).toBe("origin/develop");
  });

  it("rejects repair mutation when in-progress state is absent", () => {
    expect(() => requireManagedPr(
      { labels: [] },
      { inProgressLabel: "agent:in-progress" },
    )).toThrow("in-progress");
  });

  it("queues one agent:implement repair request and never relaunches on a replayed dispatch", () => {
    const result = runV1ChangesRequestedTwice();

    expect({ launches: result.launches, actions: result.actions, reviewerPhase: result.reviewerPhase }).toEqual({
      launches: 0,
      actions: ["review_repair_requested", "review_repair_already_requested_stale"],
      reviewerPhase: "workspace_closed",
    });
  });

  it("records the review result before the implement request exists", () => {
    const result = runV1ChangesRequestedTwice({ attempts: 1 });
    const mutations = result.labelMoves;

    expect(mutations.slice(0, 2)).toEqual([
      "comment",
      `add +${"agent:implement"}`,
    ]);
  });

  it("replaces in-progress with the implement request label", () => {
    const result = runV1ChangesRequestedTwice({ attempts: 1 });

    expect(result.finalLabels).toContain("agent:implement");
  });

  it("releases the in-progress claim when the implement request is queued", () => {
    const result = runV1ChangesRequestedTwice({ attempts: 1 });

    expect(result.finalLabels).not.toContain("agent:in-progress");
  });

  it("records the claim grounding when the replayed dispatch no longer holds the active claim", () => {
    const result = runV1ChangesRequestedTwice();

    expect(result.staleReasons[1]).toMatch(/state=OPEN head=unchanged labels=agent:implement/);
  });

  it("fails closed when metadata requires history but the prompt and history artifacts are missing", () => {
    expect(runV1ChangesRequestedTwice({ attempts: 1, historyRequired: true }).actions[0]).toBe("incomplete_review_history");
  });

  it("leaves human-required review state untouched when unrelated history races with its result comment", () => {
    const result = runHumanRequiredHistoryRace();

    expect(result).toEqual({
      action: "review_stale_history",
      mutations: [
        expect.stringContaining("pr comment 243"),
        expect.stringContaining("--remove-label agent:in-progress --add-label agent:review"),
      ],
    });
  });

  it("hands a completed human-required review to a person", () => {
    expect(runHumanRequiredHistoryRace({ stableHistory: true }).action).toBe("review_human_handoff");
  });

  it("leaves no agent workflow label on a pull request handed to a person", () => {
    const result = runHumanRequiredHistoryRace({ stableHistory: true });

    expect(result.mutations.at(-1)).toBe(
      "pr edit 243 -R owner/repo --remove-label agent:review --remove-label agent:implement"
      + " --remove-label agent:update-branch --remove-label agent:in-progress --remove-label agent:blocked",
    );
  });

  it("records the review result before removing the requests that wait on it", () => {
    const result = runHumanRequiredHistoryRace({ stableHistory: true });

    expect(result.mutations[0]).toContain("pr comment 243");
  });

  it("marks a draft pull request ready when it hands its review to a person", () => {
    const result = runHumanRequiredHistoryRace({ stableHistory: true, draft: true });

    expect(result.mutations.some((mutation) => mutation.startsWith("pr ready 243"))).toBe(true);
  });

  it("keeps labels untouched when a concurrent block lands before the stale-history release", () => {
    const result = runHumanRequiredHistoryRace({ blockDuringRelease: true });

    expect(result).toEqual({
      action: "review_stale_history",
      mutations: [expect.stringContaining("pr comment 243")],
    });
  });

  it("carries only required findings inside the persisted repair marker payload", () => {
    const result = runV1ChangesRequestedTwice({
      attempts: 1,
      advisories: [{ title: "Clearer helper name", body: "The helper name could describe its job." }],
    });
    const payload = decodeMarkerPayload(String(result.persistedComments.at(-1)?.body));

    expect(payload?.findings).toEqual([{ title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }]);
  });

  it("keeps advisory observations out of the persisted repair marker payload", () => {
    const result = runV1ChangesRequestedTwice({
      attempts: 1,
      advisories: [{ title: "Clearer helper name", body: "The helper name could describe its job." }],
    });
    const payloadText = JSON.stringify(decodeMarkerPayload(String(result.persistedComments.at(-1)?.body)));

    expect(payloadText).not.toContain("Clearer helper name");
  });

  it("requests a further progress-qualified repair when a different historical marker appears first", () => {
    const result = runV1ChangesRequestedTwice({ attempts: 1, injectCumulativeLimitRace: true });

    expect({ action: result.actions[0], launches: result.launches }).toEqual({
      action: "review_repair_requested",
      launches: 0,
    });
  });

  it("stops active review work when history changes before repair launch", () => {
    const result = runV1ChangesRequestedTwice({ attempts: 1, injectBlockingHistoryRace: true });

    expect({ action: result.actions[0], launches: result.launches }).toEqual({
      action: "review_stale_history",
      launches: 0,
    });
  });

  it("forwards custom request labels into the repair request transition", () => {
    const result = runV1ChangesRequestedTwice({ customConfiguration: true, renderedCommand: true, attempts: 1 });

    expect({ action: result.actions[0], dispatcherArgsForwarded: result.dispatcherArgsForwarded, finalLabels: result.finalLabels }).toEqual({
      action: "review_repair_requested",
      dispatcherArgsForwarded: true,
      finalLabels: ["ready-for-human", "team:platform", "custom:implement"],
    });
  });

  it("writes no approved comment or persistence marker when the head changes during authorization", () => {
    const race = runApprovedAuthorizationRace({ headChangeAfter: 3 });

    expect({ driverAction: race.output.driverAction, comments: race.comments }).toEqual({
      driverAction: "review_stale_head",
      comments: [],
    });
  });

  it("writes only a recovery stop when the trusted policy changes during the last PR read", () => {
    const comments = runApprovedAuthorizationRace({ policyChangeAfter: 3 }).comments as Array<{ body?: string }>;
    expect(comments.map((comment) => comment.body)).toEqual([expect.stringContaining("target=pr-243")]);
  });

  it("records the changes-requested result and one recovery notice when trusted policy changes", () => {
    expect(runV1ChangesRequestedTwice({ attempts: 1, policyRaceAfterViews: 1 }).comments).toBe(2);
  });

  it("launches no repair when the trusted policy changes during the attempt", () => {
    expect(runV1ChangesRequestedTwice({ attempts: 1, policyRaceAfterViews: 1 }).launches).toBe(0);
  });

  it("stops the failing review for explicit recovery", () => {
    expect(runV1ChangesRequestedTwice({ attempts: 1, policyRaceAfterViews: 1 }).actions[0]).toBe("review_verification_blocked");
  });

  it("stops approval instead of persisting it when trusted policy changes", () => {
    expect(runApprovedAuthorizationRace({ policyChangeAfter: 3 }).output.driverAction).toBe("review_verification_blocked");
  });

  it("serializes concurrent approved retries to one review-result comment", async () => {
    expect(await runConcurrentApprovedRetries()).toBe(1);
  });

  it("executes the deterministic attempt handler's dispatcher arguments in a clean environment", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-rendered-dispatch-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const state = path.join(root, "config", "deadloop");
    enableProject(state, root);
    const runDir = path.join(state, "runs", "reviewer");
    const promise = path.join(runDir, "promise.json");
    fs.mkdirSync(bin);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(state, "enabled-projects.json"), JSON.stringify({ lastWriterCodeIdentity: "a".repeat(40), 
      projects: [{
        repoPath: root, githubRepo: "owner/repo", githubRepositoryId: "R_repo", automationLogin: "deadloop-bot", enabledAt: 7,
        firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
        autoMergeAcknowledged: false, enabled: true,
      }],
    }));
    fs.writeFileSync(promise, JSON.stringify({
      schemaVersion: 1, attemptId: "reviewer", role: "reviewer", status: "complete",
      target: { kind: "pull-request", number: 143, repository: "owner/repo" },
      inputRevision: { head: "a".repeat(40) }, summary: "approved",
      result: { outcome: "approved", reviewedHead: "a".repeat(40) }, evidence: { reviewed: ["diff"] },
    }));
    fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      attemptId: "reviewer", launchUuid: "launch", project: "demo", repository: "owner/repo",
      role: "reviewer", target: { kind: "pull-request", number: 143 }, inputRevision: { head: "a".repeat(40) },
      branch: "agent/issue-142", worktreePath: root, agentName: "reviewer", workspaceLabel: "reviewer",
      promptFile: path.join(runDir, "prompt.md"), promiseFile: promise, phase: "report_received", lastSuccessfulPhase: "report_received",
      requestEventId: "22",
    }));
    fixReviewerContract(state, root, path.join(runDir, "attempt.json"));
    passthroughGit(bin);
    supportedHerdr(bin);
    executable(path.join(bin, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") process.stdout.write("deadloop-bot\\n");
else process.stdout.write(JSON.stringify(args[0] === "repo"
  ? {id:"R_repo",nameWithOwner:"owner/repo"}
  : {number:143,state:"OPEN",headRefName:"agent/issue-142",headRefOid:"${"a".repeat(40)}",isCrossRepository:false,labels:[{name:"agent:in-progress"}],comments:[]}));
`);
    const args = dispatcherArgs({
      prNumber: 143, expectedHeadOid: "a".repeat(40), branch: "agent/issue-142", promiseFile: promise,
      attemptRecordFile: path.join(runDir, "attempt.json"), projectId: "demo", repoPath: root,
      worktreeRoot: path.join(root, "worktrees"), githubRepo: "owner/repo", stateDir: state, enabledAt: 7,
      requestEventId: "22", projectCheckCommand: "npm test", workerAgent: "pi", workerModel: "test-worker-model", repairModel: "test-repair-model",
      repairRemote: "origin", reviewLabel: "agent:review", implementLabel: "agent:implement",
      updateBranchLabel: "agent:update-branch", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    }, { requestEventId: "22" });

    const result = spawnSync("node", ["extensions/deadloop/automations/pr-review-repair-dispatch.cts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: path.dirname(state), DEADLOOP_REQUIRED_VERIFICATION: process.env.DEADLOOP_REQUIRED_VERIFICATION },
    });

    expect(JSON.parse(result.stdout).action).toBe("done");
  });

  it("rejects an unsupported direct repair dispatch before GitHub mutation or agent launch", () => {
    expect(runDispatch(true, false).events).toEqual([]);
  });

  it("finishes with a queued implement request instead of a monitor handoff", () => {
    const output = runDispatch(true).output;

    expect({ action: output.action, driverAction: output.driverAction, handoff: output.monitorHandoff }).toEqual({
      action: "done",
      driverAction: "review_repair_requested",
      handoff: undefined,
    });
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

  it("rejects an advanced PR mutation when no owned worktree exists", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
      { hasWorktree: false },
    );

    expect(result.output.driverAction).toBe("review_stale_head");
  });

  it("rejects an advanced PR mutation when the owned worktree targets another head", () => {
    const expectedHead = "6c994aad94595aa113e8a35cc2962a9e32a7f6c8";
    const result = runStaleWorktreeDispatch(expectedHead, "ab08360529da29cf16d5ccb109138c9a938e309d", {
      worktreeHead: expectedHead,
    });

    expect(result.output.driverAction).toBe("review_stale_head");
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

  it("rejects a dirty-worktree mutation when the first PR read is already advanced", () => {
    const expectedHead = "6c994aad94595aa113e8a35cc2962a9e32a7f6c8";
    const currentHead = "ab08360529da29cf16d5ccb109138c9a938e309d";
    const result = runStaleWorktreeDispatch(expectedHead, currentHead, { dirty: true, initialHead: currentHead });

    expect(result.output.driverAction).toBe("review_stale_head");
  });

  it("rejects an ambiguous-worktree mutation after the claimed head changes", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
      { duplicateWorktree: true },
    );

    expect(result.output.driverAction).toBe("review_stale_head");
  });

  it("leaves no waiting request when review requires a human", () => {
    expect(blockedClaimMove({
      inProgressLabel: "agent:in-progress",
      updateBranchLabel: "agent:update-branch",
      implementLabel: "agent:implement",
      reviewLabel: "agent:review",
      blockedLabel: "agent:blocked",
    })).toEqual({
      remove: ["agent:update-branch", "agent:implement", "agent:review", "agent:in-progress"],
      add: ["agent:blocked"],
    });
  });

  it("rejects an advanced dirty-worktree mutation after the claimed head changes", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
      { dirty: true },
    );

    expect(result.output.driverAction).toBe("review_stale_head");
  });






});

describe("review result checkpoint replay", () => {
  it("resumes an approved review from the accepted result checkpoint after a downstream stop", () => {
    const result = runAcceptedResultSequence({ outcome: "approved" });
    expect(result).toEqual({
      actions: ["review_approved", "review_approved"],
      checkpointNotes: [undefined, "accepted_result_history"],
      comments: 1,
      finalLabels: ["agent:in-progress"],
    });
  });

  it("releases the claim for a fresh review when a comment follows the accepted history", () => {
    const result = runAcceptedResultSequence({ outcome: "approved", replay: "add_comment" });
    expect(result).toEqual({
      actions: ["review_approved", "review_stale_history"],
      checkpointNotes: [undefined, undefined],
      comments: 2,
      finalLabels: ["agent:review"],
    });
  });

  it("releases the claim for a fresh review when the result comment is edited", () => {
    const result = runAcceptedResultSequence({ outcome: "approved", replay: "edit_result" });
    expect(result.actions[1]).toBe("review_stale_history");
  });

  it("releases the claim for a fresh review when the result comment is deleted", () => {
    const result = runAcceptedResultSequence({ outcome: "approved", replay: "delete_result" });
    expect(result.actions[1]).toBe("review_stale_history");
  });

  it("releases the claim for a fresh review when a submitted review follows the accepted history", () => {
    const result = runAcceptedResultSequence({ outcome: "approved", replay: "add_review" });
    expect(result.actions[1]).toBe("review_stale_history");
  });

  it("releases the claim for a fresh review when an inline comment follows the accepted history", () => {
    const result = runAcceptedResultSequence({ outcome: "approved", replay: "add_inline" });
    expect(result.actions[1]).toBe("review_stale_history");
  });

  it("releases the claim for a fresh review when the head changes after the accepted history", () => {
    const result = runAcceptedResultSequence({ outcome: "approved", replay: "change_head" });
    expect(result.actions[1]).toBe("review_stale_history");
  });

  it("releases the claim for a fresh review when the base changes after the accepted history", () => {
    const result = runAcceptedResultSequence({ outcome: "approved", replay: "change_base" });
    expect(result.actions[1]).toBe("review_stale_history");
  });

  it("releases the claim for a fresh review when the diff changes after the accepted history", () => {
    const result = runAcceptedResultSequence({ outcome: "approved", replay: "change_diff" });
    expect(result.actions[1]).toBe("review_stale_history");
  });

  it("does not adopt an accepted history that is not the original history plus one comment", () => {
    const result = runAcceptedResultSequence({ outcome: "approved", tamperAccepted: "extra_comment" });
    expect(result.actions[1]).toBe("review_stale_history");
  });

  it("continues the interrupted repair request from the accepted changes-requested checkpoint", () => {
    const result = runAcceptedResultSequence({ outcome: "changes_requested", replay: "reset_labels" });
    expect(result).toEqual({
      actions: ["review_repair_requested", "review_repair_already_requested"],
      checkpointNotes: [undefined, "accepted_result_history"],
      comments: 1,
      finalLabels: ["agent:implement"],
    });
  });

  it("continues the interrupted human handoff from the accepted human-required checkpoint", () => {
    const result = runAcceptedResultSequence({ outcome: "human_required", replay: "reset_labels" });
    expect(result).toEqual({
      actions: ["review_human_handoff", "review_human_handoff"],
      checkpointNotes: [undefined, "accepted_result_history"],
      comments: 1,
      finalLabels: [],
    });
  });
});
