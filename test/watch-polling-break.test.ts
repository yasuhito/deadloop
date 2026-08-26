import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const automationDir = path.join(process.cwd(), "extensions/deadloop/automations");

function promptTemplate(promptFile: string): string {
  return fs.readFileSync(path.join(automationDir, promptFile), "utf8");
}

describe("watch polling break instruction", () => {
  it("keeps the issue coordinator free of promise polling instructions", () => {
    const coordinatorPrompt = promptTemplate("issue-coordinator.prompt.md");

    expect(coordinatorPrompt).not.toMatch(/break polling/i);
  });

  it("tells pr-reviewer watch to break polling once the promise settles", () => {
    expect(promptTemplate("pr-reviewer.prompt.md")).toMatch(/Break polling immediately/);
  });

  it("shows pr-reviewer watch a break-early loop example", () => {
    expect(promptTemplate("pr-reviewer.prompt.md")).toMatch(/complete.*blocked/);
  });
});
