import { describe, expect, it } from "vitest";

import { resolveAutomationFile } from "../src/core";

const CURRENT_FILES = new Set([
  "issue-coordinator-driver.cts",
  "pr-reviewer-driver.cts",
]);

const exists = (name: string) => CURRENT_FILES.has(name);

describe("automation file resolution", () => {
  it("marks an unknown automation file as not found", () => {
    expect(resolveAutomationFile("does-not-exist.cts", exists).found).toBe(false);
  });

  it("keeps the requested current short name unchanged", () => {
    expect(resolveAutomationFile("issue-coordinator-driver.cts", exists).resolved).toBe("issue-coordinator-driver.cts");
  });

  it("marks a current short name as found", () => {
    expect(resolveAutomationFile("pr-reviewer-driver.cts", exists).found).toBe(true);
  });
});
