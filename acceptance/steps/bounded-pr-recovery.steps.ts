import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

import { fixtureStateDir } from "../support/fixture-state-dir";

const { finalizeBranchUpdate } = require("../../extensions/deadloop/automations/pr-branch-update-finalize.cts");
const { renderRepairMarker, renderTechnicalFailureMarker, reviewResultFingerprint } = require("../../extensions/deadloop/automations/pr-review-repair-state.cts");
const { finalizeReviewRepair } = require("../../extensions/deadloop/automations/pr-review-repair-finalize.cts");
const { renderChangesRequestedComment } = require("../../extensions/deadloop/automations/pr-review-comments.cts");
const { comparePrHistoryObservations } = require("../../src/pr-review-history.cts");
const { validateCompletionReportV1 } = require("../../src/attempt-lifecycle.ts");
const { writeWorkerContractSnapshot } = require("../../src/worker-required-verification-runtime.cjs");
const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const repairedHead = "cccccccccccccccccccccccccccccccccccccccc";
const branch = "agent/issue-31";
const findings = [{ title: "Lint contract failure", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }];

type RecoveryWorld = {
  case?: string;
  result?: Record<string, any>;
  commands?: string[][];
  error?: Error;
  originalComments?: Array<{ id: number; body: string }>;
};

function adapterEffects(result: Record<string, unknown> | undefined): any {
  return result?.testAdapterEffects;
}

function loggedAgentStartCount(result: Record<string, unknown> | undefined): number {
  return String(result?.herdrLog || "").split("\n").filter((line) => line.startsWith("agent start ")).length;
}

function observedLabels(result: Record<string, unknown> | undefined): string[] {
  return adapterEffects(result)?.labels?.["31"] ?? result?.observedLabels ?? [];
}

function observedComments(result: Record<string, unknown> | undefined): Array<{ body: string }> {
  return adapterEffects(result)?.githubComments ?? result?.observedComments ?? [];
}

