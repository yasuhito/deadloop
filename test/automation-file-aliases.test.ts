import { describe, expect, it } from "vitest";

import { resolveAutomationFile } from "../src/core";

const CURRENT_FILES = new Set([
  "issue-coordinator.prompt.md",
  "issue-coordinator.precheck.sh",
  "pr-reviewer.prompt.md",
  "pr-reviewer.precheck.sh",
]);

const exists = (name: string) => CURRENT_FILES.has(name);
const legacyName = (currentName: string) => `${["generic", ""].join("-")}${currentName}`;

describe("automation file aliases", () => {
  it("resolves a legacy prompt file to its current short name", () => {
    expect(resolveAutomationFile(legacyName("issue-coordinator.prompt.md"), exists).resolved).toBe(
      "issue-coordinator.prompt.md",
    );
  });

  it("resolves a legacy precheck file to its current short name", () => {
    expect(resolveAutomationFile(legacyName("pr-reviewer.precheck.sh"), exists).resolved).toBe(
      "pr-reviewer.precheck.sh",
    );
  });

  it("reports that a legacy file was resolved through an alias", () => {
    expect(resolveAutomationFile(legacyName("issue-coordinator.prompt.md"), exists).aliased).toBe(true);
  });

  it("marks an unknown automation file as not found", () => {
    expect(resolveAutomationFile("does-not-exist.prompt.md", exists).found).toBe(false);
  });

  it("passes a current short name through without aliasing", () => {
    expect(resolveAutomationFile("issue-coordinator.prompt.md", exists).aliased).toBe(false);
  });

  it("marks a current short name as found", () => {
    expect(resolveAutomationFile("pr-reviewer.precheck.sh", exists).found).toBe(true);
  });
});
