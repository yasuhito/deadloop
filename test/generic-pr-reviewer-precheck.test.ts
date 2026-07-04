import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function runPrecheckWithReadyForHumanPr(autoMerge: boolean): number | null {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-looper-precheck-"));
  try {
    const fakeGhPath = path.join(tempRoot, "gh");
    writeFileSync(
      fakeGhPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "if [ \"${1:-}\" = \"pr\" ] && [ \"${2:-}\" = \"list\" ]; then",
        "  cat \"${PI_LOOPER_TEST_FIXTURE:?}\"",
        "  exit 0",
        "fi",
        "echo \"unexpected gh invocation: $*\" >&2",
        "exit 2",
        "",
      ].join("\n"),
    );
    chmodSync(fakeGhPath, 0o755);

    const result = spawnSync("bash", ["extensions/pi-looper/automations/generic-pr-reviewer.precheck.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH || ""}`,
        PI_LOOPER_REPO_PATH: process.cwd(),
        PI_LOOPER_GITHUB_REPO: "owner/repo",
        PI_LOOPER_AUTO_MERGE: autoMerge ? "1" : "0",
        PI_LOOPER_REVIEW_LABEL: "agent:review",
        PI_LOOPER_REVIEWING_LABEL: "agent:reviewing",
        PI_LOOPER_HUMAN_LABEL: "ready-for-human",
        PI_LOOPER_BLOCKED_LABEL: "agent:blocked",
        PI_LOOPER_TEST_FIXTURE: path.join(
          process.cwd(),
          "test/fixtures/generic-pr-reviewer/precheck-ready-for-human.json",
        ),
      },
      encoding: "utf8",
    });

    return result.status;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("generic PR reviewer precheck", () => {
  it("skips ready-for-human-only PRs when auto merge is disabled", () => {
    expect(runPrecheckWithReadyForHumanPr(false)).toBe(1);
  });

  it("selects ready-for-human-only PRs when auto merge is enabled", () => {
    expect(runPrecheckWithReadyForHumanPr(true)).toBe(0);
  });
});
