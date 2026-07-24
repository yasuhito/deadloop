import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const sandboxes: string[] = [];

function mutationRanAfterDisable(monitor: string, useFabricatedState = false): boolean {
  const root = mkdtempSync(path.join(os.tmpdir(), `deadloop-${monitor}-monitor-`));
  sandboxes.push(root);
  const configDir = path.join(root, "config");
  const stateDir = path.join(configDir, "deadloop");
  const repoPath = path.join(root, "repo");
  const marker = path.join(root, "mutation-ran");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(repoPath);
  writeFileSync(
    path.join(stateDir, "enabled-projects.json"),
    JSON.stringify({ projects: [{ repoPath, githubRepo: "owner/repo", enabledAt: 1, firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false, autoMergeAcknowledged: false, enabled: false }] }),
  );
  const suppliedStateDir = useFabricatedState ? path.join(root, "fabricated-state") : stateDir;
  if (useFabricatedState) {
    mkdirSync(suppliedStateDir);
    writeFileSync(
      path.join(suppliedStateDir, "enabled-projects.json"),
      JSON.stringify({ projects: [{ repoPath, githubRepo: "owner/repo", enabledAt: 1, firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false, autoMergeAcknowledged: false, enabled: true }] }),
    );
  }
  const result = spawnSync(
    "node",
    [
      "extensions/deadloop/automations/guarded-operation.ts",
      "--project-repo", repoPath,
      "--github-repo", "owner/repo",
      "--state-dir", suppliedStateDir,
      "--",
      "node", "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: configDir } },
  );
  if (result.status !== 2) throw new Error(result.stderr || result.stdout);
  return existsSync(marker);
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe("pending monitor disable integration", () => {
  it("stops a pending issue monitor mutation after disable", () => {
    expect(mutationRanAfterDisable("issue")).toBe(false);
  });

  it("stops a pending reviewer monitor mutation after disable", () => {
    expect(mutationRanAfterDisable("reviewer")).toBe(false);
  });

  it("stops a pending branch-update monitor mutation after disable", () => {
    expect(mutationRanAfterDisable("branch-update")).toBe(false);
  });

  it("stops a pending repair monitor mutation after disable", () => {
    expect(mutationRanAfterDisable("repair")).toBe(false);
  });

  it("rejects a fabricated enabled state directory when canonical state is disabled", () => {
    expect(mutationRanAfterDisable("fabricated", true)).toBe(false);
  });
});
