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

  it("reports a malformed journal beside a retained deterministic worktree without claiming ownership", () => {
    const scenario = fixture();
    const attemptId = "malformed-attempt";
    const attemptDir = path.join(scenario.stateDir, "required-verification", "enablement", attemptId);
    const worktreePath = path.join(scenario.stateDir, "required-verification", "worktrees", attemptId);
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(attemptDir, "journal.json"), "{malformed");

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

  it("preserves timeout classification and retained quarantine evidence when restoration fails", async () => {
    const scenario = fixture();
    const hookPath = path.join(scenario.repoPath, ".git", "hooks", "post-checkout");
    fs.writeFileSync(hookPath, "#!/bin/sh\nmkdir .deadloop\nprintf evidence > .deadloop/promise.json\n", { mode: 0o755 });
    const contract = { ...scenario.contract, command: "chmod a-w .; sleep 60" };
    const result = await runEnablementVerification({
      stateDir: scenario.stateDir,
      primaryRepoPath: scenario.repoPath,
      repository: contract.repository,
      resolution: { status: "resolved", contract },
      timeoutMs: 100,
    });
    const record = JSON.parse(fs.readFileSync(result.recordPath, "utf8"));
    const journal = JSON.parse(fs.readFileSync(result.journalPath, "utf8"));
    fs.chmodSync(journal.worktreePath, 0o700);

    expect({
      outcome: record.outcome,
      reason: record.terminationReason,
      timedOut: record.timedOut,
      quarantineRetained: fs.existsSync(record.artifactRestorationFailure.quarantinePath),
    }).toEqual({ outcome: "timed_out", reason: "timeout", timedOut: true, quarantineRetained: true });
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
