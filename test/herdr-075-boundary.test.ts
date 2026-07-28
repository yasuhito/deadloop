import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { herdr075DoctorFinding } from "../src/doctor";

const selectedEntrypoints = [
  "extensions/deadloop/index.ts",
  "src/agent-launch-flow.ts",
  "src/automation-driver-kit.ts",
  "src/automation-runner.ts",
  "extensions/deadloop/automations/issue-coordinator-driver.ts",
  "extensions/deadloop/automations/pr-reviewer-driver.ts",
  "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
  "extensions/deadloop/automations/launch-agent.ts",
  "extensions/deadloop/automations/cleanup-completed-worker-worktrees.ts",
];

describe("Herdr 0.7.5 dormant boundary", () => {
  it("keeps the new runner out of selected automation paths", () => {
    expect(selectedEntrypoints.map((file) => readFileSync(file, "utf8")).join("\n")).not.toMatch(
      /herdr-075-runner|herdr-075-compat|herdr-agent-name/,
    );
  });

  it("provides non-destructive incompatible-Herdr doctor finding data", () => {
    expect(herdr075DoctorFinding("incompatible", "client 0.7.3")).toEqual({
      id: "herdr-075-incompatible",
      type: "herdr_incompatible",
      title: "unsupported or protocol-incompatible Herdr",
      summary: "client 0.7.3",
      commands: ["herdr update --handoff"],
    });
  });
});
