import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { herdr075DoctorFinding } from "../src/doctor";
import { compatibilityDiagnosticData } from "../src/herdr-075-compat";

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
    expect(herdr075DoctorFinding("incompatible", compatibilityDiagnosticData({
      clientVersion: "0.7.3",
      serverVersion: "0.7.4",
    }))).toEqual({
      id: "herdr-075-incompatible",
      type: "herdr_incompatible",
      title: "unsupported or protocol-incompatible Herdr",
      summary: "Detected Herdr client 0.7.3 and server 0.7.4; minimum required version is 0.7.5. Quiet active deadloop automations, then run `herdr update --handoff`.",
      commands: ["herdr update --handoff"],
    });
  });
});
