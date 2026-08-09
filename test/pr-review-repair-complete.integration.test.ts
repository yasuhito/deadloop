import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);
const key = "abcdef1234567890abcd";

function writeCompatibleHerdr(bin: string): void {
  const herdr = path.join(bin, "herdr");
  fs.writeFileSync(herdr, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'herdr 0.7.5\\n'; else printf 'version: 0.7.5\\ncompatible: yes\\n'; fi\n`);
  fs.chmodSync(herdr, 0o755);
}

function runCompletion(options: {
  promise: Record<string, unknown>;
  receipt?: Record<string, unknown> | string;
  comments?: { body: string; author?: { login: string } }[];
  liveHead?: string;
  state?: string;
  labels?: { name: string }[];
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-repair-complete-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const stateDir = path.join(root, "config", "deadloop");
  const projectRepo = path.join(root, "repo");
  const runDir = path.join(stateDir, "runs", "repair-run");
  const attemptFile = path.join(runDir, "attempt.json");
  const promiseFile = path.join(runDir, "promise.json");
  const resultFile = path.join(runDir, "finalizer-result.json");
  const contractFile = path.join(runDir, "review-contract.json");
  const postedFile = path.join(root, "posted.txt");
  const actionsFile = path.join(root, "actions.txt");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(projectRepo);
  writeCompatibleHerdr(bin);
  spawnSync("git", ["-C", projectRepo, "init", "--quiet"]);
  spawnSync("git", ["-C", projectRepo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  fs.writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({ projects: [{
    repoPath: projectRepo, githubRepo: "owner/repo", githubRepositoryId: "R_repo", enabledAt: 1,
    firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
    autoMergeAcknowledged: false, enabled: true,
  }] }));
  const outcome = String(options.promise.reason || "");
  const strongPromise = {
    schemaVersion: 1, attemptId: key, role: "review-repair",
    target: { repository: "owner/repo", kind: "pull-request", number: 24 },
    inputRevision: { head: oldHead }, status: options.promise.status, summary: options.promise.summary,
    result: outcome === "repair_pushed"
      ? { outcome, outputRevision: newHead, repairs: options.promise.repairs }
      : outcome === "stale_head" ? { outcome, outputRevision: options.liveHead || newHead }
        : options.promise.result,
    evidence: outcome === "repair_pushed"
      ? { finalizer: typeof options.receipt === "object" ? { ...options.receipt, reason: outcome } : options.receipt, validations: options.promise.checks }
      : outcome === "stale_head" ? { finalizer: options.receipt } : options.promise.evidence || {},
  };
  fs.writeFileSync(promiseFile, JSON.stringify(strongPromise));
  fs.writeFileSync(attemptFile, JSON.stringify({
    schemaVersion: 1, attemptId: key, launchUuid: "repair-run", project: "demo", repository: "owner/repo",
    role: "review-repair", target: { kind: "pull-request", number: 24 }, inputRevision: { head: oldHead },
    branch: "agent/issue-24", worktreePath: projectRepo, agentName: "dl-x-24-abcdef123456",
    workspaceLabel: "repair", promptFile: path.join(runDir, "prompt.md"), promiseFile,
    phase: "agent_started", lastSuccessfulPhase: "agent_started",
  }));
  fs.writeFileSync(
    contractFile,
    JSON.stringify({ attemptKey: key, expectedHead: oldHead, findingTitles: ["Unsafe fallback"] }),
  );
  if (options.receipt) {
    fs.writeFileSync(resultFile, typeof options.receipt === "string" ? options.receipt : JSON.stringify(options.receipt));
  }
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({id:"R_repo"}));
else if (args[0] === "api" && args[1] === "user") process.stdout.write("deadloop-bot\\n");
else if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({state:${JSON.stringify(options.state || "OPEN")},headRefName:"agent/issue-24",headRefOid:"${options.liveHead || newHead}",isCrossRepository:false,labels:${JSON.stringify(options.labels || [{ name: "agent:in-progress" }, { name: "agent:reviewing" }])},comments:${JSON.stringify(options.comments || [])}}));
else if (args[0] === "pr" && args[1] === "comment") fs.writeFileSync(process.env.POSTED_FILE, args[args.indexOf("--body") + 1]);
else if (args[0] === "pr" && args[1] === "edit") fs.appendFileSync(process.env.ACTIONS_FILE, args.join(" ") + "\\n");
`,
  );
  fs.chmodSync(gh, 0o755);
  const result = spawnSync(
    "node",
    [
      "extensions/deadloop/automations/pr-review-repair-complete.ts",
      "--promise",
      promiseFile,
      "--attempt-record",
      attemptFile,
      "--project-id",
      "demo",
      "--result",
      resultFile,
      "--contract",
      contractFile,
      "--project-repo",
      projectRepo,
      "--github-repo",
      "owner/repo",
      "--state-dir",
      stateDir,
      "--enabled-at",
      "1",
      "--pr",
      "24",
      "--branch",
      "agent/issue-24",
      "--expected-head",
      oldHead,
      "--attempt-key",
      key,
      "--review-label",
      "agent:review",
      "--reviewing-label",
      "agent:reviewing",
      "--in-progress-label",
      "agent:in-progress",
      "--blocked-label",
      "agent:blocked",
    ],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: path.join(root, "config"), POSTED_FILE: postedFile, ACTIONS_FILE: actionsFile } },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return {
    output: JSON.parse(result.stdout),
    posted: fs.existsSync(postedFile) ? fs.readFileSync(postedFile, "utf8") : "",
    actions: fs.existsSync(actionsFile) ? fs.readFileSync(actionsFile, "utf8") : "",
  };
}

