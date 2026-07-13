import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const script = "extensions/deadloop/automations/pr-reviewer-decisions.ts";

function runSelect(
  prsFixture: string,
  options: { agents?: string; projectId?: string; now?: string } = {},
): { selected: boolean; staleReclaim?: boolean; reason?: string } {
  const args = [
    script,
    "--mode",
    "select",
    "--input",
    path.join("test/fixtures/pr-reviewer", prsFixture),
    "--project-id",
    options.projectId ?? "demo",
    "--now",
    options.now ?? "2026-07-04T00:30:00Z",
  ];
  if (options.agents) {
    args.push("--agents", path.join("test/fixtures/pr-reviewer", options.agents));
  }
  const result = spawnSync("node", args, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

describe("PR reviewer stale reviewing reclaim", () => {
  it("reclaims a reviewing PR when no reviewer agent is running", () => {
    expect(runSelect("precheck-reviewing.json", { agents: "agents-empty.json" }).selected).toBe(true);
  });

  it("marks the reclaimed reviewing PR as a stale reclaim", () => {
    expect(runSelect("precheck-reviewing.json", { agents: "agents-empty.json" }).staleReclaim).toBe(true);
  });

  it("skips a reviewing PR while its reviewer agent is working", () => {
    expect(runSelect("precheck-reviewing.json", { agents: "agents-reviewer-working.json" }).selected).toBe(false);
  });

  it("does not relaunch a reviewing PR while its reviewer agent name is still occupied by an idle session", () => {
    expect(runSelect("precheck-reviewing.json", { agents: "agents-reviewer-idle.json" }).selected).toBe(false);
  });

  it("reclaims a reviewing PR when its matching reviewer agent is done", () => {
    expect(runSelect("precheck-reviewing.json", { agents: "agents-reviewer-done.json" }).selected).toBe(true);
  });

  it("keeps skipping blocked PRs regardless of reviewer agents", () => {
    expect(runSelect("precheck-blocked.json", { agents: "agents-empty.json" }).selected).toBe(false);
  });

  it("does not flag an ordinary review PR as a stale reclaim", () => {
    expect(runSelect("precheck-agent-review.json", { agents: "agents-empty.json" }).staleReclaim).toBe(false);
  });
});
