import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const {
  persistHostVerificationEvidence,
  requiredVerificationBinding,
  workerRequiredVerificationPath,
  writeWorkerContractSnapshot,
} = require("../src/worker-required-verification-runtime.cjs");
const { renderReviewClaimComment } = require("../extensions/deadloop/automations/pr-review-claim.ts");
const { completion } = require("../extensions/deadloop/automations/pr-review-repair-complete.ts");
const roots: string[] = [];
const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);
const key = "abcdef1234567890abcd";
const activeReviewState = {
  managedLabels: ["agent:review", "agent:implement", "agent:update-branch", "agent:in-progress", "agent:blocked"],
  requestLabel: "agent:review",
  requiredLabels: ["agent:in-progress"],
};

function writeCompatibleHerdr(bin: string): void {
  const herdr = path.join(bin, "herdr");
  fs.writeFileSync(herdr, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'herdr 0.8.0\\n'; else printf 'version: 0.8.0\\n'; fi\n`);
  fs.chmodSync(herdr, 0o755);
}

function runCompletion(options: {
  promise: Record<string, unknown>;
  receipt?: Record<string, unknown> | string;
  comments?: { body: string; author?: { login: string } }[];
  liveHead?: string;
  headAfterAuthorization?: string;
  state?: string;
  labels?: { name: string }[];
  verificationRecord?: "authenticated" | "legacy" | "missing";
  headAfterPosting?: string;
  currentProject?: Record<string, unknown>;
  authenticatedLogin?: string;
  enabled?: boolean;
  dateUnavailable?: boolean;
  editedClaim?: boolean;
  expireAfterObservations?: boolean;
  raceAfterComment?: "runtime" | "grace" | "managed label" | "authorized identity" | "authenticated login" | "enablement";
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-repair-complete-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const stateDir = path.join(root, "config", "deadloop");
  const projectRepo = path.join(root, "repo");
  const runDir = path.join(stateDir, "runs", "repair-run");
  const attemptFile = path.join(runDir, "attempt.json");
  const promiseFile = path.join(runDir, "promise.json");
  const resultFile = path.join(runDir, "finalizer-result.json");
  const contractFile = path.join(runDir, "review-contract.json");
  const postedFile = path.join(root, "posted.txt");
  const actionsFile = path.join(root, "actions.txt");
  const viewsFile = path.join(root, "views.txt");
  const retractedFile = path.join(root, "retracted.txt");
  const authLoginFile = path.join(root, "authenticated-login");
  const observationFile = path.join(root, "claim-observation-complete");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(projectRepo);
  writeCompatibleHerdr(bin);
  spawnSync("git", ["-C", projectRepo, "init", "--quiet"]);
  spawnSync("git", ["-C", projectRepo, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", projectRepo, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(projectRepo, "README.md"), "fixture\n");
  fs.writeFileSync(path.join(projectRepo, "deadloop.json"), "{}\n");
  spawnSync("git", ["-C", projectRepo, "add", "."]);
  spawnSync("git", ["-C", projectRepo, "commit", "--quiet", "-m", "fixture"]);
  const branchName = spawnSync("git", ["-C", projectRepo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const baseBranch = `origin/${branchName}`;
  spawnSync("git", ["-C", projectRepo, "update-ref", `refs/remotes/${baseBranch}`, "HEAD"]);
  const baseRevision = spawnSync("git", ["-C", projectRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["-C", projectRepo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  const enabledProjectsFile = path.join(stateDir, "enabled-projects.json");
  const projectsFile = path.join(stateDir, "projects.json");
  fs.writeFileSync(authLoginFile, `${options.authenticatedLogin || "deadloop-bot"}\n`);
  fs.writeFileSync(enabledProjectsFile, JSON.stringify({ projects: [{
    repoPath: projectRepo, githubRepo: "owner/repo", githubRepositoryId: "R_repo", baseBranch, automationLogin: "deadloop-bot", enabledAt: 1,
    firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
    autoMergeAcknowledged: false, enabled: options.enabled ?? true,
  }] }));
  fs.writeFileSync(projectsFile, JSON.stringify({ projects: [{
    id: "demo", repoPath: projectRepo, githubRepo: "owner/repo", baseBranch, checkCommand: "npm test", ...options.currentProject,
  }] }));
  const binding = {
    repositoryId: "R_repo", repository: "owner/repo", targetNumber: 24, requestEventId: "22", role: "reviewer", revision: oldHead, owner: "host-a",
    authority: { durationSeconds: 86700 }, activeState: activeReviewState,
  };
  const reviewClaim = {
    binding, commentId: "101", authorizedLogins: ["deadloop-bot"], automationLogin: "deadloop-bot", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
    requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
  };
  const claimComment = { id: 101, created_at: "2026-07-20T10:01:00Z", updated_at: options.editedClaim ? "2026-07-20T10:02:00Z" : "2026-07-20T10:01:00Z", user: { login: "deadloop-bot" }, body: renderReviewClaimComment(binding) };
  const outcome = String(options.promise.reason || "");
  const strongPromise = {
    schemaVersion: 1, attemptId: key, role: "review-repair",
    target: { repository: "owner/repo", kind: "pull-request", number: 24 },
    inputRevision: { head: oldHead }, status: options.promise.status, summary: options.promise.summary,
    result: outcome === "repair_pushed"
      ? { outcome, outputRevision: newHead, repairs: options.promise.repairs }
      : outcome === "stale_head" ? { outcome, outputRevision: options.liveHead || newHead }
        : options.promise.result,
    evidence: outcome === "repair_pushed"
      ? { finalizer: typeof options.receipt === "object" ? { ...options.receipt, reason: outcome } : options.receipt, validations: options.promise.checks }
      : outcome === "stale_head" ? { finalizer: options.receipt } : options.promise.evidence || {},
  };
  fs.writeFileSync(promiseFile, JSON.stringify(strongPromise));
  const requiredVerification = {
    repository: "owner/repo", command: "npm test",
    source: { kind: "local", location: `${path.join(stateDir, "projects.json")}#project=demo` }, baseRevision,
  };
  const attempt = {
    schemaVersion: 1, attemptId: key, launchUuid: "repair-run", project: "demo", repository: "owner/repo",
    role: "review-repair", target: { kind: "pull-request", number: 24 }, inputRevision: { head: oldHead },
    branch: "agent/issue-24", baseBranch: baseRevision, worktreePath: projectRepo, agentName: "dl-x-24-abcdef123456",
    workspaceLabel: "repair", promptFile: path.join(runDir, "prompt.md"), promiseFile, requiredVerification,
    phase: "agent_started", lastSuccessfulPhase: "agent_started", reviewClaim,
  };
  fs.writeFileSync(attemptFile, JSON.stringify(attempt));
  writeWorkerContractSnapshot(runDir, attempt);
  const verificationRecord = {
    version: 1, binding: requiredVerificationBinding(requiredVerification, newHead), outcome: "passed", exitCode: 0,
    startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1, logPath: path.join(runDir, "required-verification.log"),
  };
  if (options.verificationRecord === "legacy") fs.writeFileSync(workerRequiredVerificationPath(attemptFile), JSON.stringify({ command: "npm test", result: "passed" }));
  else if (options.verificationRecord !== "missing") persistHostVerificationEvidence(workerRequiredVerificationPath(attemptFile), verificationRecord);
  fs.writeFileSync(
    contractFile,
    JSON.stringify({ attemptKey: key, expectedHead: oldHead, findingTitles: ["Unsafe fallback"] }),
  );
  if (options.receipt) {
    fs.writeFileSync(resultFile, typeof options.receipt === "string" ? options.receipt : JSON.stringify(options.receipt));
  }
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"owner/repo"}));
else if (args[0] === "api" && args[1] === "user") process.stdout.write(fs.readFileSync(process.env.AUTH_LOGIN_FILE, "utf8"));
else if (args.some((arg) => arg.endsWith("/events"))) process.stdout.write(JSON.stringify([[{id:22,event:"labeled",created_at:"2026-07-20T10:00:00Z",label:{name:"agent:review"}}]]));
else if (args.some((arg) => arg.endsWith("/comments"))) { fs.writeFileSync(process.env.OBSERVATION_FILE, "complete"); process.stdout.write(${JSON.stringify(JSON.stringify([[claimComment]]))}); }
else if (args[0] === "api" && args.includes("DELETE")) { fs.appendFileSync(process.env.RETRACTED_FILE, args.join(" ") + "\\n"); fs.rmSync(process.env.POSTED_FILE, {force:true}); }
else if (args[0] === "api" && args.includes("--include")) { const expired = process.env.EXPIRE_AFTER_OBSERVATIONS === "1" && fs.existsSync(process.env.OBSERVATION_FILE); process.stdout.write(expired ? "date: Tue, 21 Jul 2026 10:06:01 GMT" : ${JSON.stringify(options.dateUnavailable ? "" : "date: Mon, 20 Jul 2026 10:03:00 GMT")}); }
else if (args[0] === "pr" && args[1] === "view") {
  const views = fs.existsSync(process.env.VIEWS_FILE) ? Number(fs.readFileSync(process.env.VIEWS_FILE, "utf8")) : 0;
  fs.writeFileSync(process.env.VIEWS_FILE, String(views + 1));
  const posted = fs.existsSync(process.env.POSTED_FILE);
  const comments = ${JSON.stringify(options.comments || [])};
  if (posted) comments.push({body:fs.readFileSync(process.env.POSTED_FILE, "utf8"),author:{login:"deadloop-bot"}});
  const head = posted && ${JSON.stringify(Boolean(options.headAfterPosting))} ? ${JSON.stringify(options.headAfterPosting || "")} : views >= 2 ? "${options.headAfterAuthorization || options.liveHead || newHead}" : "${options.liveHead || newHead}";
  process.stdout.write(JSON.stringify({state:${JSON.stringify(options.state || "OPEN")},headRefName:"agent/issue-24",headRefOid:head,isCrossRepository:false,labels:${JSON.stringify(options.labels || [{ name: "agent:in-progress" }])},comments}));
}
else if (args[0] === "pr" && args[1] === "comment") {
  fs.writeFileSync(process.env.POSTED_FILE, args[args.indexOf("--body") + 1]);
  process.stdout.write("https://github.com/owner/repo/pull/24#issuecomment-9901\\n");
  if (process.env.RACE_AFTER_COMMENT === "authenticated login") fs.writeFileSync(process.env.AUTH_LOGIN_FILE, "other-bot\\n");
  else if (process.env.RACE_AFTER_COMMENT === "enablement") {
    const data = JSON.parse(fs.readFileSync(process.env.ENABLED_PROJECTS_FILE, "utf8"));
    data.projects[0].enabled = false;
    fs.writeFileSync(process.env.ENABLED_PROJECTS_FILE, JSON.stringify(data));
  } else if (process.env.RACE_AFTER_COMMENT) {
    const data = JSON.parse(fs.readFileSync(process.env.PROJECTS_FILE, "utf8"));
    if (process.env.RACE_AFTER_COMMENT === "runtime") data.projects[0].automations = [{id:"demo:pr-reviewer",driverFile:"pr-reviewer-driver.ts",maxRuntimeSeconds:80000,shutdownGraceSeconds:300}];
    if (process.env.RACE_AFTER_COMMENT === "grace") data.projects[0].automations = [{id:"demo:pr-reviewer",driverFile:"pr-reviewer-driver.ts",maxRuntimeSeconds:86400,shutdownGraceSeconds:100}];
    if (process.env.RACE_AFTER_COMMENT === "managed label") data.projects[0].labels = {review:"custom:review"};
    if (process.env.RACE_AFTER_COMMENT === "authorized identity") data.projects[0].automationLogins = ["other-bot"];
    fs.writeFileSync(process.env.PROJECTS_FILE, JSON.stringify(data));
  }
}
else if (args[0] === "pr" && args[1] === "edit") fs.appendFileSync(process.env.ACTIONS_FILE, args.join(" ") + "\\n");
`,
  );
  fs.chmodSync(gh, 0o755);
  const result = spawnSync(
    "node",
    [
      "extensions/deadloop/automations/pr-review-repair-complete.ts",
      "--promise",
      promiseFile,
      "--attempt-record",
      attemptFile,
      "--project-id",
      "demo",
      "--result",
      resultFile,
      "--contract",
      contractFile,
      "--project-repo",
      projectRepo,
      "--github-repo",
      "owner/repo",
      "--state-dir",
      stateDir,
      "--enabled-at",
      "1",
      "--pr",
      "24",
      "--branch",
      "agent/issue-24",
      "--expected-head",
      oldHead,
      "--attempt-key",
      key,
      "--review-label",
      "agent:review",
      "--in-progress-label",
      "agent:in-progress",
      "--blocked-label",
      "agent:blocked",
      "--review-claim",
      JSON.stringify(reviewClaim),
    ],
    { cwd: process.cwd(), encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: path.join(root, "config"),
      POSTED_FILE: postedFile, ACTIONS_FILE: actionsFile, VIEWS_FILE: viewsFile, RETRACTED_FILE: retractedFile,
      AUTH_LOGIN_FILE: authLoginFile,
      ENABLED_PROJECTS_FILE: enabledProjectsFile, PROJECTS_FILE: projectsFile,
      OBSERVATION_FILE: observationFile, EXPIRE_AFTER_OBSERVATIONS: options.expireAfterObservations ? "1" : "0",
      RACE_AFTER_COMMENT: options.raceAfterComment || "",
    } },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  return {
    output,
    posted: fs.existsSync(postedFile) ? fs.readFileSync(postedFile, "utf8") : "",
    actions: fs.existsSync(actionsFile) ? fs.readFileSync(actionsFile, "utf8") : "",
    retracted: fs.existsSync(retractedFile) ? fs.readFileSync(retractedFile, "utf8") : "",
  };
}

async function runConcurrentSuccessRetries(): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-repair-concurrent-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const configDir = path.join(root, "config");
  const stateDir = path.join(configDir, "deadloop");
  const projectRepo = path.join(root, "repo");
  const commentsFile = path.join(root, "comments.json");
  const runDir = path.join(stateDir, "runs", "repair-run");
  const attemptFile = path.join(runDir, "attempt.json");
  const promiseFile = path.join(runDir, "promise.json");
  const resultFile = path.join(runDir, "finalizer-result.json");
  const contractFile = path.join(runDir, "review-contract.json");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(projectRepo);
  writeCompatibleHerdr(bin);
  spawnSync("git", ["-C", projectRepo, "init", "--quiet"]);
  spawnSync("git", ["-C", projectRepo, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", projectRepo, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(projectRepo, "README.md"), "fixture\n");
  fs.writeFileSync(path.join(projectRepo, "deadloop.json"), "{}\n");
  spawnSync("git", ["-C", projectRepo, "add", "."]);
  spawnSync("git", ["-C", projectRepo, "commit", "--quiet", "-m", "fixture"]);
  const branchName = spawnSync("git", ["-C", projectRepo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const baseBranch = `origin/${branchName}`;
  spawnSync("git", ["-C", projectRepo, "update-ref", `refs/remotes/${baseBranch}`, "HEAD"]);
  const baseRevision = spawnSync("git", ["-C", projectRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["-C", projectRepo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  fs.writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({ projects: [{
    repoPath: projectRepo, githubRepo: "owner/repo", githubRepositoryId: "R_repo", baseBranch, automationLogin: "deadloop-bot", enabledAt: 1,
    firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
    autoMergeAcknowledged: false, enabled: true,
  }] }));
  const binding = {
    repositoryId: "R_repo", repository: "owner/repo", targetNumber: 24, requestEventId: "22", role: "reviewer", revision: oldHead, owner: "host-a",
    authority: { durationSeconds: 86700 }, activeState: activeReviewState,
  };
  const reviewClaim = {
    binding, commentId: "101", authorizedLogins: ["deadloop-bot"], automationLogin: "deadloop-bot", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
    requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
  };
  const checks = [{ command: "npm test", result: "passed" }];
  const receipt = { action: "pushed", reason: "repair_pushed", originalHeadOid: oldHead, headOid: newHead, checks };
  fs.writeFileSync(promiseFile, JSON.stringify({
    schemaVersion: 1, attemptId: key, role: "review-repair",
    target: { repository: "owner/repo", kind: "pull-request", number: 24 }, inputRevision: { head: oldHead },
    status: "complete", summary: "fixed",
    result: { outcome: "repair_pushed", outputRevision: newHead, repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }] },
    evidence: { finalizer: receipt, validations: checks },
  }));
  fs.writeFileSync(resultFile, JSON.stringify(receipt));
  fs.writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify({ projects: [{
    id: "demo", repoPath: projectRepo, githubRepo: "owner/repo", baseBranch, checkCommand: "npm test",
  }] }));
  const requiredVerification = {
    repository: "owner/repo", command: "npm test",
    source: { kind: "local", location: `${path.join(stateDir, "projects.json")}#project=demo` }, baseRevision,
  };
  const attempt = {
    schemaVersion: 1, attemptId: key, launchUuid: "repair-run", project: "demo", repository: "owner/repo",
    role: "review-repair", target: { kind: "pull-request", number: 24 }, inputRevision: { head: oldHead },
    branch: "agent/issue-24", baseBranch: baseRevision, worktreePath: projectRepo, agentName: "dl-x-24-abcdef123456",
    workspaceLabel: "repair", promptFile: path.join(runDir, "prompt.md"), promiseFile, requiredVerification,
    phase: "agent_started", lastSuccessfulPhase: "agent_started", reviewClaim,
  };
  fs.writeFileSync(attemptFile, JSON.stringify(attempt));
  writeWorkerContractSnapshot(runDir, attempt);
  persistHostVerificationEvidence(workerRequiredVerificationPath(attemptFile), {
    version: 1, binding: requiredVerificationBinding(requiredVerification, newHead), outcome: "passed", exitCode: 0,
    startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1, logPath: path.join(runDir, "required-verification.log"),
  });
  fs.writeFileSync(contractFile, JSON.stringify({ attemptKey: key, expectedHead: oldHead, findingTitles: ["Unsafe fallback"] }));
  fs.writeFileSync(commentsFile, "[]");
  const claimComment = { id: 101, created_at: "2026-07-20T10:01:00Z", updated_at: "2026-07-20T10:01:00Z", user: { login: "deadloop-bot" }, body: renderReviewClaimComment(binding) };
  const gh = path.join(bin, "gh");
  fs.writeFileSync(gh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write(JSON.stringify({id:"R_repo",nameWithOwner:"owner/repo"}));
else if (args[0] === "api" && args[1] === "user") process.stdout.write("deadloop-bot\\n");
else if (args.some((arg) => arg.endsWith("/events"))) process.stdout.write(JSON.stringify([[{id:22,event:"labeled",created_at:"2026-07-20T10:00:00Z",label:{name:"agent:review"}}]]));
else if (args.some((arg) => arg.endsWith("/comments"))) process.stdout.write(${JSON.stringify(JSON.stringify([[claimComment]]))});
else if (args[0] === "api" && args.includes("--include")) process.stdout.write("date: Mon, 20 Jul 2026 10:03:00 GMT");
else if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({state:"OPEN",headRefName:"agent/issue-24",headRefOid:"${newHead}",isCrossRepository:false,labels:[{name:"agent:in-progress"}],comments:JSON.parse(fs.readFileSync(process.env.COMMENTS_FILE,"utf8"))}));
else if (args[0] === "pr" && args[1] === "comment") {
  const comments = JSON.parse(fs.readFileSync(process.env.COMMENTS_FILE,"utf8"));
  comments.push({body:args[args.indexOf("--body")+1],author:{login:"deadloop-bot"}});
  fs.writeFileSync(process.env.COMMENTS_FILE, JSON.stringify(comments));
}
`);
  fs.chmodSync(gh, 0o755);
  const args = [
    "extensions/deadloop/automations/pr-review-repair-complete.ts",
    "--promise", promiseFile, "--attempt-record", attemptFile, "--project-id", "demo",
    "--result", resultFile, "--contract", contractFile, "--project-repo", projectRepo, "--github-repo", "owner/repo", "--state-dir", stateDir,
    "--enabled-at", "1", "--pr", "24", "--branch", "agent/issue-24", "--expected-head", oldHead,
    "--attempt-key", key, "--review-label", "agent:review",
    "--in-progress-label", "agent:in-progress", "--blocked-label", "agent:blocked",
    "--review-claim", JSON.stringify(reviewClaim),
  ];
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: configDir, COMMENTS_FILE: commentsFile };
  await Promise.all([0, 1].map(() => new Promise<void>((resolve, reject) => {
    const child = spawn("node", args, { cwd: process.cwd(), env, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(`completion exited ${status}`)));
  })));
  return JSON.parse(fs.readFileSync(commentsFile, "utf8")).length;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("review repair deterministic completion", () => {
  it.each([
    ["runtime", { currentProject: { automations: [{ id: "demo:pr-reviewer", driverFile: "pr-reviewer-driver.ts", maxRuntimeSeconds: 80000, shutdownGraceSeconds: 300 }] } }],
    ["grace", { currentProject: { automations: [{ id: "demo:pr-reviewer", driverFile: "pr-reviewer-driver.ts", maxRuntimeSeconds: 86400, shutdownGraceSeconds: 100 }] } }],
    ["labels", { currentProject: { labels: { review: "custom:review" } } }],
    ["identities", { currentProject: { automationLogins: ["other-bot"] } }],
    ["authenticated login", { authenticatedLogin: "other-bot" }],
    ["enablement", { enabled: false }],
  ])("performs no repair completion comment or label mutation after current %s changes", (_name, change) => {
    const result = runCompletion({
      promise: { status: "complete", summary: "fixed", reason: "repair_pushed", repairs: [{ title: "Unsafe fallback", summary: "fixed" }], checks: [{ command: "npm test", result: "passed" }] },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks: [{ command: "npm test", result: "passed" }] },
      ...change,
    });
    expect({ posted: result.posted, actions: result.actions }).toEqual({ posted: "", actions: "" });
  });
  it.each(["runtime", "grace", "managed label", "authorized identity", "authenticated login", "enablement"] as const)(
    "suppresses the repair-completion label mutation when %s races after the success comment",
    (raceAfterComment) => {
      const checks = [{ command: "npm test", result: "passed" }];
      const result = runCompletion({
        promise: { status: "complete", reason: "repair_pushed", summary: "fixed", repairs: [{ title: "Unsafe fallback", summary: "fixed" }], checks },
        receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
        raceAfterComment,
      });
      expect(result.actions).toBe("");
    },
  );

  it("posts no repair success when the claim expires while completion observations are being collected", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: { status: "complete", reason: "repair_pushed", summary: "fixed", repairs: [{ title: "Unsafe fallback", summary: "fixed" }], checks },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      expireAfterObservations: true,
    });

    expect(result.posted).toBe("");
  });

  it("visibly blocks repair completion when only REST Date is unavailable", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: { status: "complete", reason: "repair_pushed", summary: "fixed", repairs: [{ title: "Unsafe fallback", summary: "fixed", paths: ["src/review.ts"] }], checks },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      dateUnavailable: true,
    });

    expect(result.posted).toContain("GitHub server-time evidence");
  });

  it("adds only blocked at the repair-completion Date-failure seam", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: { status: "complete", reason: "repair_pushed", summary: "fixed", repairs: [{ title: "Unsafe fallback", summary: "fixed", paths: ["src/review.ts"] }], checks },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      dateUnavailable: true,
    });

    expect(result.actions.trim().split(/\s+/).slice(-2)).toEqual(["--add-label", "agent:blocked"]);
  });

  it("performs no repair-completion mutation for an edited claim with missing REST Date", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: { status: "complete", reason: "repair_pushed", summary: "fixed", repairs: [{ title: "Unsafe fallback", summary: "fixed", paths: ["src/review.ts"] }], checks },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      dateUnavailable: true,
      editedClaim: true,
    });

    expect({ posted: result.posted, actions: result.actions }).toEqual({ posted: "", actions: "" });
  });

  it("fails before repair completion effects when the active review claim is omitted", () => {
    expect(() => completion({})).toThrow("active review claim is required");
  });

  it.each(["--attempt-record", "--project-id", "--review-claim"])("requires mutation authority argument %s", (missingFlag) => {
    const { parseArgs } = require("../extensions/deadloop/automations/pr-review-repair-complete.ts");
    const values = {
      promise: "/state/runs/one/promise.json", attemptRecord: "/state/runs/one/attempt.json", projectId: "demo",
      result: "/state/runs/one/finalizer-result.json", contract: "/state/runs/one/review-contract.json",
      projectRepo: "/repo", githubRepo: "owner/repo", stateDir: "/state", enabledAt: "1", pr: "24",
      branch: "agent/issue-24", expectedHead: oldHead, attemptKey: key, reviewLabel: "review",
      inProgressLabel: "in-progress", blockedLabel: "blocked", reviewClaim: "{}",
    };
    const args = Object.entries(values).flatMap(([name, value]) => {
      const flag = `--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
      return flag === missingFlag ? [] : [flag, value];
    });
    expect(() => parseArgs(args)).toThrow();
  });

  it("posts success after the promise, finalizer receipt, and live head agree", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
    });

    expect(result.posted).toContain(`New commit: \`${newHead}\``);
  });

  it("rejects repair success when the authenticated verification record is missing", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: { status: "complete", reason: "repair_pushed", summary: "fixed", repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }], checks },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      verificationRecord: "missing",
    });

    expect(result.posted).toBe("");
  });

  it("rejects repair success when only legacy verification evidence exists", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: { status: "complete", reason: "repair_pushed", summary: "fixed", repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }], checks },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      verificationRecord: "legacy",
    });

    expect(result.posted).toBe("");
  });

  it("releases the active review claim after recording successful repair", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
    });

    expect(result.actions).toContain("--remove-label agent:in-progress --add-label agent:review");
  });

  it("turns a malformed finalizer receipt into recovery instead of an exception", () => {
    const result = runCompletion({
      promise: { status: "blocked", reason: "check_failed", summary: "checks stopped" },
      receipt: "{",
      liveHead: oldHead,
    });

    expect(result.output.driverAction).toBe("repair_human_blocked");
  });

  it("requeues the review request when bounded repair requires human recovery", () => {
    const result = runCompletion({
      promise: { status: "blocked", reason: "check_failed", summary: "checks stopped" },
      receipt: "{",
      liveHead: oldHead,
    });

    expect(result.actions).toContain("--remove-label agent:in-progress --add-label agent:review --add-label agent:blocked");
  });

  it("does not post repair success for stale_head", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
      receipt: { action: "stale_head", originalHeadOid: oldHead },
    });

    expect(result.posted).toBe("");
  });

  it("leaves a changed head untouched when stale_head has no finalizer receipt", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
    });

    expect(result.output.driverAction).toBe("repair_target_changed");
  });

  it("leaves an invalid stale receipt on a changed head untouched", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
      receipt: { action: "stale_head", originalHeadOid: "c".repeat(40) },
    });

    expect(result.output.driverAction).toBe("repair_target_changed");
  });

  it("requires recovery when stale_head is reported but the live head did not change", () => {
    const result = runCompletion({
      promise: { status: "complete", reason: "stale_head", summary: "head changed" },
      receipt: { action: "stale_head", originalHeadOid: oldHead },
      liveHead: oldHead,
    });

    expect(result.output.driverAction).toBe("repair_human_blocked");
  });

  it("requires recovery when a pushed receipt and live head are unchanged", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: oldHead, checks },
      liveHead: oldHead,
    });

    expect(result.output.driverAction).toBe("repair_human_blocked");
  });

  it("does not post success when the PR head changes during authorization", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete", reason: "repair_pushed", summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }], checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      headAfterAuthorization: "c".repeat(40),
    });

    expect({ action: result.output.driverAction, posted: result.posted }).toEqual({ action: "repair_target_changed", posted: "" });
  });

  it("retracts the success comment when the head changes during posting", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete", reason: "repair_pushed", summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }], checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      headAfterPosting: "c".repeat(40),
    });

    expect({
      action: result.output.driverAction,
      retracted: result.retracted.includes("DELETE") && result.retracted.includes("issues/comments/9901"),
      labelMutations: result.actions,
    }).toEqual({ action: "repair_target_changed", retracted: true, labelMutations: "" });
  });

  it("does not duplicate an existing repair result comment", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      comments: [{ body: `<!-- deadloop:review-repair-result key=${key} head=${newHead} -->`, author: { login: "deadloop-bot" } }],
    });

    expect(result.output.driverAction).toBe("repair_result_duplicate");
  });

  it("releases the active review claim when reconciling a duplicate result", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete",
        reason: "repair_pushed",
        summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }],
        checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      comments: [{ body: `<!-- deadloop:review-repair-result key=${key} head=${newHead} -->`, author: { login: "deadloop-bot" } }],
    });

    expect(result.actions).toContain("--remove-label agent:in-progress --add-label agent:review");
  });

  it("serializes concurrent completion retries to one success comment", async () => {
    expect(await runConcurrentSuccessRetries()).toBe(1);
  });

  it("does not trust a copied result marker from another commenter", () => {
    const checks = [{ command: "npm test", result: "passed" }];
    const result = runCompletion({
      promise: {
        status: "complete", reason: "repair_pushed", summary: "fixed",
        repairs: [{ title: "Unsafe fallback", summary: "Removed fallback", paths: ["src/review.ts"] }], checks,
      },
      receipt: { action: "pushed", originalHeadOid: oldHead, headOid: newHead, checks },
      comments: [{ body: `<!-- deadloop:review-repair-result key=${key} head=${newHead} -->`, author: { login: "attacker" } }],
    });

    expect(result.output.driverAction).toBe("repair_result_posted");
  });

  it("leaves a closed PR untouched", () => {
    const result = runCompletion({
      promise: { status: "blocked", reason: "check_failed", summary: "failed" },
      receipt: { action: "blocked", reason: "finalizer_error", originalHeadOid: oldHead },
      liveHead: oldHead,
      state: "CLOSED",
    });

    expect({ action: result.output.driverAction, posted: result.posted }).toEqual({ action: "repair_target_changed", posted: "" });
  });

  it("leaves a superseded repair head untouched", () => {
    const result = runCompletion({
      promise: { status: "blocked", reason: "check_failed", summary: "failed" },
      receipt: { action: "blocked", reason: "finalizer_error", originalHeadOid: oldHead },
      liveHead: "c".repeat(40),
    });

    expect({ action: result.output.driverAction, posted: result.posted }).toEqual({ action: "repair_target_changed", posted: "" });
  });
});
