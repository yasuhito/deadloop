import { describe, expect, it } from "vitest";

import { resolveAutomationFile } from "../src/core";

const CURRENT_FILES = new Set([
  "issue-coordinator.prompt.md",
  "issue-coordinator.precheck.sh",
  "pr-reviewer.prompt.md",
  "pr-reviewer.precheck.sh",
]);

const exists = (name: string) => CURRENT_FILES.has(name);

describe("automation file resolution", () => {
  it("marks an unknown automation file as not found", () => {
    expect(resolveAutomationFile("does-not-exist.prompt.md", exists).found).toBe(false);
  });

  it("keeps the requested current short name unchanged", () => {
    expect(resolveAutomationFile("issue-coordinator.prompt.md", exists).resolved).toBe("issue-coordinator.prompt.md");
  });

  it("marks a current short name as found", () => {
    expect(resolveAutomationFile("pr-reviewer.precheck.sh", exists).found).toBe(true);
  });
});
