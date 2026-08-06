import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPreparedAttempt, readAttemptRecord, transitionPersistedAttempt } from "../src/attempt-lifecycle";

const { assertWorkerPersistenceAuthorized, completeLocked: completeLockedRaw } = require("../extensions/deadloop/automations/complete-attempt-workspace.ts");
const completeLocked = (args: any, runner: any, recheck: () => void, authorizeWorker?: (...values: any[]) => void) =>
  completeLockedRaw(args, runner, recheck, authorizeWorker || (() => {}));
const { renderAttemptPersistenceMarker } = require("../src/attempt-persistence-marker.cjs");

const roots: string[] = [];
function fixture(withMarker: boolean) {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-complete-attempt-")); roots.push(root);
  const stateDir = path.join(root, "state"); const runDir = path.join(stateDir, "runs", "launch-1");
  const worktree = path.join(root, "worktree"); const inputHead = "a".repeat(40); const outputHead = "b".repeat(40);
  mkdirSync(worktree); mkdirSync(path.join(root, ".git"));
  createPreparedAttempt(runDir, {
    attemptId: "launch-1", launchUuid: "launch-1", project: "demo", repository: "owner/repo", role: "worker",
    target: { kind: "issue", number: 12 }, inputRevision: { head: inputHead }, requiredVerification: {
      repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: inputHead,
    }, branch: "agent/issue-12", baseBranch: "origin/main",
    worktreePath: worktree, agentName: "dl-w-12-123456789abc", workspaceLabel: "Issue 12",
    promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
  });
  transitionPersistedAttempt(runDir, "github_claimed");
  const claimed = readAttemptRecord(runDir);
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({ ...claimed, phase: "workspace_opened", lastSuccessfulPhase: "workspace_opened", workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1" }));
  transitionPersistedAttempt(runDir, "agent_started");
  const report = { schemaVersion: 1, attemptId: "launch-1", role: "worker", target: { repository: "owner/repo", kind: "issue", number: 12 }, inputRevision: { head: inputHead }, status: "complete", summary: "done", result: { outputRevision: outputHead }, evidence: { validations: ["npm test"] } };
  writeFileSync(path.join(runDir, "promise.json"), JSON.stringify(report));
  const marker = withMarker ? renderAttemptPersistenceMarker(readAttemptRecord(runDir), report) : "";
  let workspaceOpen = true; const textCommands: string[][] = [];
  const runner = {
    runText(args: string[]) {
      textCommands.push(args);
      if (args[0] === "git" && args.includes("--git-common-dir")) return `${path.join(root, ".git")}\n`;
      if (args[0] === "git" && args.includes("--show-toplevel")) return `${worktree}\n`;
      if (args[0] === "git" && args.includes("worktree") && args.includes("--porcelain")) return `worktree ${root}\n\nworktree ${worktree}\nbranch refs/heads/agent/issue-12\n`;
      if (args[0] === "herdr" && args[1] === "workspace" && args[2] === "close") workspaceOpen = false;
      return "";
    },
    runJson(args: string[]) {
      if (args[0] === "gh" && args[1] === "pr" && args[2] === "list") return [{ number: 21, state: "OPEN", headRefName: "agent/issue-12", headRefOid: outputHead, baseRefName: "main", body: "Closes #12", labels: [{ name: "agent:review" }], closingIssuesReferences: [{ number: 12 }], comments: marker ? [{ body: marker }] : [] }];
      if (args[0] === "gh" && args[1] === "issue") return { state: "OPEN", labels: [{ name: "agent:in-progress" }] };
      if (args[0] === "herdr" && args[1] === "workspace") return { result: { workspaces: workspaceOpen ? [{ workspace_id: "workspace-1", pane_count: 1, tab_count: 1, worktree: { checkout_path: worktree } }] : [] } };
      if (args[0] === "herdr" && args[1] === "worktree") return { result: { worktrees: [{ path: worktree, branch: "agent/issue-12" }] } };
      if (args[0] === "herdr" && args[1] === "agent") return { result: { agents: [] } };
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  };
  const args = {
    attemptRecord: path.join(runDir, "attempt.json"), projectId: "demo", projectRepo: root, githubRepo: "owner/repo", stateDir,
    enabledAt: "1", expectedLabel: [], workerReadyLabel: "ready-for-agent", workerImplementLabel: "agent:implement",
    workerReviewLabel: "agent:review",
  };
  return { args, runDir, runner, textCommands, setWorkspaceOpen: (value: boolean) => { workspaceOpen = value; } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("selected attempt workspace completion", () => {
  it("retains a strongly reported Worker when the persisted attempt marker is absent", () => {
    const data = fixture(false);
    const result = completeLocked(data.args, data.runner, () => undefined);
    expect({ action: result.driverAction, phase: readAttemptRecord(data.runDir).phase, githubWrites: data.textCommands.filter((args) => args[0] === "gh").length }).toEqual({ action: "workspace_retained", phase: "report_received", githubWrites: 0 });
  });

  it("does not close a prepared attempt from a completion file", () => {
    const data = fixture(true);
    const current = readAttemptRecord(data.runDir);
    writeFileSync(path.join(data.runDir, "attempt.json"), JSON.stringify({
      ...current, phase: "prepared", lastSuccessfulPhase: "prepared",
      workspaceId: undefined, tabId: undefined, rootPaneId: undefined,
    }));
    const result = completeLocked(data.args, data.runner, () => undefined);
    expect({ action: result.driverAction, phase: readAttemptRecord(data.runDir).phase }).toEqual({ action: "workspace_retained", phase: "prepared" });
  });

  it("does not close a workspace-opened attempt without exact agent observation", () => {
    const data = fixture(true);
    const current = readAttemptRecord(data.runDir);
    writeFileSync(path.join(data.runDir, "attempt.json"), JSON.stringify({ ...current, phase: "workspace_opened", lastSuccessfulPhase: "workspace_opened" }));
    const result = completeLocked(data.args, data.runner, () => undefined);
    expect({ action: result.driverAction, phase: readAttemptRecord(data.runDir).phase }).toEqual({ action: "workspace_retained", phase: "workspace_opened" });
  });

  it("does not record GitHub persistence from report_received when the owned workspace is absent", () => {
    const data = fixture(true);
    data.setWorkspaceOpen(false);
    const result = completeLocked(data.args, data.runner, () => undefined);
    expect({ action: result.driverAction, phase: readAttemptRecord(data.runDir).phase }).toEqual({ action: "workspace_retained", phase: "report_received" });
  });

  it("retains a proven Worker workspace when authoritative verification evidence is missing", () => {
    const data = fixture(true);
    const result = completeLocked(data.args, data.runner, () => undefined, (record: any, report: any, args: any) =>
      assertWorkerPersistenceAuthorized(record, report, args, () => record.requiredVerification));
    expect({ action: result.driverAction, phase: readAttemptRecord(data.runDir).phase }).toEqual({ action: "workspace_retained", phase: "report_received" });
  });

  it("does not authorize a synthetic local-source record without host execution", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-complete-local-policy-")); roots.push(root);
    const remote = path.join(root, "remote.git"); const seed = path.join(root, "seed"); const checkout = path.join(root, "checkout");
    const stateDir = path.join(root, "state"); const runDir = path.join(stateDir, "runs", "attempt-1");
    execFileSync("git", ["init", "--bare", "--quiet", remote]);
    execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
    execFileSync("git", ["-C", seed, "config", "user.name", "Test"]); execFileSync("git", ["-C", seed, "config", "user.email", "test@example.com"]);
    writeFileSync(path.join(seed, "file.txt"), "base\n"); execFileSync("git", ["-C", seed, "add", "file.txt"]); execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "base"]);
    execFileSync("git", ["-C", seed, "remote", "add", "origin", remote]); execFileSync("git", ["-C", seed, "push", "--quiet", "-u", "origin", "main"]);
    execFileSync("git", ["clone", "--quiet", "-b", "main", remote, checkout]); mkdirSync(runDir, { recursive: true });
    const baseRevision = execFileSync("git", ["-C", checkout, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
    const configFile = path.join(stateDir, "projects.json");
    writeFileSync(configFile, JSON.stringify({ projects: [{ id: "demo", githubRepo: "owner/repo", checkCommand: "true" }] }));
    const contract = { repository: "owner/repo", command: "true", source: { kind: "local", location: `${configFile}#project=demo` }, baseRevision };
    const attempt = { project: "demo", repository: "owner/repo", role: "worker", baseBranch: "origin/main", requiredVerification: contract };
    const report = { role: "worker", status: "complete", result: { outputRevision: baseRevision } };
    const attemptRecord = path.join(runDir, "attempt.json");
    writeFileSync(path.join(runDir, "required-verification.json"), JSON.stringify({ version: 1, binding: { ...contract, targetCommit: baseRevision }, outcome: "passed", exitCode: 0, startedAt: "2026-08-06T00:00:00.000Z", durationMs: 1, logPath: path.join(runDir, "required-verification.log") }));

    expect(() => assertWorkerPersistenceAuthorized(attempt, report, { attemptRecord, projectRepo: checkout, stateDir }, undefined, "R_owner_repo")).toThrow("stale_policy");
    expect(() => assertWorkerPersistenceAuthorized(attempt, report, { attemptRecord, projectRepo: checkout, stateDir })).toThrow("host execution authenticity");
  });

  it("retains a proven Worker workspace when verification evidence names another output", () => {
    const data = fixture(true); const record = readAttemptRecord(data.runDir);
    writeFileSync(path.join(data.runDir, "required-verification.json"), JSON.stringify({
      version: 1, binding: { ...record.requiredVerification, targetCommit: "c".repeat(40) },
      outcome: "passed", exitCode: 0,
    }));
    const result = completeLocked(data.args, data.runner, () => undefined, (attempt: any, report: any, args: any) =>
      assertWorkerPersistenceAuthorized(attempt, report, args, () => attempt.requiredVerification));
    expect({ action: result.driverAction, phase: readAttemptRecord(data.runDir).phase }).toEqual({ action: "workspace_retained", phase: "report_received" });
  });

  it("durably records persistence before closing a proven Worker workspace", () => {
    const data = fixture(true);
    const result = completeLocked(data.args, data.runner, () => undefined);
    expect({ action: result.driverAction, phase: readAttemptRecord(data.runDir).phase }).toEqual({ action: "workspace_closed", phase: "workspace_closed" });
  });

  it("reconciles an already closed proven attempt idempotently", () => {
    const data = fixture(true);
    completeLocked(data.args, data.runner, () => undefined);
    writeFileSync(path.join(data.runDir, "promise.json"), "malformed later promise");
    const result = completeLocked(data.args, { runText: () => { throw new Error("runner must not be called"); }, runJson: () => { throw new Error("runner must not be called"); } }, () => undefined);
    expect({ action: result.driverAction, phase: readAttemptRecord(data.runDir).phase }).toEqual({ action: "workspace_closed", phase: "workspace_closed" });
  });

  it("retries only workspace cleanup after GitHub persistence even when the promise later becomes malformed", () => {
    const data = fixture(true);
    const record = readAttemptRecord(data.runDir);
    writeFileSync(path.join(data.runDir, "attempt.json"), JSON.stringify({ ...record, phase: "github_persisted", lastSuccessfulPhase: "github_persisted" }));
    writeFileSync(path.join(data.runDir, "promise.json"), "malformed later promise");
    const result = completeLocked(data.args, data.runner, () => undefined);
    expect(result.driverAction).toBe("workspace_closed");
  });

  it("normalizes an ambiguous close failure to cleanup pending", () => {
    const data = fixture(true);
    const original = data.runner.runText.bind(data.runner);
    data.runner.runText = (args: string[]) => args[0] === "herdr" && args[1] === "workspace" && args[2] === "close"
      ? (() => { throw new Error("timeout"); })()
      : original(args);
    const result = completeLocked(data.args, data.runner, () => undefined);
    expect(result.driverAction).toBe("cleanup_pending");
  });

  it("rejects a same-repository attempt owned by another configured project before closure", () => {
    const data = fixture(true);
    expect(() => completeLocked({ ...data.args, projectId: "other-project" }, data.runner, () => undefined)).toThrow(/project/);
  });

  it("rejects a worktree from another clone even when both clones point to the same GitHub repository", () => {
    const data = fixture(true);
    const clone = path.join(data.args.projectRepo, "configured-clone"); mkdirSync(path.join(clone, ".git"), { recursive: true });
    const original = data.runner.runText.bind(data.runner);
    data.runner.runText = (args: string[]) => args[0] === "git" && args[2] === clone && args.includes("--git-common-dir")
      ? `${path.join(clone, ".git")}\n` : original(args);
    expect(() => completeLocked({ ...data.args, projectRepo: clone }, data.runner, () => undefined)).toThrow(/configured project checkout/);
  });
});