function reviewerDriver(fixture: string): Record<string, unknown> {
  const fixturePath = path.isAbsolute(fixture) ? fixture : path.join("test/fixtures/pr-reviewer-driver", fixture);
  const result = spawnSync(
    "node",
    ["extensions/deadloop/automations/pr-reviewer-driver.cts", "--fixture", fixturePath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DEADLOOP_PROJECT_ID: "demo",
        DEADLOOP_STATE_DIR: fixtureStateDir(),
        DEADLOOP_REPO_PATH: "/repo",
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_REVIEWER_AGENT: "pi",
        DEADLOOP_REVIEWER_MODEL: "",
        DEADLOOP_AUTO_MERGE: "0",
        DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS: "deadloop-bot",
        DEADLOOP_NOW: "2026-07-08T00:00:00Z",
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function repairDispatch(testCase: string): Record<string, unknown> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-acceptance-review-repair-"));
  try {
    const bin = path.join(root, "bin");
    const worktreeRoot = path.join(root, "worktrees");
    const worktree = path.join(worktreeRoot, "agent-issue-31");
    const configDir = path.join(root, "config");
    const state = path.join(configDir, "deadloop");
    const runDir = path.join(state, "runs", "reviewer");
    const promise = path.join(runDir, "promise.json");
    const attemptRecord = path.join(runDir, "attempt.json");
    const githubLog = path.join(root, "github.log");
    const herdrLog = path.join(root, "herdr.log");
    const labelsFile = path.join(root, "labels.json");
    const commentsFile = path.join(root, "comments.json");
    fs.mkdirSync(bin);
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(labelsFile, JSON.stringify(["agent:in-progress"]));
    fs.writeFileSync(path.join(state, "projects.json"), JSON.stringify({ projects: [{
      id: "demo", repoPath: root, githubRepo: "owner/repo", baseBranch: "origin/main",
    }] }));
    fs.writeFileSync(
      path.join(state, "enabled-projects.json"),
      JSON.stringify({ lastWriterCodeIdentity: "a".repeat(40), projects: [{
        repoPath: root,
        githubRepo: "owner/repo",
        githubRepositoryId: "R_repo",
        baseBranch: "origin/main",
        automationLogin: "deadloop-bot",
        enabledAt: 1,
        firstEnableAutoMerge: false,
        firstStartPending: false,
        lastObservedAutoMerge: false,
        autoMergeAcknowledged: false,
        enabled: true,
      }] }),
    );
    const blocked = testCase === "first-technical-failure" || testCase === "repeated-technical-failure";
    const currentHead = testCase === "repeated-repair" ? repairedHead : head;
    const priorRequiredFindings = testCase === "repeated-repair" || testCase === "persisted-finding"
      ? "persisted"
      : testCase === "regressed-finding"
        ? "regressed"
        : testCase === "mixed-findings"
          ? "mixed"
          : testCase === "fourth-progress-repair"
            ? "all_resolved"
            : "none";
    const reportBase = {
      schemaVersion: 1, attemptId: "reviewer", role: "reviewer",
      target: { repository: "owner/repo", kind: "pull-request", number: 31 }, inputRevision: { head: currentHead },
      summary: blocked ? "Technical review failure." : "Repair required.", evidence: { reviewed: ["PR diff"] },
    };
    fs.writeFileSync(promise, JSON.stringify(blocked
      ? { ...reportBase, status: "blocked", result: { reason: "reviewer failed", explanation: "Technical review failure.", recovery: "Retry the review." } }
      : {
        ...reportBase,
        status: "complete",
        result: {
          outcome: "changes_requested",
          reviewedHead: currentHead,
          findings,
          // The review agent owns this semantic judgment; dispatch only maps the
          // structured disposition to the allowed production transition.
          priorRequiredFindings,
        },
      }));
    // Every reviewer launch fixes a required-verification contract, and this fixture's policy
    // resolves to the deadloop default because its project configures no check command.
    fs.writeFileSync(attemptRecord, JSON.stringify({
      attemptId: "reviewer", launchUuid: "reviewer", project: "demo", repository: "owner/repo", role: "reviewer",
      target: { kind: "pull-request", number: 31 }, inputRevision: { head: currentHead }, branch,
      baseBranch: "origin/main",
      worktreePath: worktree, agentName: "reviewer", workspaceLabel: "reviewer",
      promptFile: path.join(runDir, "prompt.md"), promiseFile: promise,
      phase: "workspace_closed", lastSuccessfulPhase: "workspace_closed", requestEventId: "22",
      requiredVerification: {
        repository: "owner/repo", command: "npm run check",
        source: { kind: "default", location: "deadloop" }, baseRevision: "f".repeat(40),
      },
    }));
    writeWorkerContractSnapshot(runDir, JSON.parse(fs.readFileSync(attemptRecord, "utf8")));
    const priorReviewComment = {
      id: 101,
      body: `## Earlier review\n\nThe required finding remained.\n\n${renderRepairMarker(head, reviewResultFingerprint(findings))}`,
      author: { login: "deadloop-bot" },
    };
    const priorRepairResultComment = {
      id: 102,
      body: `## Automatic review repair completed\n\n<!-- deadloop:review-repair-result key=1234567890abcdef1234 head=${repairedHead} -->`,
      author: { login: "deadloop-bot" },
    };
    const comments = testCase === "repeated-repair" || testCase === "persisted-finding"
      ? [priorReviewComment, priorRepairResultComment]
      : testCase === "fourth-progress-repair"
        ? [1, 2, 3].map((index) => ({
            body: renderRepairMarker(String(index).repeat(40).slice(0, 40), String(index).repeat(20)),
            author: { login: "deadloop-bot" },
          }))
        : testCase === "repeated-technical-failure"
          ? [{ body: renderTechnicalFailureMarker(head) }]
          : [];
    fs.writeFileSync(commentsFile, JSON.stringify(comments));
    const executable = (file: string, content: string) => {
      fs.writeFileSync(file, content);
      fs.chmodSync(file, 0o755);
    };
    executable(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const methodFlag = args.includes("--method") ? "--method" : "-X";
const mutationMethod = args[args.indexOf(methodFlag) + 1];
if (args[0] === "api" && args[1] === "user") process.stdout.write("deadloop-bot\\n");
else if (args.some((arg) => arg.endsWith("/events"))) process.stdout.write(JSON.stringify([[{id:22,event:"labeled",created_at:"2026-07-20T10:00:00Z",label:{name:"agent:review"}}]]));
else if (args.some((arg) => arg.endsWith("/comments"))) process.stdout.write(JSON.stringify([[]]));
else if (args[0] === "api" && args.includes("--include")) process.stdout.write("date: Mon, 20 Jul 2026 10:03:00 GMT");
else if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number: 31, state: "OPEN", headRefName: "${branch}", headRefOid: "${currentHead}", isCrossRepository: false,
  labels: JSON.parse(fs.readFileSync(process.env.TEST_LABELS_FILE, "utf8")).map(name => ({name})),
  comments: JSON.parse(fs.readFileSync(process.env.TEST_COMMENTS_FILE, "utf8"))
}));
else if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({id: "R_repo", nameWithOwner: "owner/repo"}));
else if (args[0] === "api" && ["POST"].includes(mutationMethod) && /labels$/.test(args[3] || "")) {
  const labels = JSON.parse(fs.readFileSync(process.env.TEST_LABELS_FILE, "utf8"));
  const bodyField = args.find(arg => arg === "-");
  const body = bodyField !== undefined ? JSON.parse(fs.readFileSync(0, "utf8")) : { labels: [] };
  fs.writeFileSync(process.env.TEST_LABELS_FILE, JSON.stringify([...new Set([...labels, ...body.labels])]));
  fs.appendFileSync(process.env.TEST_GITHUB_LOG, args.join(" ") + "\\n");
  process.stdout.write(JSON.stringify(labels));
}
else {
  if (args[0] === "pr" && args[1] === "edit") {
    const labels = new Set(JSON.parse(fs.readFileSync(process.env.TEST_LABELS_FILE, "utf8")));
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--add-label") labels.add(args[index + 1]);
      if (args[index] === "--remove-label") labels.delete(args[index + 1]);
    }
    fs.writeFileSync(process.env.TEST_LABELS_FILE, JSON.stringify([...labels]));
  }
  if (args[0] === "pr" && args[1] === "comment") {
    const comments = JSON.parse(fs.readFileSync(process.env.TEST_COMMENTS_FILE, "utf8"));
    const body = args[args.indexOf("--body") + 1];
    if (args.includes("--delete-last")) comments.pop();
    else if (args.includes("--edit-last")) comments[comments.length - 1].body = body;
    else comments.push({id: 1000 + comments.length, body, author: {login: "deadloop-bot"}});
    fs.writeFileSync(process.env.TEST_COMMENTS_FILE, JSON.stringify(comments));
  }
  if (args[0] === "api" && ["PATCH", "PUT", "DELETE"].includes(mutationMethod)) {
    const comments = JSON.parse(fs.readFileSync(process.env.TEST_COMMENTS_FILE, "utf8"));
    const endpoint = args.find(arg => /issues\\/comments\\/\\d+$/.test(arg));
    const commentId = Number(endpoint && endpoint.split("/").pop());
    const index = comments.findIndex(comment => comment.id === commentId);
    if (index >= 0 && mutationMethod === "DELETE") comments.splice(index, 1);
    else if (index >= 0) {
      const bodyField = args.find(arg => arg.startsWith("body="));
      comments[index].body = bodyField ? bodyField.slice("body=".length) : "edited through API";
    }
    fs.writeFileSync(process.env.TEST_COMMENTS_FILE, JSON.stringify(comments));
  }
  if (args[0] === "api" && args[1] === "graphql" && /(?:update|delete)IssueComment/.test(args.join(" "))) {
    const comments = JSON.parse(fs.readFileSync(process.env.TEST_COMMENTS_FILE, "utf8"));
    if (comments.length > 0) comments[comments.length - 1].body = "mutated through GraphQL";
    fs.writeFileSync(process.env.TEST_COMMENTS_FILE, JSON.stringify(comments));
  }
  fs.appendFileSync(process.env.TEST_GITHUB_LOG, args.join(" ") + "\\n");
}
`,
    );
    executable(
      path.join(bin, "git"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
// The checkout already carries the expected head, so alignment finds nothing to do.
else if (args.includes("rev-parse") && args.includes("HEAD")) process.stdout.write("${currentHead}\\n");
else if (args.includes("rev-parse") && args.some(arg => arg.endsWith("^{commit}"))) process.stdout.write("${"f".repeat(40)}\\n");
else if (args.includes("show") && args.some(arg => arg.endsWith(":deadloop.json"))) process.exit(1);
`,
    );
    executable(
      path.join(bin, "herdr"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_HERDR_LOG, args.join(" ") + "\\n");
if (args[0] === "--version") process.stdout.write("herdr 0.8.0\\n");
else if (args[0] === "status" && args[1] === "server") process.stdout.write("version: 0.8.0\\n");
else if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result: {worktrees: [{path: process.env.TEST_WORKTREE, branch: "agent/issue-31"}]}}));
else if (args[0] === "worktree" && args[1] === "open") process.stdout.write(JSON.stringify({result: {type: "worktree_opened", already_open: false, workspace: {workspace_id: "workspace-1"}, tab: {tab_id: "tab-1", workspace_id: "workspace-1"}, root_pane: {pane_id: "pane-1", tab_id: "tab-1", workspace_id: "workspace-1", cwd: process.env.TEST_WORKTREE}, worktree: {path: process.env.TEST_WORKTREE}}}));
else if (args[0] === "workspace" && args[1] === "list") process.stdout.write(JSON.stringify({result: {workspaces: []}}));
else if (args[0] === "workspace" && args[1] === "rename") process.stdout.write("renamed");
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result: {agents: fs.existsSync(process.env.TEST_HERDR_LOG + ".agent") ? [JSON.parse(fs.readFileSync(process.env.TEST_HERDR_LOG + ".agent", "utf8"))] : []}}));
else if (args[0] === "agent" && args[1] === "start") { fs.writeFileSync(process.env.TEST_HERDR_LOG + ".agent", JSON.stringify({terminal_id:"terminal-1",name:args[2],agent_status:"working",cwd:process.env.TEST_WORKTREE,pane_id:args[args.indexOf("--pane")+1]})); process.stdout.write(JSON.stringify({ok: true})); }
`,
    );
    const result = spawnSync(
      "node",
      ["extensions/deadloop/automations/pr-review-repair-dispatch.cts", "--promise", promise, "--attempt-record", attemptRecord, "--request-event-id", "22", "--pr", "31", "--expected-head", currentHead, "--branch", branch],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PI_CODING_AGENT_DIR: configDir,
          DEADLOOP_PROJECT_ID: "demo",
          DEADLOOP_REPO_PATH: root,
          DEADLOOP_WORKTREE_ROOT: worktreeRoot,
          DEADLOOP_GITHUB_REPO: "owner/repo",
          DEADLOOP_ENABLED_AT: "1",
          DEADLOOP_STATE_DIR: state,
          DEADLOOP_REQUIRED_VERIFICATION: JSON.stringify({ repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: head }),
          TEST_COMMENTS_FILE: commentsFile,
          TEST_GITHUB_LOG: githubLog,
          TEST_HERDR_LOG: herdrLog,
          TEST_LABELS_FILE: labelsFile,
          TEST_WORKTREE: worktree,
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    let retryCycleEffects: unknown;
    if (testCase === "first-technical-failure" || testCase === "repeated-technical-failure") {
      const retryFixture = path.join(root, "retry-cycle.json");
      fs.writeFileSync(retryFixture, JSON.stringify({
        prs: [{
          number: 31, title: "PR", url: "https://github.com/owner/repo/pull/31", updatedAt: "2026-07-08T00:00:00Z",
          headRefName: branch, headRefOid: head, isCrossRepository: false, isDraft: false,
          labels: JSON.parse(fs.readFileSync(labelsFile, "utf8")).map((name: string) => ({ name })),
          statusCheckRollup: [], comments: JSON.parse(fs.readFileSync(commentsFile, "utf8")), reviewRequests: [], mergeStateStatus: "CLEAN",
        }],
        agents: { result: { agents: [] } },
      }));
      retryCycleEffects = reviewerDriver(retryFixture).testAdapterEffects;
    }
    return {
      ...JSON.parse(result.stdout),
      githubLog: fs.existsSync(githubLog) ? fs.readFileSync(githubLog, "utf8") : "",
      herdrLog: fs.existsSync(herdrLog) ? fs.readFileSync(herdrLog, "utf8") : "",
      observedLabels: JSON.parse(fs.readFileSync(labelsFile, "utf8")),
      observedComments: JSON.parse(fs.readFileSync(commentsFile, "utf8")),
      retryCycleEffects,
      originalComments: comments.flatMap((comment) =>
        "id" in comment ? [{ id: Number(comment.id), body: comment.body }] : []),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function finalizerOps(
  commands: string[][],
  actualHead = head,
  isCrossRepository = false,
  checkFails = false,
  changedFiles: string[] = [],
) {
  return {
    ensureVerification: async (_args: unknown, _candidate: string, _repositoryId: string, run: (args: string[]) => unknown) => {
      const result = run(["node", "/automation/run-project-check.ts"]) as { status?: number };
      if (checkFails && result.status !== 0) throw new Error("required verification failed");
      return result;
    },
    loadAttemptRecord: () => ({
      role: "review-repair", repository: "owner/repo", target: { kind: "pull-request", number: 31 },
      inputRevision: { head },
    }),
    assertEnabled: () => ({ githubRepo: "owner/repo", githubRepositoryId: "R_repo", automationLogin: "deadloop-bot" }),
    run: (args: string[]) => {
      commands.push(args);
      if (checkFails && args[0] === "node" && args.some((argument) => argument.endsWith("run-project-check.ts"))) {
        return { status: 1, stdout: "", stderr: "required verification failed" };
      }
      if (args.includes("--name-only") && (args.includes("diff") || args.includes("diff-tree"))) {
        return { status: 0, stdout: changedFiles.map((file) => `${file}\n`).join(""), stderr: "" };
      }
      if (args.includes("get-url")) return { status: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
      if (args.includes("ls-remote")) return { status: 0, stdout: `${head}\trefs/heads/${branch}\n`, stderr: "" };
      if (args.includes("--git-common-dir")) return { status: 0, stdout: "/common\n", stderr: "" };
      if (args.includes("symbolic-ref")) return { status: 0, stdout: `${branch}\n`, stderr: "" };
      if (args[0] === "gh" && args[1] === "api" && args[2] === "user") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
      if (args[0] === "gh" && args[1] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: "owner/repo" }), stderr: "" };
      if (args[0] === "gh" && args.some((arg) => arg.endsWith("/events"))) return { status: 0, stdout: JSON.stringify([[{ id: 22, event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } }]]), stderr: "" };
      if (args[0] === "gh" && args.includes("--include")) return { status: 0, stdout: "date: Mon, 20 Jul 2026 10:03:00 GMT", stderr: "" };
      if (args[0] === "gh") {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", isCrossRepository, headRefName: branch, headRefOid: actualHead, labels: [{ name: "agent:in-progress" }] }),
          stderr: "",
        };
      }
      if (args.includes("rev-parse")) return { status: 0, stdout: `${repairedHead}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

