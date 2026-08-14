import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { AGENT_SCRATCH_AREAS } = require("../src/agent-scratch-area.cjs");
const { runProjectCheck } = require("../src/project-check.ts");

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

/** A worktree holding one file per agent scratch area, plus a shared project resource. */
function scenario(): { cwd: string; quarantineRoot: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-quarantine-"));
  sandboxes.push(root);
  const cwd = path.join(root, "worktree");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  for (const scratchArea of AGENT_SCRATCH_AREAS) {
    mkdirSync(path.join(cwd, scratchArea), { recursive: true });
    writeFileSync(path.join(cwd, scratchArea, "evidence"), `${scratchArea}\n`);
  }
  writeFileSync(path.join(cwd, ".pi", "settings.json"), '{"kept":true}\n');
  return { cwd, quarantineRoot: path.join(root, "quarantine") };
}

/** Records what the check command could see, then reports what survived it. */
async function check(command: string): Promise<{ cwd: string; seen: string; code: number }> {
  const { cwd, quarantineRoot } = scenario();
  const result = await runProjectCheck({ cwd, command, quarantineRoot, timeoutMs: 20_000 });
  return { cwd, seen: result.stdout, code: result.code };
}

describe("the project-check quarantine hides agent scratch areas", () => {
  it.each(AGENT_SCRATCH_AREAS)("hides %s from the check command", async (scratchArea: string) => {
    const { seen } = await check(`ls -d ${scratchArea} 2>/dev/null || echo absent`);
    expect(seen.trim()).toBe("absent");
  });

  it.each(AGENT_SCRATCH_AREAS)("restores %s after the check command", async (scratchArea: string) => {
    const { cwd } = await check("true");
    expect(readFileSync(path.join(cwd, scratchArea, "evidence"), "utf8")).toBe(`${scratchArea}\n`);
  });

  it("leaves the shared project resource beside the scratch areas in place", async () => {
    const { seen } = await check("cat .pi/settings.json");
    expect(seen.trim()).toBe('{"kept":true}');
  });

  it("restores a scratch area whose parent the check command removed", async () => {
    const { cwd } = await check("rm -rf .pi");
    expect(existsSync(path.join(cwd, ".pi", "subagents", "evidence"))).toBe(true);
  });
});
