import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectRetainedEnablementVerifications,
  runEnablementVerification,
} from "../src/enablement-verification";
import type { RequiredVerificationContract } from "../src/required-verification";

const sandboxes: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-verification-"));
  sandboxes.push(root);
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath);
  execFileSync("git", ["-C", repoPath, "init", "--quiet"]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repoPath, "add", "README.md"]);
  execFileSync("git", ["-C", repoPath, "commit", "--quiet", "-m", "initial"]);
  const baseRevision = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const stateDir = path.join(root, "state");
  const countPath = path.join(root, "count");
  const contract: RequiredVerificationContract = {
    repository: "owner/demo",
    command: `printf x >> ${countPath}`,
    source: { kind: "repo_policy", location: "deadloop.json" },
    baseRevision,
  };
  const run = (selectedContract = contract) => runEnablementVerification({
    stateDir,
    primaryRepoPath: repoPath,
    repository: selectedContract.repository,
    resolution: { status: "resolved", contract: selectedContract },
  });
  return { root, repoPath, stateDir, countPath, contract, run };
}

async function thrownRestorationFailureScenario() {
  const scenario = fixture();
  const quarantinePath = path.join(scenario.stateDir, "check-quarantine", "retained-after-throw");
  fs.mkdirSync(quarantinePath, { recursive: true });
  const failure = Object.assign(new Error("checker spawn failed"), {
    restorationFailure: { message: "restore failed after spawn failure", quarantinePath },
  });
  const result = await runEnablementVerification({
    stateDir: scenario.stateDir,
    primaryRepoPath: scenario.repoPath,
    repository: scenario.contract.repository,
    resolution: { status: "resolved", contract: scenario.contract },
    projectCheckRunner: async () => { throw failure; },
  });
  return {
    failure,
    quarantinePath,
    record: JSON.parse(fs.readFileSync(result.recordPath, "utf8")),
    journal: JSON.parse(fs.readFileSync(result.journalPath, "utf8")),
    result,
  };
}

