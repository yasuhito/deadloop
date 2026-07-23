import { describe, expect, it } from "vitest";

const { decidePushGuard } = require("../extensions/deadloop/automations/pr-branch-update-finalize.ts");
const {
  branchUpdateAttemptExists,
  branchUpdateRetryKey,
  renderBranchUpdateMarker,
} = require("../extensions/deadloop/automations/pr-branch-update-state.ts");

const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("PR branch-update safety", () => {
  it("derives the same retry key for the same exact pair", () => {
    expect(branchUpdateRetryKey(head, base)).toBe("63bdfe090637cf9ff5d4");
  });

  it("recognizes a persisted exact-pair attempt marker", () => {
    expect(branchUpdateAttemptExists([{ body: renderBranchUpdateMarker(head, base) }], head, base)).toBe(true);
  });

  it("allows a new attempt when the base head changes", () => {
    expect(branchUpdateAttemptExists([{ body: renderBranchUpdateMarker(head, base) }], head, "cccccccccccccccccccccccccccccccccccccccc")).toBe(false);
  });

  it("treats a cross-repository target as unsafe", () => {
    expect(
      decidePushGuard(
        { state: "OPEN", isCrossRepository: true, headRefName: "agent/issue-31", headRefOid: head },
        "agent/issue-31",
        head,
      ).action,
    ).toBe("blocked");
  });

});
