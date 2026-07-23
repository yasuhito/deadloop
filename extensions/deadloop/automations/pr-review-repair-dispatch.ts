#!/usr/bin/env node
// Turn a completed reviewer promise into an approved handoff, bounded retry,
// human block, or one dedicated repair launch for the exact PR head/result.

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { validatePromise } = require("./extract-worker-promise.ts");
const {
  decideTechnicalReviewFailure,
  renderRepairMarker,
  renderTechnicalFailureMarker,
  selectRepairAttempt,
} = require("./pr-review-repair-state.ts");
const { launchAgentFlow } = require("../../../src/agent-launch-flow.ts");
const { renderRepairMonitorPrompt } = require("../../../src/monitor-prompts.ts");
const {
  createCommandRunner,
  createHerdrRunnerFromCommandRunner,
  driverResult,
  shellQuote,
} = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit";

const commandRunner = createCommandRunner();
const github = createGithubOperations(commandRunner);

function envConfig() {
  const automationDir = __dirname;
  return {
    projectId: process.env.DEADLOOP_PROJECT_ID || "project",
    repoPath: process.env.DEADLOOP_REPO_PATH || ".",
    githubRepo: process.env.DEADLOOP_GITHUB_REPO || "",
    stateDir:
      process.env.DEADLOOP_STATE_DIR ||
      path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "deadloop"),
    checkCommand: process.env.DEADLOOP_CHECK_COMMAND || "git diff --check",
    workerAgent: process.env.DEADLOOP_WORKER_AGENT || "pi",
    workerModel: process.env.DEADLOOP_WORKER_MODEL || "",
    remote: process.env.DEADLOOP_REVIEW_REPAIR_REMOTE || "origin",
    reviewLabel: process.env.DEADLOOP_REVIEW_LABEL || "agent:review",
    reviewingLabel: process.env.DEADLOOP_REVIEWING_LABEL || "agent:reviewing",
    blockedLabel: process.env.DEADLOOP_BLOCKED_LABEL || "agent:blocked",
    automationDir,
  };
}

function parseArgs(argv: string[]): JsonObject {
  const values: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const name of ["promise", "pr", "expectedHead", "branch"]) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

function readLivePr(repo: string, prNumber: string): JsonObject {
  return commandRunner.runJson([
    "gh",
    "pr",
    "view",
    prNumber,
    "-R",
    repo,
    "--json",
    "number,state,headRefName,headRefOid,isCrossRepository,labels,comments",
  ]);
}

type RepairWorktreeInspection =
  | { kind: "absent" }
  | { kind: "ambiguous" }
  | { kind: "present"; head: string; clean: boolean };

function branchWorktrees(repoPath: string, branch: string): string[] {
  const output = commandRunner.runText(["git", "-C", repoPath, "worktree", "list", "--porcelain", "-z"]);
  const expectedBranch = `refs/heads/${branch}`;
  const matches: string[] = [];
  for (const block of output.split("\0\0")) {
    const fields = block.split("\0");
    const worktreeField = fields.find((field) => field.startsWith("worktree "));
    const branchField = fields.find((field) => field.startsWith("branch "));
    if (worktreeField && branchField?.slice("branch ".length) === expectedBranch) {
      matches.push(worktreeField.slice("worktree ".length));
    }
  }
  return matches;
}

function inspectRepairWorktree(repoPath: string, branch: string): RepairWorktreeInspection {
  const worktrees = branchWorktrees(repoPath, branch);
  if (worktrees.length === 0) return { kind: "absent" };
  if (worktrees.length !== 1) return { kind: "ambiguous" };
  const worktreePath = worktrees[0];
  const head = commandRunner.runText(["git", "-C", worktreePath, "rev-parse", "HEAD"]).trim().toLowerCase();
  const clean =
    commandRunner.runText(["git", "-C", worktreePath, "status", "--porcelain", "--untracked-files=all"]).trim() === "";
  return { kind: "present", head, clean };
}