async function returnedRestorationFailureScenario() {
  const scenario = fixture();
  const quarantinePath = path.join(scenario.stateDir, "check-quarantine", "retained");
  const result = await runEnablementVerification({
    stateDir: scenario.stateDir,
    primaryRepoPath: scenario.repoPath,
    repository: scenario.contract.repository,
    resolution: { status: "resolved", contract: scenario.contract },
    projectCheckRunner: async () => {
      fs.mkdirSync(quarantinePath, { recursive: true });
      return {
        code: null,
        stdout: "",
        stderr: "",
        timedOut: true,
        interrupted: false,
        signal: null,
        restorationFailure: { message: "deterministic restoration failure", quarantinePath },
      };
    },
  });
  return {
    doctorFinding: inspectRetainedEnablementVerifications(scenario.stateDir, scenario.repoPath)[0],
    journal: JSON.parse(fs.readFileSync(result.journalPath, "utf8")),
    quarantinePath,
    record: JSON.parse(fs.readFileSync(result.recordPath, "utf8")),
    result,
  };
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("enablement required-verification records", () => {
  it("reuses a completely matching successful record", async () => {
    const scenario = fixture();
    await scenario.run();

    expect((await scenario.run()).reused).toBe(true);
  });

  it("does not execute the command again when a successful record is reused", async () => {
    const scenario = fixture();
    await scenario.run();
    await scenario.run();

    expect(fs.readFileSync(scenario.countPath, "utf8")).toBe("x");
  });

  it("reruns verification when the command binding changes", async () => {
    const scenario = fixture();
    await scenario.run();

    expect((await scenario.run({ ...scenario.contract, command: `${scenario.contract.command}; true` })).reused).toBe(false);
  });

  it("reruns verification when the binding contradicts the persisted contract", async () => {
    const scenario = fixture();
    const result = await scenario.run();
    const record = JSON.parse(fs.readFileSync(result.recordPath, "utf8"));
    const contradictoryCommand = `${scenario.contract.command}; true`;
    fs.writeFileSync(result.recordPath, `${JSON.stringify({
      ...record,
      binding: { ...record.binding, command: contradictoryCommand },
    })}\n`);

    expect((await scenario.run({ ...scenario.contract, command: contradictoryCommand })).reused).toBe(false);
  });

  it("reruns verification when the source identity changes", async () => {
    const scenario = fixture();
    await scenario.run();

    expect((await scenario.run({ ...scenario.contract, source: { kind: "local", location: "projects.json" } })).reused).toBe(false);
  });

  it("reuses verification when only override metadata changes", async () => {
    const scenario = fixture();
    await scenario.run({
      ...scenario.contract,
      override: { source: { kind: "repo_policy", location: "old-policy.json" }, command: "npm run old-check" },
    });

    expect((await scenario.run({
      ...scenario.contract,
      override: { source: { kind: "repo_policy", location: "new-policy.json" }, command: "npm run new-check" },
    })).reused).toBe(true);
  });

  it("reruns verification when the repository binding changes", async () => {
    const scenario = fixture();
    await scenario.run();

    expect((await scenario.run({ ...scenario.contract, repository: "owner/renamed" })).reused).toBe(false);
  });

  it("reruns verification when the base revision changes", async () => {
    const scenario = fixture();
    await scenario.run();
    fs.writeFileSync(path.join(scenario.repoPath, "NEXT.md"), "next\n");
    execFileSync("git", ["-C", scenario.repoPath, "add", "NEXT.md"]);
    execFileSync("git", ["-C", scenario.repoPath, "commit", "--quiet", "-m", "next"]);
    const baseRevision = execFileSync("git", ["-C", scenario.repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    expect((await scenario.run({ ...scenario.contract, baseRevision })).reused).toBe(false);
  });

  it("never reuses a failed record", async () => {
    const scenario = fixture();
    const failing = { ...scenario.contract, command: "exit 9" };
    await scenario.run(failing);

    expect((await scenario.run(failing)).reused).toBe(false);
  });

  it("reruns a passed record that contains a termination signal", async () => {
    const scenario = fixture();
    const result = await scenario.run();
    const record = JSON.parse(fs.readFileSync(result.recordPath, "utf8"));
    fs.writeFileSync(result.recordPath, `${JSON.stringify({ ...record, terminationSignal: "SIGTERM" })}\n`);

    expect((await scenario.run()).reused).toBe(false);
  });

  it("reruns a passed record that contains artifact restoration failure evidence", async () => {
    const scenario = fixture();
    const result = await scenario.run();
    const record = JSON.parse(fs.readFileSync(result.recordPath, "utf8"));
    fs.writeFileSync(result.recordPath, `${JSON.stringify({
      ...record,
      artifactRestorationFailure: { message: "restore failed", quarantinePath: "/retained/quarantine" },
    })}\n`);

    expect((await scenario.run()).reused).toBe(false);
  });

  it("records a signal termination with no exit code", async () => {
    const scenario = fixture();
    const result = await scenario.run({ ...scenario.contract, command: "kill -TERM $$" });
    const record = JSON.parse(fs.readFileSync(result.recordPath, "utf8"));

    expect({ outcome: record.outcome, exitCode: record.exitCode, reason: record.terminationReason, signal: record.terminationSignal }).toEqual({
      outcome: "failed",
      exitCode: null,
      reason: "signal",
      signal: "SIGTERM",
    });
  });

  it("does not reuse a success whose cleanup result is unknown", async () => {
    const scenario = fixture();
    const dirtyContract = { ...scenario.contract, command: "touch generated" };
    const result = await scenario.run(dirtyContract);
    const journal = JSON.parse(fs.readFileSync(result.journalPath, "utf8"));
    fs.writeFileSync(result.journalPath, `${JSON.stringify({ ...journal, state: "checked" })}\n`);

    expect((await scenario.run(dirtyContract)).reused).toBe(false);
  });

  it("exposes a cleanup-unknown worktree for doctor inspection", async () => {
    const scenario = fixture();
    const result = await scenario.run({ ...scenario.contract, command: "touch generated" });
    const journal = JSON.parse(fs.readFileSync(result.journalPath, "utf8"));
    fs.writeFileSync(result.journalPath, `${JSON.stringify({ ...journal, state: "checked", retentionReason: undefined })}\n`);

    expect(inspectRetainedEnablementVerifications(scenario.stateDir, scenario.repoPath)[0]?.retentionReason).toContain("cleanup result is unknown");
  });

  it("exposes cleanup-unknown journals even when the recorded path is missing", async () => {
    const scenario = fixture();
    const result = await scenario.run();
    const journal = JSON.parse(fs.readFileSync(result.journalPath, "utf8"));
    fs.writeFileSync(result.journalPath, `${JSON.stringify({ ...journal, state: "checked" })}\n`);

    expect(inspectRetainedEnablementVerifications(scenario.stateDir, scenario.repoPath)[0]?.journalPath).toBe(result.journalPath);
  });

  it.each([
    ["invalid JSON", "{malformed"],
    ["incomplete V1 JSON", JSON.stringify({ version: 1, state: "retained" })],
  ])("reports a %s journal beside a retained deterministic worktree without claiming ownership", (_case, journalContents) => {
    const scenario = fixture();
    const attemptId = "malformed-attempt";
    const attemptDir = path.join(scenario.stateDir, "required-verification", "enablement", attemptId);
    const worktreePath = path.join(scenario.stateDir, "required-verification", "worktrees", attemptId);
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(attemptDir, "journal.json"), journalContents);

    const finding = inspectRetainedEnablementVerifications(scenario.stateDir, scenario.repoPath)[0];
    expect({ ...finding, ownershipClaimed: Object.hasOwn(finding || {}, "primaryRepoPath") }).toMatchObject({
      attemptId,
      repository: "unknown",
      worktreePath,
      retentionReason: expect.stringContaining("ownership and cleanup state are unknown"),
      ownershipClaimed: false,
    });
  });

  it("records every success binding explicitly", async () => {
    const scenario = fixture();
    const result = await scenario.run();
    const record = JSON.parse(fs.readFileSync(result.recordPath, "utf8"));

    expect(record.binding).toEqual({
      repository: "owner/demo",
      targetCommit: scenario.contract.baseRevision,
      command: scenario.contract.command,
      source: scenario.contract.source,
      baseRevision: scenario.contract.baseRevision,
    });
  });

  it("types a thrown runner restoration failure", async () => {
    const { record } = await thrownRestorationFailureScenario();

    expect(record.terminationReason).toBe("artifact_restoration_failure");
  });

  it("records restoration evidence from a thrown runner", async () => {
    const { failure, record } = await thrownRestorationFailureScenario();

    expect(record.artifactRestorationFailure).toEqual(failure.restorationFailure);
  });

  it("retains cleanup when a thrown runner cannot restore artifacts", async () => {
    const { result } = await thrownRestorationFailureScenario();

    expect(result.cleanup).toBe("retained");
  });

  it("retains the verification worktree when a thrown runner cannot restore artifacts", async () => {
    const { journal } = await thrownRestorationFailureScenario();

    expect(fs.existsSync(journal.worktreePath)).toBe(true);
  });

  it("retains quarantine when a thrown runner cannot restore artifacts", async () => {
    const { quarantinePath } = await thrownRestorationFailureScenario();

    expect(fs.existsSync(quarantinePath)).toBe(true);
  });

  it("preserves the timeout outcome when artifact restoration fails", async () => {
    const { record } = await returnedRestorationFailureScenario();

    expect(record.outcome).toBe("timed_out");
  });

  it("preserves the timeout reason when artifact restoration fails", async () => {
    const { record } = await returnedRestorationFailureScenario();

    expect(record.terminationReason).toBe("timeout");
  });

  it("retains cleanup when a completed check cannot restore artifacts", async () => {
    const { result } = await returnedRestorationFailureScenario();

    expect(result.cleanup).toBe("retained");
  });

  it("retains the verification worktree when a completed check cannot restore artifacts", async () => {
    const { journal } = await returnedRestorationFailureScenario();

    expect(fs.existsSync(journal.worktreePath)).toBe(true);
  });

  it("retains quarantine when a completed check cannot restore artifacts", async () => {
    const { quarantinePath } = await returnedRestorationFailureScenario();

    expect(fs.existsSync(quarantinePath)).toBe(true);
  });

  it("reports the retained verification worktree after artifact restoration fails", async () => {
    const { doctorFinding, journal } = await returnedRestorationFailureScenario();

    expect(doctorFinding?.worktreePath).toBe(journal.worktreePath);
  });

  it("reports the artifact restoration failure reason for doctor inspection", async () => {
    const { doctorFinding } = await returnedRestorationFailureScenario();

    expect(doctorFinding?.retentionReason).toContain("artifact restoration failed");
  });

  it("reports a retained dirty verification worktree for doctor inspection", async () => {
    const scenario = fixture();
    const result = await scenario.run({ ...scenario.contract, command: "touch generated" });

    expect(inspectRetainedEnablementVerifications(scenario.stateDir, scenario.repoPath)[0]).toMatchObject({
      worktreePath: JSON.parse(fs.readFileSync(result.journalPath, "utf8")).worktreePath,
      targetRevision: scenario.contract.baseRevision,
      journalPath: result.journalPath,
      recordPath: result.recordPath,
      logPath: result.logPath,
    });
  });

  it("reports a worktree retained by a failed post-checkout hook", async () => {
    const scenario = fixture();
    const hookPath = path.join(scenario.repoPath, ".git", "hooks", "post-checkout");
    fs.writeFileSync(hookPath, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    try {
      await scenario.run();
    } catch {
      // The retained-resource finding below is the observable failure contract.
    }

    expect(inspectRetainedEnablementVerifications(scenario.stateDir, scenario.repoPath)[0]).toMatchObject({
      worktreePath: expect.stringContaining("required-verification/worktrees"),
      targetRevision: scenario.contract.baseRevision,
      journalPath: expect.stringContaining("journal.json"),
      logPath: expect.stringContaining("check.log"),
      retentionReason: expect.stringContaining("git worktree add failed after retaining"),
    });
  });
});
