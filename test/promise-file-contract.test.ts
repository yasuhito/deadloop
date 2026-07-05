import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const contractFiles = [
  "extensions/pi-looper/automations/generic-issue-coordinator.prompt.md",
  "extensions/pi-looper/automations/generic-pr-reviewer.prompt.md",
  "extensions/pi-looper/automations/extract-worker-promise.py",
];

function combinedContractText() {
  return contractFiles.map((file) => readFileSync(file, "utf8")).join("\n---FILE---\n");
}

describe("promise file contract", () => {
  it("removes the legacy promise text tag", () => {
    expect(combinedContractText()).not.toContain("<promise>");
  });

  it("removes JSONL session extraction", () => {
    expect(combinedContractText()).not.toContain("JSONL");
  });

  it("removes pane-id based helper input", () => {
    expect(combinedContractText()).not.toContain("--pane-id");
  });

  it("documents unique promise file allocation", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).toContain(
      "<worktreePath>/.pi-looper/promise-<uuid>.json",
    );
  });

  it("requires blocked workers to write a promise file", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).toContain(
      '"status":"blocked"',
    );
  });

  it("uses the promise file as the completion authority", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).toContain(
      "唯一の完了判定の権威",
    );
  });
});
