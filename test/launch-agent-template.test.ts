import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const automationDir = path.join(process.cwd(), "extensions/pi-looper/automations");

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(automationDir, name), "utf8");
}

// A raw agent-launch branch is a `herdr agent start ... -- pi`/`-- claude`
// command that names the agent binary directly, which the launcher replaced.
const rawLaunchBranch = /agent start[^\n]*--\s+(pi|claude)\b/;

describe("agent launch template migration", () => {
  it("launches workers through launch-agent in the issue coordinator", () => {
    expect(readTemplate("issue-coordinator.prompt.md")).toMatch(/launch-agent\.ts/);
  });

  it("launches the review agent through launch-agent in the pr reviewer", () => {
    expect(readTemplate("pr-reviewer.prompt.md")).toMatch(/launch-agent\.ts/);
  });

  it("keeps no raw agent-start launch branch in the issue coordinator", () => {
    expect(readTemplate("issue-coordinator.prompt.md")).not.toMatch(rawLaunchBranch);
  });

  it("keeps no raw agent-start launch branch in the pr reviewer", () => {
    expect(readTemplate("pr-reviewer.prompt.md")).not.toMatch(rawLaunchBranch);
  });

  it("keeps the claude submit-reminder prose in the issue coordinator", () => {
    expect(readTemplate("issue-coordinator.prompt.md")).toMatch(/herdr agent send/);
  });
});
