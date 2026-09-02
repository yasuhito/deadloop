import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeProject } from "../src/core";
import { buildStatusSnapshot, formatStatusReport, resolveActiveProject } from "../src/status";

const fixture = JSON.parse(readFileSync("test/fixtures/status/report-case.json", "utf8"));
const projects = fixture.projects.map(normalizeProject);
const store = require("../src/ci-fallback-store.cjs");
const roots: string[] = [];

function realRepo(): { root: string; repoPath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-status-"));
  roots.push(root);
  const repoPath = path.join(root, "repo");
  execFileSync("git", ["init", "--quiet", "-b", "main", repoPath]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "T"]);
  writeFileSync(path.join(repoPath, "f.txt"), "x\n");
  execFileSync("git", ["-C", repoPath, "add", "."]);
  execFileSync("git", ["-C", repoPath, "commit", "--quiet", "-m", "c"]);
  return { root, repoPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});


describe("deadloop status report", () => {
  it("resolves the active project only from the exact repository top-level", () => {
    expect(resolveActiveProject("/home/yasuhito/Work/deadloop", projects)?.id).toBe("deadloop");
  });

  it("does not select a parent project from a nested repository root", () => {
    expect(resolveActiveProject("/home/yasuhito/Work/deadloop/vendor/nested", projects)).toBeNull();
  });

  it("shows the resolved role models in the status report", () => {
    const report = formatStatusReport(buildStatusSnapshot({ cwd: "/home/yasuhito/Work/deadloop", projects }));

    expect({
      hasWorkerModel: report.includes(`roleModels: worker=${projects[0].workerModel}`),
      hasExplorerModel: report.includes(`explorer=${projects[0].workerModel}`),
    }).toEqual({ hasWorkerModel: true, hasExplorerModel: true });
  });

  it("lists current-attempt model and token totals when an active attempt has usage", () => {
    const attemptUsage = [{
      attemptId: "attempt-9", role: "worker", repository: "yasuhito/deadloop", targetKind: "issue",
      targetNumber: 42, phase: "agent_started", active: true, records: 3,
      models: ["openai-codex/gpt-5.6-sol"],
      totals: {
        responses: 3, inputTokens: 900, cacheReadTokens: 12_000, cacheWriteTokens: 0, outputTokens: 150,
        reasoningTokens: 30, totalTokens: 1050, estimatedCostUsd: 0.02, hasUnknown: false,
      },
    }];
    const report = formatStatusReport(
      buildStatusSnapshot({ cwd: "/home/yasuhito/Work/deadloop", projects, attemptUsage }),
    );

    expect({
      hasUsageHeading: report.includes("Current attempt usage:"),
      hasAttemptModel: report.includes("attempt-9 (worker, issue #42): model=openai-codex/gpt-5.6-sol"),
      hasCacheRead: report.includes("cache-read=12000"),
    }).toEqual({ hasUsageHeading: true, hasAttemptModel: true, hasCacheRead: true });
  });


  it("leaves a stale base-blocking record in place when building the snapshot", () => {
    const { root, repoPath } = realRepo();
    const project = normalizeProject({ id: "demo", repoPath, baseBranch: "main", workerModel: "test-model", reviewerModel: "review-model" });
    store.writeBaseBlocking(root, "demo", { baseRevision: "0".repeat(40), command: "make ci", prNumber: 24 });

    buildStatusSnapshot({ cwd: repoPath, projects: [project], statePath: path.join(root, "state.json") });

    expect(store.readBaseBlocking(root, "demo")).not.toBeNull();
  });
});
