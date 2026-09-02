import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { reconcile } = require("../extensions/deadloop/automations/reconcile-pr-work-authority.cts");

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
 * The state Issue #420 measured: a reviewer whose `changes_requested` result and repair contract
 * are saved on the pull request, whose workspace the runtime no longer lists, and whose journal
 * stopped at `github_persisted` before its own workspace-closure transition. A later request event
 * (the repair demand) is queued beside the saved one.
 */
function finishedReviewerFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "deadloop-finished-reviewer-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const stateDir = path.join(root, "deadloop");
  const runDir = path.join(stateDir, "runs", "finished");
  const bin = path.join(root, "bin");
  for (const directory of [repo, worktree, bin, runDir]) mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify({ projects: [{
    id: "demo", repoPath: repo, githubRepo: "owner/repo", baseBranch: "origin/master",
  }] }));
  writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write(JSON.stringify({ id: "repo-id", nameWithOwner: "owner/repo" }));
else if (args[0] === "api" && args[1] === "user") process.stdout.write("deadloop-bot\\n");
else process.stdout.write(JSON.stringify([[]]));
`);
  writeFileSync(path.join(bin, "git"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if ((args[0] === "-C" ? args[2] : args[0]) === "fetch") process.exit(0);
const result = require("node:child_process").spawnSync("/usr/bin/git", args, { encoding: "utf8" });
process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`);
  writeFileSync(path.join(bin, "herdr"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("herdr 0.8.0\\n");
else if (args[0] === "status" && args[1] === "server") process.stdout.write("version: 0.8.0\\n");
else if (args[0] === "worktree") process.stdout.write(JSON.stringify({ result: { worktrees: [] } }));
else if (args[0] === "agent") process.stdout.write(JSON.stringify({ result: { agents: [] } }));
else process.stdout.write(JSON.stringify({ result: { workspaces: [] } }));
`);
  for (const command of ["gh", "git", "herdr"]) execFileSync("chmod", ["+x", path.join(bin, command)]);
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath || ""}`;
  originalConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.TEST_LABELS = path.join(root, "labels.json");
  writeFileSync(process.env.TEST_LABELS, JSON.stringify(["agent:review"]));
  writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({ lastWriterCodeIdentity: "a".repeat(40), projects: [{
    repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "repo-id", enabledAt: 1, baseBranch: "origin/master",
    automationLogin: "deadloop-bot", firstEnableAutoMerge: false, firstStartPending: false,
    lastObservedAutoMerge: false, autoMergeAcknowledged: false, enabled: true,
  }] }));

  // The reviewer's completion is proven: a strong report bound to this journal, reviewing the head
  // the attempt was launched against. The journal stopped at github_persisted, the phase the
  // guarded completion chain writes only after that persistence was confirmed.
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
    attemptId: "finished", launchUuid: "launch", project: "demo", repository: "owner/repo",
    role: "reviewer", target: { kind: "pull-request", number: 42 }, inputRevision: { head: HEAD },
    branch: "agent/issue-42", baseBranch: "origin/master", worktreePath: worktree,
    agentName: "dl-r-42-abcdef123456", workspaceLabel: "reviewer",
    promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
    workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1",
    phase: "github_persisted", lastSuccessfulPhase: "github_persisted", requestEventId: "10",
  }));
  writeFileSync(path.join(runDir, "promise.json"), JSON.stringify({
    schemaVersion: 1, attemptId: "finished", role: "reviewer", status: "complete",
    target: { repository: "owner/repo", kind: "pull-request", number: 42 }, inputRevision: { head: HEAD },
    summary: "two required findings need a repair",
    result: {
      outcome: "changes_requested", reviewedHead: HEAD,
      findings: [{ title: "Race", body: "Re-observe the head", path: "src/a.ts", line: 1, severity: "major" }],
    },
    evidence: { reviewed: ["the exact diff"] },
  }));
  return { root, repo, stateDir, worktree, runDir };
}

