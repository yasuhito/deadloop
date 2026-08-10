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
const { renderReviewClaimComment } = require("../extensions/deadloop/automations/pr-review-claim.ts");
const { assertWorkerHead, assertWorkerPushBinding, parseArgs: parseGuardedPushArgs, runGuardedPush } = require("../extensions/deadloop/automations/guarded-push.ts");
const originalConfigDir = process.env.PI_CODING_AGENT_DIR;
const originalPath = process.env.PATH;
const sandboxes: string[] = [];
const activeReviewState = {
  managedLabels: ["agent:review", "agent:reviewing", "agent:implement", "agent:update-branch", "agent:in-progress", "agent:blocked"],
  requestLabel: "agent:review",
  requiredLabels: ["agent:in-progress"],
};
const currentReviewConfiguration = {
  reviewerMaxRuntimeSeconds: 86400,
  cleanupGraceSeconds: 300,
  authoritySeconds: 86700,
  managedLabels: activeReviewState.managedLabels,
  requestLabel: "agent:review",
  requiredLabels: ["agent:in-progress"],
  repositoryId: "R_repo",
  repository: "owner/repo",
  authorizedLogins: ["deadloop-bot"],
  authenticatedLogin: "deadloop-bot",
  reviewerAgent: "pi",
};

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

  it("rejects a reused repository name after the enabled repository transfers", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1, githubAliases: ["owner/repo"] });
    writeFileSync(project.repositoryIdPath, "R_reused\n");

    expect(() => assertEnabled(project)).toThrow("disabled");
  });

  it("rejects a reused persisted mutation namespace after the origin follows a rename", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1, githubAliases: ["owner/renamed"] });
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

  it("can persist a winning GitHub claim before creating its attempt journal", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const events: string[] = [];

    withEnabledDriverLaunch(
      { ...project, enabledAt: 1 },
      () => events.push("github-claim"),
      () => events.push("launched"),
      {
        claimBeforePrepare: true,
        revalidate: () => events.push("revalidated"),
        prepareAttempt: () => events.push("prepared"),
        recordClaim: () => events.push("claim-recorded"),
      },
    );

    expect(events).toEqual(["revalidated", "github-claim", "revalidated", "prepared", "claim-recorded", "launched"]);
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
        { prepareAttempt: () => events.push("prepared"), recordClaim: () => events.push("claim-recorded") },
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

  it("rejects a guarded PR mutation without an active claim", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });

    expect(() => runGuarded({
      projectRepo: project.repoPath,
      githubRepo: project.githubRepo,
      stateDir: project.stateDir,
      enabledAt: 1,
      targetKind: "pull-request",
      command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"],
    })).toThrow("saved attempt record is required");
  });

  it("rejects a guarded PR mutation disguised as an issue target without an active claim", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });

    expect(() => runGuarded({
      projectRepo: project.repoPath,
      githubRepo: project.githubRepo,
      stateDir: project.stateDir,
      enabledAt: 1,
      targetKind: "issue",
      command: ["gh", "issue", "comment", "24", "-R", project.githubRepo, "--body", "done"],
    }, (_command: string, args: string[]) => ({
      status: 0,
      stdout: args[0] === "api" ? JSON.stringify({ number: 24, pull_request: { url: "https://api.github.test/pulls/24" } }) : "",
      stderr: "",
    }))).toThrow("exact non-PR issue target");
  });

  it("rejects a guarded PR mutation for another claim target", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const reviewClaim = {
      binding: { targetNumber: 24 },
    };

    expect(() => runGuarded({
      projectRepo: project.repoPath,
      githubRepo: project.githubRepo,
      stateDir: project.stateDir,
      enabledAt: 1,
      targetKind: "pull-request",
      attemptRecord: path.join(project.stateDir, "runs", "reviewer", "attempt.json"),
      reviewClaim,
      command: ["gh", "pr", "comment", "25", "-R", project.githubRepo, "--body", "done"],
    }, () => { throw new Error("unexpected command"); }, () => reviewClaim)).toThrow("claim target does not match");
  });

  it("authorizes a guarded mutation when the active claim is on a later REST page", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const head = "a".repeat(40);
    const binding = {
      repositoryId: "R_repo", repository: project.githubRepo, targetNumber: 24, requestEventId: "22", role: "reviewer", revision: head, owner: "host-a",
      authority: { durationSeconds: 86700 }, activeState: activeReviewState,
    };
    const claim = { id: 101, created_at: "2026-07-20T10:01:00Z", updated_at: "2026-07-20T10:01:00Z", user: { login: "deadloop-bot" }, body: renderReviewClaimComment(binding) };
    const reviewClaim = {
      binding, commentId: "101", authorizedLogins: ["deadloop-bot"], automationLogin: "deadloop-bot", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    let mutated = false;
    runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord: path.join(project.stateDir, "runs", "reviewer", "attempt.json"), reviewClaim, command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"] },
      (_command: string, args: string[]) => {
        if (args[0] === "api" && args[1] === "user") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
        if (args[0] === "repo" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: project.githubRepo }), stderr: "" };
        if (args[0] === "pr" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] }), stderr: "" };
        if (args.some((arg) => arg.endsWith("/events"))) return { status: 0, stdout: JSON.stringify([[], [{ id: 22, event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } }]]), stderr: "" };
        if (args.some((arg) => arg.endsWith("/comments"))) return { status: 0, stdout: JSON.stringify([[], [claim]]), stderr: "" };
        if (args[0] === "api") return { status: 0, stdout: "date: Mon, 20 Jul 2026 10:03:00 GMT", stderr: "" };
        mutated = true;
        return { status: 0, stdout: "", stderr: "" };
      },
      () => reviewClaim,
      () => currentReviewConfiguration,
    );

    expect(mutated).toBe(true);
  });

  function guardedDateFailureScenario(editClaim = false, expireAfterObservations = false) {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const head = "a".repeat(40);
    const binding = {
      repositoryId: "R_repo", repository: project.githubRepo, targetNumber: 24, requestEventId: "22", role: "reviewer", revision: head, owner: "host-a",
      authority: { durationSeconds: 86700 }, activeState: activeReviewState,
    };
    const claim = { id: 101, created_at: "2026-07-20T10:01:00Z", updated_at: editClaim ? "2026-07-20T10:02:00Z" : "2026-07-20T10:01:00Z", user: { login: "deadloop-bot" }, body: renderReviewClaimComment(binding) };
    const comments: Record<string, unknown>[] = [claim];
    const labels = ["agent:in-progress", "customer:keep"];
    const mutations: string[] = [];
    let observationComplete = false;
    const reviewClaim = {
      binding, commentId: "101", authorizedLogins: ["deadloop-bot"], automationLogin: "deadloop-bot", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    try {
      runGuarded(
        { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord: path.join(project.stateDir, "runs", "reviewer", "attempt.json"), reviewClaim, command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "requested"] },
        (_command: string, args: string[]) => {
          if (args[0] === "api" && args[1] === "user") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
          if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: project.githubRepo }), stderr: "" };
          if (args[0] === "pr" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: head, labels: labels.map((name) => ({ name })) }), stderr: "" };
          if (args.some((arg) => arg.endsWith("/events"))) return { status: 0, stdout: JSON.stringify([[{ id: 22, event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } }]]), stderr: "" };
          if (args.some((arg) => arg.endsWith("/comments"))) {
            observationComplete = true;
            return { status: 0, stdout: JSON.stringify([comments]), stderr: "" };
          }
          if (args[0] === "api") return {
            status: 0,
            stdout: expireAfterObservations && observationComplete ? "date: Tue, 21 Jul 2026 10:06:01 GMT" : "",
            stderr: "",
          };
          if (args[0] === "pr" && args[1] === "comment") {
            mutations.push(String(args.at(-1)) === "requested" ? "requested" : "visible-comment");
            comments.push({ id: 102, body: String(args.at(-1)) });
          }
          if (args[0] === "pr" && args[1] === "edit") {
            mutations.push("blocked");
            labels.push("agent:blocked");
          }
          return { status: 0, stdout: "", stderr: "" };
        },
        () => reviewClaim,
        () => currentReviewConfiguration,
      );
    } catch {}
    return { mutations, labels };
  }

  it("performs no generic mutation when the claim expires while observations are being collected", () => {
    expect(guardedDateFailureScenario(false, true).mutations).toEqual([]);
  });

  it("visibly blocks a generic guarded PR mutation when only REST Date is unavailable", () => {
    expect(guardedDateFailureScenario().mutations).toEqual(["visible-comment", "blocked"]);
  });

  it("performs no generic GitHub mutation when the claim is edited and REST Date is unavailable", () => {
    expect(guardedDateFailureScenario(true).mutations).toEqual([]);
  });

  it("preserves unrelated labels while visibly blocking a guarded Date failure", () => {
    expect(guardedDateFailureScenario().labels).toEqual(["agent:in-progress", "customer:keep", "agent:blocked"]);
  });

  it.each([
    ["comment", ["gh", "pr", "comment", "24", "-R", "owner/repo", "--body", "done"]],
    ["label/ready", ["gh", "pr", "edit", "24", "-R", "owner/repo", "--remove-label", "agent:in-progress"]],
  ] as const)("blocks generic guarded %s mutations for every current activation race", (_seam, command) => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const head = "a".repeat(40);
    const binding = {
      repositoryId: "R_repo", repository: project.githubRepo, targetNumber: 24, requestEventId: "22", role: "reviewer", revision: head, owner: "host-a",
      authority: { durationSeconds: 86700 }, activeState: activeReviewState,
    };
    const reviewClaim = {
      binding, commentId: "101", authorizedLogins: ["deadloop-bot"], automationLogin: "deadloop-bot", reviewerAgent: "pi",
      reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    let mutated = false;
    const failures = [
      { ...currentReviewConfiguration, reviewerMaxRuntimeSeconds: 80000, authoritySeconds: 80300 },
      { ...currentReviewConfiguration, cleanupGraceSeconds: 100, authoritySeconds: 86500 },
      { ...currentReviewConfiguration, requestLabel: "custom:review" },
      { ...currentReviewConfiguration, authorizedLogins: ["other-bot"] },
      { ...currentReviewConfiguration, authenticatedLogin: "other-bot" },
    ];
    const results = failures.map((configuration) => {
      mutated = false;
      let error = "";
      try {
        runGuarded(
          { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord: path.join(project.stateDir, "runs", "reviewer", "attempt.json"), reviewClaim, command: [...command] },
          (_command: string, args: string[]) => {
            if (args[0] === "api" && args[1] === "user") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
            mutated = true;
            return { status: 0, stdout: "", stderr: "" };
          },
          () => reviewClaim,
          () => configuration,
        );
      } catch (caught) { error = String(caught); }
      return { error: error.includes("current enablement"), mutated };
    });

    expect(results).toEqual(failures.map(() => ({ error: true, mutated: false })));
  });

  it("suppresses a generic PR mutation when the winning comment disappears during final inspection", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    const head = "a".repeat(40);
    const binding = {
      repositoryId: "R_repo", repository: project.githubRepo, targetNumber: 24, requestEventId: "22", role: "reviewer", revision: head, owner: "host-a",
      authority: { durationSeconds: 86700 }, activeState: activeReviewState,
    };
    const reviewClaim = {
      binding, commentId: "101", authorizedLogins: ["deadloop-bot"], automationLogin: "deadloop-bot", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };

    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, targetKind: "pull-request", attemptRecord: path.join(project.stateDir, "runs", "reviewer", "attempt.json"), reviewClaim, command: ["gh", "pr", "comment", "24", "-R", project.githubRepo, "--body", "done"] },
      (_command: string, args: string[]) => {
        if (args[0] === "api" && args[1] === "user") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: project.githubRepo }), stderr: "" };
        if (args[0] === "pr") return { status: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] }), stderr: "" };
        if (args.some((arg) => arg.endsWith("/events"))) return { status: 0, stdout: JSON.stringify([[{ id: 22, event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } }]]), stderr: "" };
        if (args.some((arg) => arg.endsWith("/comments"))) return { status: 0, stdout: "[[]]", stderr: "" };
        return { status: 0, stdout: "date: Mon, 20 Jul 2026 10:03:00 GMT", stderr: "" };
      },
      () => reviewClaim,
      () => currentReviewConfiguration,
    )).toThrow("reauthorized");
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
