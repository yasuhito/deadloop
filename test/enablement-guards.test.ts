import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { assertEnabled, withEnabledProjectLock } = require("../src/enabled-operation.cjs");
const { assertDriverEnabled, withEnabledDriverLaunch } = require("../src/driver-enablement.cjs");
const { acquireLockSync, reclaimStale } = require("../src/enablement-lock.cjs");
const { GUARDED_OPERATION_TIMEOUT_MS, runGuarded } = require("../extensions/deadloop/automations/guarded-operation.ts");
const originalConfigDir = process.env.PI_CODING_AGENT_DIR;
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
  execFileSync("git", ["-C", repoPath, "init", "--quiet"]);
  execFileSync("git", ["-C", repoPath, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  return { repoPath, stateDir, githubRepo: "owner/repo" };
}

function writeState(project: ReturnType<typeof fixture>, record: Record<string, unknown>) {
  writeFileSync(path.join(project.stateDir, "enabled-projects.json"), JSON.stringify({ projects: [{ repoPath: project.repoPath, githubRepo: project.githubRepo, ...record }] }));
}

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalConfigDir;
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe("enablement mutation guards", () => {
  for (const [name, record] of [
    ["missing enabledAt", {}],
    ["invalid enabledAt", { enabledAt: "now" }],
    ["invalid optional field", { enabledAt: 1, autoMergeAcknowledged: "yes" }],
  ] as const) {
    it(`rejects ${name} through guarded operations`, () => {
      const project = fixture();
      writeState(project, record);
      expect(() => assertEnabled(project)).toThrow("disabled");
    });

    it(`rejects ${name} through driver authorization`, () => {
      const project = fixture();
      writeState(project, record);
      expect(() => assertDriverEnabled(project)).toThrow("disabled");
    });
  }

  it("does not mutate when disable wins after an earlier driver authorization", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    assertDriverEnabled(project);
    writeState(project, { enabledAt: 1, enabled: false });
    let mutated = false;
    try { withEnabledProjectLock(project, () => { mutated = true; }); } catch {}
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
        project,
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

  it("bounds the command while holding the enablement lock", () => {
    const project = fixture();
    writeState(project, { enabledAt: 1 });
    let timeout: number | undefined;

    runGuarded(
      { projectRepo: project.repoPath, githubRepo: project.githubRepo, stateDir: project.stateDir, command: ["mutation"] },
      (_command: string, _args: string[], options: { timeout?: number }) => {
        timeout = options.timeout;
        return { status: 0 };
      },
    );

    expect(timeout).toBe(GUARDED_OPERATION_TIMEOUT_MS);
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
