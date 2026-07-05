import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function runExternalReviewGate(fixtureName: string, now = "2026-07-04T00:30:00Z"): string {
  const result = spawnSync(
    "python3",
    [
      "extensions/pi-looper/automations/pr-reviewer-decisions.py",
      "--mode",
      "external-review-gate",
      "--input",
      path.join(process.cwd(), "test/fixtures/pr-reviewer", fixtureName),
      "--external-review-wait-seconds",
      "1800",
      "--now",
      now,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout).action;
}

function runPrecheck(
  fixtureName: string,
  options: { autoMerge?: boolean; now?: string; projectId?: string; agentsFixture?: string } = {},
): number | null {
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

    const fakeHerdrPath = path.join(tempRoot, "herdr");
    writeFileSync(
      fakeHerdrPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "if [ \"${1:-}\" = \"agent\" ] && [ \"${2:-}\" = \"list\" ]; then",
        "  cat \"${PI_LOOPER_TEST_HERDR_FIXTURE:?}\"",
        "  exit 0",
        "fi",
        "echo \"unexpected herdr invocation: $*\" >&2",
        "exit 2",
        "",
      ].join("\n"),
    );
    chmodSync(fakeHerdrPath, 0o755);

    const result = spawnSync("bash", ["extensions/pi-looper/automations/pr-reviewer.precheck.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH || ""}`,
        PI_LOOPER_REPO_PATH: process.cwd(),
        PI_LOOPER_GITHUB_REPO: "owner/repo",
        PI_LOOPER_PROJECT_ID: options.projectId || "demo",
        PI_LOOPER_AUTO_MERGE: options.autoMerge ? "1" : "0",
        PI_LOOPER_REVIEW_LABEL: "agent:review",
        PI_LOOPER_REVIEWING_LABEL: "agent:reviewing",
        PI_LOOPER_HUMAN_LABEL: "ready-for-human",
        PI_LOOPER_BLOCKED_LABEL: "agent:blocked",
        PI_LOOPER_EXTERNAL_REVIEW_WAIT_SECONDS: "1800",
        PI_LOOPER_NOW: options.now || "2026-07-04T00:30:00Z",
        PI_LOOPER_TEST_FIXTURE: path.join(process.cwd(), "test/fixtures/pr-reviewer", fixtureName),
        PI_LOOPER_TEST_HERDR_FIXTURE: path.join(
          process.cwd(),
          "test/fixtures/pr-reviewer",
          options.agentsFixture || "agents-empty.json",
        ),
      },
      encoding: "utf8",
    });

    return result.status;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("PR reviewer precheck", () => {
  it("selects a PR labeled agent:review", () => {
    expect(runPrecheck("precheck-agent-review.json")).toBe(0);
  });

  it("skips ready-for-human-only PRs when auto merge is disabled", () => {
    expect(runPrecheck("precheck-ready-for-human.json", { autoMerge: false })).toBe(1);
  });

  it("selects ready-for-human-only PRs when auto merge is enabled", () => {
    expect(runPrecheck("precheck-ready-for-human.json", { autoMerge: true })).toBe(0);
  });

  it("skips PRs while checks are pending", () => {
    expect(runPrecheck("precheck-pending-checks.json")).toBe(1);
  });

  it("selects PRs after the external-review marker is stale", () => {
    expect(runPrecheck("precheck-stale-external-marker.json")).toBe(0);
  });

  it("skips PRs while a Copilot review request is fresh", () => {
    expect(runPrecheck("precheck-fresh-copilot-request.json")).toBe(1);
  });

  it("skips PRs while CodeRabbit is processing", () => {
    expect(runPrecheck("precheck-coderabbit-processing.json")).toBe(1);
  });

  it("starts the automation for draft PRs so the draft gate can block them", () => {
    expect(runPrecheck("precheck-draft.json")).toBe(0);
  });

  it("requests external review when the marker is missing", () => {
    expect(runExternalReviewGate("precheck-agent-review.json")).toBe("request_external_review");
  });

  it("waits for external review while the marker is fresh", () => {
    expect(runExternalReviewGate("precheck-fresh-copilot-request.json")).toBe("wait_external_review");
  });

  it("falls back after the external-review marker is stale", () => {
    expect(runExternalReviewGate("precheck-stale-external-marker.json")).toBe("fallback_review");
  });

  it("reclaims a stale reviewing PR when no reviewer agent is running", () => {
    expect(runPrecheck("precheck-reviewing.json", { agentsFixture: "agents-empty.json" })).toBe(0);
  });

  it("skips a reviewing PR while its reviewer agent is working", () => {
    expect(runPrecheck("precheck-reviewing.json", { agentsFixture: "agents-reviewer-working.json" })).toBe(1);
  });

  it("skips PRs with the blocked label", () => {
    expect(runPrecheck("precheck-blocked.json")).toBe(1);
  });
});
