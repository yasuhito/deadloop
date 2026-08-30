// Shared review-repair launch mechanics. The PR driver is the only caller that
// launches a repair worker (ADR 0032); these helpers keep that launch identical
// to the contract the finalizer and completion handler still bind to.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../../src/agent-scratch-area.cjs");
const { launchAgentFlow, prepareAgentLaunchFlow } = require("../../../src/agent-launch-flow.cts");
const { createCommandRunner, createHerdrRunnerFromCommandRunner, shellQuote } = require("../../../src/automation-driver-kit.cts");

import type { JsonObject } from "../../../src/automation-driver-kit-types";
import type { RunnerAdapter } from "../../../src/runner";

type RepairLaunchEnv = {
  projectId: string;
  repoPath: string;
  githubRepo: string;
  baseBranch: string;
  remote: string;
  checkCommand: string;
  workerAgent: string;
  workerModel: string;
  requiredVerification?: unknown;
  enabledAt: number;
  automationDir: string;
  stateDir: string;
  worktreeRoot: string;
  inProgressLabel: string;
  blockedLabel: string;
};

type RepairWorktreeInspection =
  | { kind: "absent" }
  | { kind: "ambiguous" }
  | { kind: "present"; head: string; clean: boolean };

function branchWorktrees(repoPath: string, branch: string, runText: (args: string[]) => string): string[] {
  const output = runText(["git", "-C", repoPath, "worktree", "list", "--porcelain", "-z"]);
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

function inspectRepairWorktree(repoPath: string, branch: string, runText: (args: string[]) => string): RepairWorktreeInspection {
  const worktrees = branchWorktrees(repoPath, branch, runText);
  if (worktrees.length === 0) return { kind: "absent" };
  if (worktrees.length !== 1) return { kind: "ambiguous" };
  const worktreePath = worktrees[0];
  const head = runText(["git", "-C", worktreePath, "rev-parse", "HEAD"]).trim().toLowerCase();
  const clean = !hasUncommittedWork(runText(["git", "-C", worktreePath, ...UNCOMMITTED_WORK_STATUS_ARGS]));
  return { kind: "present", head, clean };
}

function repairWorkerPrompt(
  prNumber: string,
  branch: string,
  expectedHead: string,
  findings: JsonObject[],
  attemptKey: string,
  promiseFile: string,
  worktreePath: string,
  env: RepairLaunchEnv,
): string {
  // The launch helpers live beside every other automation script, so an omitted
  // automationDir is always this package's automations directory.
  const automationDir = env.automationDir || __dirname;
  const finalizer = [
    "node",
    shellQuote(path.join(automationDir, "pr-review-repair-finalize.cts")),
    "--repo",
    shellQuote(worktreePath),
    "--project-id",
    shellQuote(env.projectId),
    "--attempt-record",
    shellQuote(path.join(path.dirname(promiseFile), "attempt.json")),
    "--project-repo",
    shellQuote(env.repoPath),
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
    shellQuote(automationDir),
    "--state-dir",
    shellQuote(env.stateDir),
    "--enabled-at",
    String(env.enabledAt),
    "--check-command",
    shellQuote(env.checkCommand),
    "--result-file",
    shellQuote(path.join(path.dirname(promiseFile), "finalizer-result.json")),
    "--in-progress-label",
    shellQuote(env.inProgressLabel),
    "--blocked-label",
    shellQuote(env.blockedLabel),
  ].join(" ");
  return `Repair only the actionable review findings below on existing PR #${prNumber}.

Exact target:
- GitHub repo: ${env.githubRepo}
- Existing PR branch (the only branch you may push): ${branch}
- Expected PR head: ${expectedHead}
- Worktree: ${worktreePath}

Required findings contract:
\`\`\`json
${JSON.stringify(findings, null, 2)}
\`\`\`

Safety contract:
- Change only what is needed to resolve every listed finding. Do not add features, reinterpret the issue, or widen scope.
- Run focused tests while editing, then commit the repair normally. Never amend, rebase, reset published history, or force-push.
- Do not run git push directly. After committing, run exactly this finalizer; it runs configured checks, immediately re-checks the PR head, and performs the only permitted push to the exact branch, leased to that exact head:
  ${finalizer}
- Never edit labels or PR metadata, create a PR, merge, close an issue, delete a branch, or invoke another agent.
- If the finalizer returns stale_head, stop without pushing or changing GitHub state.

Promise report:
- Always write one V1 JSON object to ${promiseFile}. Its immutable identity is ${JSON.stringify({ schemaVersion: 1, attemptId: attemptKey, role: "review-repair", target: { repository: env.githubRepo, kind: "pull-request", number: Number(prNumber) }, inputRevision: { head: expectedHead } })}. Every report must also include the summary field beside the identity: "summary":"<three sentences>"; a report without it is invalid.
- After action=pushed, read the finalizer result file beside the promise and write "summary":"<three sentences>" plus status="complete", result={outcome:"repair_pushed",outputRevision:"<finalizer headOid>",repairs:[{title:"exact finding title",summary:"specific change",paths:["changed/repo/path"]}]}, and evidence={finalizer:<entire receipt>,validations:<receipt checks>}. Include exactly one repair entry for every finding and only files actually changed for that finding.
- After action=stale_head, read the finalizer result file and write "summary":"<three sentences>" plus status="complete", result={outcome:"stale_head",outputRevision:"<finalizer currentRemoteHeadOid>"}, and evidence={finalizer:<entire receipt>}. The outputRevision is required and must be the current remote head recorded by the finalizer.
- On technical, validation, invariant, or push failure, write "summary":"<three sentences>" plus status="blocked", result={reason:"add_request|free_storage|fix_environment|fix_verification_policy",explanation:"what failed",recovery:"safe next step"}, and evidence={}.
- This attempt key is ${attemptKey}; do not place it or any local path in public text.
- Do not claim success unless the finalizer returned pushed or stale_head.`;
}

function repairWorkspaceLabel(prNumber: string, key: string, env: RepairLaunchEnv): string {
  return `${env.projectId}-pr-${prNumber}-review-repair-${key}`;
}

function repairLaunchInput(
  prNumber: string,
  branch: string,
  expectedHead: string,
  findings: JsonObject[],
  key: string,
  env: RepairLaunchEnv,
  uuid: string,
) {
  return {
    worktree: { mode: "open" as const, branch, baseBranch: env.baseBranch, remote: env.remote },
    repoPath: env.repoPath,
    automationDir: env.automationDir || __dirname,
    stateDir: env.stateDir,
    workspaceLabel: repairWorkspaceLabel(prNumber, key, env),
    agent: env.workerAgent,
    model: env.workerModel,
    level: "medium",
    uuid,
    attemptId: key,
    promptFilePrefix: "review-repair-prompt",
    project: env.projectId,
    repository: env.githubRepo,
    role: "review-repair" as const,
    target: { kind: "pull-request" as const, number: Number(prNumber) },
    inputRevision: { head: expectedHead },
    requiredVerification: env.requiredVerification,
    requestEventId: undefined as string | undefined,
    intendedWorktreePath: path.join(env.worktreeRoot, branch.replace(/\//g, "-")),
    renderPrompt: ({ promiseFile, worktreePath }: { promiseFile: string; worktreePath: string }) =>
      repairWorkerPrompt(prNumber, branch, expectedHead, findings, key, promiseFile, worktreePath, env),
  };
}

function writeRepairContract(runDir: string, expectedHead: string, findings: JsonObject[], key: string): void {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(runDir, "review-contract.json"),
    `${JSON.stringify({ attemptKey: key, expectedHead, findingTitles: findings.map((finding) => String(finding.title)) })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

type RepairLaunchOperations = {
  mkdirSync: (dir: string, options: { recursive: true; mode?: number }) => void;
  runner?: RunnerAdapter;
  runText: (args: string[]) => string;
  writeFileSync: (file: string, text: string, encoding: "utf8") => void;
};

function launchRepair(
  prNumber: string,
  branch: string,
  expectedHead: string,
  findings: JsonObject[],
  key: string,
  env: RepairLaunchEnv & { requestEventId?: string },
  beforeAgentStart?: () => void,
  uuid: string = randomUUID(),
  prepareOnly = false,
  operations?: RepairLaunchOperations,
): JsonObject {
  const commandRunner = createCommandRunner();
  const selectedOperations = operations || {
    mkdirSync: fs.mkdirSync,
    runner: createHerdrRunnerFromCommandRunner(commandRunner),
    runText: commandRunner.runText,
    writeFileSync: fs.writeFileSync,
  };
  selectedOperations.runText(["git", "check-ref-format", "--branch", branch]);
  const runDir = path.join(env.stateDir, "runs", uuid);
  writeRepairContract(runDir, expectedHead, findings, key);
  const input = repairLaunchInput(prNumber, branch, expectedHead, findings, key, env, uuid);
  input.requestEventId = env.requestEventId || undefined;
  const repairName = input.workspaceLabel;
  const promiseFile = path.join(runDir, "promise.json");
  try {
    const ops = { ...selectedOperations, beforeAgentStart };
    const prepared = prepareAgentLaunchFlow(input, ops);
    if (prepareOnly) return { repairName: prepared.agentName, promiseFile: prepared.promiseFile };
    const launch = launchAgentFlow(input, ops);
    return { ...launch, repairName: launch.agentName };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      launch: { repairName, promiseFile },
    });
  }
}

module.exports = {
  inspectRepairWorktree,
  launchRepair,
  repairLaunchInput,
  repairWorkerPrompt,
  repairWorkspaceLabel,
  writeRepairContract,
};
