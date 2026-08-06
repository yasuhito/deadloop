import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const decisionScript = "extensions/deadloop/automations/pr-reviewer-decisions.ts";

function runDecision(args: string[]) {
  return spawnSync("node", [decisionScript, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

function runExternalReviewGate(fixtureName: string, now = "2026-07-04T00:30:00Z"): string {
  const result = spawnSync(
    "node",
    [
      decisionScript,
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
  options: { autoMerge?: boolean; externalReview?: boolean; now?: string; projectId?: string; agentsFixture?: string } = {},
): number | null {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "deadloop-precheck-"));
  try {
    const fakeGhPath = path.join(tempRoot, "gh");
    writeFileSync(
      fakeGhPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "if [ \"${1:-}\" = \"pr\" ] && [ \"${2:-}\" = \"list\" ]; then",
        "  cat \"${DEADLOOP_TEST_FIXTURE:?}\"",
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
        "  cat \"${DEADLOOP_TEST_HERDR_FIXTURE:?}\"",
        "  exit 0",
        "fi",
        "echo \"unexpected herdr invocation: $*\" >&2",
        "exit 2",
        "",
      ].join("\n"),
    );
    chmodSync(fakeHerdrPath, 0o755);

    const result = spawnSync("bash", ["extensions/deadloop/automations/pr-reviewer.precheck.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH || ""}`,
        DEADLOOP_REPO_PATH: process.cwd(),
        DEADLOOP_STATE_DIR: path.join(tempRoot, "state"),
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_PROJECT_ID: options.projectId || "demo",
        DEADLOOP_AUTO_MERGE: options.autoMerge ? "1" : "0",
        DEADLOOP_REVIEW_LABEL: "agent:review",
        DEADLOOP_REVIEWING_LABEL: "agent:reviewing",
        DEADLOOP_HUMAN_LABEL: "ready-for-human",
        DEADLOOP_BLOCKED_LABEL: "agent:blocked",
        DEADLOOP_EXTERNAL_REVIEW_ENABLED: options.externalReview ? "1" : "0",
        DEADLOOP_EXTERNAL_REVIEW_WAIT_SECONDS: "1800",
        DEADLOOP_NOW: options.now || "2026-07-04T00:30:00Z",
        DEADLOOP_TEST_FIXTURE: path.join(process.cwd(), "test/fixtures/pr-reviewer", fixtureName),
        DEADLOOP_TEST_HERDR_FIXTURE: path.join(
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

  it("selects PRs with fresh external review markers when external review is disabled", () => {
    expect(runPrecheck("precheck-fresh-copilot-request.json")).toBe(0);
  });

  it("skips PRs while a Copilot review request is fresh when external review is enabled", () => {
    expect(runPrecheck("precheck-fresh-copilot-request.json", { externalReview: true })).toBe(1);
  });

  it("skips PRs while CodeRabbit is processing when external review is enabled", () => {
    expect(runPrecheck("precheck-coderabbit-processing.json", { externalReview: true })).toBe(1);
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

  it("rejects invalid decision modes", () => {
    expect(runDecision(["--mode", "typo", "--input", path.join(process.cwd(), "test/fixtures/pr-reviewer/precheck-agent-review.json")]).status).toBe(2);
  });

  it("rejects invalid external review wait seconds", () => {
    expect(
      runDecision([
        "--mode",
        "external-review-gate",
        "--input",
        path.join(process.cwd(), "test/fixtures/pr-reviewer/precheck-agent-review.json"),
        "--external-review-wait-seconds",
        "NaN",
      ]).status,
    ).toBe(2);
  });

  it("rejects non-ISO now timestamps", () => {
    expect(
      runDecision([
        "--mode",
        "external-review-gate",
        "--input",
        path.join(process.cwd(), "test/fixtures/pr-reviewer/precheck-agent-review.json"),
        "--now",
        "123",
      ]).status,
    ).toBe(2);
  });

  it("reclaims a stale reviewing PR when no reviewer agent is running", () => {
    expect(runPrecheck("precheck-reviewing.json", { agentsFixture: "agents-empty.json" })).toBe(0);
  });

  it("does not treat an unjournaled legacy reviewer name as live ownership", () => {
    expect(runPrecheck("precheck-reviewing.json", { agentsFixture: "agents-reviewer-working.json" })).toBe(0);
  });

  it("skips PRs with the blocked label", () => {
    expect(runPrecheck("precheck-blocked.json")).toBe(1);
  });
});
