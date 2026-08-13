import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { finalizeReviewRepair } = require("../extensions/deadloop/automations/pr-review-repair-finalize.ts");
const { renderReviewClaimComment } = require("../extensions/deadloop/automations/pr-review-claim.ts");
const { repairWorkerPrompt } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.ts");
const { finalizeBranchUpdate } = require("../extensions/deadloop/automations/pr-branch-update-finalize.ts");

const sandboxes: string[] = [];
const branch = "agent/issue-1";
const ref = `refs/heads/${branch}`;
const activeReviewState = {
  managedLabels: ["agent:review", "agent:implement", "agent:update-branch", "agent:in-progress", "agent:blocked"],
  requestLabel: "agent:review",
  requiredLabels: ["agent:in-progress"],
};

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-finalizer-push-"));
  sandboxes.push(root);
  const repo = path.join(root, "repo");
  const remote = path.join(root, "origin.git");
  mkdirSync(repo);
  git(repo, ["init", "--quiet"]);
  git(repo, ["checkout", "--quiet", "-b", branch]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "file.txt"), "root\n");
  git(repo, ["add", "file.txt"]);
  git(repo, ["commit", "--quiet", "-m", "root"]);
  const rootOid = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(repo, "file.txt"), "expected\n");
  git(repo, ["commit", "--quiet", "-am", "expected"]);
  const expectedHead = git(repo, ["rev-parse", "HEAD"]);
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  git(repo, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  execFileSync("git", ["-C", repo, "push", "--quiet", remote, `${expectedHead}:${ref}`]);
  writeFileSync(path.join(repo, "file.txt"), "candidate\n");
  git(repo, ["commit", "--quiet", "-am", "candidate"]);
  const configPath = path.join(root, ".gitconfig");
  writeFileSync(configPath, `[url "file://${remote}"]\n\tinsteadOf = https://github.com/owner/repo.git\n`);
  return { repo, remote, rootOid, expectedHead, configPath };
}