async function runConcurrentSuccessRetries(): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-repair-concurrent-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const configDir = path.join(root, "config");
  const stateDir = path.join(configDir, "deadloop");
  const projectRepo = path.join(root, "repo");
  const commentsFile = path.join(root, "comments.json");
  const runDir = path.join(stateDir, "runs", "repair-run");
  const attemptFile = path.join(runDir, "attempt.json");
  const promiseFile = path.join(runDir, "promise.json");
  const resultFile = path.join(runDir, "finalizer-result.json");
  const contractFile = path.join(runDir, "review-contract.json");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(projectRepo);
  writeCompatibleHerdr(bin);
  spawnSync("git", ["-C", projectRepo, "init", "--quiet"]);
  spawnSync("git", ["-C", projectRepo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  fs.writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({ projects: [{
    repoPath: projectRepo, githubRepo: "owner/repo", githubRepositoryId: "R_repo", enabledAt: 1,
    firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
    autoMergeAcknowledged: false, enabled: true,
  }] }));
  const checks = [{ command: "npm test", result: "passed" }];
  const receipt = { action: "pushed", reason: "repair_pushed", originalHeadOid: oldHead, headOid: newHead, checks };
  fs.writeFileSync(promiseFile, JSON.stringify({
    schemaVersion: 1, attemptId: key, role: "review-repair",
    target: { repository: "owner/repo", kind: "pull-request", number: 24 }, inputRevision: { head: oldHead },
    status: "complete", summary: "fixed",
    result: { outcome: "repair_pushed", outputRevision: newHead, repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }] },
    evidence: { finalizer: receipt, validations: checks },
  }));
  fs.writeFileSync(resultFile, JSON.stringify(receipt));
  fs.writeFileSync(attemptFile, JSON.stringify({
    schemaVersion: 1, attemptId: key, launchUuid: "repair-run", project: "demo", repository: "owner/repo",
    role: "review-repair", target: { kind: "pull-request", number: 24 }, inputRevision: { head: oldHead },
    branch: "agent/issue-24", worktreePath: projectRepo, agentName: "dl-x-24-abcdef123456",
    workspaceLabel: "repair", promptFile: path.join(runDir, "prompt.md"), promiseFile,
    phase: "agent_started", lastSuccessfulPhase: "agent_started",
  }));
  fs.writeFileSync(contractFile, JSON.stringify({ attemptKey: key, expectedHead: oldHead, findingTitles: ["Unsafe fallback"] }));
  fs.writeFileSync(commentsFile, "[]");
  const gh = path.join(bin, "gh");
  fs.writeFileSync(gh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write(JSON.stringify({id:"R_repo"}));
else if (args[0] === "api") process.stdout.write("deadloop-bot\\n");
else if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({state:"OPEN",headRefName:"agent/issue-24",headRefOid:"${newHead}",isCrossRepository:false,labels:[{name:"agent:in-progress"},{name:"agent:reviewing"}],comments:JSON.parse(fs.readFileSync(process.env.COMMENTS_FILE,"utf8"))}));
else if (args[0] === "pr" && args[1] === "comment") {
  const comments = JSON.parse(fs.readFileSync(process.env.COMMENTS_FILE,"utf8"));
  comments.push({body:args[args.indexOf("--body")+1],author:{login:"deadloop-bot"}});
  fs.writeFileSync(process.env.COMMENTS_FILE, JSON.stringify(comments));
}
`);
  fs.chmodSync(gh, 0o755);
  const args = [
    "extensions/deadloop/automations/pr-review-repair-complete.ts",
    "--promise", promiseFile, "--attempt-record", attemptFile, "--project-id", "demo",
    "--result", resultFile, "--contract", contractFile, "--project-repo", projectRepo, "--github-repo", "owner/repo", "--state-dir", stateDir,
    "--enabled-at", "1", "--pr", "24", "--branch", "agent/issue-24", "--expected-head", oldHead,
    "--attempt-key", key, "--review-label", "agent:review", "--reviewing-label", "agent:reviewing",
    "--in-progress-label", "agent:in-progress", "--blocked-label", "agent:blocked",
  ];
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: configDir, COMMENTS_FILE: commentsFile };
  await Promise.all([0, 1].map(() => new Promise<void>((resolve, reject) => {
    const child = spawn("node", args, { cwd: process.cwd(), env, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(`completion exited ${status}`)));
  })));
  return JSON.parse(fs.readFileSync(commentsFile, "utf8")).length;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("review repair deterministic completion", () => {
  it.each(["--attempt-record", "--project-id"])("requires canonical identity argument %s", (missingFlag) => {
    const { parseArgs } = require("../extensions/deadloop/automations/pr-review-repair-complete.ts");
    const values = {
      promise: "/state/runs/one/promise.json", attemptRecord: "/state/runs/one/attempt.json", projectId: "demo",
      result: "/state/runs/one/finalizer-result.json", contract: "/state/runs/one/review-contract.json",
      projectRepo: "/repo", githubRepo: "owner/repo", stateDir: "/state", enabledAt: "1", pr: "24",
      branch: "agent/issue-24", expectedHead: oldHead, attemptKey: key, reviewLabel: "review",
      reviewingLabel: "reviewing", inProgressLabel: "in-progress", blockedLabel: "blocked",
    };
    const args = Object.entries(values).flatMap(([name, value]) => {
      const flag = `--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
      return flag === missingFlag ? [] : [flag, value];
    });
    expect(() => parseArgs(args)).toThrow();
  });

  it("posts success after the promise, finalizer receipt, and live head agree", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
    });

    expect(result.posted).toContain(`New commit: \`${newHead}\``);
  });

  it("releases the active review claim after recording successful repair", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
    });

    expect(result.actions).toContain("--remove-label agent:in-progress --remove-label agent:reviewing --add-label agent:review");
  });

  it("turns a malformed finalizer receipt into recovery instead of an exception", () => {
    const result = runCompletion({
      promise: { status: "blocked", reason: "check_failed", summary: "checks stopped" },
      receipt: "{",
      liveHead: oldHead,
    });

    expect(result.output.driverAction).toBe("repair_human_blocked");
  });

  it("does not post repair success for stale_head", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
      receipt: { action: "stale_head", originalHeadOid: oldHead },
    });

    expect(result.posted).toBe("");
  });

  it("leaves a changed head untouched when stale_head has no finalizer receipt", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
    });

    expect(result.output.driverAction).toBe("repair_target_changed");
  });

  it("leaves an invalid stale receipt on a changed head untouched", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
      receipt: { action: "stale_head", originalHeadOid: "c".repeat(40) },
    });

    expect(result.output.driverAction).toBe("repair_target_changed");
  });

  it("requires recovery when stale_head is reported but the live head did not change", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
      receipt: { action: "stale_head", originalHeadOid: oldHead },
      liveHead: oldHead,
    });

    expect(result.output.driverAction).toBe("repair_human_blocked");
  });

  it("requires recovery when a pushed receipt and live head are unchanged", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: oldHead, checks },
      liveHead: oldHead,
    });

    expect(result.output.driverAction).toBe("repair_human_blocked");
  });

  it("does not duplicate an existing repair result comment", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      comments: [{ body: `<!-- deadloop:review-repair-result key=${key} head=${newHead} -->`, author: { login: "deadloop-bot" } }],
    });

    expect(result.output.driverAction).toBe("repair_result_duplicate");
  });

  it("releases the active review claim when reconciling a duplicate result", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      comments: [{ body: `<!-- deadloop:review-repair-result key=${key} head=${newHead} -->`, author: { login: "deadloop-bot" } }],
    });

    expect(result.actions).toContain("--remove-label agent:in-progress --remove-label agent:reviewing --add-label agent:review");
  });

  it("serializes concurrent completion retries to one success comment", async () => {
    expect(await runConcurrentSuccessRetries()).toBe(1);
  });

  it("does not trust a copied result marker from another commenter", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete", reason: "repair_pushed", summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }], checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      comments: [{ body: `<!-- deadloop:review-repair-result key=${key} head=${newHead} -->`, author: { login: "attacker" } }],
    });

    expect(result.output.driverAction).toBe("repair_result_posted");
  });

  it("leaves a closed PR untouched", () => {
    const result = runCompletion({
      promise: { status: "blocked", reason: "check_failed", summary: "failed" },
      receipt: { action: "blocked", reason: "finalizer_error", originalHeadOid: oldHead },
      liveHead: oldHead,
      state: "CLOSED",
    });

    expect({ action: result.output.driverAction, posted: result.posted }).toEqual({ action: "repair_target_changed", posted: "" });
  });

  it("leaves a superseded repair head untouched", () => {
    const result = runCompletion({
      promise: { status: "blocked", reason: "check_failed", summary: "failed" },
      receipt: { action: "blocked", reason: "finalizer_error", originalHeadOid: oldHead },
      liveHead: "c".repeat(40),
    });

    expect({ action: result.output.driverAction, posted: result.posted }).toEqual({ action: "repair_target_changed", posted: "" });
  });
});