function recoveryComment(prNumber: string, env: ReturnType<typeof envConfig>, reason: string, summary: string): string {
  return `## What happened
- Automatic review repair for PR #${prNumber} requires human intervention: ${reason}.
- ${summary || "The bounded automatic path could not safely continue."}

## Recovery steps
1. Inspect the current head, review findings, checks, and deadloop attempt markers.
   \`\`\`bash
gh pr view ${prNumber} -R ${shellQuote(env.githubRepo)} --comments --json number,state,headRefName,headRefOid,labels,statusCheckRollup
   \`\`\`
2. Correct the branch or resolve the required decision without rewriting history.
3. Push a new commit, then remove ${env.blockedLabel}; the changed head can start a new review cycle.`;
}

function applyHumanBlock(prNumber: string, env: ReturnType<typeof envConfig>, reason: string, summary: string): string {
  const comment = recoveryComment(prNumber, env, reason, summary);
  github.commentPr(env.githubRepo, prNumber, comment);
  github.movePrLabels(env.githubRepo, prNumber, { remove: env.reviewingLabel, add: env.blockedLabel });
  return comment;
}

function repairWorkerPrompt(
  prNumber: string,
  branch: string,
  expectedHead: string,
  findings: JsonObject[],
  promiseFile: string,
  worktreePath: string,
  env: ReturnType<typeof envConfig>,
): string {
  const finalizer = [
    "node",
    shellQuote(path.join(env.automationDir, "pr-review-repair-finalize.ts")),
    "--repo",
    shellQuote(worktreePath),
    "--github-repo",
    shellQuote(env.githubRepo),
    "--pr",
    prNumber,
    "--branch",
    shellQuote(branch),
    "--expected-head",
    shellQuote(expectedHead),
    "--remote",
    shellQuote(env.remote),
    "--automation-dir",
    shellQuote(env.automationDir),
    "--state-dir",
    shellQuote(env.stateDir),
    "--check-command",
    shellQuote(env.checkCommand),
  ].join(" ");
  return `Repair only the actionable review findings below on existing PR #${prNumber}.

Exact target:
- GitHub repo: ${env.githubRepo}
- Existing PR branch (the only branch you may push): ${branch}
- Expected PR head: ${expectedHead}
- Worktree: ${worktreePath}

Bounded findings contract:
\`\`\`json
${JSON.stringify(findings, null, 2)}
\`\`\`

Safety contract:
- First require a clean worktree and HEAD exactly equal to ${expectedHead}.
- Change only what is needed to resolve every listed finding. Do not add features, reinterpret the issue, or widen scope.
- Run focused tests while editing, then commit the repair normally. Never amend, rebase, reset published history, or force-push.
- Do not run git push directly. After committing, run exactly this finalizer; it runs configured checks, immediately re-checks the PR head, and performs the only permitted non-force push to the exact branch:
  ${finalizer}
- Never edit labels or PR metadata, create a PR, merge, close an issue, delete a branch, or invoke another agent.
- If the finalizer returns stale_head, stop without pushing or changing GitHub state.

Promise report:
- Always write JSON to ${promiseFile} before stopping; status remains complete|blocked.
- After action=pushed, write {"status":"complete","reason":"repair_pushed","summary":"findings fixed, checks passed, repair commit pushed"}.
- After action=stale_head, write {"status":"complete","reason":"stale_head","summary":"PR head changed; stopped without push or labels"}.
- On technical, validation, invariant, or push failure, write {"status":"blocked","reason":"specific failure","summary":"what failed and why a human is now required"}.
- Do not claim success unless the finalizer returned pushed or stale_head.`;
}

function launchRepair(
  prNumber: string,
  branch: string,
  expectedHead: string,
  findings: JsonObject[],
  key: string,
  env: ReturnType<typeof envConfig>,
): JsonObject {
  commandRunner.runText(["git", "check-ref-format", "--branch", branch]);
  const uuid = randomUUID();
  const repairName = `${env.projectId}-pr-${prNumber}-review-repair-${key}`;
  const launch = launchAgentFlow(
    {
      worktree: { mode: "open", branch },
      repoPath: env.repoPath,
      automationDir: env.automationDir,
      stateDir: env.stateDir,
      name: repairName,
      agent: env.workerAgent,
      model: env.workerModel,
      level: "medium",
      uuid,
      promptFilePrefix: "review-repair-prompt",
      renderPrompt: ({ promiseFile, worktreePath }: { promiseFile: string; worktreePath: string }) =>
        repairWorkerPrompt(prNumber, branch, expectedHead, findings, promiseFile, worktreePath, env),
    },
    {
      mkdirSync: fs.mkdirSync,
      runner: createHerdrRunnerFromCommandRunner(commandRunner),
      runText: commandRunner.runText,
      writeFileSync: fs.writeFileSync,
    },
  );
  return { repairName, ...launch };
}

