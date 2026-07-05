import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const launcher = path.join(process.cwd(), "extensions/pi-looper/automations/launch-agent.ts");

let sandbox: string;
let binDir: string;
let homeDir: string;
let worktree: string;
let promptFile: string;
let argvOut: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "launch-agent-"));
  binDir = path.join(sandbox, "bin");
  homeDir = path.join(sandbox, "home");
  worktree = path.join(sandbox, "wt");
  promptFile = path.join(sandbox, "prompt.md");
  argvOut = path.join(sandbox, "argv.json");
  fs.mkdirSync(binDir);
  fs.mkdirSync(homeDir);
  fs.mkdirSync(worktree);

  // A fake herdr on PATH that records the exact argv it received as JSON. Because
  // the launcher spawns it without a shell, every argument arrives verbatim.
  const fakeHerdr = [
    "#!/usr/bin/env node",
    `require("node:fs").writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));`,
    'process.stdout.write(JSON.stringify({ ok: true, result: { tab: { tab_id: "t1" } } }));',
  ].join("\n");
  fs.writeFileSync(path.join(binDir, "herdr"), fakeHerdr, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function trustWorktree(): void {
  fs.writeFileSync(
    path.join(homeDir, ".claude.json"),
    JSON.stringify({ projects: { [worktree]: { hasTrustDialogAccepted: true } } }),
  );
}

function run(args: string[], env: Record<string, string> = {}): { status: number; recorded: string[] | null } {
  let status = 0;
  try {
    execFileSync("node", [launcher, ...args], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, ...env },
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    status = (error as { status?: number }).status ?? 1;
  }
  const recorded = fs.existsSync(argvOut) ? (JSON.parse(fs.readFileSync(argvOut, "utf8")) as string[]) : null;
  return { status, recorded };
}

describe("launch-agent integration", () => {
  it("passes the pi launch argv to herdr without a shell", () => {
    fs.writeFileSync(promptFile, "prompt body");
    const { recorded } = run([
      "--agent", "pi", "--name", "demo-worker", "--cwd", worktree, "--level", "medium",
      "--prompt-file", promptFile, "--tab", "t1",
    ]);

    expect(recorded).toEqual([
      "agent", "start", "demo-worker", "--cwd", worktree, "--no-focus", "--tab", "t1",
      "--", "pi", "--name", "demo-worker", "--thinking", "medium", `@${promptFile}`,
    ]);
  });

  it("delivers a prompt containing shell metacharacters as one intact argument", () => {
    trustWorktree();
    const payload = 'line1 "quoted" $VAR `backtick` end';
    fs.writeFileSync(promptFile, payload);
    const { recorded } = run([
      "--agent", "claude", "--name", "demo-worker", "--cwd", worktree, "--level", "high",
      "--uuid", "U-1", "--prompt-file", promptFile,
    ]);

    expect(recorded?.at(-1)).toBe(payload);
  });

  it("does not start herdr when claude workspace trust is confirmed unaccepted", () => {
    fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({ projects: {} }));
    fs.writeFileSync(promptFile, "body");
    const { recorded } = run([
      "--agent", "claude", "--name", "w", "--cwd", worktree, "--level", "high",
      "--uuid", "U", "--prompt-file", promptFile,
    ]);

    expect(recorded).toBeNull();
  });

  it("starts herdr anyway when claude workspace trust cannot be determined", () => {
    fs.writeFileSync(promptFile, "body");
    const { recorded } = run([
      "--agent", "claude", "--name", "w", "--cwd", worktree, "--level", "high",
      "--uuid", "U", "--prompt-file", promptFile,
    ]);

    expect(recorded).not.toBeNull();
  });
});