function runRace(finalizer: "repair" | "branch-update", race: "delete" | "rewind") {
  const { repo, remote, rootOid, expectedHead, configPath } = fixture();
  const hookPath = path.join(repo, ".git", "hooks", "pre-push");
  const updateRef = race === "delete"
    ? `git --git-dir='${remote}' update-ref -d '${ref}'`
    : `git --git-dir='${remote}' update-ref '${ref}' '${rootOid}'`;
  writeFileSync(hookPath, `#!/bin/sh\n${updateRef}\n`);
  chmodSync(hookPath, 0o755);
  const binding = {
    repositoryId: "R_repo", repository: "owner/repo", targetNumber: 1, requestEventId: "22", role: "reviewer", revision: expectedHead, owner: "host-a",
    authority: { durationSeconds: 86700 }, activeState: activeReviewState,
  };
  const run = (args: string[]) => {
    if (args[0] === "node") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "gh" && args[1] === "api" && args[2] === "user") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
    if (args[0] === "gh" && args.some((arg) => arg.endsWith("/events"))) return { status: 0, stdout: JSON.stringify([[{ id: 22, event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } }]]), stderr: "" };
    if (args[0] === "gh" && args.some((arg) => arg.endsWith("/comments"))) return { status: 0, stdout: JSON.stringify([[{ id: 101, created_at: "2026-07-20T10:01:00Z", updated_at: "2026-07-20T10:01:00Z", user: { login: "deadloop-bot" }, body: renderReviewClaimComment(binding) }]]), stderr: "" };
    if (args[0] === "gh" && args.includes("--include")) return { status: 0, stdout: "date: Mon, 20 Jul 2026 10:03:00 GMT", stderr: "" };
    if (args[0] === "git" && args.includes("get-url")) {
      return { status: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
    }
    if (args[0] === "gh" && args[1] === "pr") {
      return {
        status: 0,
        stdout: JSON.stringify({ state: "OPEN", isCrossRepository: false, headRefName: branch, headRefOid: expectedHead, labels: [{ name: "agent:in-progress" }] }),
        stderr: "",
      };
    }
    if (args[0] === "gh" && args[1] === "repo") {
      return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: "owner/repo" }), stderr: "" };
    }
    const result = spawnSync(args[0], args.slice(1), {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: configPath, GIT_CONFIG_NOSYSTEM: "1" },
    });
    return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
  };
  const reviewClaim = {
    binding, commentId: "101", authorizedLogins: ["deadloop-bot"], automationLogin: "deadloop-bot", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
    requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
  };
  const common = {
    repo,
    attemptRecord: "/state/runs/attempt/attempt.json",
    projectRepo: repo,
    githubRepo: "owner/repo",
    pr: "1",
    branch,
    expectedHead,
    remote: "origin",
    automationDir: "/automation",
    stateDir: "/state",
    enabledAt: 1,
    checkCommand: "true",
    resultFile: path.join(path.dirname(repo), "result.json"),
    reviewClaim,
  };
  const ops = {
    run,
    loadSavedReviewClaim: () => reviewClaim,
    loadCurrentReviewClaimConfiguration: () => ({
      reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
      managedLabels: activeReviewState.managedLabels, requestLabel: "agent:review", requiredLabels: ["agent:in-progress"],
      repositoryId: "R_repo", repository: "owner/repo", authorizedLogins: ["deadloop-bot"],
      authenticatedLogin: "deadloop-bot", reviewerAgent: "pi",
    }),
    assertEnabled: () => ({ githubRepo: "owner/repo", githubRepositoryId: "R_repo", automationLogin: "deadloop-bot" }),
  };
  const result = finalizer === "repair"
    ? finalizeReviewRepair(common, ops)
    : finalizeBranchUpdate({ ...common, expectedBase: rootOid }, ops);
  let remoteHead = "";
  try {
    remoteHead = execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", ref], { encoding: "utf8" }).trim();
  } catch {}
  return { action: result.action, remoteHead, rootOid };
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe("finalizer exact-head pushes against real remotes", () => {
  it.each([
    ["review repair", "pr-review-repair-finalize.ts"],
    ["branch update", "pr-branch-update-finalize.ts"],
  ] as const)("atomically writes a blocked receipt when %s finalizer argument validation fails", (_name, script) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-finalizer-receipt-"));
    sandboxes.push(root);
    const resultFile = path.join(root, "result.json");
    const result = spawnSync("node", [
      `extensions/deadloop/automations/${script}`,
      "--expected-head", "a".repeat(40), "--result-file", resultFile,
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect({ status: result.status, receipt: JSON.parse(readFileSync(resultFile, "utf8")).action }).toEqual({ status: 2, receipt: "blocked" });
  });

  function runRenderedRepairFinalizer() {
    const { repo, remote, rootOid, expectedHead } = fixture();
    const root = path.dirname(repo);
    const bin = path.join(root, "bin");
    const configDir = path.join(root, "config");
    const stateDir = path.join(configDir, "deadloop");
    const runDir = path.join(stateDir, "runs", "rendered");
    mkdirSync(bin);
    mkdirSync(runDir, { recursive: true });
    git(repo, ["update-ref", "refs/remotes/origin/main", rootOid]);
    const baseBranch = "origin/main";
    writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({ projects: [{
      repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "R_repo", baseBranch, enabledAt: 1,
      automationLogin: "deadloop-bot",
      firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
      autoMergeAcknowledged: false, enabled: true,
    }] }));
    writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify({ projects: [{
      id: "demo", repoPath: repo, githubRepo: "owner/repo", baseBranch,
    }] }));
    const gitCommand = path.join(bin, "git");
    writeFileSync(gitCommand, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2).map((arg) => arg === "https://github.com/owner/repo.git" && (process.argv.includes("push") || process.argv.includes("ls-remote")) ? ${JSON.stringify(remote)} : arg);
const result = spawnSync("/usr/bin/git", args, {stdio:"inherit"});
process.exit(result.status ?? 1);
`);
    chmodSync(gitCommand, 0o755);
    const binding = {
      repositoryId: "R_repo", repository: "owner/repo", targetNumber: 1, requestEventId: "22", role: "reviewer", revision: expectedHead, owner: "host-a",
      authority: { durationSeconds: 86700 }, activeState: activeReviewState,
    };
    const reviewClaim = {
      binding, commentId: "101", authorizedLogins: ["deadloop-bot"], automationLogin: "deadloop-bot", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      attemptId: "attempt", launchUuid: "launch", project: "demo", repository: "owner/repo",
      role: "review-repair", target: { kind: "pull-request", number: 1 }, inputRevision: { head: expectedHead },
      branch, worktreePath: repo, agentName: "repair", workspaceLabel: "repair",
      promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
      phase: "agent_started", lastSuccessfulPhase: "agent_started", reviewClaim,
    }));
    const gh = path.join(bin, "gh");
    writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") process.stdout.write("deadloop-bot\\n");
else if (args[0] === "repo") process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"owner/repo"}));
else if (args.some((arg) => arg.endsWith("/events"))) process.stdout.write(JSON.stringify([[{id:22,event:"labeled",created_at:"2026-07-20T10:00:00Z",label:{name:"agent:review"}}]]));
else if (args.some((arg) => arg.endsWith("/comments"))) process.stdout.write(JSON.stringify([[{id:101,created_at:"2026-07-20T10:01:00Z",updated_at:"2026-07-20T10:01:00Z",user:{login:"deadloop-bot"},body:${JSON.stringify(renderReviewClaimComment(binding))}}]]));
else if (args.includes("--include")) process.stdout.write("date: Mon, 20 Jul 2026 10:03:00 GMT");
else if (args[0] === "pr") process.stdout.write(JSON.stringify({state:"OPEN",isCrossRepository:false,headRefName:"${branch}",headRefOid:"${expectedHead}",labels:[{name:"agent:in-progress"}],comments:[{body:"<!-- deadloop:review-repair-attempt key=11111111111111111111 head=${expectedHead} review=22222222222222222222 findings=1 -->"}]}));
`);
    chmodSync(gh, 0o755);
    const promiseFile = path.join(runDir, "promise.json");
    const automationDir = path.resolve("extensions/deadloop/automations");
    const rendered = repairWorkerPrompt("1", branch, expectedHead, [{ title: "repair", body: "repair the file" }], "attempt", promiseFile, repo, {
      projectId: "demo", repoPath: repo, githubRepo: "owner/repo", stateDir, checkCommand: "true",
      workerAgent: "pi", workerModel: "", remote: "origin", reviewLabel: "agent:review",
      blockedLabel: "agent:blocked", inProgressLabel: "agent:in-progress",
      reviewClaim, automationDir, enabledAt: 1,
    });
    const command = rendered.match(/permitted non-force push to the exact branch:\n  (.+)\n- Never edit labels/)?.[1];
    if (!command) throw new Error("rendered finalizer command was not found");
    const result = spawnSync("bash", ["-c", command], {
      cwd: process.cwd(), encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: configDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    const resultFile = path.join(runDir, "finalizer-result.json");
    const receipt = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : { action: "missing" };
    return { result, receipt };
  }

  it("runs the rendered repair finalizer command without an error", () => {
    const { result, receipt } = runRenderedRepairFinalizer();
    expect(result.stderr || receipt.summary || "").toBe("");
  });

  it("writes the pushed receipt for the rendered repair finalizer command", () => {
    const { result, receipt } = runRenderedRepairFinalizer();
    expect({ status: result.status, receipt: receipt.action }).toEqual({ status: 0, receipt: "pushed" });
  });

  it.each([
    ["review repair", "repair"],
    ["branch update", "branch-update"],
  ] as const)("does not recreate a deleted branch during %s finalization", (_name, finalizer) => {
    const result = runRace(finalizer, "delete");
    expect({ action: result.action, remoteHead: result.remoteHead }).toEqual({ action: "stale_head", remoteHead: "" });
  });

  it.each([
    ["review repair", "repair"],
    ["branch update", "branch-update"],
  ] as const)("does not replace a rewound branch during %s finalization", (_name, finalizer) => {
    const result = runRace(finalizer, "rewind");
    expect({ action: result.action, rewoundHeadRetained: result.remoteHead === result.rootOid }).toEqual({
      action: "stale_head",
      rewoundHeadRetained: true,
    });
  });
});
