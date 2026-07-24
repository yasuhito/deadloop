import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { acquireSchedulerLock, releaseSchedulerLock } = require("../src/scheduler-lock.cjs");
const sandboxes: string[] = [];

function lockFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-scheduler-lock-"));
  sandboxes.push(root);
  mkdirSync(root, { recursive: true });
  return path.join(root, "scheduler.lock");
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe("scheduler lock", () => {
  it("lets only one contender acquire while the original creator is delayed before publication", () => {
    const lockPath = lockFixture();
    let contender: ReturnType<typeof acquireSchedulerLock> | undefined;

    const creator = acquireSchedulerLock(lockPath, {}, {
      beforePublish: () => { contender = acquireSchedulerLock(lockPath, {}); },
    });

    expect([creator, contender].filter((result) => result?.acquired)).toHaveLength(1);
  });

  it("does not delete a replacement lock installed by another contender during stale reclamation", () => {
    const lockPath = lockFixture();
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, token: "stale" }));

    acquireSchedulerLock(lockPath, {}, { beforeStaleUnlink: () => {
      rmSync(lockPath);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "contender-a" }));
    } });

    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("contender-a");
  });

  it("does not release a lock now owned by a different token", () => {
    const lockPath = lockFixture();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "replacement" }));

    releaseSchedulerLock(lockPath, "original");

    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("replacement");
  });
});
