import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

type IssueSelectionDecision = {
  selected: boolean;
  number?: number;
};

type IssueSelectionWorld = {
  fixtureName?: string;
  decision?: IssueSelectionDecision;
  precheckMode?: "closed-issue";
  precheckStatus?: number | null;
};

const decisionScript = "extensions/deadloop/automations/issue-coordinator-decisions.ts";

function selectIssue(fixtureName: string): IssueSelectionDecision {
  const result = spawnSync(
    "node",
    [decisionScript, "--fixture", path.join("test/fixtures/issue-coordinator", fixtureName), "--json"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function writeExecutable(filePath: string, lines: string[]): void {
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  chmodSync(filePath, 0o755);
}

function runClosedIssuePrecheck(): number | null {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "deadloop-closed-issue-"));
  try {
    const repoPath = path.join(tempRoot, "repo");
    mkdirSync(repoPath);
    writeExecutable(path.join(tempRoot, "gh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "list" ]; then printf \'%s\\n\' \'[]\'; exit 0; fi',
      'if [ "${1:-}" = "issue" ] && [ "${2:-}" = "list" ]; then',
      '  if [[ " $* " = *" --state all "* ]]; then',
      `    printf '%s\\n' '[{"number":117,"title":"Closed ready issue","body":"","labels":[{"name":"ready-for-agent"},{"name":"agent:implement"}],"updatedAt":"2026-07-24T00:00:00Z"}]'`,
      "  else",
      "    printf '%s\\n' '[]'",
      "  fi",
      "  exit 0",
      "fi",
      'echo "unexpected gh invocation: $*" >&2',
      "exit 2",
    ]);
    writeExecutable(path.join(tempRoot, "herdr"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" = "worktree" ] && [ "${2:-}" = "list" ]; then',
      "  printf '%s\\n' '{\"result\":{\"worktrees\":[]}}'",
      "  exit 0",
      "fi",
      'echo "unexpected herdr invocation: $*" >&2',
      "exit 2",
    ]);

    return spawnSync("bash", ["extensions/deadloop/automations/issue-coordinator.precheck.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH || ""}`,
        DEADLOOP_REPO_PATH: repoPath,
        DEADLOOP_GITHUB_REPO: "owner/repo",
      },
    }).status;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

Given("An eligible Issue has the `agent:implement` request without `ready-for-agent`", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-ready-implement.json";
});

Given("An Issue with all required public labels is closed", function (this: IssueSelectionWorld) {
  this.precheckMode = "closed-issue";
});

Given("An Issue lacks the required implementation request", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-missing-required-label.json";
});

Given("An Issue in progress has the `agent:in-progress` label", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-in-progress.json";
});

Given("A blocked Issue has the `agent:blocked` label", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-blocked.json";
});

Given("An Issue with all required public labels has an unfinished dependency in the {string}", function (this: IssueSelectionWorld, location: string) {
  const fixtures: Record<string, string> = {
    "dependency section": "selection-open-body-dependency.json",
    "end": "selection-open-final-section-dependency.json",
  };
  const fixtureName = fixtures[location];
  if (!fixtureName) throw new Error(`unknown dependency location: ${location}`);
  this.fixtureName = fixtureName;
});

Given("An eligible Issue has a completed dependency in its body", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-closed-body-dependency.json";
});

Given("An Issue with all required public labels has an unfinished dependency on GitHub", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-open-relationship-dependency.json";
});

When("deadloop searches for a work target", function (this: IssueSelectionWorld) {
  if (this.precheckMode !== "closed-issue") throw new Error("precheck precondition is missing");
  this.precheckStatus = runClosedIssuePrecheck();
});

When("deadloop selects a work target", function (this: IssueSelectionWorld) {
  if (!this.fixtureName) throw new Error("issue precondition is missing");
  this.decision = selectIssue(this.fixtureName);
});

Then("Issue #{int} is selected for work", function (this: IssueSelectionWorld, issueNumber: number) {
  assert.equal(this.decision?.number, issueNumber);
});

Then("The closed Issue is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.precheckStatus, 1);
});

Then("The unprepared Issue is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("The Issue in progress is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("The blocked Issue is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("The Issue with an unfinished dependency is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("The Issue with an unfinished GitHub dependency is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});
