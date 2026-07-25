import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function exampleAutomationFiles(index: number) {
  const config = JSON.parse(readFileSync("extensions/deadloop/projects.example.json", "utf8"));
  const automation = config.projects[0].automations[index] as { promptFile: string; precheckFile: string };
  return { promptFile: automation.promptFile, precheckFile: automation.precheckFile };
}

describe("automation short names", () => {
  it("uses short issue coordinator files in the example project config", () => {
    expect(exampleAutomationFiles(0)).toEqual({
      promptFile: "issue-coordinator.prompt.md",
      precheckFile: "issue-coordinator.precheck.sh",
    });
  });

  it("uses short PR reviewer files in the example project config", () => {
    expect(exampleAutomationFiles(1)).toEqual({
      promptFile: "pr-reviewer.prompt.md",
      precheckFile: "pr-reviewer.precheck.sh",
    });
  });
});
