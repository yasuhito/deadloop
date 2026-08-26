import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { persistedRepairContract } = require("../extensions/deadloop/automations/pr-reviewer-driver.cts");
const { inspectRepairWorktree } = require("../extensions/deadloop/automations/pr-review-repair-launch.cts");
const { renderRepairMarker, reviewResultFingerprint } = require("../extensions/deadloop/automations/pr-review-repair-state.cts");

const fixtureDir = path.join(process.cwd(), "test/fixtures/pr-reviewer-driver");

type DriverRun = {
  driverAction?: string;
  comment?: string;
  monitorHandoff?: { kind?: string; input?: Record<string, unknown> };
  testAdapterEffects?: {
    herdrStarts?: Array<Record<string, unknown>>;
    labels?: Record<string, string[]>;
  };
};

function runDriverFixture(fixture: string): DriverRun {
  const stateDir = mkdtempSync(path.join(tmpdir(), "deadloop-repair-driver-state-"));
  try {
    const result = spawnSync(
      "node",
      ["extensions/deadloop/automations/pr-reviewer-driver.cts", "--fixture", path.join(fixtureDir, fixture)],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DEADLOOP_PROJECT_ID: "demo",
          DEADLOOP_STATE_DIR: stateDir,
          DEADLOOP_REPO_PATH: "/repo",
          DEADLOOP_GITHUB_REPO: "owner/repo",
          DEADLOOP_REVIEWER_AGENT: "pi",
          DEADLOOP_REVIEWER_MODEL: "",
          DEADLOOP_AUTO_MERGE: "0",
          DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS: "deadloop-bot",
          DEADLOOP_NOW: "2026-07-08T00:00:00Z",
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout) as DriverRun;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function stubGitRunner(output: { worktrees?: string; head?: string; status?: string }) {
  return (args: string[]) => {
    if (args.includes("worktree")) return output.worktrees || "";
    if (args.includes("rev-parse")) return output.head ? `${output.head}\n` : "";
    if (args.includes("status")) return output.status || "";
    return "";
  };
}

afterEach(() => {
  // no shared state
});

describe("driver-served review repair", () => {
  it("claims the implement request before launching exactly one repair worker", () => {
    const run = runDriverFixture("review-repair-request.json");

    expect({
      action: run.driverAction,
      launches: run.testAdapterEffects?.herdrStarts?.length,
      finalLabels: run.testAdapterEffects?.labels?.["31"],
    }).toEqual({
      action: "review_repair_monitor_request",
      launches: 1,
      finalLabels: ["agent:in-progress"],
    });
  });

  it("launches no agent for a repair request whose findings are not recorded on this head", () => {
    const run = runDriverFixture("obsolete-review-repair.json");

    expect({
      launches: run.testAdapterEffects?.herdrStarts?.length ?? 0,
      explainsItself: String(run.comment || "").includes("no required findings"),
      finalLabels: run.testAdapterEffects?.labels?.["31"],
    }).toEqual({
      launches: 0,
      explainsItself: true,
      finalLabels: ["agent:review"],
    });
  });

  it("consumes a repair request whose one repair already completed without relaunching", () => {
    const run = runDriverFixture("completed-review-repair.json");

    expect({
      launches: run.testAdapterEffects?.herdrStarts?.length ?? 0,
      explainsItself: String(run.comment || "").includes("already completed its one automatic repair"),
      finalLabels: run.testAdapterEffects?.labels?.["31"],
    }).toEqual({
      launches: 0,
      explainsItself: true,
      finalLabels: ["agent:review"],
    });
  });

  it("extracts the persisted contract from the latest matching review-result marker", () => {
    const head = "a".repeat(40);
    const findings = [{ title: "Only finding", body: "Fix it" }];
    const marker = renderRepairMarker(head, reviewResultFingerprint(findings), { findings });
    const contract = persistedRepairContract([{ author: { login: "bot" }, body: `x ${marker} y` }], head, "bot");

    expect(contract).toEqual({
      key: expect.any(String),
      findings,
      reviewFingerprint: reviewResultFingerprint(findings),
    });
  });

  it("holds no contract for a head whose markers carry no findings payload", () => {
    const head = "a".repeat(40);
    const marker = renderRepairMarker(head, "f".repeat(20));

    expect(persistedRepairContract([{ author: { login: "bot" }, body: marker }], head, "bot")).toBeNull();
  });

  it("ignores contract markers left by untrusted authors", () => {
    const head = "a".repeat(40);
    const findings = [{ title: "Only finding", body: "Fix it" }];
    const marker = renderRepairMarker(head, reviewResultFingerprint(findings), { findings });

    expect(persistedRepairContract([{ author: { login: "stranger" }, body: marker }], head, "bot")).toBeNull();
  });

  it("reads the latest contract when several reviews of one head exist", () => {
    const head = "a".repeat(40);
    const first = [{ title: "Old finding", body: "Old" }];
    const second = [{ title: "New finding", body: "New" }];
    const comments = [
      { author: { login: "bot" }, body: renderRepairMarker(head, reviewResultFingerprint(first), { findings: first }) },
      { author: { login: "bot" }, body: renderRepairMarker(head, reviewResultFingerprint(second), { findings: second }) },
    ];

    expect(persistedRepairContract(comments, head, "bot")?.findings).toEqual(second);
  });

  it("treats an agent scratch area as a clean repair worktree", () => {
    const inspection = inspectRepairWorktree("/repo", "feature", stubGitRunner({
      worktrees: "worktree /wt\0HEAD abc\0branch refs/heads/feature\0\0",
      head: "abc123",
      status: "?? .pi/subagents/artifacts/note.md\n",
    }));

    expect(inspection).toEqual({ kind: "present", head: "abc123", clean: true });
  });

  it("flags a dirty repair worktree before launch", () => {
    const inspection = inspectRepairWorktree("/repo", "feature", stubGitRunner({
      worktrees: "worktree /wt\0HEAD abc\0branch refs/heads/feature\0\0",
      head: "abc123",
      status: "?? scratch.c\n",
    }));

    expect(inspection).toEqual({ kind: "present", head: "abc123", clean: false });
  });

  it("flags an ambiguous repair worktree before launch", () => {
    const worktrees = "worktree /wt1\0HEAD abc\0branch refs/heads/feature\0\0worktree /wt2\0HEAD abc\0branch refs/heads/feature\0\0";
    const inspection = inspectRepairWorktree("/repo", "feature", stubGitRunner({ worktrees }));

    expect(inspection.kind).toBe("ambiguous");
  });

  it("reports no owned worktree as absent so launch can create it", () => {
    const inspection = inspectRepairWorktree("/repo", "feature", stubGitRunner({ worktrees: "" }));

    expect(inspection.kind).toBe("absent");
  });

  it("hands the launched worker to the shared repair monitor", () => {
    const run = runDriverFixture("review-repair-request.json");

    expect(run.monitorHandoff?.kind).toBe("repair");
  });
});
