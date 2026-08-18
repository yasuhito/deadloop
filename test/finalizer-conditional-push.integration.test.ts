import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { finalizeReviewRepair } = require("../extensions/deadloop/automations/pr-review-repair-finalize.ts");
const { createPreparedAttempt } = require("../src/attempt-lifecycle-runtime.cjs");
const { repairWorkerPrompt } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.ts");
const { finalizeBranchUpdate } = require("../extensions/deadloop/automations/pr-branch-update-finalize.ts");
const { writeWorkerContractSnapshot } = require("../src/worker-required-verification-runtime.cjs");

type JsonObject = Record<string, any>;

const sandboxes: string[] = [];
const branch = "agent/issue-1";
const ref = `refs/heads/${branch}`;

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
  writeFileSync(path.join(repo, "file.txt"), "advanced\n");
  git(repo, ["commit", "--quiet", "-am", "advanced ancestor"]);
  const advancedOid = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(repo, "file.txt"), "candidate\n");
  git(repo, ["commit", "--quiet", "-am", "candidate"]);
  const configPath = path.join(root, ".gitconfig");
  writeFileSync(configPath, `[url "file://${remote}"]\n\tinsteadOf = https://github.com/owner/repo.git\n`);
  return { repo, remote, rootOid, expectedHead, advancedOid, configPath };
}

async function runRace(finalizer: "repair" | "branch-update", race: "advance" | "delete" | "rewind") {
  const { repo, remote, rootOid, expectedHead, advancedOid, configPath } = fixture();
  const stateDir = path.dirname(repo);
  const runDir = path.join(stateDir, "runs", "attempt");
  createPreparedAttempt(runDir, {
    attemptId: "attempt", launchUuid: "launch", project: "demo", repository: "owner/repo",
    role: "review-repair", target: { kind: "pull-request", number: 1 }, inputRevision: { head: expectedHead },
    branch, worktreePath: repo, agentName: "repair", workspaceLabel: "repair",
    promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"), requestEventId: "22",
  });
  const hookPath = path.join(repo, ".git", "hooks", "pre-push");
  const updateRef = race === "delete"
    ? `git --git-dir='${remote}' update-ref -d '${ref}'`
    : race === "advance"
      ? `git --git-dir='${remote}' fetch --quiet '${repo}' '${advancedOid}' && git --git-dir='${remote}' update-ref '${ref}' '${advancedOid}'`
      : `git --git-dir='${remote}' update-ref '${ref}' '${rootOid}'`;
  writeFileSync(hookPath, `#!/bin/sh\n${updateRef}\n`);
  chmodSync(hookPath, 0o755);
  const run = (args: string[]) => {
    if (args[0] === "node") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "gh" && args[1] === "api" && args[2] === "user") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
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
  const common = {
    repo,
    projectId: "demo",
    attemptRecord: path.join(runDir, "attempt.json"),
    projectRepo: repo,
    githubRepo: "owner/repo",
    pr: "1",
    branch,
    expectedHead,
    remote: "origin",
    automationDir: "/automation",
    stateDir,
    enabledAt: 1,
    checkCommand: "true",
    resultFile: path.join(path.dirname(repo), "result.json"),
    inProgressLabel: "agent:in-progress",
    blockedLabel: "agent:blocked",
  };
  const ops = {
    run,
    ensureVerification: (_args: unknown, _candidate: string, _repositoryId: string, execute: (args: string[]) => unknown) => execute(["node", "/automation/run-project-check.ts"]),
    assertEnabled: () => ({ githubRepo: "owner/repo", githubRepositoryId: "R_repo", automationLogin: "deadloop-bot" }),
  };
  const result = finalizer === "repair"
    ? await finalizeReviewRepair(common, ops)
    : await finalizeBranchUpdate({ ...common, expectedBase: rootOid }, ops);
  let remoteHead = "";
  try {
    remoteHead = execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", ref], { encoding: "utf8" }).trim();
  } catch {}
  return { action: result.action, remoteHead, rootOid, advancedOid };
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

  // The configured check runs inside the worktree, so its markers go to the parent directory and
  // leave the worktree clean for the post-check.
  const startedMarker = "check-started";
  const completedMarker = "check-completed";
  const SLOW_CHECK = `touch ../${startedMarker} && sleep 30 && touch ../${completedMarker}`;

  function renderedRepairFinalizer(checkCommand: string) {
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
      id: "demo", repoPath: repo, githubRepo: "owner/repo", baseBranch, checkCommand,
    }] }));
    const gitCommand = path.join(bin, "git");
    writeFileSync(gitCommand, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2).map((arg) => arg === "https://github.com/owner/repo.git" && (process.argv.includes("push") || process.argv.includes("ls-remote")) ? ${JSON.stringify(remote)} : arg);
