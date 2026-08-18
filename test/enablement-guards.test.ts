import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { MAX_GUARDED_OPERATION_MS, MAX_ORIGIN_IDENTITIES, assertEnabled, withEnabledProjectLock } = require("../src/enabled-operation.cjs");
const {
  DISABLE_LOCK_ATTEMPTS,
  DISABLE_LOCK_DELAY_MS,
  MAX_DRIVER_REVALIDATION_MS,
  MAX_GUARDED_LAUNCH_DURATION_MS,
  assertDriverEnabled,
  withEnabledDriverLaunch,
} = require("../src/driver-enablement.cjs");
const { acquireLockSync, reclaimStale } = require("../src/enablement-lock.cjs");
const { GUARDED_OPERATION_TIMEOUT_MS, runGuarded } = require("../extensions/deadloop/automations/guarded-operation.ts");
const { assertWorkerHead, assertWorkerPushBinding, parseArgs: parseGuardedPushArgs, runGuardedPush } = require("../extensions/deadloop/automations/guarded-push.ts");
const originalConfigDir = process.env.PI_CODING_AGENT_DIR;
const originalPath = process.env.PATH;
const sandboxes: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-guard-"));
  sandboxes.push(root);
  const repoPath = path.join(root, "repo");
  const configDir = path.join(root, "config");
  const stateDir = path.join(configDir, "deadloop");
  process.env.PI_CODING_AGENT_DIR = configDir;
  mkdirSync(repoPath);
  mkdirSync(stateDir, { recursive: true });
  const binDir = path.join(root, "bin");
  const repositoryIdPath = path.join(root, "repository-id");
  mkdirSync(binDir);
  writeFileSync(repositoryIdPath, "R_repo\n");
  const ghPath = path.join(binDir, "gh");
  const ghCallsPath = path.join(root, "gh-calls");
  const reusedNamePath = path.join(root, "reused-name");
  writeFileSync(ghPath, `#!/bin/sh
printf '%s\\n' "$*" >> '${ghCallsPath}'
if [ -f '${reusedNamePath}' ] && [ "$3" = "owner/repo" ]; then
  printf '{"id":"R_reused"}\\n'
else
  printf '{"id":"%s"}\\n' "$(cat '${repositoryIdPath}')"
fi
`);
  execFileSync("chmod", ["+x", ghPath]);
  process.env.PATH = `${binDir}:${originalPath || ""}`;
  execFileSync("git", ["-C", repoPath, "init", "--quiet"]);
  execFileSync("git", ["-C", repoPath, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  return { repoPath, stateDir, githubRepo: "owner/repo", repositoryIdPath, ghCallsPath, reusedNamePath };
}

function writeState(project: ReturnType<typeof fixture>, record: Record<string, unknown>, withSafetyFields = true) {
  const safetyFields = withSafetyFields
    ? { githubRepositoryId: "R_repo", automationLogin: "deadloop-bot", firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false, autoMergeAcknowledged: false, enabled: true }
    : {};
  writeFileSync(path.join(project.stateDir, "enabled-projects.json"), JSON.stringify({ projects: [{ repoPath: project.repoPath, githubRepo: project.githubRepo, ...safetyFields, ...record }] }));
}

function writeGuardedPrAttempt(project: ReturnType<typeof fixture>, head = "a".repeat(40)): string {
  const runDir = path.join(project.stateDir, "runs", "guarded-pr");
  mkdirSync(runDir, { recursive: true });
  const attemptRecord = path.join(runDir, "attempt.json");
  writeFileSync(attemptRecord, JSON.stringify({
    schemaVersion: 1,
    attemptId: "guarded-pr",
    launchUuid: "guarded-pr",
    project: "demo",
    repository: project.githubRepo,
    role: "reviewer",
    target: { kind: "pull-request", number: 24 },
    inputRevision: { head },
    branch: "agent/issue-24",
    worktreePath: path.join(project.repoPath, "worktree"),
    agentName: "dl-r-24",
    workspaceLabel: "demo-pr-24-reviewer",
    promptFile: path.join(runDir, "prompt.md"),
    promiseFile: path.join(runDir, "promise.json"),
    phase: "report_received",
    lastSuccessfulPhase: "report_received",
  }));
  return attemptRecord;
}

function guardedPrFinalIdentityRace(race: "login" | "repository-id" | "repository-name"): number {
  const project = fixture();
  writeState(project, { enabledAt: 1 });
  const attemptRecord = writeGuardedPrAttempt(project);
  let loginReads = 0;
  let repositoryReads = 0;
  let mutations = 0;
  try {
    runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord, inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"] },
      (_command: string, args: string[]) => {
        if (args[0] === "api") {
          loginReads += 1;
          return { status: 0, stdout: loginReads >= 2 && race === "login" ? "other-bot\n" : "deadloop-bot\n", stderr: "" };
        }
        if (args[0] === "repo") {
          repositoryReads += 1;
          const final = repositoryReads >= 2;
          return { status: 0, stdout: JSON.stringify({
            id: final && race === "repository-id" ? "R_other" : "R_repo",
            nameWithOwner: final && race === "repository-name" ? "other/repo" : project.githubRepo,
          }), stderr: "" };
        }
        if (args[0] === "pr" && args[1] === "view") {
          return { status: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: "a".repeat(40), labels: [{ name: "agent:in-progress" }] }), stderr: "" };
        }
        mutations += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    );
  } catch {}
  return mutations;
}