function repairFinalizer(commands: string[][], actualHead = head, checkFails = false, changedFiles: string[] = []) {
  return finalizeReviewRepair(
    {
      repo: "/worktree",
      projectId: "demo",
      attemptRecord: "/state/runs/reviewer/attempt.json",
      projectRepo: "/repo",
      githubRepo: "owner/repo",
      pr: "31",
      branch,
      expectedHead: head,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      enabledAt: 1,
      checkCommand: "npm test",
      inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
      resultFile: "/state/runs/reviewer/finalizer-result.json",
    },
    finalizerOps(commands, actualHead, false, checkFails, changedFiles),
  );
}

function branchUpdateFinalizer(commands: string[][], actualHead = head, isCrossRepository = false) {
  return finalizeBranchUpdate(
    {
      repo: "/worktree",
      projectId: "demo",
      projectRepo: "/repo",
      githubRepo: "owner/repo",
      attemptRecord: "/state/runs/attempt/attempt.json",
      pr: "31",
      branch,
      expectedHead: head,
      expectedBase: base,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      enabledAt: 1,
      checkCommand: "npm test",
    },
    finalizerOps(commands, actualHead, isCrossRepository),
  );
}

Given("A pull request has a conflict that can be recovered", function (this: RecoveryWorld) {
  this.case = "conflict";
});

