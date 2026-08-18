import { describe, expect, it } from "vitest";

const { decideRepairPushGuard, parseArgs: parseFinalizerArgs } = require("../extensions/deadloop/automations/pr-review-repair-finalize.ts");
const { recoveryComment, sameFindingTitles } = require("../extensions/deadloop/automations/pr-review-repair-complete.ts");
const { requireManagedPr } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.ts");

const head = "a".repeat(40);

describe("automatic review repair", () => {
  it("permits a same-repository open PR at the exact head", () => {
    expect(decideRepairPushGuard({ state: "OPEN", headRefName: "feature", headRefOid: head }, "feature", head).action).toBe("push");
  });

  it("reports a changed head as stale", () => {
    expect(decideRepairPushGuard({ state: "OPEN", headRefName: "feature", headRefOid: "b".repeat(40) }, "feature", head).action).toBe("stale_head");
  });

  it("rejects a cross-repository repair target", () => {
    expect(decideRepairPushGuard({ state: "OPEN", isCrossRepository: true, headRefName: "feature", headRefOid: head }, "feature", head).action).toBe("blocked");
  });

  it("requires the active in-progress workflow state", () => {
    expect(() => requireManagedPr({ labels: [] }, { inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked" })).toThrow("in-progress");
  });

  it("rejects repair mutation while blocked", () => {
    expect(() => requireManagedPr({ labels: [{ name: "agent:in-progress" }, { name: "agent:blocked" }] }, { inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked" })).toThrow("in-progress");
  });

  it("requires configured workflow labels in finalizer arguments", () => {
    expect(() => parseFinalizerArgs([])).toThrow("--repo is required");
  });

  it("keeps repair recovery comments readable", () => {
    expect(recoveryComment({ expectedHead: head, reviewLabel: "agent:review", blockedLabel: "agent:blocked", attemptKey: "attempt" }, "check_failed", "Tests failed")).toContain("Automatic review repair stopped");
  });

  it("matches one repair result per required finding", () => {
    expect(sameFindingTitles([{ title: "A" }], ["A"])).toBe(true);
  });
});
