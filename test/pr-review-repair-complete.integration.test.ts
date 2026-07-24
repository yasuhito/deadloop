import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);
const key = "abcdef1234567890abcd";

function runCompletion(options: {
  promise: Record<string, unknown>;
  receipt?: Record<string, unknown> | string;
  comments?: { body: string }[];
  liveHead?: string;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-repair-complete-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const promiseFile = path.join(root, "promise.json");
  const resultFile = path.join(root, "result.json");
  const contractFile = path.join(root, "contract.json");
  const postedFile = path.join(root, "posted.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(promiseFile, JSON.stringify(options.promise));
  fs.writeFileSync(
    contractFile,
    JSON.stringify({ attemptKey: key, expectedHead: oldHead, findingTitles: ["Unsafe fallback"] }),
  );
  if (options.receipt) {
    fs.writeFileSync(resultFile, typeof options.receipt === "string" ? options.receipt : JSON.stringify(options.receipt));
  }
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({state:"OPEN",headRefOid:"${options.liveHead || newHead}",labels:[{name:"agent:reviewing"}],comments:${JSON.stringify(options.comments || [])}}));
if (args[0] === "pr" && args[1] === "comment") fs.writeFileSync(process.env.POSTED_FILE, args[args.indexOf("--body") + 1]);
`,
  );
  fs.chmodSync(gh, 0o755);
  const result = spawnSync(
    "node",
    [
      "extensions/deadloop/automations/pr-review-repair-complete.ts",
      "--promise",
      promiseFile,
      "--result",
      resultFile,
      "--contract",
      contractFile,
      "--github-repo",
      "owner/repo",
      "--pr",
      "24",
      "--expected-head",
      oldHead,
      "--attempt-key",
      key,
      "--reviewing-label",
      "agent:reviewing",
      "--blocked-label",
      "agent:blocked",
    ],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, POSTED_FILE: postedFile } },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return { output: JSON.parse(result.stdout), posted: fs.existsSync(postedFile) ? fs.readFileSync(postedFile, "utf8") : "" };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("review repair deterministic completion", () => {
  it("posts success after the promise, finalizer receipt, and live head agree", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
    });

    expect(result.posted).toContain(`New commit: \`${newHead}\``);
  });

  it("turns a malformed finalizer receipt into recovery instead of an exception", () => {
    const result = runCompletion({
      promise: { status: "blocked", reason: "check_failed", summary: "checks stopped" },
      receipt: "{",
    });

    expect(result.output.driverAction).toBe("repair_human_blocked");
  });

  it("does not post repair success for stale_head", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
      receipt: { action: "stale_head", originalHeadOid: oldHead },
    });

    expect(result.posted).toBe("");
  });

  it("requires recovery when stale_head has no finalizer receipt", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
    });

    expect(result.output.driverAction).toBe("repair_human_blocked");
  });

  it("requires recovery when stale_head receipt names a different original head", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
      receipt: { action: "stale_head", originalHeadOid: "c".repeat(40) },
    });

    expect(result.output.driverAction).toBe("repair_human_blocked");
  });

  it("requires recovery when stale_head is reported but the live head did not change", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
      receipt: { action: "stale_head", originalHeadOid: oldHead },
      liveHead: oldHead,
    });

    expect(result.output.driverAction).toBe("repair_human_blocked");
  });

  it("requires recovery when a pushed receipt and live head are unchanged", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: oldHead, checks },
      liveHead: oldHead,
    });

    expect(result.output.driverAction).toBe("repair_human_blocked");
  });

  it("does not duplicate an existing repair result comment", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      comments: [{ body: `<!-- deadloop:review-repair-result key=${key} head=${newHead} -->` }],
    });

    expect(result.output.driverAction).toBe("repair_result_duplicate");
  });
});
