import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { reconcile } = require("../extensions/deadloop/automations/reconcile-pr-work-authority.cts");
const { writeWorkerContractSnapshot } = require("../src/worker-required-verification-runtime.cjs");

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
 * The state Issue #454 measured: a reviewer still running against `agent:in-progress` whose
 * runtime identity one tick could not resolve, because a second agent sat inside the attempt's
 * checkout. The reconciler read that as unobservable and blocked the pull request before the
 * reviewer could hand over its result.
 */
function runningReviewerFixture(options: { malformedJournal?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "deadloop-ambiguous-reviewer-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const stateDir = path.join(root, "deadloop");
  const runDir = path.join(stateDir, "runs", "reviewer");
  const bin = path.join(root, "bin");
  for (const directory of [repo, worktree, bin, runDir]) mkdirSync(directory, { recursive: true });
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
  // The completion dispatch runs its own commands rather than the injected runner, so the whole
  // handoff has to resolve inside this fixture too.
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
  // Real git for every command except the trusted-policy fetch, which no fixture remote can serve.
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
else if (args[0] === "worktree") process.stdout.write(JSON.stringify({ result: { worktrees: [{ path: "${worktree.replace(/\\/g, "\\\\")}" }] } }));
else if (args[0] === "agent") process.stdout.write(JSON.stringify({ result: { agents: [] } }));
else process.stdout.write(JSON.stringify({ result: { workspaces: [{ workspace_id: "workspace-1", pane_count: 1, tab_count: 1, worktree: { checkout_path: "${worktree.replace(/\\/g, "\\\\")}" } }] } }));
`);
  for (const command of ["gh", "git", "herdr"]) execFileSync("chmod", ["+x", path.join(bin, command)]);
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath || ""}`;
  // The handoff refuses a state directory that is not the enabled one, so the fixture has to be it.
  originalConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.TEST_LABELS = path.join(root, "labels.json");
  process.env.TEST_MUTATIONS = path.join(root, "mutations.log");
  process.env.TEST_COMMENTS = path.join(root, "comments.json");
  writeFileSync(process.env.TEST_COMMENTS, JSON.stringify([[]]));
  writeFileSync(process.env.TEST_LABELS, JSON.stringify(["agent:in-progress"]));
  writeFileSync(process.env.TEST_MUTATIONS, "");
  writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({ lastWriterCodeIdentity: "a".repeat(40), projects: [{
    repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "repo-id", enabledAt: 1, baseBranch: "origin/master",
    automationLogin: "deadloop-bot", firstEnableAutoMerge: false, firstStartPending: false,
    lastObservedAutoMerge: false, autoMergeAcknowledged: false, enabled: true,
  }] }));

  const baseRevision = execFileSync("git", ["-C", repo, "rev-parse", "--verify", "origin/master^{commit}"], { encoding: "utf8" }).trim();
  const record = {
    attemptId: "reviewer", launchUuid: "launch", project: "demo", repository: "owner/repo",
    role: "reviewer", target: { kind: "pull-request", number: 42 }, inputRevision: { head: HEAD },
    branch: "agent/issue-42", baseBranch: "origin/master", worktreePath: worktree,
    agentName: "dl-r-42-abcdef123456", workspaceLabel: "reviewer",
    promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
    workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1",
    requiredVerification: {
      repository: "owner/repo", command: "npm run check",
      source: { kind: "default", location: "deadloop" }, baseRevision,
    },
    phase: "agent_started", lastSuccessfulPhase: "agent_started", requestEventId: "10",
    runDir,
  };
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify(record));
  writeWorkerContractSnapshot(runDir, record);
  // A journal that parses but fails the record contract: active-attempt state nothing can account
  // for, which is the deterministic fail-closed evidence the reconciliation keeps blocking on.
  if (options.malformedJournal) {
    const malformedRun = path.join(stateDir, "runs", "malformed");
    mkdirSync(malformedRun, { recursive: true });
    writeFileSync(path.join(malformedRun, "attempt.json"), JSON.stringify({
      project: "demo", repository: "owner/repo", target: { kind: "pull-request", number: 42 },
      inputRevision: { head: "not-a-commit" },
    }));
  }
  return { root, repo, stateDir, worktree, runDir };
}

