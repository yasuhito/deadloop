import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type ExampleAutomation = { promptFile: string; precheckFile: string; driverFile: string };

function exampleAutomations(): ExampleAutomation[] {
  const config = JSON.parse(readFileSync("extensions/deadloop/projects.example.json", "utf8"));
  return config.projects[0].automations as ExampleAutomation[];
}

function exampleAutomationFiles(index: number) {
  const automation = exampleAutomations()[index];
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

  it("resolves every example automation file to a shipped automation file", () => {
    const missing = exampleAutomations()
      .flatMap((automation) => [automation.promptFile, automation.precheckFile, automation.driverFile])
      .filter((file) => !existsSync(join("extensions/deadloop/automations", file)));
    expect(missing).toEqual([]);
  });
});
