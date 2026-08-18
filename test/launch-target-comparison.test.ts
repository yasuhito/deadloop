import { describe, expect, it } from "vitest";

const { assertSameLaunchTarget } = require("../src/launch-revalidation.ts");

const selected = {
  number: 14,
  state: "OPEN",
  headRefName: "agent/issue-1",
  headRefOid: "a".repeat(40),
  isCrossRepository: false,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  labels: [{ name: "agent:review" }, { name: "customer:keep" }],
};

function revalidate(live: Record<string, unknown>): () => void {
  return () => assertSameLaunchTarget(selected, { ...selected, ...live }, "pr");
}

describe("launch target comparison", () => {
  it("accepts an unchanged target", () => {
    expect(revalidate({})).not.toThrow();
  });

  it("stops a launch after the target revision changed", () => {
    expect(revalidate({ headRefOid: "b".repeat(40) })).toThrow("headRefOid changed before launch");
  });

  it("stops a launch after the target became a draft", () => {
    expect(revalidate({ isDraft: true })).toThrow("isDraft changed before launch");
  });

  it("stops a launch after the target stopped being open", () => {
    expect(revalidate({ state: "CLOSED" })).toThrow("state changed before launch");
  });

  it("stops a launch after an unrelated label was added", () => {
    expect(revalidate({ labels: [...selected.labels, { name: "customer:hold" }] })).toThrow("labels changed before launch");
  });

  it("stops a launch after an unrelated label was removed", () => {
    expect(revalidate({ labels: [{ name: "agent:review" }] })).toThrow("labels changed before launch");
  });

  it("stops a launch after the target is no longer the selected pull request", () => {
    expect(() => assertSameLaunchTarget(selected, undefined, "pr")).toThrow("is no longer selected");
  });
});
