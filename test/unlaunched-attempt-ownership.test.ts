import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { reconcile } = require("../extensions/deadloop/automations/reconcile-pr-work-authority.ts");

const HEAD = "a".repeat(40);
const roots: string[] = [];
let originalPath: string | undefined;
let originalConfigDir: string | undefined;

afterEach(() => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  if (originalConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalConfigDir;
  originalPath = undefined;
  originalConfigDir = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * The state PR #228 reached: one review that completed and still owes its handoff, beside a second
 * attempt for the same pull request that failed to launch before any workspace was opened.
 */
function pullRequestWithUnlaunchedSecondAttempt(options: { unlaunchedHoldsWorkspace?: boolean; blocked?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "deadloop-unlaunched-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const stateDir = path.join(root, "deadloop");
  const completedRun = path.join(stateDir, "runs", "completed");
  const unlaunchedRun = path.join(stateDir, "runs", "unlaunched");
  const bin = path.join(root, "bin");
  for (const directory of [repo, worktree, bin, completedRun, unlaunchedRun]) mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo]);
  for (const [key, value] of [["user.email", "test@example.com"], ["user.name", "Test"]]) {
    execFileSync("git", ["-C", repo, "config", key, value]);
  }
  writeFileSync(path.join(repo, "deadloop.json"), "{}\n");
  execFileSync("git", ["-C", repo, "add", "deadloop.json"]);
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "fixture"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/master", "HEAD"]);
  writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify({ projects: [{
    id: "demo", repoPath: repo, githubRepo: "owner/repo", baseBranch: "origin/master",
  }] }));
  // The completion handler runs its own commands rather than the injected runner, so the whole
  // handoff has to resolve inside this fixture. A stub that answers less than the handler asks for
  // turns a refusal into something that reads like the reconciler declining to finish.
  writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const pr = () => ({
  number: 42, state: "OPEN", isDraft: true, headRefName: "agent/issue-42", headRefOid: "${HEAD}",
  isCrossRepository: false, labels: JSON.parse(fs.readFileSync(process.env.TEST_LABELS, "utf8")).map((name) => ({ name })),
  comments: [],
});
if (args[0] === "repo") process.stdout.write(JSON.stringify({ id: "repo-id", nameWithOwner: "owner/repo" }));
else if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify(pr()));
else if (args[0] === "pr") { fs.appendFileSync(process.env.TEST_MUTATIONS, args.join(" ") + "\\n"); process.stdout.write("https://github.com/owner/repo/pull/42#issuecomment-1\\n"); }
else if (args[0] === "api" && args[1] === "user") process.stdout.write("deadloop-bot\\n");
else if (args[0] === "api" && args.includes("--include")) process.stdout.write("date: Sat, 01 Aug 2026 10:06:01 GMT");
else if (args.some((value) => String(value).endsWith("/comments"))) process.stdout.write(fs.readFileSync(process.env.TEST_COMMENTS, "utf8"));
else if (args.some((value) => String(value).endsWith("/events"))) process.stdout.write(JSON.stringify([[{ id: 10, event: "labeled", created_at: "2026-08-01T09:00:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:review" } }]]));
else if (args[0] === "api") process.stdout.write(JSON.stringify([[]]));
`);
  writeFileSync(path.join(bin, "herdr"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("herdr 0.8.0\\n");
else if (args[0] === "status" && args[1] === "server") process.stdout.write("version: 0.8.0\\n");
else if (args[0] === "worktree") process.stdout.write(JSON.stringify({ result: { worktrees: [] } }));
else if (args[0] === "agent") process.stdout.write(JSON.stringify({ result: { agents: [] } }));
else process.stdout.write(JSON.stringify({ result: { workspaces: [] } }));
`);
  for (const command of ["gh", "herdr"]) execFileSync("chmod", ["+x", path.join(bin, command)]);
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath || ""}`;
  // The handoff refuses a state directory that is not the enabled one, so the fixture has to be it.
  originalConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.TEST_LABELS = path.join(root, "labels.json");
  process.env.TEST_MUTATIONS = path.join(root, "mutations.log");
  process.env.TEST_COMMENTS = path.join(root, "comments.json");
  writeFileSync(process.env.TEST_COMMENTS, JSON.stringify([[]]));
  writeFileSync(process.env.TEST_LABELS, JSON.stringify(options.blocked ? ["agent:blocked"] : ["agent:in-progress"]));
  writeFileSync(process.env.TEST_MUTATIONS, "");
  writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({ projects: [{
    repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "repo-id", enabledAt: 1, baseBranch: "origin/master",
    automationLogin: "deadloop-bot", firstEnableAutoMerge: false, firstStartPending: false,
    lastObservedAutoMerge: false, autoMergeAcknowledged: false, enabled: true,
  }] }));

  const attempt = (overrides: Record<string, unknown>) => ({
    launchUuid: "launch", project: "demo", repository: "owner/repo", role: "reviewer",
    target: { kind: "pull-request", number: 42 }, inputRevision: { head: HEAD },
    branch: "agent/issue-42", worktreePath: worktree, agentName: "dl-r-42-abcdef123456",
    workspaceLabel: "reviewer", ...overrides,
  });
  writeFileSync(path.join(completedRun, "attempt.json"), JSON.stringify(attempt({
    attemptId: "completed", promptFile: path.join(completedRun, "prompt.md"),
    promiseFile: path.join(completedRun, "promise.json"),
    workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1",
    phase: "report_received", lastSuccessfulPhase: "report_received", requestEventId: "10",
  })));
  writeFileSync(path.join(completedRun, "promise.json"), JSON.stringify({
    schemaVersion: 1, attemptId: "completed", role: "reviewer", status: "complete",
    target: { repository: "owner/repo", kind: "pull-request", number: 42 }, inputRevision: { head: HEAD },
    summary: "two required findings need a person",
    result: {
      outcome: "human_required", reviewedHead: HEAD,
      findings: [{ title: "Race", body: "Re-observe the head", path: "src/a.ts", line: 1, severity: "major" }],
    },
    evidence: { reviewed: ["the exact diff"] },
  }));
  // The second attempt never opened a workspace: it stopped on the launch that found the first
  // attempt's checkout still occupied.
  writeFileSync(path.join(unlaunchedRun, "attempt.json"), JSON.stringify(attempt({
    attemptId: "unlaunched", promptFile: path.join(unlaunchedRun, "prompt.md"),
    promiseFile: path.join(unlaunchedRun, "promise.json"),
    phase: "launch_failed",
    lastSuccessfulPhase: options.unlaunchedHoldsWorkspace ? "workspace_opened" : "github_claimed",
    ...(options.unlaunchedHoldsWorkspace
      ? { workspaceId: "workspace-2", tabId: "tab-2", rootPaneId: "pane-2" }
      : {}),
    requestEventId: "20",
    launchError: "worktree agent/issue-42 already has an open attempt workspace",
  })));
  return { root, repo, stateDir, worktree, completedRun, mutations: path.join(root, "mutations.log") };
}

async function reconcileOnce(fixture: ReturnType<typeof pullRequestWithUnlaunchedSecondAttempt>) {
  const labels = ["agent:blocked"];
  const comments: Record<string, unknown>[] = [];
  const events = [
    { id: "10", event: "labeled", created_at: "2026-08-01T09:00:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:review" } },
    { id: "20", event: "labeled", created_at: "2026-08-01T10:04:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:review" } },
  ];
  const pr = () => ({ number: 42, state: "OPEN", headRefOid: HEAD, labels: labels.map((name) => ({ name })) });
  const commandRunner = {
    runText: (argv: string[]) => {
      if (argv[0] === "herdr") return "";
      if (argv[2] === "user") return "deadloop-bot\n";
      return "date: Sat, 01 Aug 2026 10:06:01 GMT";
    },
    runJson: (argv: string[]) => {
      const command = argv.slice(0, 3).join(" ");
      // The completed attempt's workspace is still open with its agent gone, which is the state
      // PR #228 was measured in.
      if (command === "herdr workspace list") return { result: { workspaces: [{ workspace_id: "workspace-1", pane_count: 1, tab_count: 1, worktree: { checkout_path: fixture.worktree } }] } };
      if (command === "herdr agent list") return { result: { agents: [] } };
      if (command === "herdr worktree list") return { result: { worktrees: [{ path: fixture.worktree }] } };
      if (command === "gh repo view") return { id: "repo-id", nameWithOwner: "owner/repo" };
      if (command === "gh pr list") return [pr()];
      if (command === "gh pr view") return pr();
      const endpoint = String(argv.at(-1) || "");
      if (endpoint.endsWith("/labels")) return [labels.map((name) => ({ name }))];
      if (endpoint.endsWith("/events")) return [[...events]];
      if (endpoint.endsWith("/comments")) return [[...comments]];
      return [];
    },
  };
  const result = await reconcile({
    projectRepo: fixture.repo, githubRepo: "owner/repo", stateDir: fixture.stateDir, projectId: "demo",
    enabledAt: 1, automationLogin: "deadloop-bot",
  }, commandRunner);
  return {
    result,
    unlaunched: JSON.parse(readFileSync(path.join(fixture.stateDir, "runs", "unlaunched", "attempt.json"), "utf8")),
  };
}

describe("a second attempt that never opened a workspace", () => {
  it("finishes the completed review the unlaunched attempt is blocking", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt();
    const { result } = await reconcileOnce(fixture);

    expect(result.results.map((entry: { action: string }) => entry.action)).toContain("completed_proven_attempt");
  });

  it("hands the completed review to a human", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt();
    const { result } = await reconcileOnce(fixture);
    const completed = result.results.find((entry: { action: string }) => entry.action === "completed_proven_attempt");

    expect(completed.result.driverAction).toBe("review_human_handoff");
  });

  // The claim an earlier block invalidated is a separate gate, and one this change does not open.
  // Naming it here keeps the refusal visible instead of leaving it to be rediscovered live.
  it("still refuses the handoff while an earlier block holds the pull request", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt({ blocked: true });
    const { result } = await reconcileOnce(fixture);
    const refused = result.results.find((entry: { action: string }) => entry.action === "completion_refused");

    expect(refused.reason).toContain("active in-progress state is required");
  });

  it("releases the unlaunched attempt", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt();
    const { unlaunched } = await reconcileOnce(fixture);

    expect(unlaunched.phase).toBe("authority_released");
  });

  it("records why the unlaunched attempt lost its authority", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt();
    const { unlaunched } = await reconcileOnce(fixture);

    expect(unlaunched.authorityRelease.reason).toBe("never_launched");
  });

  it("keeps the launch error of the released attempt as evidence", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt();
    const { unlaunched } = await reconcileOnce(fixture);

    expect(unlaunched.launchError).toContain("already has an open attempt workspace");
  });

  it("keeps a launch failure that already held a workspace", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt({ unlaunchedHoldsWorkspace: true });
    const { unlaunched } = await reconcileOnce(fixture);

    expect(unlaunched.phase).toBe("launch_failed");
  });

  it("reconciles a pull request whose block already removed every request label", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt({ blocked: true });
    const { result } = await reconcileOnce(fixture);

    expect(result.results.some((entry: { prNumber?: number }) => entry.prNumber === 42)).toBe(true);
  });
});