async function reconcileOnce(fixture: ReturnType<typeof finishedReviewerFixture>, options: { labels?: string[]; blockedEventAppearsLater?: boolean } = {}) {
  const labels = [...(options.labels || ["agent:review"])];
  const mutations: string[] = [];
  const postedComments: string[] = [];
  // Event 10 launched the review; event 30 is a later request a person queued beside the saved
  // repair demand.
  const baseEvents = [
    { id: "10", event: "labeled", created_at: "2026-08-01T09:00:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:review" } },
    { id: "30", event: "labeled", created_at: "2026-08-01T10:00:00Z", actor: { login: "yasuhito" }, label: { name: "agent:implement" } },
  ];
  const events = () => options.blockedEventAppearsLater && labels.includes("agent:blocked")
    ? [...baseEvents, { id: "20", event: "labeled", created_at: "2026-08-01T09:30:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } }]
    : baseEvents;
  const pr = () => ({ number: 42, state: "OPEN", headRefOid: HEAD, labels: labels.map((name) => ({ name })) });
  const commandRunner = {
    runText: (argv: string[]) => {
      if (argv[0] === "herdr") return "";
      if (argv[2] === "user") return "deadloop-bot\n";
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "edit") {
        mutations.push(`EDIT ${argv.join(" ")}`);
        argv.forEach((token, index) => {
          if (token === "--add-label" && !labels.includes(argv[index + 1])) labels.push(argv[index + 1]);
          if (token === "--remove-label") {
            const position = labels.indexOf(argv[index + 1]);
            if (position >= 0) labels.splice(position, 1);
          }
        });
        return "";
      }
      return "date: Sat, 01 Aug 2026 10:06:01 GMT";
    },
    runJson: (argv: string[], requestOptions: { input?: string } = {}) => {
      const command = argv.slice(0, 3).join(" ");
      // The workspace the journal owned is closed: the runtime lists none, while the project
      // still retains the linked worktree.
      if (command === "herdr workspace list") return { result: { workspaces: [] } };
      if (command === "herdr agent list") return { result: { agents: [] } };
      if (command === "herdr worktree list") return { result: { worktrees: [{ path: fixture.worktree }] } };
      if (command === "gh repo view") return { id: "repo-id", nameWithOwner: "owner/repo" };
      if (command === "gh pr list") return [pr()];
      if (command === "gh pr view") return pr();
      if (argv[0] === "gh" && argv[1] === "api" && argv.includes("--method")) {
        const method = argv[Number(argv.indexOf("--method")) + 1];
        const endpointArg = String(argv.find((token) => typeof token === "string" && token.startsWith("repos/")));
        if (endpointArg.endsWith("/labels") && method === "PUT" && requestOptions.input) {
          mutations.push(`PUT ${endpointArg}`);
          labels.splice(0, labels.length, ...JSON.parse(requestOptions.input).labels);
          return labels.map((name) => ({ name }));
        }
        if (endpointArg.endsWith("/comments") && method === "POST") {
          mutations.push(`POST ${endpointArg}`);
          postedComments.push(String(argv.at(-1)).replace(/^body=/, ""));
          return { id: "comment-new" };
        }
      }
      const endpoint = String(argv.at(-1) || "");
      if (endpoint.endsWith("/labels")) return [labels.map((name) => ({ name }))];
      if (endpoint.endsWith("/events")) return [[...events()]];
      if (endpoint.endsWith("/comments")) return [[[]].flat()];
      return [];
    },
  };
  const result = await reconcile({
    projectRepo: fixture.repo, githubRepo: "owner/repo", stateDir: fixture.stateDir, projectId: "demo",
    enabledAt: 1, automationLogin: "deadloop-bot",
  }, commandRunner);
  return {
    result,
    postedComments,
    mutations,
    journal: JSON.parse(readFileSync(path.join(fixture.runDir, "attempt.json"), "utf8")),
  };
}

describe("a finished reviewer journal whose workspace is closed", () => {
  it("does not block the pull request the finished journal claimed", async () => {
    const fixture = finishedReviewerFixture();
    const { result } = await reconcileOnce(fixture);
    expect(result.results.filter((entry: { action?: string }) => entry.action === "block")).toEqual([]);
  });

  it("invalidates no request label while releasing the finished journal", async () => {
    const fixture = finishedReviewerFixture();
    const { mutations } = await reconcileOnce(fixture);
    expect(mutations).toEqual([]);
  });

  it("keeps the later agent:implement request beside the saved repair request", async () => {
    const fixture = finishedReviewerFixture();
    const { result } = await reconcileOnce(fixture);
    expect(result.results).toContainEqual(expect.objectContaining({ action: "released_finished_attempt", attemptId: "finished" }));
  });

  it("posts no recovery comment for the finished journal", async () => {
    const fixture = finishedReviewerFixture();
    const { postedComments } = await reconcileOnce(fixture);
    expect(postedComments).toEqual([]);
  });

  it("releases the finished journal's authority as finished evidence", async () => {
    const fixture = finishedReviewerFixture();
    const { journal } = await reconcileOnce(fixture);
    expect({ phase: journal.phase, reason: journal.authorityRelease?.reason })
      .toEqual({ phase: "authority_released", reason: "owner_absent" });
  });

  it("still blocks a pull request whose finished journal leaves the active state unclaimed", async () => {
    const fixture = finishedReviewerFixture();
    const { result } = await reconcileOnce(fixture, { labels: ["agent:in-progress"], blockedEventAppearsLater: true });
    expect(result.results.filter((entry: { action?: string }) => entry.action === "block"))
      .toEqual([expect.objectContaining({ action: "block", cleanup: "preserve_workspace" })]);
  });
});
