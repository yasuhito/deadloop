import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { MAX_ORIGIN_IDENTITIES, assertEnabled, withEnabledProjectLock } = require("../src/enabled-operation.cjs");
const {
  DISABLE_LOCK_ATTEMPTS,
  DISABLE_LOCK_DELAY_MS,
  MAX_GUARDED_LAUNCH_DURATION_MS,
  assertDriverEnabled,
  withEnabledDriverLaunch,
} = require("../src/driver-enablement.cjs");
const { acquireLockSync, reclaimStale } = require("../src/enablement-lock.cjs");
const { GUARDED_OPERATION_TIMEOUT_MS, runGuarded } = require("../extensions/deadloop/automations/guarded-operation.ts");
const { runGuardedPush } = require("../extensions/deadloop/automations/guarded-push.ts");
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
  writeFileSync(ghPath, `#!/bin/sh
printf '%s\\n' "$*" >> '${ghCallsPath}'
printf '{"id":"%s"}\\n' "$(cat '${repositoryIdPath}')"
`);
  execFileSync("chmod", ["+x", ghPath]);
  process.env.PATH = `${binDir}:${originalPath || ""}`;
  execFileSync("git", ["-C", repoPath, "init", "--quiet"]);
  execFileSync("git", ["-C", repoPath, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  return { repoPath, stateDir, githubRepo: "owner/repo", repositoryIdPath, ghCallsPath };
}

function writeState(project: ReturnType<typeof fixture>, record: Record<string, unknown>, withSafetyFields = true) {
  const safetyFields = withSafetyFields
    ? { githubRepositoryId: "R_repo", firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false, autoMergeAcknowledged: false, enabled: true }
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

  it("lets disable outwait the maximum authorization and multi-command launch duration", () => {
    expect(DISABLE_LOCK_ATTEMPTS * DISABLE_LOCK_DELAY_MS).toBeGreaterThan(MAX_GUARDED_LAUNCH_DURATION_MS);
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
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, command: ["mutation"] },
      (_command: string, _args: string[], options: { timeout?: number }) => {
        timeout = options.timeout;
        return { status: 0 };
      },
    );

    expect(timeout).toBe(GUARDED_OPERATION_TIMEOUT_MS);
  });

  it("rejects git push through the generic guarded operation", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    expect(() => runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, command: ["git", "push", "origin"] },
    )).toThrow("guarded-push.ts");
  });

  it("pushes to the verified URL even if origin changes after authorization", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    let pushedDestination = "";
    const ops = { run: (args: string[]) => {
      if (args.includes("get-url")) return { status: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
      if (args[0] === "gh") return { status: 0, stdout: '{"id":"R_repo"}', stderr: "" };
      pushedDestination = args[5] || "";
      execFileSync("git", ["-C", project.repoPath, "remote", "set-url", "origin", "https://github.com/attacker/wrong.git"]);
      return { status: 0, stdout: "", stderr: "" };
    } };

    runGuardedPush({ projectRepo: project.repoPath, worktree: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, enabledAt: 1, remote: "origin", branch: "agent/test" }, ops);

    expect(pushedDestination).toBe("https://github.com/owner/repo.git");
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
});