/** Saves the completion report a stopped reviewer hands over through the review dispatch. */
function writeReviewerReport(fixture: ReturnType<typeof runningReviewerFixture>, outcome: string): void {
  writeFileSync(path.join(fixture.runDir, "promise.json"), JSON.stringify({
    schemaVersion: 1, attemptId: "reviewer", role: "reviewer", status: "complete",
    target: { repository: "owner/repo", kind: "pull-request", number: 42 }, inputRevision: { head: HEAD },
    summary: "two required findings need a person",
    result: {
      outcome, reviewedHead: HEAD,
      findings: [{ title: "Race", body: "Re-observe the head", path: "src/a.ts", line: 1, severity: "major" }],
    },
    evidence: { reviewed: ["the exact diff"] },
  }));
}

type ReconcileObserve = {
  /** Agents the runtime lists; the reviewer agent alone means its turn is observable. */
  agents?: Array<Record<string, unknown>>;
  /** Every herdr read fails, the way an unreachable runtime answers. */
  runtimeUnreachable?: boolean;
};

async function reconcileOnce(
  fixture: ReturnType<typeof runningReviewerFixture>,
  observe: ReconcileObserve = {},
) {
  const labels = ["agent:in-progress"];
  const postedComments: string[] = [];
  // Both channels that reach GitHub are observed: the injected runner, and the gh stub the
  // completion dispatch spawns with. One merged log is what "GitHub was not touched" means.
  const mutations: string[] = [];
  const syncLabelFile = () => writeFileSync(process.env.TEST_LABELS!, JSON.stringify(labels));
  const events = () => labels.includes("agent:blocked")
    ? [
        { id: "10", event: "labeled", created_at: "2026-08-01T09:00:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:review" } },
        { id: "20", event: "labeled", created_at: "2026-08-01T10:06:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } },
      ]
    : [
        { id: "10", event: "labeled", created_at: "2026-08-01T09:00:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:review" } },
      ];
  const pr = () => ({ number: 42, state: "OPEN", headRefOid: HEAD, labels: labels.map((name) => ({ name })) });
  const commandRunner = {
    runText: (argv: string[]) => {
      if (observe.runtimeUnreachable && argv[0] === "herdr") throw new Error("herdr command failed");
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
        syncLabelFile();
        return "";
      }
      return "date: Sat, 01 Aug 2026 10:06:01 GMT";
    },
    runJson: (argv: string[], requestOptions: { input?: string } = {}) => {
      if (observe.runtimeUnreachable && argv[0] === "herdr") throw new Error("herdr command failed");
      const command = argv.slice(0, 3).join(" ");
      if (command === "herdr workspace list") {
        return { result: { workspaces: [{ workspace_id: "workspace-1", pane_count: 1, tab_count: 1, worktree: { checkout_path: fixture.worktree } }] } };
      }
      if (command === "herdr agent list") return { result: { agents: observe.agents || [] } };
      if (command === "herdr worktree list") return { result: { worktrees: [{ path: fixture.worktree }] } };
      if (command === "gh repo view") return { id: "repo-id", nameWithOwner: "owner/repo" };
      if (command === "gh pr list") return [pr()];
      if (command === "gh pr view") return pr();
      // Label writes and comment posts are observed so a test can prove what reached GitHub.
      if (argv[0] === "gh" && argv[1] === "api" && argv.includes("--method")) {
        const method = argv[Number(argv.indexOf("--method")) + 1];
        const endpointArg = String(argv.find((token) => typeof token === "string" && token.startsWith("repos/")));
        if (endpointArg.endsWith("/labels") && method === "PUT" && requestOptions.input) {
          mutations.push(`PUT ${endpointArg}`);
          labels.splice(0, labels.length, ...JSON.parse(requestOptions.input).labels);
          syncLabelFile();
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
      if (endpoint.endsWith("/comments")) return [[]];
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
    mutations: [...mutations, ...readFileSync(process.env.TEST_MUTATIONS!, "utf8").split("\n").filter(Boolean)],
    labels,
  };
}

/** The reviewer agent, alive in its own checkout. */
function reviewerAgent(fixture: ReturnType<typeof runningReviewerFixture>): Record<string, unknown> {
  return { terminal_id: "t1", pane_id: "pane-1", agent_status: "working", cwd: fixture.worktree };
}

/** A second agent inside the same checkout, so the runtime cannot describe one attempt. */
function strangerAgent(fixture: ReturnType<typeof runningReviewerFixture>): Record<string, unknown> {
  return { terminal_id: "t2", pane_id: "pane-x", agent_status: "working", cwd: fixture.worktree };
}

describe("a running reviewer whose runtime reading is transiently ambiguous", () => {
  it("changes no GitHub label while the runtime reading stays ambiguous", async () => {
    const fixture = runningReviewerFixture();
    const { mutations } = await reconcileOnce(fixture, { agents: [reviewerAgent(fixture), strangerAgent(fixture)] });

    expect(mutations).toEqual([]);
  });

  it("posts no block comment while the runtime reading stays ambiguous", async () => {
    const fixture = runningReviewerFixture();
    const { postedComments } = await reconcileOnce(fixture, { agents: [reviewerAgent(fixture), strangerAgent(fixture)] });

    expect(postedComments).toEqual([]);
  });

  it("keeps the active attempt instead of deciding on the unreadable reading", async () => {
    const fixture = runningReviewerFixture();
    const { result } = await reconcileOnce(fixture, { agents: [reviewerAgent(fixture), strangerAgent(fixture)] });

    expect(result.results).toContainEqual(expect.objectContaining({ action: "keep_active", cleanup: "none" }));
  });

  it("changes no GitHub label while the runtime cannot answer at all", async () => {
    const fixture = runningReviewerFixture();
    const { mutations } = await reconcileOnce(fixture, { runtimeUnreachable: true });

    expect(mutations).toEqual([]);
  });

  it("keeps the active attempt while one journal reads ambiguously beside a malformed one", async () => {
    const fixture = runningReviewerFixture({ malformedJournal: true });
    const { result } = await reconcileOnce(fixture, { agents: [reviewerAgent(fixture), strangerAgent(fixture)] });

    expect(result.results).toContainEqual(expect.objectContaining({ action: "keep_active", cleanup: "none" }));
  });

  it("still blocks a malformed journal once every readable journal reads stopped", async () => {
    const fixture = runningReviewerFixture({ malformedJournal: true });
    const { result } = await reconcileOnce(fixture, { agents: [] });

    expect(result.results).toContainEqual(expect.objectContaining({ action: "block" }));
  });
});

describe("after the ambiguity resolves into a stopped reviewer with a valid report", () => {
  it("dispatches the review normally instead of blocking the pull request", async () => {
    const fixture = runningReviewerFixture();
    await reconcileOnce(fixture, { agents: [reviewerAgent(fixture), strangerAgent(fixture)] });
    writeReviewerReport(fixture, "human_required");
    const second = await reconcileOnce(fixture, { agents: [] });

    expect(second.result.results.map((entry: { action: string }) => entry.action)).toContain("completed_proven_attempt");
  });

  it("moves no label to the blocked state on the resolving tick", async () => {
    const fixture = runningReviewerFixture();
    await reconcileOnce(fixture, { agents: [reviewerAgent(fixture), strangerAgent(fixture)] });
    writeReviewerReport(fixture, "human_required");
    const second = await reconcileOnce(fixture, { agents: [] });

    expect(second.labels).not.toContain("agent:blocked");
  });
});
