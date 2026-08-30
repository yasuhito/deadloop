import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { acquireLockSync, cleanupStalePending, pendingLockFiles, processStartIdentity, releaseOwned } = require("../src/enablement-lock.cjs");

function unavailableProc(): never {
  throw new Error("/proc unavailable");
}

describe("portable enablement lock identity", () => {
  it("uses ps start time when procfs is unavailable on Unix", () => {
    const identity = processStartIdentity(42, {
      platform: "darwin",
      readFileSync: unavailableProc,
      spawnSync: () => ({ status: 0, stdout: "Mon Mar  2 10:20:30 2026\n" }),
    });

    expect(identity).toBe("darwin:Mon Mar  2 10:20:30 2026");
  });

  it("uses PowerShell start ticks when procfs is unavailable on Windows", () => {
    const identity = processStartIdentity(42, {
      platform: "win32",
      readFileSync: unavailableProc,
      spawnSync: () => ({ status: 0, stdout: "639080148300000000\r\n" }),
    });

    expect(identity).toBe("win32:639080148300000000");
  });
});

function esrchKill(): never {
  const error = new Error("no such process");
  (error as unknown as { code: string }).code = "ESRCH";
  throw error;
}

const startIdentity = "darwin:Mon Mar  2 10:20:30 2026";
const aliveHooks = {
  kill: () => undefined,
  platform: "darwin",
  readFileSync: unavailableProc,
  spawnSync: () => ({ status: 0, stdout: "Mon Mar  2 10:20:30 2026\n" }),
};
const deadHooks = { ...aliveHooks, kill: esrchKill };

const sandboxes: string[] = [];

function lockSandbox(): { lockPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deadloop-pending-lock-"));
  sandboxes.push(dir);
  return { lockPath: path.join(dir, "enabled-projects.json.lock") };
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("enablement lock pending temp files", () => {
  it("leaves no pending temp file after a failed lock acquisition", () => {
    const { lockPath } = lockSandbox();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startIdentity, token: "held" }));

    expect(() => acquireLockSync(lockPath, { attempts: 1, delayMs: 1, hooks: aliveHooks })).toThrow(/busy/);

    expect(pendingLockFiles(lockPath)).toEqual([]);
  });

  it("removes a dead owner's pending temp file at the next lock acquisition", () => {
    const { lockPath } = lockSandbox();
    const pendingPath = `${lockPath}.64999.dead-token.pending`;
    writeFileSync(pendingPath, JSON.stringify({ pid: 64999, startIdentity, token: "dead-token" }));

    const lock = acquireLockSync(lockPath, { attempts: 1, delayMs: 1, hooks: deadHooks });
    releaseOwned(lockPath, lock.token);

    expect(existsSync(pendingPath)).toBe(false);
  });

  it("keeps a live owner's pending temp file at the next lock acquisition", () => {
    const { lockPath } = lockSandbox();
    const pendingPath = `${lockPath}.64999.live-token.pending`;
    writeFileSync(pendingPath, JSON.stringify({ pid: 64999, startIdentity, token: "live-token" }));

    const lock = acquireLockSync(lockPath, { attempts: 1, delayMs: 1, hooks: aliveHooks });
    releaseOwned(lockPath, lock.token);

    expect(existsSync(pendingPath)).toBe(true);
  });

  it("removes an unreadable pending temp file only after the grace age", () => {
    const { lockPath } = lockSandbox();
    const pendingPath = `${lockPath}.64999.empty.pending`;
    writeFileSync(pendingPath, "");

    expect(cleanupStalePending(lockPath, deadHooks)).toBe(0);

    const past = new Date(Date.now() - 5_000);
    utimesSync(pendingPath, past, past);
    expect(cleanupStalePending(lockPath, deadHooks)).toBe(1);
    expect(existsSync(pendingPath)).toBe(false);
  });
});
