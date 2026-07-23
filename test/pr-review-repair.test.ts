import { describe, expect, it } from "vitest";

const {
  renderRepairMarker,
  renderTechnicalFailureMarker,
  reviewResultFingerprint,
  technicalFailureCount,
} = require("../extensions/deadloop/automations/pr-review-repair-state.ts");
const { repairWorkerPrompt } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.ts");

const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const findings = [
  {
    title: "Lint contract failure",
    body: "Format src/a.ts and keep the public contract unchanged",
    path: "src/a.ts",
    line: 4,
    severity: "major",
  },
];

function prompt() {
  return repairWorkerPrompt("243", "agent/issue-243", head, findings, "/state/promise.json", "/worktree", {
    projectId: "demo",
    repoPath: "/repo",
    githubRepo: "owner/repo",
    stateDir: "/state",
    checkCommand: "npm test",
    workerAgent: "pi",
    workerModel: "",
    remote: "origin",
    reviewLabel: "agent:review",
    reviewingLabel: "agent:reviewing",
    blockedLabel: "agent:blocked",
    automationDir: "/automation",
  });
}

describe("automatic PR review repair", () => {
  it("persists the exact head and review fingerprint attempt", () => {
    const fingerprint = reviewResultFingerprint(findings);

    expect(renderRepairMarker(head, fingerprint)).toContain(`head=${head} review=${fingerprint}`);
  });

  it("counts only technical failures for the exact PR head", () => {
    const comments = [{ body: renderTechnicalFailureMarker(head) }];

    expect(technicalFailureCount(comments, "b".repeat(40))).toBe(0);
  });

  it("passes #243-style lint findings as the repair worker's bounded contract", () => {
    expect(prompt()).toContain('"title": "Lint contract failure"');
  });
});
