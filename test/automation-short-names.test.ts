import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type ExampleAutomation = { driverFile: string };

function exampleAutomations(): ExampleAutomation[] {
  const config = JSON.parse(readFileSync("extensions/deadloop/projects.example.json", "utf8"));
  return config.projects[0].automations as ExampleAutomation[];
}

describe("automation short names", () => {
  it("uses the short issue coordinator driver file in the example project config", () => {
    expect(exampleAutomations()[0].driverFile).toBe("issue-coordinator-driver.cts");
  });

  it("uses the short PR reviewer driver file in the example project config", () => {
    expect(exampleAutomations()[1].driverFile).toBe("pr-reviewer-driver.cts");
  });

  it("resolves every example automation file to a shipped automation file", () => {
    const missing = exampleAutomations()
      .map((automation) => automation.driverFile)
      .filter((file) => !existsSync(join("extensions/deadloop/automations", file)));
    expect(missing).toEqual([]);
  });
});
