import { spawnSync } from "node:child_process";
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

    const winner = [creator, contender].find((result) => result?.acquired)!;
    releaseSchedulerLock(lockPath, winner.token);
    expect([creator, contender].filter((result) => result?.acquired)).toHaveLength(1);
  });

  it("lets a child host acquire the OS lock", () => {
    const lockPath = lockFixture();
    const script = `const lock=require(${JSON.stringify(path.resolve("src/scheduler-lock.cjs"))}); const result=lock.acquireSchedulerLock(process.argv[1],{}); if(!result.acquired) process.exit(2);`;

    expect(spawnSync(process.execPath, ["-e", script, lockPath]).status).toBe(0);
  });

  it("lets another host acquire after process exit releases the OS lock", () => {
    const lockPath = lockFixture();
    const script = `const lock=require(${JSON.stringify(path.resolve("src/scheduler-lock.cjs"))}); const result=lock.acquireSchedulerLock(process.argv[1],{}); if(!result.acquired) process.exit(2);`;
    spawnSync(process.execPath, ["-e", script, lockPath]);

    const acquired = acquireSchedulerLock(lockPath, {});
    releaseSchedulerLock(lockPath, acquired.token);

    expect(acquired.acquired).toBe(true);
  });

  it("does not release a lock now owned by a different token", () => {
    const lockPath = lockFixture();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "replacement" }));

    releaseSchedulerLock(lockPath, "original");

    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("replacement");
  });
});