Given("Conflict recovery was already attempted for the same pull request head and base", function (this: RecoveryWorld) {
  this.case = "repeated-conflict";
});

Given("Conflict recovery changed the pull request head", function (this: RecoveryWorld) {
  this.case = "resolved-conflict";
});

Given("Conflict recovery changed a repaired pull request head", function (this: RecoveryWorld) {
  this.case = "resolved-repaired-conflict";
});

Given("An approved review contains only advisory observations", function (this: RecoveryWorld) {
  this.result = {
    schemaVersion: 1,
    attemptId: "reviewer",
    role: "reviewer",
    target: { repository: "owner/repo", kind: "pull-request", number: 31 },
    inputRevision: { head },
    status: "complete",
    summary: "The review is complete. No required correction remains. One optional observation is recorded.",
    result: {
      outcome: "approved",
      reviewedHead: head,
      findings: [],
      advisories: [{ title: "Clearer name", body: "A more descriptive name would help readers." }],
    },
    evidence: { reviewed: ["complete PR history"] },
  };
});

Given("An approved review contains a required finding", function (this: RecoveryWorld) {
  this.result = {
    schemaVersion: 1,
    attemptId: "reviewer",
    role: "reviewer",
    target: { repository: "owner/repo", kind: "pull-request", number: 31 },
    inputRevision: { head },
    status: "complete",
    summary: "The review is complete. A required correction remains. Approval is therefore invalid.",
    result: { outcome: "approved", reviewedHead: head, findings },
    evidence: { reviewed: ["complete PR history"] },
  };
});