const result = spawnSync("/usr/bin/git", args, {stdio:"inherit"});
process.exit(result.status ?? 1);
`);
    chmodSync(gitCommand, 0o755);
    const gh = path.join(bin, "gh");
    writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") process.stdout.write("deadloop-bot\\n");
else if (args[0] === "repo") process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"owner/repo"}));
else if (args[0] === "pr") process.stdout.write(JSON.stringify({state:"OPEN",isCrossRepository:false,headRefName:"${branch}",headRefOid:"${expectedHead}",labels:[{name:"agent:in-progress"}],comments:[{body:"<!-- deadloop:review-repair-attempt key=11111111111111111111 head=${expectedHead} review=22222222222222222222 findings=1 -->"}]}));
`);
    chmodSync(gh, 0o755);
    const promiseFile = path.join(runDir, "promise.json");
    const contract = {
      repository: "owner/repo",
      command: checkCommand,
      source: { kind: "local", location: `${path.join(stateDir, "projects.json")}#project=demo` },
      baseRevision: expectedHead,
    };
    const attempt = {
      attemptId: "attempt", launchUuid: "rendered", project: "demo", repository: "owner/repo", role: "review-repair",
      target: { kind: "pull-request", number: 1 }, inputRevision: { head: expectedHead }, branch, baseBranch: expectedHead,
      worktreePath: repo, agentName: "dl-repair-test", workspaceLabel: "repair", promptFile: path.join(runDir, "prompt.md"), promiseFile,
      requiredVerification: contract, requestEventId: "22",
    };
    writeWorkerContractSnapshot(runDir, attempt);
    createPreparedAttempt(runDir, attempt);
    const automationDir = path.resolve("extensions/deadloop/automations");
    const rendered = repairWorkerPrompt("1", branch, expectedHead, [{ title: "repair", body: "repair the file" }], "attempt", promiseFile, repo, {
      projectId: "demo", repoPath: repo, githubRepo: "owner/repo", stateDir, checkCommand,
      baseBranch: expectedHead, requiredVerification: contract,
      workerAgent: "pi", workerModel: "", remote: "origin", reviewLabel: "agent:review",
      blockedLabel: "agent:blocked", inProgressLabel: "agent:in-progress",
      automationDir, enabledAt: 1,
    });
    const command = rendered.match(/permitted non-force push to the exact branch:\n  (.+)\n- Never edit labels/)?.[1];
    if (!command) throw new Error("rendered finalizer command was not found");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: configDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    return { command, env, root, runDir, remote, expectedHead };
  }

  function runRenderedRepairFinalizer() {
    const { command, env, runDir } = renderedRepairFinalizer("true");
    const result = spawnSync("bash", ["-c", command], { cwd: process.cwd(), encoding: "utf8", env });
    const resultFile = path.join(runDir, "finalizer-result.json");
    const receipt = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : { action: "missing" };
    return { result, receipt };
  }

  function remoteHeadOf(remote: string): string {
    try {
      return execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", ref], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  }

  // A real subprocess starts the configured check on its own clock, so the scenario polls the
  // marker that check writes; a fake timer cannot advance another process.
  async function waitForMarker(marker: string): Promise<void> {
    for (let waited = 0; waited < 30_000 && !existsSync(marker); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  type SignaledFinalizer = {
    stoppedWithinMs: number;
    checkCompleted: boolean;
    checkerInterrupted: boolean;
    record: JsonObject;
    receipt: JsonObject;
    remoteHead: string;
    expectedHead: string;
  };

  /**
   * Signal the real finalizer process while its configured check is still running.
   *
   * `exec` makes the rendered command replace the shell, so SIGTERM reaches the finalizer itself
   * and the scenario observes what a signaled finalizer leaves behind.
   */
  async function signalRenderedRepairFinalizer(): Promise<SignaledFinalizer> {
    const { command, env, root, runDir, remote, expectedHead } = renderedRepairFinalizer(SLOW_CHECK);
    const finalizer = spawn("bash", ["-c", `exec ${command}`], { cwd: process.cwd(), env, stdio: "ignore" });
    await waitForMarker(path.join(root, startedMarker));
    const signalledAt = Date.now();
    finalizer.kill("SIGTERM");
    await new Promise((resolve) => finalizer.once("close", resolve));
    const stoppedWithinMs = Date.now() - signalledAt;
    const structuredPath = path.join(runDir, "required-verification-check-result.json");
    const recordPath = path.join(runDir, "required-verification.json");
    const resultFile = path.join(runDir, "finalizer-result.json");
    return {
      stoppedWithinMs,
      checkCompleted: existsSync(path.join(root, completedMarker)),
      checkerInterrupted: existsSync(structuredPath) && JSON.parse(readFileSync(structuredPath, "utf8")).interrupted === true,
      record: existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : {},
      receipt: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : { action: "missing" },
      remoteHead: remoteHeadOf(remote),
      expectedHead,
    };
  }

  let signalled: SignaledFinalizer | undefined;
  async function signaledRepairFinalizer(): Promise<SignaledFinalizer> {
    signalled ??= await signalRenderedRepairFinalizer();
    return signalled;
  }

  it("runs the rendered repair finalizer command without an error", () => {
    const { result, receipt } = runRenderedRepairFinalizer();
    expect(result.stderr || receipt.summary || "").toBe("");
  });

  it("writes the pushed receipt for the rendered repair finalizer command", () => {
    const { result, receipt } = runRenderedRepairFinalizer();
    expect({ status: result.status, receipt: receipt.action }).toEqual({ status: 0, receipt: "pushed" });
  });

  // The scenario spawns the finalizer, waits for the configured check to start, and signals it, so
  // whichever of these runs first pays for a real process launch.
  const SIGNALED_SCENARIO_TIMEOUT_MS = 60_000;

  it("stops the configured check when the repair finalizer is signaled", async () => {
    expect((await signaledRepairFinalizer()).checkerInterrupted).toBe(true);
  }, SIGNALED_SCENARIO_TIMEOUT_MS);

  it("does not let the configured check finish after the repair finalizer is signaled", async () => {
    expect((await signaledRepairFinalizer()).checkCompleted).toBe(false);
  }, SIGNALED_SCENARIO_TIMEOUT_MS);

  it("stops the signaled repair finalizer long before its configured check would end", async () => {
    expect((await signaledRepairFinalizer()).stoppedWithinMs).toBeLessThan(10_000);
  }, SIGNALED_SCENARIO_TIMEOUT_MS);

  it("persists an interrupted required-verification record for the signaled repair finalizer", async () => {
    expect((await signaledRepairFinalizer()).record.outcome).toBe("interrupted");
  }, SIGNALED_SCENARIO_TIMEOUT_MS);

  it("does not push when the repair finalizer is signaled", async () => {
    const signaled = await signaledRepairFinalizer();
    expect(signaled.remoteHead).toBe(signaled.expectedHead);
  }, SIGNALED_SCENARIO_TIMEOUT_MS);

  it("writes a blocked receipt naming the interruption for the signaled repair finalizer", async () => {
    expect((await signaledRepairFinalizer()).receipt).toMatchObject({ action: "blocked", summary: expect.stringContaining("interrupted") });
  }, SIGNALED_SCENARIO_TIMEOUT_MS);

  it.each([
    ["review repair", "repair"],
    ["branch update", "branch-update"],
  ] as const)("rejects an advancing-ancestor race during %s finalization", async (_name, finalizer) => {
    const result = await runRace(finalizer, "advance");
    expect({ action: result.action, advancedHeadRetained: result.remoteHead === result.advancedOid }).toEqual({
      action: "stale_head",
      advancedHeadRetained: true,
    });
  });

  it.each([
    ["review repair", "repair"],
    ["branch update", "branch-update"],
  ] as const)("does not recreate a deleted branch during %s finalization", async (_name, finalizer) => {
    const result = await runRace(finalizer, "delete");
    expect({ action: result.action, remoteHead: result.remoteHead }).toEqual({ action: "stale_head", remoteHead: "" });
  });

  it.each([
    ["review repair", "repair"],
    ["branch update", "branch-update"],
  ] as const)("does not replace a rewound branch during %s finalization", async (_name, finalizer) => {
    const result = await runRace(finalizer, "rewind");
    expect({ action: result.action, rewoundHeadRetained: result.remoteHead === result.rootOid }).toEqual({
      action: "stale_head",
      rewoundHeadRetained: true,
    });
  });
});
