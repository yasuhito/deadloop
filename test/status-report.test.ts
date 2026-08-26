import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normalizeProject } from "../src/core";
import { buildStatusSnapshot, formatStatusReport, resolveActiveProject } from "../src/status";

const fixture = JSON.parse(readFileSync("test/fixtures/status/report-case.json", "utf8"));
const projects = fixture.projects.map(normalizeProject);


describe("deadloop status report", () => {
  it("resolves the active project only from the exact repository top-level", () => {
    expect(resolveActiveProject("/home/yasuhito/Work/deadloop", projects)?.id).toBe("deadloop");
  });

  it("does not select a parent project from a nested repository root", () => {
    expect(resolveActiveProject("/home/yasuhito/Work/deadloop/vendor/nested", projects)).toBeNull();
  });

  it("shows the resolved role models in the status report", () => {
    const report = formatStatusReport(buildStatusSnapshot({ cwd: "/home/yasuhito/Work/deadloop", projects }));

    expect(report).toContain(`roleModels: worker=${projects[0].workerModel}`);
    expect(report).toContain(`explorer=${projects[0].workerModel}`);
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

    expect(report).toContain("Current attempt usage:");
    expect(report).toContain("attempt-9 (worker, issue #42): model=openai-codex/gpt-5.6-sol");
    expect(report).toContain("cache-read=12000");
  });

});