Given("A pull request has actionable review findings for the first time", function (this: RecoveryWorld) {
  this.case = "first-repair";
});

Given("A pull request has three historical repairs and only new required findings", function (this: RecoveryWorld) {
  this.case = "fourth-progress-repair";
});

Given("A prior required finding persists after repair", function (this: RecoveryWorld) {
  this.case = "persisted-finding";
});

Given("A resolved required finding regresses after repair", function (this: RecoveryWorld) {
  this.case = "regressed-finding";
});

Given("Prior and new required findings are mixed after repair", function (this: RecoveryWorld) {
  this.case = "mixed-findings";
});

Given("A review result has an internal finding fingerprint", function (this: RecoveryWorld) {
  const reviewFingerprint = "1234567890abcdef1234";
  this.result = {
    reviewFingerprint,
    comment: renderChangesRequestedComment({
      headOid: head,
      reviewFingerprint,
      priorRequiredFindings: "none",
      findings,
    }),
  };
});

Given("A completed review has a recorded pull request history", function (this: RecoveryWorld) {
  const history = {
    pullRequest: { number: 31, state: "open", headRef: branch, headSha: head, baseRef: "main", baseSha: base },
    commits: [{ sha: head }],
    diff: { sha256: createHash("sha256").update("diff\n").digest("hex"), bytes: 5 },
    conversationComments: [],
    submittedReviews: [],
    inlineReviewComments: [],
  };
  this.result = {
    expected: {
      schemaVersion: 1,
      repository: "owner/repo",
      pullRequestNumber: 31,
      revision: createHash("sha256").update(`${JSON.stringify(history)}\n`).digest("hex"),
      history,
      evidence: { exactDiff: "diff\n" },
    },
  };
});