function guardedPrFinalStateRace(race: "closed" | "head" | "blocked"): number {
  const project = fixture();
  writeState(project, { enabledAt: 1 });
  const attemptRecord = writeGuardedPrAttempt(project);
  let prReads = 0;
  let mutations = 0;
  try {
    runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord, inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"] },
      (_command: string, args: string[]) => {
        if (args[0] === "api") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: project.githubRepo }), stderr: "" };
        if (args[0] === "pr" && args[1] === "view") {
          prReads += 1;
          const final = prReads >= 2;
          return { status: 0, stdout: JSON.stringify({
            state: final && race === "closed" ? "CLOSED" : "OPEN",
            headRefOid: final && race === "head" ? "b".repeat(40) : "a".repeat(40),
            labels: final && race === "blocked" ? [{ name: "agent:in-progress" }, { name: "agent:blocked" }] : [{ name: "agent:in-progress" }],
          }), stderr: "" };
        }
        mutations += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    );
  } catch {}
  return mutations;
}

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalConfigDir;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe("enablement mutation guards", () => {
  for (const [name, record] of [
    ["missing enabledAt", {}],
    ["invalid enabledAt", { enabledAt: "now" }],
    ["missing safety fields", { enabledAt: 1 }],
    ["invalid safety field", { enabledAt: 1, autoMergeAcknowledged: "yes" }],
  ] as const) {
    it(`rejects ${name} through guarded operations`, () => {
      const project = fixture();
      writeState(project, record, false);
      expect(() => assertEnabled(project)).toThrow("disabled");
    });

    it(`rejects ${name} through driver authorization`, () => {
      const project = fixture();
      writeState(project, record, false);
      expect(() => assertDriverEnabled(project)).toThrow("disabled");
    });
  }

  it("rejects active enablement without an authorized automation identity", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1, automationLogin: undefined });

    expect(() => assertEnabled(project)).toThrow("disabled");
  });

  it("rejects a reused repository name after the enabled repository transfers", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    writeFileSync(project.repositoryIdPath, "R_reused\n");

    expect(() => assertEnabled(project)).toThrow("disabled");
  });

  it("rejects a reused persisted mutation namespace after the origin follows a rename", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    execFileSync("git", ["-C", project.repoPath, "remote", "set-url", "origin", "https://github.com/owner/renamed.git"]);
    writeFileSync(project.reusedNamePath, "reused\n");

    expect(() => assertEnabled(project)).toThrow("disabled");
  });

  it("does not mutate when disable wins after an earlier driver authorization", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    assertDriverEnabled(project);
    writeState(project, { enabledAt: 1, enabled: false });
    let mutated = false;
    try { withEnabledProjectLock({ ...project, enabledAt: 1 }, () => { mutated = true; }); } catch {}
    expect(mutated).toBe(false);
  });

  it("rejects a pre-disable operation after a new enablement generation", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    writeState(project, { enabledAt: 2 });
    let mutated = false;

    try { withEnabledProjectLock({ ...project, enabledAt: 1 }, () => { mutated = true; }); } catch {}

    expect(mutated).toBe(false);
  });

  it("defers mutation to a later enablement cycle when disable intent arrives after authorization", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const events: string[] = [];
    const disableGenerationPath = path.join(project.stateDir, "disable-generation.json");

    try {
      withEnabledProjectLock(
        { ...project, enabledAt: 1 },
        (_enabled: unknown, recheck: () => void) => {
          recheck();
          events.push("mutated-before-reenable");
        },
        { afterAuthorization: () => writeFileSync(disableGenerationPath, JSON.stringify({
          generation: 0,
          generations: { [path.resolve(project.repoPath)]: 1 },
        })) },
      );
    } catch {}

    writeState(project, { enabledAt: 2, disableGeneration: 1 });
    withEnabledProjectLock({ ...project, enabledAt: 2 }, (_enabled: unknown, recheck: () => void) => {
      recheck();
      events.push("mutated-after-reenable");
    });

    expect(events).toEqual(["mutated-after-reenable"]);
  });

  it.each(["issue worker", "PR reviewer", "branch update", "review repair"])(
    "keeps disable excluded between the %s mutation and launch",
    () => {
      const project = fixture();
      writeState(project, { enabledAt: 1 });
      const lockPath = path.join(project.stateDir, "enabled-projects.json.lock");
      const events: string[] = [];

      withEnabledDriverLaunch(
        { ...project, enabledAt: 1 },
        () => {
          events.push("mutated");
          try {
            acquireLockSync(lockPath, { attempts: 1, delayMs: 1 });
            events.push("disable-acquired");
          } catch {
            events.push("disable-excluded");
          }
        },
        () => events.push("launched"),
      );

      expect(events).toEqual(["mutated", "disable-excluded", "launched"]);
    },
  );

  it("persists the prepared attempt before consuming a GitHub request", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const events: string[] = [];

    withEnabledDriverLaunch(
      { ...project, enabledAt: 1 },
      () => events.push("github-claim"),
      () => events.push("launched"),
      {
        revalidate: () => events.push("revalidated"),
        revalidateAfterMutation: () => events.push("post-revalidated"),
        prepareAttempt: () => events.push("prepared"),
        recordGithubMutation: () => events.push("claim-recorded"),
      },
    );

    expect(events).toEqual(["revalidated", "prepared", "github-claim", "post-revalidated", "claim-recorded", "launched"]);
  });

  it("retains prepared evidence when request consumption succeeds before phase advancement", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const events: string[] = [];

    try {
      withEnabledDriverLaunch(
        { ...project, enabledAt: 1 },
        () => events.push("delete-200"),
        () => events.push("launched"),
        {
          revalidate: () => events.push("revalidated"),
          prepareAttempt: () => events.push("prepared"),
          revalidateAfterMutation: () => { throw new Error("crash before phase advance"); },
          recordGithubMutation: () => events.push("claim-recorded"),
        },
      );
    } catch {}

    expect(events).toEqual(["revalidated", "prepared", "delete-200"]);
  });

  it("records the guarded claim before a runner failure", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const events: string[] = [];
    try {
      withEnabledDriverLaunch(
        { ...project, enabledAt: 1 },
        () => events.push("github-claim"),
        () => { events.push("runner-open"); throw new Error("runner failed"); },
        { prepareAttempt: () => events.push("prepared"), recordGithubMutation: () => events.push("claim-recorded") },
      );
    } catch {}
    expect(events).toEqual(["prepared", "github-claim", "claim-recorded", "runner-open"]);
  });

  it("stops final agent start when disable intent arrives during launch preparation", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const events: string[] = [];

    let error = "";
    try {
      withEnabledDriverLaunch(
        { ...project, enabledAt: 1 },
        () => events.push("mutated"),
        (recheck: () => void) => {
          events.push("prepared");
          writeFileSync(path.join(project.stateDir, "disable-generation.json"), JSON.stringify({
            generation: 0,
            generations: { [path.resolve(project.repoPath)]: 1 },
          }));
          recheck();
          events.push("launched");
        },
      );
    } catch (caught) {
      error = String(caught);
    }

    expect({ error: error.includes("disabled"), events }).toEqual({ error: true, events: ["mutated", "prepared"] });
  });

  it("lets disable outwait the maximum authorization, revalidation, and multi-command launch duration", () => {
    expect(DISABLE_LOCK_ATTEMPTS * DISABLE_LOCK_DELAY_MS).toBeGreaterThan(MAX_GUARDED_LAUNCH_DURATION_MS);
  });

  it("includes the enforced issue revalidation deadline in the disable wait budget", () => {
    expect(MAX_GUARDED_LAUNCH_DURATION_MS).toBe(
      (2 + MAX_ORIGIN_IDENTITIES + 1) * MAX_GUARDED_OPERATION_MS + MAX_DRIVER_REVALIDATION_MS + 7 * 20_000,
    );
  });

  it("deduplicates identity checks at the maximum supported origin URL path", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    execFileSync("git", ["-C", project.repoPath, "remote", "set-url", "--add", "origin", "https://github.com/owner/repo.git"]);
    for (let index = 1; index < MAX_ORIGIN_IDENTITIES; index++) {
      execFileSync("git", ["-C", project.repoPath, "remote", "set-url", "--add", "--push", "origin", `https://github.com/old-${index}/repo.git`]);
    }

    assertEnabled(project);

    expect(readFileSync(project.ghCallsPath, "utf8").trim().split("\n")).toHaveLength(MAX_ORIGIN_IDENTITIES);
  });

  it("rejects origins beyond the supported identity cap before GitHub lookups", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    for (let index = 0; index < MAX_ORIGIN_IDENTITIES; index++) {
      execFileSync("git", ["-C", project.repoPath, "remote", "set-url", "--add", "--push", "origin", `https://github.com/extra-${index}/repo.git`]);
    }

    try { assertEnabled(project); } catch {}

    expect(() => readFileSync(project.ghCallsPath, "utf8")).toThrow();
  });

  it.each(["issue worker", "PR reviewer", "branch update", "review repair"])(
    "aborts a stale %s target before mutation or launch",
    () => {
      const project = fixture();
      writeState(project, { enabledAt: 1 });
      const events: string[] = [];

      try {
        withEnabledDriverLaunch(
          { ...project, enabledAt: 1 },
          () => events.push("mutated"),
          () => events.push("launched"),
          { revalidate: () => { events.push("revalidated"); throw new Error("stale target"); } },
        );
      } catch {}

      expect(events).toEqual(["revalidated"]);
    },
  );

  it("bounds the command while holding the enablement lock", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    let timeout: number | undefined;

    runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "issue", command: ["gh", "issue", "comment", "1", "-R", project.githubRepo, "--body", "done"] },
      (_command: string, args: string[], options: { timeout?: number }) => {
        timeout = options.timeout;
        return { status: 0, stdout: args[0] === "api" ? JSON.stringify({ number: 1 }) : "" };
      },
    );

    expect(timeout).toBe(GUARDED_OPERATION_TIMEOUT_MS);
  });

  it("rejects issue mutation when GitHub does not return the exact issue identity", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });

    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "issue", command: ["gh", "issue", "comment", "1", "-R", project.githubRepo, "--body", "done"] },
      () => ({ status: 0, stdout: "{}", stderr: "" }),
    )).toThrow("exact non-PR issue target");
  });

  it("rejects a guarded PR mutation when the live repository ID drifts", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const attemptRecord = writeGuardedPrAttempt(project);

    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord, inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"] },
      (_command: string, args: string[]) => {
        if (args[0] === "api") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_other", nameWithOwner: project.githubRepo }), stderr: "" };
        return { status: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: "a".repeat(40), labels: [{ name: "agent:in-progress" }] }), stderr: "" };
      },
    )).toThrow("attempt revision");
  });

  it("rejects a guarded PR mutation when the live repository name drifts", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const attemptRecord = writeGuardedPrAttempt(project);

    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord, inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"] },
      (_command: string, args: string[]) => {
        if (args[0] === "api") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: "other/repo" }), stderr: "" };
        return { status: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: "a".repeat(40), labels: [{ name: "agent:in-progress" }] }), stderr: "" };
      },
    )).toThrow("attempt revision");
  });

  it("rejects a guarded PR mutation when its exact head drifts", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const attemptRecord = writeGuardedPrAttempt(project);

    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord, inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"] },
      (_command: string, args: string[]) => {
        if (args[0] === "api") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: project.githubRepo }), stderr: "" };
        return { status: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: "b".repeat(40), labels: [{ name: "agent:in-progress" }] }), stderr: "" };
      },
    )).toThrow("attempt revision");
  });

  it("rejects a guarded PR mutation after human handoff removes in-progress", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const attemptRecord = writeGuardedPrAttempt(project);

    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord, inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"] },
      (_command: string, args: string[]) => {
        if (args[0] === "api") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: project.githubRepo }), stderr: "" };
        return { status: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: "a".repeat(40), labels: [] }), stderr: "" };
      },
    )).toThrow("active workflow state");
  });

  it("rejects a guarded PR mutation after the pull request is blocked", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const attemptRecord = writeGuardedPrAttempt(project);

    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord, inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"] },
      (_command: string, args: string[]) => {
        if (args[0] === "api") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: project.githubRepo }), stderr: "" };
        return { status: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: "a".repeat(40), labels: [{ name: "agent:in-progress" }, { name: "agent:blocked" }] }), stderr: "" };
      },
    )).toThrow("active workflow state");
  });

  it("does not mutate when active PR labels race the final guard", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const attemptRecord = writeGuardedPrAttempt(project);
    let prReads = 0;
    let mutations = 0;

    try {
      runGuarded(
        { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord, inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"] },
        (_command: string, args: string[]) => {
          if (args[0] === "api") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
          if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: project.githubRepo }), stderr: "" };
          if (args[0] === "pr" && args[1] === "view") {
            prReads += 1;
            const labels = prReads === 1 ? [{ name: "agent:in-progress" }] : [];
            return { status: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: "a".repeat(40), labels }), stderr: "" };
          }
          mutations += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      );
    } catch {}

    expect(mutations).toBe(0);
  });

  it("does not mutate when the PR closes after enablement recheck", () => {
    expect(guardedPrFinalStateRace("closed")).toBe(0);
  });

  it("does not mutate when the exact PR head changes after enablement recheck", () => {
    expect(guardedPrFinalStateRace("head")).toBe(0);
  });

  it("does not mutate when the PR becomes blocked after enablement recheck", () => {
    expect(guardedPrFinalStateRace("blocked")).toBe(0);
  });

  it("does not mutate when authenticated login races the final PR guard", () => {
    expect(guardedPrFinalIdentityRace("login")).toBe(0);
  });

  it("does not mutate when repository ID races the final PR guard", () => {
    expect(guardedPrFinalIdentityRace("repository-id")).toBe(0);
  });

  it("does not mutate when repository name races the final PR guard", () => {
    expect(guardedPrFinalIdentityRace("repository-name")).toBe(0);
  });

  it("does not mutate when enablement races the final guarded PR recheck", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const attemptRecord = writeGuardedPrAttempt(project);
    let mutations = 0;

    try {
      runGuarded(
        { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord, inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"] },
        (_command: string, args: string[]) => {
          if (args[0] === "api") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
          if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: project.githubRepo }), stderr: "" };
          if (args[0] === "pr" && args[1] === "view") {
            writeState(project, { enabledAt: 2 });
            return { status: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: "a".repeat(40), labels: [{ name: "agent:in-progress" }] }), stderr: "" };
          }
          mutations += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      );
    } catch {}

    expect(mutations).toBe(0);
  });

  it("rejects merge through the generic guarded operation", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", command: ["gh", "pr", "merge", "1", "-R", project.githubRepo] },
    )).toThrow("not approved");
  });

  it("rejects Worker PR creation through the generic guarded operation", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", command: ["gh", "pr", "create", "-R", project.githubRepo, "--head", "agent/issue-1"] },
    )).toThrow("not approved");
  });

  it("rejects success-label additions through the generic guarded operation", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", command: ["gh", "pr", "edit", "1", "-R", project.githubRepo, "--add-label", "agent:review"] },
    )).toThrow("not approved");
  });

  it("rejects a GitHub mutation targeting another repository", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "issue", command: ["gh", "issue", "comment", "1", "-R", "other/repo", "--body", "done"] },
    )).toThrow("does not match enabled repository");
  });

  it("rejects branch deletion through the generic guarded operation", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "issue", command: ["git", "branch", "-D", "agent/issue-1"] },
    )).toThrow("only approved gh mutations");
  });

  it("rejects another attempt repository before Worker push", () => {
    expect(() => assertWorkerPushBinding(
      { project: "demo", repository: "owner/repo", branch: "agent/issue-1", worktreePath: "/worktree" },
      { projectId: "demo", githubRepo: "other/repo", branch: "agent/issue-1", worktree: "/worktree" },
    )).toThrow("repository");
  });

  it("requires an attempt record for every guarded Worker push", () => {
    expect(() => parseGuardedPushArgs([
      "--project-id", "demo", "--project-repo", "/repo", "--worktree", "/worktree",
      "--github-repo", "owner/repo", "--state-dir", "/state", "--enabled-at", "1",
      "--remote", "origin", "--branch", "agent/issue-1",
    ])).toThrow("attempt-record");
  });

  it("rejects a Worker HEAD that changed after required verification", () => {
    expect(() => assertWorkerHead(
      { worktree: "/worktree" },
      { run: () => ({ status: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" }) },
      "a".repeat(40),
      "Worker HEAD changed after verification",
    )).toThrow("Worker HEAD changed after verification");
  });

  it("pushes to the verified URL even if origin changes after authorization", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    let pushedDestination = "";
    let pushedRefspec = "";
    const ops = { run: (args: string[]) => {
      if (args.includes("--git-common-dir")) return { status: 0, stdout: `${project.repoPath}/.git\n`, stderr: "" };
      if (args.includes("symbolic-ref")) return { status: 0, stdout: "agent/issue-1\n", stderr: "" };
      if (args.includes("HEAD^{commit}")) return { status: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
      if (args.includes("get-url")) return { status: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
      if (args[0] === "gh") return { status: 0, stdout: '{"id":"R_repo"}', stderr: "" };
      pushedDestination = args[5] || "";
      pushedRefspec = args[6] || "";
      execFileSync("git", ["-C", project.repoPath, "remote", "set-url", "origin", "https://github.com/attacker/wrong.git"]);
      return { status: 0, stdout: "", stderr: "" };
    } };

    runGuardedPush({ attemptRecord: "/attempt.json", projectId: "demo", projectRepo: project.repoPath, worktree: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, remote: "origin", branch: "agent/issue-1" }, ops, () => "a".repeat(40));

    expect({ pushedDestination, pushedRefspec }).toEqual({
      pushedDestination: "https://github.com/owner/repo.git",
      pushedRefspec: `${"a".repeat(40)}:refs/heads/agent/issue-1`,
    });
  });

  it("rejects a source checkout from a different Git common directory", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const ops = { run: (args: string[]) => ({
      status: 0,
      stdout: args.includes("--git-common-dir") && args[2] === "/foreign" ? "/foreign/.git\n" : `${project.repoPath}/.git\n`,
      stderr: "",
    }) };

    expect(() => runGuardedPush({ attemptRecord: "/attempt.json", projectId: "demo", projectRepo: project.repoPath, worktree: "/foreign", githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, remote: "origin", branch: "agent/issue-1" }, ops, () => "a".repeat(40))).toThrow("does not belong to the enabled checkout");
  });

  it("rejects a requested branch that is not checked out in the source worktree", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const ops = { run: (args: string[]) => ({
      status: 0,
      stdout: args.includes("symbolic-ref") ? "agent/issue-2\n" : `${project.repoPath}/.git\n`,
      stderr: "",
    }) };

    expect(() => runGuardedPush({ attemptRecord: "/attempt.json", projectId: "demo", projectRepo: project.repoPath, worktree: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, remote: "origin", branch: "agent/issue-1" }, ops, () => "a".repeat(40))).toThrow("does not match the requested branch");
  });

  it("rejects the configured base branch as the push destination", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1, baseBranch: "origin/main" });

    expect(() => runGuardedPush({ attemptRecord: "/attempt.json", projectId: "demo", projectRepo: project.repoPath, worktree: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, remote: "origin", branch: "main" }, { run: () => ({ status: 0, stdout: "", stderr: "" }) }, () => "a".repeat(40))).toThrow("configured base branch");
  });

  it("recovers an old empty lock left before metadata was written", () => {
    const project = fixture();
    const lockPath = path.join(project.stateDir, "enabled-projects.json.lock");
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    expect(acquireLockSync(lockPath, { attempts: 3, delayMs: 1 }).token).toEqual(expect.any(String));
  });

  it("does not let a delayed live creator split lock ownership", () => {
    const project = fixture();
    const lockPath = path.join(project.stateDir, "enabled-projects.json.lock");
    let competitor: { token: string } | undefined;

    try {
      acquireLockSync(lockPath, {
        attempts: 1,
        delayMs: 1,
        hooks: { beforePublish: () => { competitor = acquireLockSync(lockPath, { attempts: 1, delayMs: 1 }); } },
      });
    } catch {}

    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe(competitor?.token);
  });

  it("recovers an orphaned reclaim hard link", () => {
    const project = fixture();
    const lockPath = path.join(project.stateDir, "enabled-projects.json.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, token: "stale" }));
    linkSync(lockPath, `${lockPath}.reclaim`);

    expect(acquireLockSync(lockPath, { attempts: 3, delayMs: 1 }).token).toEqual(expect.any(String));
  });

  it("reclaims after an obsolete claim survives a replacement owner's lifetime", () => {
    const project = fixture();
    const lockPath = path.join(project.stateDir, "enabled-projects.json.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, token: "first-owner" }));
    linkSync(lockPath, `${lockPath}.reclaim`);
    rmSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_998, token: "second-owner" }));

    expect(acquireLockSync(lockPath, { attempts: 3, delayMs: 1 }).token).toEqual(expect.any(String));
  });

  it("reclaims a lock whose PID belongs to a different process lifetime", () => {
    const project = fixture();
    const lockPath = path.join(project.stateDir, "enabled-projects.json.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startIdentity: "different-start", token: "stale" }));

    expect(acquireLockSync(lockPath, { attempts: 3, delayMs: 1 }).token).toEqual(expect.any(String));
  });

  it("does not unlink a replacement created between stale inspection and removal", () => {
    const project = fixture();
    const lockPath = path.join(project.stateDir, "enabled-projects.json.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, token: "stale" }));
    reclaimStale(lockPath, { beforeStaleUnlink: () => {
      rmSync(lockPath);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "replacement" }));
    } });
    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("replacement");
  });

  it("does not unlink a replacement published after a competing reclaimer removes the stale inode", () => {
    const project = fixture();
    const lockPath = path.join(project.stateDir, "enabled-projects.json.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, token: "stale" }));
    let competingResult = false;

    const result = reclaimStale(lockPath, { beforeStaleUnlink: () => {
      competingResult = reclaimStale(lockPath);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "replacement" }));
    } });

    expect({ result, competingResult, token: JSON.parse(readFileSync(lockPath, "utf8")).token }).toEqual({
      result: false,
      competingResult: true,
      token: "replacement",
    });
  });
});