function dispatch(args: JsonObject): DriverResult {
  const env = envConfig();
  if (!env.githubRepo) return driverResult("error", "DEADLOOP_GITHUB_REPO is required", { driverAction: "configuration_error" });
  const validation = validatePromise(String(args.promise));
  if (validation.status === "none" || validation.status === "invalid") {
    return driverResult("error", `reviewer promise is ${validation.status}`, { driverAction: "invalid_promise", validation });
  }
  const promise = validation.promise as JsonObject;
  const prNumber = String(args.pr);
  const expectedHead = String(args.expectedHead).toLowerCase();
  const branch = String(args.branch);
  const pr = readLivePr(env.githubRepo, prNumber);

  if (String(pr.state || "").toUpperCase() !== "OPEN" || Boolean(pr.isCrossRepository) || String(pr.headRefName || "") !== branch) {
    const comment = applyHumanBlock(prNumber, env, "the selected PR is no longer a safe same-repository branch target", promise.summary);
    return driverResult("done", `PR #${prNumber} requires human intervention`, { driverAction: "review_human_blocked", comment });
  }
  if (validation.status === "blocked") {
    if (String(pr.headRefOid || "").toLowerCase() !== expectedHead) {
      return driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, {
        driverAction: "review_stale_head",
      });
    }
    const technicalDecision = decideTechnicalReviewFailure(pr.comments || [], expectedHead);
    if (technicalDecision.action === "retry") {
      github.commentPr(
        env.githubRepo,
        prNumber,
        `Reviewer technical failure will be retried once for this head: ${promise.reason || "unknown failure"}.\n\n${renderTechnicalFailureMarker(expectedHead)}`,
      );
      return driverResult("done", `PR #${prNumber} reviewer technical failure retained review labels for one retry`, {
        driverAction: "review_technical_retry",
      });
    }
    const comment = applyHumanBlock(prNumber, env, "the reviewer failed technically twice on the same PR head", promise.summary);
    return driverResult("done", `PR #${prNumber} exhausted its technical review retry`, {
      driverAction: "review_technical_retry_exhausted",
      comment,
    });
  }

  const outcome = promise.outcome || "approved";
  if (outcome === "approved") {
    return String(pr.headRefOid || "").toLowerCase() === expectedHead
      ? driverResult("done", `PR #${prNumber} review completed without actionable findings`, { driverAction: "review_approved" })
      : driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, {
          driverAction: "review_stale_head",
        });
  }
  if (outcome === "human_required") {
    if (String(pr.headRefOid || "").toLowerCase() !== expectedHead) {
      return driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, {
        driverAction: "review_stale_head",
      });
    }
    const comment = applyHumanBlock(prNumber, env, promise.reason || "the reviewer requested a human decision", promise.summary);
    return driverResult("done", `PR #${prNumber} review requires a human`, { driverAction: "review_human_blocked", comment });
  }

  const findings = promise.findings as JsonObject[];
  const worktree = inspectRepairWorktree(env.repoPath, branch);
  const refreshedPr = readLivePr(env.githubRepo, prNumber);
  if (
    String(refreshedPr.state || "").toUpperCase() !== "OPEN" ||
    Boolean(refreshedPr.isCrossRepository) ||
    String(refreshedPr.headRefName || "") !== branch
  ) {
    const comment = applyHumanBlock(
      prNumber,
      env,
      "the selected PR stopped being a safe same-repository branch target before repair dispatch",
      promise.summary,
    );
    return driverResult("done", `PR #${prNumber} requires human intervention`, {
      driverAction: "review_human_blocked",
      comment,
    });
  }
  if (worktree.kind === "ambiguous") {
    const comment = applyHumanBlock(
      prNumber,
      env,
      "more than one worktree claims the repair branch",
      "Worktree ownership must be made unambiguous before another repair starts.",
    );
    return driverResult("done", `PR #${prNumber} repair worktree ownership is ambiguous; marked blocked`, {
      driverAction: "review_repair_ambiguous_worktree",
      comment,
    });
  }
  if (worktree.kind === "present" && !worktree.clean) {
    const comment = applyHumanBlock(
      prNumber,
      env,
      "the existing repair worktree is dirty",
      "The existing repair worktree must be inspected before another repair starts.",
    );
    return driverResult("done", `PR #${prNumber} repair worktree is dirty; marked blocked`, {
      driverAction: "review_repair_dirty_worktree",
      comment,
    });
  }

  const refreshedHead = String(refreshedPr.headRefOid || "").toLowerCase();
  if (refreshedHead !== expectedHead) {
    if (worktree.kind === "present" && worktree.head === refreshedHead) {
      return driverResult("done", `PR #${prNumber} head changed before repair dispatch; left labels untouched for re-evaluation`, {
        driverAction: "review_stale_head",
      });
    }
    const comment = applyHumanBlock(
      prNumber,
      env,
      "the refreshed PR head does not have one matching clean repair worktree",
      "The PR branch and worktree ownership must be reconciled before another repair starts.",
    );
    return driverResult("done", `PR #${prNumber} refreshed head lacks a matching repair worktree; marked blocked`, {
      driverAction: "review_repair_worktree_mismatch",
      comment,
    });
  }
  if (worktree.kind === "present" && worktree.head !== expectedHead) {
    const comment = applyHumanBlock(
      prNumber,
      env,
      "the clean repair worktree and current PR head do not match",
      "The existing worktree must be reconciled without rewriting history before another repair starts.",
    );
    return driverResult("done", `PR #${prNumber} repair worktree does not match its current head; marked blocked`, {
      driverAction: "review_repair_worktree_mismatch",
      comment,
    });
  }

  const selection = selectRepairAttempt(refreshedPr.comments || [], expectedHead, findings);
  if (selection.action !== "launch_repair") {
    const comment = applyHumanBlock(prNumber, env, "the same review findings remained after their bounded repair attempt", promise.summary);
    return driverResult("done", `PR #${prNumber} repeated the same findings; marked blocked`, {
      driverAction: "review_repair_repeated",
      selection,
      comment,
    });
  }

  const marker = renderRepairMarker(expectedHead, selection.reviewFingerprint);
  github.commentPr(env.githubRepo, prNumber, `Starting one bounded repair for this exact PR head and review result.\n\n${marker}`);
  github.movePrLabels(env.githubRepo, prNumber, { add: [env.reviewLabel, env.reviewingLabel] });
  try {
    const launch = launchRepair(prNumber, branch, expectedHead, findings, selection.key, env);
    return driverResult("needs_llm", `Launched review-repair worker for PR #${prNumber}`, {
      driverAction: "review_repair_monitor_request",
      selection,
      labelsPreserved: [env.reviewLabel, env.reviewingLabel],
      launch,
      prompt: renderRepairMonitorPrompt({
        prNumber: Number(prNumber),
        expectedHeadOid: expectedHead,
        branch,
        automationDir: env.automationDir,
        promiseFile: launch.promiseFile,
        actorName: "review-repair worker",
        reviewLabel: env.reviewLabel,
        reviewingLabel: env.reviewingLabel,
        blockedLabel: env.blockedLabel,
      }),
    });
  } catch (error) {
    const comment = applyHumanBlock(
      prNumber,
      env,
      `the bounded repair launch failed after its attempt marker was recorded: ${error instanceof Error ? error.message : String(error)}`,
      promise.summary,
    );
    return driverResult("done", `PR #${prNumber} repair launch failed; marked blocked`, {
      driverAction: "review_repair_launch_failed",
      comment,
    });
  }
}

function main(): void {
  try {
    process.stdout.write(`${JSON.stringify(dispatch(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`,
    );
  }
}

if (require.main === module) main();

module.exports = { dispatch, parseArgs, repairWorkerPrompt };
