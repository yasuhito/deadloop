import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Each test drives the host-side PR work-authority reconciliation boundary with one fixture
// failure, so a diagnosis lost at that boundary is reproduced before the reason is built.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-reconcile-diagnostics-"));
const stateDir = path.join(root, "deadloop");
let reconcilePrWorkAuthority: (
  pi: unknown,
  project: unknown,
) => Promise<{ reconciled: boolean; reason: string }>;

const project = {
  id: "demo", githubRepo: "octo/demo", repoPath: root, enabledAt: 1,
  labels: { ready: "ready-for-agent", explore: "agent:explore", implement: "agent:implement", review: "agent:review", inProgress: "agent:in-progress", blocked: "agent:blocked", human: "ready-for-human" },
};

function execFixture(result: { code?: number; stdout?: string; stderr?: string; killed?: boolean }) {
  return {
    exec: async () => ({ code: 0, stdout: "", stderr: "", ...result }),
  };
}

function throwingExecFixture(error: Error) {
  return {
    exec: async () => {
      throw error;
    },
  };
}

beforeAll(async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.resetModules();
  // @ts-expect-error Vitest transforms this runtime extension import.
  ({ reconcilePrWorkAuthority } = await import("../extensions/deadloop/index"));
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({
    projects: [{
      repoPath: root, githubRepo: "octo/demo", githubRepositoryId: "R_demo", enabledAt: 1,
      firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
      autoMergeAcknowledged: false, enabled: true, automationLogin: "deadloop-bot",
    }],
    lastWriterCodeIdentity: "a".repeat(40),
  }));
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("PR work-authority reconciliation driver diagnostics", () => {
  it("names a non-zero driver exit with its exit code in the reason", async () => {
    const authority = await reconcilePrWorkAuthority(execFixture({ code: 1, stdout: "", stderr: "EACCES: permission denied" }), project);
    expect(authority).toEqual({ reconciled: false, reason: expect.stringContaining("exited with code 1") });
  });

  it("keeps the sanitized driver stderr in a non-zero exit reason", async () => {
    const authority = await reconcilePrWorkAuthority(execFixture({ code: 1, stdout: "", stderr: "FATAL: journal lock held by pid 4242" }), project);
    expect(authority).toEqual({ reconciled: false, reason: expect.stringContaining("journal lock held by pid 4242") });
  });

  it("names a timed-out driver in the reason", async () => {
    const authority = await reconcilePrWorkAuthority(execFixture({ code: 143, stdout: "", stderr: "", killed: true }), project);
    expect(authority).toEqual({ reconciled: false, reason: expect.stringContaining("timed out") });
  });

  it("names a driver launch failure in the reason", async () => {
    const authority = await reconcilePrWorkAuthority(throwingExecFixture(new Error("spawn node ENOENT")), project);
    expect(authority).toEqual({ reconciled: false, reason: expect.stringContaining("could not be started") });
  });

  it("names invalid driver JSON output as an output contract violation in the reason", async () => {
    const authority = await reconcilePrWorkAuthority(execFixture({ code: 0, stdout: "not-json", stderr: "" }), project);
    expect(authority).toEqual({ reconciled: false, reason: expect.stringContaining("invalid JSON") });
  });

  it("names an empty driver output as an output contract violation in the reason", async () => {
    const authority = await reconcilePrWorkAuthority(execFixture({ code: 0, stdout: "", stderr: "" }), project);
    expect(authority).toEqual({ reconciled: false, reason: expect.stringContaining("empty result") });
  });

  it("keeps a driver-reported error summary as the reason", async () => {
    const authority = await reconcilePrWorkAuthority(
      execFixture({ code: 0, stdout: JSON.stringify({ action: "error", summary: "journal rebuild refused", driverAction: "pr_work_authority_reconciliation_failed" }), stderr: "" }),
      project,
    );
    expect(authority).toEqual({ reconciled: false, reason: "journal rebuild refused" });
  });

  it("redacts local absolute paths from a non-zero exit reason", async () => {
    const authority = await reconcilePrWorkAuthority(
      execFixture({ code: 1, stdout: "", stderr: "Cannot find module '/home/yasuhito/Work/deadloop/extensions/deadloop/automations/reconcile-pr-work-authority.cts'" }),
      project,
    );
    expect(authority.reason).not.toContain("/home/yasuhito");
  });

  it("redacts token-shaped secrets from a non-zero exit reason", async () => {
    const authority = await reconcilePrWorkAuthority(
      execFixture({ code: 1, stdout: "", stderr: "env GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz rejected" }),
      project,
    );
    expect(authority.reason).not.toContain("ghp_0123456789");
  });
});