Given("The English and Japanese public documentation", function (this: RecoveryWorld) {
  this.result = {
    english: fs.readFileSync("README.md", "utf8"),
    japanese: fs.readFileSync("README.ja.md", "utf8"),
  };
});

Given("A verified repair necessarily changes twenty-one files", function (this: RecoveryWorld) {
  this.case = "broad-repair-finalize";
});

Given("The same review findings remain on the new head after repair", function (this: RecoveryWorld) {
  this.case = "repeated-repair";
});

Given("A pull request is being repaired for review findings", function (this: RecoveryWorld) {
  this.case = "repair-dispatch";
});

Given("A repair push changed the pull request head", function (this: RecoveryWorld) {
  this.case = "repaired-head";
});

Given("A pull request has its first technical review failure", function (this: RecoveryWorld) {
  this.case = "first-technical-failure";
});

Given("A pull request already had one technical review failure", function (this: RecoveryWorld) {
  this.case = "repeated-technical-failure";
});

Given("The pull request head selected for repair has been verified", function (this: RecoveryWorld) {
  this.case = "repair-finalize";
});

Given("The pull request head selected for conflict recovery has been verified", function (this: RecoveryWorld) {
  this.case = "branch-update-finalize";
});

Given("A pull request from another repository has a conflict", function (this: RecoveryWorld) {
  this.case = "cross-repository-branch-update";
});

When("deadloop checks the pull request", function (this: RecoveryWorld) {
  if (this.case === "conflict") this.result = reviewerDriver("merge-conflict.json");
  if (this.case === "repeated-conflict") this.result = reviewerDriver("merge-conflict-double-attempt.json");
  if (this.case === "resolved-conflict") this.result = reviewerDriver("merge-conflict-updated.json");
  if (this.case === "resolved-repaired-conflict") this.result = reviewerDriver("repaired-merge-conflict-updated.json");
  if (this.case === "repaired-head") this.result = reviewerDriver("review-repair-pushed.json");
});

When("deadloop validates the review result", function (this: RecoveryWorld) {
  try {
    this.result = { validated: validateCompletionReportV1(this.result) };
  } catch (error) {
    this.error = error as Error;
  }
});

When("deadloop processes the review result", function (this: RecoveryWorld) {
  if (!this.case) throw new Error("review recovery case is missing");
  this.result = repairDispatch(this.case);
});

When("deadloop renders the review comment", function (this: RecoveryWorld) {
  // Rendering already occurred through the production comment seam in Given.
});

When("A conversation comment is added after review", function (this: RecoveryWorld) {
  const expected = this.result?.expected;
  const actualHistory = {
    ...expected.history,
    conversationComments: [{ id: "1", nodeId: "", author: "human", body: "New evidence", createdAt: "x", updatedAt: "x" }],
  };
  const actual = {
    ...expected,
    revision: createHash("sha256").update(`${JSON.stringify(actualHistory)}\n`).digest("hex"),
    history: actualHistory,
  };
  this.result = comparePrHistoryObservations(expected, actual);
});

When("The review repair contracts are compared", function (this: RecoveryWorld) {
  const english = String(this.result?.english || "");
  const japanese = String(this.result?.japanese || "");
  this.result = {
    english: {
      advisories: english.includes("may still include advisory observations"),
      fourthRepair: english.includes("a fourth or later repair remains eligible"),
      appendOnly: english.includes("chronological and append-only"),
      untrustedEvidence: english.includes("untrusted evidence"),
      requiredVerification: english.includes("Required-verification failure still blocks a repair push"),
    },
    japanese: {
      advisories: japanese.includes("任意の参考所見は残せます"),
      fourthRepair: japanese.includes("四回目以降の修復も実行できます"),
      appendOnly: japanese.includes("投稿済みコメントを編集しません"),
      untrustedEvidence: japanese.includes("信頼できない証拠"),
      requiredVerification: japanese.includes("必須検証に失敗した修復は push しません"),
    },
  };
});

