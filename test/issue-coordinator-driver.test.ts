import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const driverScript = "extensions/deadloop/automations/issue-coordinator-driver.cts";
const { acquireLockSync, releaseOwned } = require("../src/enablement-lock.cjs");
const { renderUnresolvedDependencyComment, unresolvedDependencyCommentPresent, unresolvedDependencyEntryFingerprint } = require("../extensions/deadloop/automations/issue-coordinator-driver.cts");
import {
  abandonPersistedAttempt,
  attemptRecordPath,
  createPreparedAttempt,
  readAttemptRecord,
  recordPersistedCompletionReport,
  transitionPersistedAttempt,
  writeAttemptRecordAtomically,
  type PreparedAttemptInput,
} from "../src/attempt-lifecycle";
import type { JsonObject } from "../src/automation-driver-kit-types";

// The dispatch lock writes under the state directory, so a fixture run needs one of its own rather
// than the operator's live deadloop state.
const fixtureStateDirs: string[] = [];

afterEach(() => {
  for (const stateDir of fixtureStateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

function fixtureStateDir(): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "deadloop-coordinator-state-"));
  fixtureStateDirs.push(stateDir);
  return stateDir;
}

function runDriverFixture(fixtureName: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [driverScript, "--fixture", path.join("test/fixtures/issue-coordinator", fixtureName)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEADLOOP_PROJECT_ID: "demo",
      DEADLOOP_REPO_PATH: "/repo path",
      DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_CHECK_COMMAND: "npm test",
      DEADLOOP_WORKER_AGENT: "pi",
      DEADLOOP_STATE_DIR: fixtureStateDir(),
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

describe("issue coordinator deterministic driver", () => {
  it("skips candidate-free runs", () => {
    expect(runDriverFixture("driver-no-candidate.json").action).toBe("skip");
  });

  it("reports an Issue skipped for unresolvable dependency references", () => {
    expect(runDriverFixture("driver-unresolved-dependency.json").summary).toContain(
      "#208 skipped for unresolvable dependency references (#999)",
    );
  });

  it("fingerprints an unchanged unresolved reference set identically regardless of order", () => {
    const entry = (numbers: number[]) => ({ dependencies: numbers.map((number) => ({ number, state: "UNKNOWN" })) });

    expect(unresolvedDependencyEntryFingerprint(entry([999, 404]))).toBe(unresolvedDependencyEntryFingerprint(entry([404, 999])));
  });

  it("changes the fingerprint when the unresolved reference set changes", () => {
    const entry = (numbers: number[]) => ({ dependencies: numbers.map((number) => ({ number, state: "UNKNOWN" })) });

    expect(unresolvedDependencyEntryFingerprint(entry([404]))).not.toBe(unresolvedDependencyEntryFingerprint(entry([999])));
  });

  it("renders the dedupe marker into the unresolved-dependency comment", () => {
    const comment = renderUnresolvedDependencyComment("owner/repo", { dependencies: [{ number: 999, state: "UNKNOWN" }] }, "abc123");

    expect(comment).toContain("<!-- deadloop:unresolved-dependency:v1 fingerprint=abc123 -->");
  });

  it("detects an existing comment that carries the same fingerprint", () => {
    const issue = { comments: [{ body: "note\n<!-- deadloop:unresolved-dependency:v1 fingerprint=abc123 -->" }] };

    expect(unresolvedDependencyCommentPresent(issue, "abc123")).toBe(true);
  });

  it("treats a different fingerprint as not yet reported", () => {
    const issue = { comments: [{ body: "<!-- deadloop:unresolved-dependency:v1 fingerprint=abc123 -->" }] };

    expect(unresolvedDependencyCommentPresent(issue, "def456")).toBe(false);
  });

  it("completes cleanup-only runs deterministically", () => {
    expect(runDriverFixture("driver-cleanup-candidate.json").driverAction).toBe("cleanup_applied");
  });

  it.each([
    ["starts cleanup before disable", (result: { cleanupStarted: boolean }) => result.cleanupStarted, true],
    ["completes disable while cleanup is blocked", (result: { disableCompleted: boolean }) => result.disableCompleted, true],
    ["preserves the worker artifact", (result: { artifactExists: boolean }) => result.artifactExists, true],
    ["does not remove the workspace", (result: { workspaceRemoved: boolean }) => result.workspaceRemoved, false],
  ])("%s", async (_name, observation, expected) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-cleanup-disable-"));
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    const artifact = path.join(worktree, ".pi", "subagents", "run.json");
    const stateDir = path.join(root, ".pi", "agent", "deadloop");
    const binDir = path.join(root, "bin");
    const started = path.join(root, "cleanup-started");
    const release = path.join(root, "cleanup-release");
    const removed = path.join(root, "workspace-removed");
    const lockPath = path.join(stateDir, "enabled-projects.json.lock");
    const statePath = path.join(stateDir, "enabled-projects.json");
    mkdirSync(repo, { recursive: true });
    mkdirSync(path.dirname(artifact), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    spawnSync("git", ["init", "-q", worktree]);
    spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
    writeFileSync(artifact, "{}\n");
    writeFileSync(statePath, JSON.stringify({ projects: [{
      repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "R_repo", enabledAt: 1,
      firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
      autoMergeAcknowledged: false, enabled: true,
    }] }));
    writeFileSync(path.join(binDir, "gh"), `#!/bin/sh
if [ "$1 $2" = "pr list" ]; then
  case "$*" in
    *--state\\ merged*) printf '%s\\n' '[{"number":1,"state":"MERGED","mergedAt":"2026-07-04T00:00:00Z","headRefName":"agent/issue-1","headRefOid":"final","labels":[{"name":"agent:review"}]}]' ;;
    *) printf '%s\\n' '[]' ;;
  esac
else
  printf '%s\\n' '{"id":"R_repo"}'
fi
`);
    writeFileSync(path.join(binDir, "git"), `#!/bin/sh
if [ "$1" = "-C" ] && [ "$2" = "${repo}" ] && [ "$3 $4" = "fetch --prune" ]; then exit 0; fi
if [ "$1" = "-C" ] && [ "$2" = "${worktree}" ] && [ "$3" = "ls-files" ]; then
  touch '${started}'
  while [ ! -f '${release}' ]; do sleep 0.05; done
fi
exec /usr/bin/git "$@"
`);
    writeFileSync(path.join(binDir, "herdr"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'herdr 0.8.0\\n'; exit 0; fi
if [ "$1 $2" = "status server" ]; then printf 'version: 0.8.0\\n'; exit 0; fi
if [ "$1 $2" = "worktree list" ]; then
  printf '%s\\n' '{"result":{"worktrees":[{"branch":"agent/issue-1","is_linked_worktree":true,"path":"${worktree}"}]}}'
  exit 0
fi
if [ "$1 $2" = "worktree remove" ]; then touch '${removed}'; exit 0; fi
exit 2
`);
    for (const command of ["gh", "git", "herdr"]) chmodSync(path.join(binDir, command), 0o755);

    const child = spawn(process.execPath, [path.resolve(driverScript)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        PI_CODING_AGENT_DIR: path.join(root, ".pi", "agent"),
        DEADLOOP_REPO_PATH: repo,
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_ENABLED_AT: "1",
        DEADLOOP_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      for (let attempt = 0; attempt < 100 && !existsSync(started); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      let disableCompleted = false;
      try {
        const lock = acquireLockSync(lockPath, { attempts: 8, delayMs: 10 });
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        state.projects[0].enabled = false;
        writeFileSync(statePath, JSON.stringify(state));
        releaseOwned(lockPath, lock.token);
        disableCompleted = true;
      } catch {}
      writeFileSync(release, "release");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));

      expect(observation({
        cleanupStarted: existsSync(started),
        disableCompleted,
        artifactExists: existsSync(artifact),
        workspaceRemoved: existsSync(removed),
      })).toBe(expected);
    } finally {
      writeFileSync(release, "release");
      child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects exploration before implementation", () => {
    expect(runDriverFixture("driver-explore.json").driverAction).toBe("explorer_monitor_request");
  });

  it("binds exploration to the selected request generation", () => {
    expect(runDriverFixture("driver-explore.json").launch.agentRequest.eventId).toBe("2");
  });

  it("records exploration consumption before launch", () => {
    expect(runDriverFixture("driver-explore.json").launch.attemptPhase).toBe("github_claimed");
  });

  it("consumes only the exploration request", () => {
    expect(runDriverFixture("driver-explore.json").launch.issueLabels).not.toContain("agent:explore");
  });

  it("leaves implementation queued after exploration consumption", () => {
    expect(runDriverFixture("driver-explore.json").launch.issueLabels).toContain("agent:implement");
  });

  it("creates no Issue comment while launching exploration", () => {
    expect(runDriverFixture("driver-explore.json").launch.comments).toEqual([]);
  });

  it("forbids repository and GitHub mutations in the explorer prompt", () => {
    expect(runDriverFixture("driver-explore.json").launch.instructions).toContain("Do not edit, create, delete, rename, or format repository files");
  });

  it("hands successful exploration to the deterministic completion path", () => {
    expect(runDriverFixture("driver-explore.json").prompt).toContain("complete-issue-exploration.cts");
  });

  it("launches a recovery request ordered after an Issue block", () => {
    expect(runDriverFixture("driver-blocked-recovery.json").driverAction).toBe("explorer_monitor_request");
  });

  it("clears the old block when its recovery attempt starts", () => {
    expect(runDriverFixture("driver-blocked-recovery.json").launch.issueLabels).not.toContain("agent:blocked");
  });

  it("clears the recovery block before consuming its only request", () => {
    expect(runDriverFixture("driver-blocked-recovery.json").launch.timelineEvents.slice(-3)
      .map((event: any) => `${event.event}:${event.label.name}`)).toEqual([
        "unlabeled:agent:blocked",
        "unlabeled:agent:explore",
        "labeled:agent:in-progress",
      ]);
  });

  it("does not let a stale blocked candidate starve another valid Issue", () => {
    expect(runDriverFixture("driver-stale-blocked-before-valid.json").issueNumber).toBe(15);
  });

  it("does not consume a request when a newer block races with recovery", () => {
    const { clearIssueRecoveryBlock } = require("../extensions/deadloop/automations/issue-coordinator-driver.cts");
    const events = [
      { id: "10", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
      { id: "11", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:explore" } },
    ];
    expect(() => clearIssueRecoveryBlock({
      listIssueLabels: () => [{ name: "agent:blocked" }],
      listIssueTimelineEvents: () => events,
      deleteIssueLabel: () => {
        events.push(
          { id: "12", event: "unlabeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
          { id: "13", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
        );
        return { status: 200 };
      },
    }, { githubRepo: "owner/repo", blockedLabel: "agent:blocked" }, 14, {
      label: "agent:explore",
      eventId: "11",
    })).toThrow("blocked again");
  });

  it("reports the deterministic Worker name", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.workerName).toBe("demo-issue-12-worker");
  });

  it("launches implementation without ready-for-agent", () => {
    expect(runDriverFixture("driver-ready-worker.json").driverAction).toBe("worker_monitor_request");
  });

  it("binds the durable attempt to the selected request generation", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.agentRequest.eventId).toBe("1");
  });

  it("records consumption before the simulated Worker launch", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.attemptPhase).toBe("github_claimed");
  });

  it("preserves an unrelated Issue label", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.issueLabels).toContain("customer:urgent");
  });

  it("consumes the selected implementation request", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.issueLabels).not.toContain("agent:implement");
  });

  it("enters in-progress only after request consumption", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.issueLabels).toContain("agent:in-progress");
  });

  it("emits the selected request's unlabeled event", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.timelineEvents).toContainEqual(expect.objectContaining({ event: "unlabeled", label: { name: "agent:implement" } }));
  });

  it("emits the in-progress labeled event", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.timelineEvents).toContainEqual(expect.objectContaining({ event: "labeled", label: { name: "agent:in-progress" } }));
  });

  it("adds in-progress after the request consumption event", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.timelineEvents.slice(-2).map((event: any) => `${event.event}:${event.label.name}`)).toEqual([
      "unlabeled:agent:implement",
      "labeled:agent:in-progress",
    ]);
  });

  const blockedVerificationResolution = JSON.stringify({
    status: "blocked",
    reason: "no_source",
    repository: "owner/repo",
    baseRevision: "f".repeat(40),
    sources: [],
  });

  it("stops an eligible Issue before launch when required verification is unresolved", () => {
    expect(runDriverFixture("driver-ready-worker.json", { DEADLOOP_REQUIRED_VERIFICATION_RESOLUTION: blockedVerificationResolution }).driverAction).toBe("required_verification_blocked");
  });

  it("does not create an attempt for a pre-launch required-verification stop", () => {
    expect(runDriverFixture("driver-ready-worker.json", { DEADLOOP_REQUIRED_VERIFICATION_RESOLUTION: blockedVerificationResolution })).not.toHaveProperty("launch");
  });

  it("resumes a fingerprinted partial stop while required verification remains blocked", () => {
    expect(runDriverFixture("driver-partial-verification-stop.json", {
      DEADLOOP_REQUIRED_VERIFICATION_RESOLUTION: blockedVerificationResolution,
    }).driverAction).toBe("required_verification_blocked");
  });

  it("replaces a partial stop diagnosis when its recovery fingerprint changes", () => {
    const changedResolution = JSON.stringify({
      status: "blocked",
      reason: "source_conflict",
      repository: "owner/repo",
      baseRevision: "f".repeat(40),
      sources: [
        { kind: "local", location: "projects.json", command: "npm test" },
        { kind: "local", location: "projects.override.json", command: "npm run check" },
      ],
    });
    const result = runDriverFixture("driver-partial-verification-stop.json", {
      DEADLOOP_REQUIRED_VERIFICATION_RESOLUTION: changedResolution,
    });

    expect(result.comment).toContain("reason: source_conflict");
  });

  it("launches a Worker for a requeued fingerprinted Issue after required verification resolves", () => {
    expect(runDriverFixture("driver-partial-verification-stop.json", {
      DEADLOOP_REQUIRED_VERIFICATION_RESOLUTION: JSON.stringify({ status: "resolved" }),
    }).driverAction).toBe("worker_monitor_request");
  });

  it("does not requeue a durable verification stop when only configuration resolves", () => {
    expect(runDriverFixture("driver-durable-verification-stop.json", {
      DEADLOOP_REQUIRED_VERIFICATION_RESOLUTION: JSON.stringify({ status: "resolved" }),
    }).driverAction).toBe("no_candidate");
  });

  it("binds the Worker V1 identity to an exact commit SHA", () => {
    const instructions = runDriverFixture("driver-ready-worker.json").launch.instructions;

    expect(instructions).toContain(`"inputRevision":{"head":"${"f".repeat(40)}"}`);
  });

  it("persists the launch-time issue title for monitor revalidation", () => {
    expect(runDriverFixture("driver-ready-worker.json").monitorHandoff.input.issueTitle).toBe("Implement small feature");
  });

  it("persists the launch-time issue body for monitor revalidation", () => {
    expect(runDriverFixture("driver-ready-worker.json").monitorHandoff.input.issueBody).toContain("Build a focused feature.");
  });

  it("does not ask the LLM to run launch-agent", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).not.toContain("launch-agent.cts");
  });

  it("keeps promise files as the worker completion authority", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain("only completion authority");
  });

  it("reports the deterministic worker promise path outside the worktree", () => {
    const stateDir = fixtureStateDir();

    expect(
      runDriverFixture("driver-ready-worker.json", { DEADLOOP_STATE_DIR: stateDir }).launch.promiseFile,
    ).toBe(path.join(stateDir, "runs/fixture-worker-demo-12/promise.json"));
  });

  it("isolates runtime artifacts during monitor validation", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain("run-project-check.ts");
  });

  it("preserves the validation gate before PR creation", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain("before creating any PR");
  });

  it("receives worker agent settings from the shared automation environment", () => {
    expect(readFileSync("src/core.ts", "utf8")).toContain("DEADLOOP_WORKER_AGENT");
  });

  it("receives worker model settings from the shared automation environment", () => {
    expect(readFileSync("src/core.ts", "utf8")).toContain("DEADLOOP_WORKER_MODEL");
  });

  it("uses the TypeScript renderer for planning comments", () => {
    expect(readFileSync(driverScript, "utf8")).toContain("renderIssuePlanningComment");
  });
});

describe("reusing an abandoned Worker checkout", () => {
  const checkout = {
    branch: "agent/issue-1-task",
    worktreePath: "/worktrees/agent-issue-1-task",
    preservedHead: "a".repeat(40),
    stoppedAt: "2026-08-14T00:00:00.000Z",
    workspaceId: "workspace-1",
    agentName: "demo-issue-1-worker",
  };

  /** Every other proof passes, so the status line is the only thing under test. */
  function assertWith(status: string, worktrees = [{ branch: checkout.branch, path: checkout.worktreePath, workspaceId: "" }]) {
    const { assertRecoverableWorkerCheckout } = require("../extensions/deadloop/automations/issue-coordinator-driver.cts");
    return () => assertRecoverableWorkerCheckout(checkout, { repoPath: "/repo" }, {
      runner: {
        listWorktrees: () => worktrees,
        listWorkspaces: () => [],
        listAgents: () => [],
      },
      runText: (args: string[]) => (args.includes("rev-parse") ? checkout.preservedHead : status),
    });
  }

  it("reuses a checkout whose only untracked files are an agent scratch area", () => {
    expect(assertWith("?? .pi/subagents/artifacts/input.md\n")).not.toThrow();
  });

  it("refuses a checkout whose scratch area holds a tracked change", () => {
    expect(assertWith(" M .pi/subagents/report.md\n")).toThrow("contains changes");
  });

  it("refuses a checkout holding somebody else's untracked file", () => {
    expect(assertWith("?? luac.out\n")).toThrow("contains changes");
  });

  it("refuses a checkout whose linked worktree shows two runner records", () => {
    const duplicate = [
      { branch: checkout.branch, path: checkout.worktreePath, workspaceId: "" },
      { branch: checkout.branch, path: checkout.worktreePath, workspaceId: "" },
    ];
    expect(assertWith("", duplicate)).toThrow("not one closed linked worktree");
  });
});

describe("reusing a formally stopped Worker checkout", () => {
  const baseHead = "a".repeat(40);
  const outputHead = "b".repeat(40);
  const advancedBaseHead = "c".repeat(40);
  const driver = require("../extensions/deadloop/automations/issue-coordinator-driver.cts");

  type StoppedFixture = { root: string; runDir: string; worktreePath: string; branch: string };

  /** Persist one valid workspace_closed Worker journal whose evidence matches this scenario. */
  function persistStoppedJournal(root: string, variant: { runName?: string; branch?: string } = {}): StoppedFixture {
    const runName = variant.runName ?? "stopped-1";
    const branch = variant.branch ?? "agent/issue-12-stop";
    const runDir = path.join(root, "runs", runName);
    const source: PreparedAttemptInput = {
      attemptId: `${runName}-attempt`, launchUuid: `${runName}-launch`, project: "demo", repository: "owner/repo",
      role: "worker", target: { kind: "issue", number: 12 }, inputRevision: { head: baseHead },
      requiredVerification: { repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: baseHead },
      branch, baseBranch: "origin/main", worktreePath: path.join(root, branch.replace(/\//g, "-")),
      agentName: `dl-w-12-${runName}000000`, workspaceLabel: "old worker",
      promptFile: path.join(runDir, "worker-prompt.md"), promiseFile: path.join(runDir, "promise.json"),
    };
    createPreparedAttempt(runDir, source);
    transitionPersistedAttempt(runDir, "github_claimed");
    writeAttemptRecordAtomically(attemptRecordPath(runDir), {
      ...readAttemptRecord(runDir), workspaceId: "workspace-old", tabId: "tab-old", rootPaneId: "pane-old",
      phase: "workspace_opened", lastSuccessfulPhase: "workspace_opened",
    });
    transitionPersistedAttempt(runDir, "agent_started");
    recordPersistedCompletionReport(runDir, {
      schemaVersion: 1, attemptId: source.attemptId, target: { repository: source.repository, kind: "issue", number: 12 },
      inputRevision: source.inputRevision, status: "complete", summary: "Stopped before verification.",
      role: "worker", result: { outputRevision: outputHead }, evidence: { validations: ["npm test passed"] },
    });
    transitionPersistedAttempt(runDir, "github_persisted");
    transitionPersistedAttempt(runDir, "workspace_closed");
    return { root, runDir, worktreePath: source.worktreePath, branch };
  }

  /** Persist one valid abandoned launch-failure journal on the same deterministic checkout. */
  function persistAbandonedJournal(root: string): StoppedFixture {
    const runDir = path.join(root, "runs", "abandoned-1");
    const source: PreparedAttemptInput = {
      attemptId: "abandoned-attempt", launchUuid: "abandoned-launch-1", project: "demo", repository: "owner/repo",
      role: "worker", target: { kind: "issue", number: 12 }, inputRevision: { head: baseHead },
      requiredVerification: { repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: baseHead },
      branch: "agent/issue-12-stop", baseBranch: "origin/main", worktreePath: path.join(root, "agent-issue-12-stop"),
      agentName: "dl-w-12-abandoned0000", workspaceLabel: "old worker",
      promptFile: path.join(runDir, "worker-prompt.md"), promiseFile: path.join(runDir, "promise.json"),
    };
    createPreparedAttempt(runDir, source);
    transitionPersistedAttempt(runDir, "github_claimed");
    writeAttemptRecordAtomically(attemptRecordPath(runDir), {
      ...readAttemptRecord(runDir), workspaceId: "workspace-old", tabId: "tab-old", rootPaneId: "pane-old",
      phase: "workspace_opened", lastSuccessfulPhase: "workspace_opened",
    });
    transitionPersistedAttempt(runDir, "launch_failed", "agent did not start");
    abandonPersistedAttempt(runDir, "2026-08-14T00:00:00.000Z");
    return { root, runDir, worktreePath: source.worktreePath, branch: source.branch };
  }

  function searchEnv(root: string) {
    return driver.envConfig({ DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: "/repo", DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_STATE_DIR: root });
  }

  function searchWith(root: string, observedHead: () => string) {
    return driver.stoppedWorkerCheckout(12, searchEnv(root), {
      runText: (args: string[]) => (args.includes("rev-parse") ? observedHead() : ""),
    });
  }

  it("finds a preserved checkout at the recorded output revision of a formally stopped attempt", () => {
    const fixture = persistStoppedJournal(fixtureStateDir());
    expect(searchWith(fixture.root, () => outputHead)?.preservedHead).toBe(outputHead);
  });

  it("still finds an abandoned launch-failure checkout at its input revision", () => {
    const fixture = persistAbandonedJournal(fixtureStateDir());
    expect(searchWith(fixture.root, () => baseHead)?.preservedHead).toBe(baseHead);
  });

  it("fails closed when the preserved checkout sits at no recorded revision", () => {
    const fixture = persistStoppedJournal(fixtureStateDir());
    expect(() => searchWith(fixture.root, () => "d".repeat(40))).toThrow("no stopped attempt journal records");
  });

  it("fails closed when the preserved checkout is gone while its journal still holds evidence", () => {
    const fixture = persistStoppedJournal(fixtureStateDir());
    expect(() => driver.stoppedWorkerCheckout(12, searchEnv(fixture.root), {
      runText: (args: string[]) => { if (args.includes("rev-parse")) throw new Error(`fatal: not a git repository: ${args[2]}`); return ""; },
    })).toThrow("restore it or remove the stale branch by hand");
  });

  it("fails closed when stopped journals disagree on the preserved checkout identity", () => {
    const root = fixtureStateDir();
    persistStoppedJournal(root);
    persistStoppedJournal(root, { runName: "stopped-2", branch: "agent/issue-12-renamed" });
    expect(() => searchWith(root, () => outputHead)).toThrow("conflicting stopped Worker checkouts");
  });

  it("fails closed when the preserved checkout holds unsaved work", () => {
    const fixture = persistStoppedJournal(fixtureStateDir());
    const checkout = searchWith(fixture.root, () => outputHead)!;
    expect(() => driver.assertRecoverableWorkerCheckout(checkout, searchEnv(fixture.root), {
      runner: {
        listWorktrees: () => [{ branch: checkout.branch, path: checkout.worktreePath, workspaceId: "" }],
        listWorkspaces: () => [],
        listAgents: () => [],
      },
      runText: (args: string[]) => (args.includes("rev-parse") ? outputHead : " M src/a.ts\n"),
    })).toThrow("contains changes");
  });

  /** Reuse the preserved checkout through the production flow with every runtime call faked. */
  function reuseStoppedCheckout(): { fixture: StoppedFixture; result: JsonObject; opened: number } {
    const root = fixtureStateDir();
    const fixture = persistStoppedJournal(root);
    let launchedName = "";
    const observation = { opened: 0 };
    const env = driver.envConfig({
      DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: "/repo", DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_BASE_BRANCH: "origin/main", DEADLOOP_WORKTREE_ROOT: root, DEADLOOP_STATE_DIR: root,
      DEADLOOP_REQUIRED_VERIFICATION: JSON.stringify({ repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: advancedBaseHead }),
    });
    const runner = {
      createWorktree: () => { throw new Error("reused Worker must not create a duplicate worktree"); },
      openWorktree: () => {
        observation.opened += 1;
        return { workspaceId: "workspace-new", tabId: "tab-new", rootPaneId: "pane-new", worktreePath: fixture.worktreePath };
      },
      renameWorkspace: () => "", startAgent: () => "", closeWorkspace: () => "", removeWorktree: () => "",
      listWorkspaces: () => [],
      listWorktrees: () => [{ branch: fixture.branch, path: fixture.worktreePath, workspaceId: "" }],
      listAgents: () => (launchedName ? [{ name: launchedName, paneId: "pane-new", cwd: fixture.worktreePath, status: "working" }] : []),
    };
    const result = driver.launchIssueWorkerFlow({ number: 12, title: "renamed issue" }, env, {
      mkdirSync,
      alignCheckout: () => {},
      runner,
      runText: (args: string[]) => {
        const nameIndex = args.indexOf("--name");
        if (nameIndex >= 0) { launchedName = args[nameIndex + 1]; return "started"; }
        if (args[0] === "git" && args.includes("status")) return "";
        if (args[0] === "git" && args[2] === "/repo") return `${advancedBaseHead}\n`;
        return args[0] === "git" ? `${outputHead}\n` : "started";
      },
      writeFileSync,
    });
    return { fixture, result, opened: observation.opened };
  }

  it("opens the preserved checkout at its recorded output revision for the new attempt", () => {
    const { fixture, result, opened } = reuseStoppedCheckout();
    const newRunName = readdirSync(path.join(fixture.root, "runs")).find((entry) => entry !== "stopped-1") as string;
    const attempt = readAttemptRecord(path.join(fixture.root, "runs", newRunName));
    expect({
      opened,
      workspaceId: result.workspaceId,
      worktreePath: result.worktreePath,
      resumedHead: attempt.inputRevision.head,
      policyBaseHead: attempt.requiredVerification?.baseRevision,
      branch: result.branch,
    }).toEqual({
      opened: 1,
      workspaceId: "workspace-new",
      worktreePath: fixture.worktreePath,
      resumedHead: outputHead,
      policyBaseHead: advancedBaseHead,
      branch: "agent/issue-12-stop",
    });
  });

  it("leaves the previous stopped attempt's journal and recorded evidence untouched", () => {
    const { fixture, result } = reuseStoppedCheckout();
    const prior = readAttemptRecord(fixture.runDir);
    expect({ phase: prior.phase, outputRevision: prior.outputRevision, worktreePath: prior.worktreePath, launchResultWorkspaceId: result.workspaceId }).toEqual({
      phase: "workspace_closed",
      outputRevision: outputHead,
      worktreePath: fixture.worktreePath,
      launchResultWorkspaceId: "workspace-new",
    });
  });
});
