import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const selectedFiles = [
  "src/agent-launch-flow.ts",
  "src/herdr-runner.ts",
  "extensions/deadloop/automations/launch-agent.ts",
  "extensions/deadloop/automations/issue-coordinator-driver.ts",
  "extensions/deadloop/automations/pr-reviewer-driver.ts",
  "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
];

describe("廃止した Herdr 0.7.3 起動経路", () => {
  it("選択済み経路にタブ指定起動や追加タブ作成を残さない", () => {
    const source = selectedFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/createTab|closeTab|removeAgent|"--tab"|\btab create\b|pane split/);
  });
});