When("deadloop starts the review repair", function (this: RecoveryWorld) {
  if (!this.case) throw new Error("review repair case is missing");
  this.result = repairDispatch(this.case);
});

When("The pull request head changes immediately before push", async function (this: RecoveryWorld) {
  this.commands = [];
  if (this.case === "repair-finalize") this.result = await repairFinalizer(this.commands, base);
  if (this.case === "branch-update-finalize") this.result = await branchUpdateFinalizer(this.commands, base);
});

When("deadloop completes the repair", async function (this: RecoveryWorld) {
  this.commands = [];
  const changedFiles = this.case === "broad-repair-finalize"
    ? Array.from({ length: 21 }, (_value, index) => `src/repair-${index + 1}.ts`)
    : [];
  this.result = await repairFinalizer(this.commands, head, false, changedFiles);
});

When("Required verification fails during repair completion", async function (this: RecoveryWorld) {
  this.commands = [];
  try {
    this.result = await repairFinalizer(this.commands, head, true);
  } catch (error) {
    this.error = error as Error;
  }
});

When("deadloop completes conflict recovery", async function (this: RecoveryWorld) {
  this.commands = [];
  this.result = await branchUpdateFinalizer(this.commands, head, this.case === "cross-repository-branch-update");
});

Then("The review result is accepted as approved", function (this: RecoveryWorld) {
  assert.equal(this.result?.validated?.result?.outcome, "approved");
});

Then("The approved review result is rejected", function (this: RecoveryWorld) {
  assert.match(String(this.error?.message || ""), /approved requires no required findings/);
});

Then("The human-readable review comment contains no finding fingerprint", function (this: RecoveryWorld) {
  const visible = String(this.result?.comment || "").replace(/<!--[\s\S]*?-->/g, "");
  assert.equal(visible.includes(String(this.result?.reviewFingerprint || "")), false);
});

Then("The completed review history is stale", function (this: RecoveryWorld) {
  assert.equal(this.result?.kind, "stale");
});

Then("Both public documents describe the review-history repair contract", function (this: RecoveryWorld) {
  assert.deepEqual(this.result, {
    english: { advisories: true, fourthRepair: true, appendOnly: true, untrustedEvidence: true, requiredVerification: true },
    japanese: { advisories: true, fourthRepair: true, appendOnly: true, untrustedEvidence: true, requiredVerification: true },
  });
});

Then("deadloop does not edit earlier review or repair-result comments", function (this: RecoveryWorld) {
  const observedById = new Map(
    (this.result?.observedComments || []).map((comment: { id: number; body: string }) => [comment.id, comment.body]),
  );
  assert.deepEqual(
    this.result?.originalComments?.map((comment) => ({ id: comment.id, body: observedById.get(comment.id) })),
    this.result?.originalComments,
  );
});

Then("deadloop requests a branch update instead of recovering from local state", function (this: RecoveryWorld) {
  const effects = adapterEffects(this.result) || {};
  assert.deepEqual({
    action: this.result?.driverAction,
    starts: effects.herdrStarts?.length ?? 0,
    requested: (effects.labels?.["31"] ?? []).includes("agent:update-branch"),
  }, { action: "branch_update_requested", starts: 0, requested: true });
});

Then("deadloop blocks the repeated conflict-recovery request", function (this: RecoveryWorld) {
  assert.equal(this.result?.driverAction, "branch_update_attempt_exhausted");
});

Then("deadloop leaves recovery guidance for the repeated conflict-recovery request", function (this: RecoveryWorld) {
  assert.match(String(this.result?.comment || ""), /Recovery steps/);
});

Then("deadloop does not start another dedicated conflict-recovery attempt", function (this: RecoveryWorld) {
  const starts = adapterEffects(this.result)?.herdrStarts?.filter((start: any) => start.name.includes("branch-update")) ?? [];
  assert.equal(starts.length, 0);
});

Then("deadloop returns the pull request to normal review", function (this: RecoveryWorld) {
  const starts = adapterEffects(this.result)?.herdrStarts?.filter((start: any) => start.name.endsWith("-reviewer")) ?? [];
  assert.equal(starts.length, 1);
});

Then("The selection reason after conflict recovery is repair re-review", function (this: RecoveryWorld) {
  assert.equal((this.result?.decision as { reason?: string } | undefined)?.reason, "repair_rereview");
});

