import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

function runRace(kind: "issue" | "pr") {
  const root = mkdtempSync(path.join(os.tmpdir(), `deadloop-${kind}-transition-race-`));
  roots.push(root);
  const repo = path.join(root, "repo");
  const configDir = path.join(root, ".pi", "agent");
  const stateDir = path.join(configDir, "deadloop");
  const bin = path.join(root, "bin");
  const mutation = path.join(root, "mutation");
  mkdirSync(repo);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(bin);
  spawnSync("git", ["-C", repo, "init", "--quiet"]);
  spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({ projects: [{
    repoPath: repo,
    githubRepo: "owner/repo",
    githubRepositoryId: "R_repo",
    enabledAt: 1,
    firstEnableAutoMerge: false,
    firstStartPending: false,
    lastObservedAutoMerge: false,
    autoMergeAcknowledged: false,
    enabled: true,
  }] }));

  const initialIssue = { number: 10, title: "Missing contract", body: "## Agent Brief\nDo something.", url: "https://github.com/owner/repo/issues/10", state: "OPEN", labels: [{ name: "ready-for-agent" }, { name: "agent:implement" }] };
  const completedIssue = { ...initialIssue, body: "## Agent Brief\nDo something.\n## Acceptance criteria\nDone." };
  const initialPr = { number: 23, title: "Draft PR", url: "https://github.com/owner/repo/pull/23", state: "OPEN", headRefName: "agent/issue-23-draft", headRefOid: "draftsha", isCrossRepository: false, isDraft: true, mergeStateStatus: "CLEAN", labels: [{ name: "agent:review" }], statusCheckRollup: [], comments: [], reviewRequests: [] };
  const readyPr = { ...initialPr, isDraft: false };
  writeFileSync(path.join(bin, "node"), `#!/bin/sh\ncase "$1" in *cleanup-completed-worker-worktrees.ts) printf '{"candidates":[]}\\n' ;; *) exec ${JSON.stringify(process.execPath)} "$@" ;; esac\n`);
  writeFileSync(path.join(bin, "herdr"), "#!/bin/sh\nprintf '{\"result\":{\"agents\":[]}}\\n'\n");
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
  "repo view") printf '{"id":"R_repo"}\\n' ;;
  "issue list") printf '%s\\n' '${JSON.stringify(initialIssue)}' | awk '{print "[" $0 "]"}' ;;
  "issue view") printf '%s\\n' '${JSON.stringify(completedIssue)}' ;;
  "pr list") printf '%s\\n' '${JSON.stringify(initialPr)}' | awk '{print "[" $0 "]"}' ;;
  "pr view") printf '%s\\n' '${JSON.stringify(readyPr)}' ;;
  "issue edit"|"issue comment"|"pr edit"|"pr comment") touch '${mutation}' ;;
  *) printf '[]\\n' ;;
esac
`);
  for (const executable of ["node", "herdr", "gh"]) chmodSync(path.join(bin, executable), 0o755);
  const script = kind === "issue"
    ? "extensions/deadloop/automations/issue-coordinator-driver.ts"
    : "extensions/deadloop/automations/pr-reviewer-driver.ts";
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PI_CODING_AGENT_DIR: configDir,
      DEADLOOP_REPO_PATH: repo,
      DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_ENABLED_AT: "1",
      DEADLOOP_STATE_DIR: stateDir,
    },
  });
  return { action: JSON.parse(result.stdout).driverAction, mutated: existsSync(mutation) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("non-launch transition revalidation", () => {
  it("does not relabel an issue whose contract completes before mutation", () => {
    expect(runRace("issue")).toEqual({ action: "contract_missing_stale", mutated: false });
  });

  it("does not block a draft PR that becomes ready before mutation", () => {
    expect(runRace("pr")).toEqual({ action: "draft_gate_stale", mutated: false });
  });
});
