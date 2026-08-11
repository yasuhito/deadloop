import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { loadCurrentReviewClaimConfiguration } = require("../src/current-review-claim-config.cjs");

const roots: string[] = [];
const originalConfig = process.env.DEADLOOP_CONFIG;
const originalProjects = process.env.DEADLOOP_PROJECTS;

function fixture(local: Record<string, unknown> = {}, policy: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-current-claim-config-"));
  roots.push(root);
  const repoPath = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(repoPath);
  fs.mkdirSync(stateDir);
  execFileSync("git", ["-C", repoPath, "init", "--quiet"]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "fixture\n");
  fs.writeFileSync(path.join(repoPath, "deadloop.json"), `${JSON.stringify(policy)}\n`);
  execFileSync("git", ["-C", repoPath, "add", "."]);
  execFileSync("git", ["-C", repoPath, "commit", "--quiet", "-m", "fixture"]);
  const baseBranch = execFileSync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  const project = { id: "demo", repoPath, githubRepo: "owner/repo", baseBranch, ...local };
  fs.writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify({ projects: [project] }));
  const enabled = {
    repoPath, githubRepo: "owner/repo", githubRepositoryId: "R_repo", baseBranch,
    automationLogin: "deadloop-bot", enabled: true,
  };
  delete process.env.DEADLOOP_CONFIG;
  delete process.env.DEADLOOP_PROJECTS;
  return { repoPath, stateDir, enabled };
}

function replacePolicy(repoPath: string, policy: Record<string, unknown>) {
  fs.writeFileSync(path.join(repoPath, "deadloop.json"), `${JSON.stringify(policy)}\n`);
  execFileSync("git", ["-C", repoPath, "add", "deadloop.json"]);
  execFileSync("git", ["-C", repoPath, "commit", "--quiet", "-m", "policy"]);
}

afterEach(() => {
  if (originalConfig === undefined) delete process.env.DEADLOOP_CONFIG;
  else process.env.DEADLOOP_CONFIG = originalConfig;
  if (originalProjects === undefined) delete process.env.DEADLOOP_PROJECTS;
  else process.env.DEADLOOP_PROJECTS = originalProjects;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("current review claim configuration", () => {
  it("observes reviewer runtime shortened in the pinned repository policy", () => {
    const value = fixture({}, { automations: [{ id: "demo:issue-coordinator", driverFile: "issue-coordinator-driver.ts" }, { id: "demo:pr-reviewer", driverFile: "pr-reviewer-driver.ts", maxRuntimeSeconds: 3500, shutdownGraceSeconds: 100 }] });
    replacePolicy(value.repoPath, { automations: [{ id: "demo:issue-coordinator", driverFile: "issue-coordinator-driver.ts" }, { id: "demo:pr-reviewer", driverFile: "pr-reviewer-driver.ts", maxRuntimeSeconds: 1200, shutdownGraceSeconds: 50 }] });

    expect(loadCurrentReviewClaimConfiguration(value.stateDir, value.enabled, "deadloop-bot").authoritySeconds).toBe(1250);
  });

  it("merges partial local and repository label changes per canonical fields", () => {
    const value = fixture({ labels: { review: "local:review" } }, { labels: { blocked: "policy:blocked" } });

    expect(loadCurrentReviewClaimConfiguration(value.stateDir, value.enabled, "deadloop-bot").managedLabels).toEqual([
      "local:review", "agent:reviewing", "agent:implement", "agent:update-branch", "agent:in-progress", "policy:blocked",
    ]);
  });

  it("rejects a configuration matching only the enabled repository name", () => {
    const value = fixture();
    fs.writeFileSync(path.join(value.stateDir, "projects.json"), JSON.stringify({ projects: [{ repoPath: path.join(value.repoPath, "other"), githubRepo: "owner/repo" }] }));

    expect(() => loadCurrentReviewClaimConfiguration(value.stateDir, value.enabled, "deadloop-bot")).toThrow("exactly match");
  });

  it("honors DEADLOOP_PROJECTS filtering at the canonical resolver", () => {
    const value = fixture();
    process.env.DEADLOOP_PROJECTS = "other";

    expect(() => loadCurrentReviewClaimConfiguration(value.stateDir, value.enabled, "deadloop-bot")).toThrow("filtering");
  });

  it("rejects malformed current configuration", () => {
    const value = fixture();
    fs.writeFileSync(path.join(value.stateDir, "projects.json"), "{");

    expect(() => loadCurrentReviewClaimConfiguration(value.stateDir, value.enabled, "deadloop-bot")).toThrow("invalid");
  });

  it("rejects disabled current enablement", () => {
    const value = fixture();

    expect(() => loadCurrentReviewClaimConfiguration(value.stateDir, { ...value.enabled, enabled: false }, "deadloop-bot")).toThrow("disabled");
  });

  it("rejects a current configuration without one reviewer automation", () => {
    const value = fixture({ automations: [] });

    expect(() => loadCurrentReviewClaimConfiguration(value.stateDir, value.enabled, "deadloop-bot")).toThrow("reviewer automation");
  });
});