Then("deadloop preserves the review state", function (this: RecoveryWorld) {
  const labels = adapterEffects(this.result)?.labels?.["31"] ?? this.result?.observedLabels;
  // The conflict case holds its review claim; the repair-dispatch case releases the claim into
  // the queued agent:implement request (ADR 0032).
  const expected = this.case === "conflict"
    ? ["agent:review", "agent:in-progress"]
    : ["agent:implement"];
  assert.deepEqual(labels, expected);
});

Then("deadloop queues an agent:implement repair request without starting an agent", function (this: RecoveryWorld) {
  assert.deepEqual({
    action: this.result?.driverAction,
    starts: loggedAgentStartCount(this.result),
    requested: observedLabels(this.result).includes("agent:implement"),
    claimReleased: !observedLabels(this.result).includes("agent:in-progress"),
  }, { action: "review_repair_requested", starts: 0, requested: true, claimReleased: true });
});

Then("deadloop does not start another dedicated repair attempt", function (this: RecoveryWorld) {
  assert.equal(loggedAgentStartCount(this.result), 0);
});

const PR_REQUEST_LABELS = ["agent:update-branch", "agent:implement", "agent:review"];

Then("deadloop leaves no waiting request on the pull request", function (this: RecoveryWorld) {
  assert.equal(observedLabels(this.result).some((label) => PR_REQUEST_LABELS.includes(label)), false);
});

const AGENT_WORKFLOW_LABELS = [...PR_REQUEST_LABELS, "agent:in-progress", "agent:blocked"];

Then("deadloop leaves no agent workflow label on the pull request", function (this: RecoveryWorld) {
  assert.equal(observedLabels(this.result).some((label) => AGENT_WORKFLOW_LABELS.includes(label)), false);
});

Then("deadloop escalates the pull request for human handling", function (this: RecoveryWorld) {
  assert.equal(observedLabels(this.result).includes("agent:blocked"), true);
});

Then("deadloop leaves recovery guidance", function (this: RecoveryWorld) {
  assert.equal(observedComments(this.result).some((comment) => comment.body.includes("## Recovery steps")), true);
});

Then("deadloop retries the review exactly once", function (this: RecoveryWorld) {
  const starts = (this.result?.retryCycleEffects as any)?.herdrStarts?.filter((start: any) => start.name.endsWith("-reviewer")) ?? [];
  assert.equal(starts.length, 1);
});

Then("deadloop does not escalate the pull request for human handling", function (this: RecoveryWorld) {
  assert.equal((this.result?.observedLabels as string[]).includes("agent:blocked"), false);
});

Then("deadloop does not start normal review", function (this: RecoveryWorld) {
  const starts = (this.result?.retryCycleEffects as any)?.herdrStarts?.filter((start: any) => start.name.endsWith("-reviewer")) ?? [];
  assert.equal(starts.length, 0);
});

Then("deadloop does not push to the branch", function (this: RecoveryWorld) {
  assert.equal(this.commands?.some((command) => command.includes("push")), false);
});

Then("deadloop pushes to the verified branch under a lease on the verified head", function (this: RecoveryWorld) {
  assert.deepEqual(this.commands?.find((command) => command.includes("push")), ["git", "-C", "/worktree", "push", "--porcelain", `--force-with-lease=refs/heads/${branch}:${head}`, "https://github.com/owner/repo.git", `${repairedHead}:refs/heads/${branch}`]);
});

Then("deadloop runs the configured checks before the final pull request head check", function (this: RecoveryWorld) {
  const checkIndex = this.commands?.findIndex((command) => command[0] === "node") ?? -1;
  const headCheckIndex = this.commands?.findIndex((command) => command[0] === "gh") ?? -1;
  assert.ok(checkIndex >= 0 && checkIndex < headCheckIndex);
});

Then("deadloop pushes to the conflict-recovery branch under a lease on the verified head", function (this: RecoveryWorld) {
  assert.deepEqual(this.commands?.find((command) => command.includes("push")), ["git", "-C", "/worktree", "push", "--porcelain", `--force-with-lease=refs/heads/${branch}:${head}`, "https://github.com/owner/repo.git", `${repairedHead}:refs/heads/${branch}`]);
});

Then("deadloop runs the configured checks before the final conflict-recovery pull request head check", function (this: RecoveryWorld) {
  const checkIndex = this.commands?.findIndex((command) => command[0] === "node") ?? -1;
  const headCheckIndex = this.commands?.findIndex((command) => command[0] === "gh") ?? -1;
  assert.ok(checkIndex >= 0 && checkIndex < headCheckIndex);
});

Then("deadloop does not push to the conflict-recovery branch", function (this: RecoveryWorld) {
  assert.equal(this.commands?.some((command) => command.includes("push")), false);
});
