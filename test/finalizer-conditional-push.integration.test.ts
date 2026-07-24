import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { finalizeReviewRepair } = require("../extensions/deadloop/automations/pr-review-repair-finalize.ts");
const { finalizeBranchUpdate } = require("../extensions/deadloop/automations/pr-branch-update-finalize.ts");

const sandboxes: string[] = [];
const branch = "agent/issue-1";
const ref = `refs/heads/${branch}`;

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-finalizer-push-"));
  sandboxes.push(root);
  const repo = path.join(root, "repo");
  const remote = path.join(root, "origin.git");
  mkdirSync(repo);
  git(repo, ["init", "--quiet"]);
  git(repo, ["checkout", "--quiet", "-b", branch]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "file.txt"), "root\n");
  git(repo, ["add", "file.txt"]);
  git(repo, ["commit", "--quiet", "-m", "root"]);
  const rootOid = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(repo, "file.txt"), "expected\n");
  git(repo, ["commit", "--quiet", "-am", "expected"]);
  const expectedHead = git(repo, ["rev-parse", "HEAD"]);
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  execFileSync("git", ["-C", repo, "push", "--quiet", remote, `${expectedHead}:${ref}`]);
  writeFileSync(path.join(repo, "file.txt"), "candidate\n");
  git(repo, ["commit", "--quiet", "-am", "candidate"]);
  const configPath = path.join(root, ".gitconfig");
  writeFileSync(configPath, `[url "file://${remote}"]\n\tinsteadOf = https://github.com/owner/repo.git\n`);
  return { repo, remote, rootOid, expectedHead, configPath };
}

function runRace(finalizer: "repair" | "branch-update", race: "delete" | "rewind") {
  const { repo, remote, rootOid, expectedHead, configPath } = fixture();
  const hookPath = path.join(repo, ".git", "hooks", "pre-push");
  const updateRef = race === "delete"
    ? `git --git-dir='${remote}' update-ref -d '${ref}'`
    : `git --git-dir='${remote}' update-ref '${ref}' '${rootOid}'`;
  writeFileSync(hookPath, `#!/bin/sh\n${updateRef}\n`);
  chmodSync(hookPath, 0o755);
  const run = (args: string[]) => {
    if (args[0] === "node") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "git" && args.includes("get-url")) {
      return { status: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
    }
    if (args[0] === "gh" && args[1] === "pr") {
      return {
        status: 0,
        stdout: JSON.stringify({ state: "OPEN", isCrossRepository: false, headRefName: branch, headRefOid: expectedHead }),
        stderr: "",
      };
    }
    if (args[0] === "gh" && args[1] === "repo") {
      return { status: 0, stdout: JSON.stringify({ id: "R_repo" }), stderr: "" };
    }
    const result = spawnSync(args[0], args.slice(1), {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: configPath, GIT_CONFIG_NOSYSTEM: "1" },
    });
    return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
  };
  const common = {
    repo,
    projectRepo: repo,
    githubRepo: "owner/repo",
    pr: "1",
    branch,
    expectedHead,
    remote: "origin",
    automationDir: "/automation",
    stateDir: "/state",
    enabledAt: 1,
    checkCommand: "true",
  };
  const ops = {
    run,
    assertEnabled: () => ({ githubRepo: "owner/repo", githubRepositoryId: "R_repo" }),
  };
  const result = finalizer === "repair"
    ? finalizeReviewRepair(common, ops)
    : finalizeBranchUpdate({ ...common, expectedBase: rootOid }, ops);
  let remoteHead = "";
  try {
    remoteHead = execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", ref], { encoding: "utf8" }).trim();
  } catch {}
  return { action: result.action, remoteHead, rootOid };
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe("finalizer exact-head pushes against real remotes", () => {
  it.each([
    ["review repair", "repair"],
    ["branch update", "branch-update"],
  ] as const)("does not recreate a deleted branch during %s finalization", (_name, finalizer) => {
    const result = runRace(finalizer, "delete");
    expect({ action: result.action, remoteHead: result.remoteHead }).toEqual({ action: "stale_head", remoteHead: "" });
  });

  it.each([
    ["review repair", "repair"],
    ["branch update", "branch-update"],
  ] as const)("does not replace a rewound branch during %s finalization", (_name, finalizer) => {
    const result = runRace(finalizer, "rewind");
    expect({ action: result.action, rewoundHeadRetained: result.remoteHead === result.rootOid }).toEqual({
      action: "stale_head",
      rewoundHeadRetained: true,
    });
  });
});
