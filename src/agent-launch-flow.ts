const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const {
  attemptRecordPath,
  createPreparedAttempt,
  readAttemptRecord,
  transitionPersistedAttempt,
  writeAttemptRecordAtomically,
} = require("./attempt-lifecycle-runtime.cjs");
const { deriveHerdrAgentName } = require("./herdr-agent-name.cjs");
const { createHerdrRunner } = require("./herdr-runner.ts");
const { writeWorkerContractSnapshot } = require("./worker-required-verification-runtime.cjs");

import type { AttemptRecord, AttemptRole, AttemptTarget, InputRevision, PreparedAttemptInput } from "./attempt-lifecycle";
import type { RequiredVerificationContract } from "./required-verification";
import type { RunnerAdapter } from "./runner";

type WorktreeRequest =
  | { mode: "create"; branch: string; baseBranch: string }
  | { mode: "open"; branch: string; baseBranch?: string };

type AgentLaunchFlowInput = {
  worktree: WorktreeRequest;
  repoPath: string;
  automationDir: string;
  stateDir: string;
  workspaceLabel: string;
  agent: string;
  model: string;
  level: string;
  uuid: string;
  attemptId?: string;
  promptFilePrefix: string;
  project: string;
  repository: string;
  role: AttemptRole;
  target: AttemptTarget;
  inputRevision: InputRevision;
  intendedWorktreePath: string;
  resolveWorktreeHead?: boolean;
  autoMergePolicy?: boolean;
  reviewHistoryRequired?: boolean;
  requiredVerification?: RequiredVerificationContract;
  reviewClaim?: Record<string, unknown>;
  renderPrompt: (input: { promiseFile: string; worktreePath: string; worktreeHead?: string }) => string;
};

type AgentLaunchFlowOps = {
  mkdirSync: (dir: string, options: { recursive: true; mode?: number }) => void;
  runner?: RunnerAdapter;
  runText: (args: string[]) => string;
  writeFileSync: (file: string, text: string, encoding: "utf8") => void;
  beforeAgentStart?: () => void;
};

type PreparedLaunch = {
  runDir: string;
  promptFile: string;
  promiseFile: string;
  agentName: string;
};

type AgentLaunchFlowResult = {
  workspaceId: string;
  tabId: string;
  rootPaneId: string;
  worktreePath: string;
  promptFile: string;
  promiseFile: string;
  attemptRecordFile: string;
  agentName: string;
  launchOutput: string;
};

function launchPaths(input: AgentLaunchFlowInput): PreparedLaunch {
  const runDir = path.join(input.stateDir, "runs", path.basename(input.uuid));
  const promptFile = path.join(runDir, `${input.promptFilePrefix}.md`);
  const promiseFile = path.join(runDir, "promise.json");
  const agentName = deriveHerdrAgentName({
    repository: input.repository,
    role: input.role,
    target: input.target.number,
    launchUuid: input.uuid,
  });
  return { runDir, promptFile, promiseFile, agentName };
}

function preparedRecordInput(input: AgentLaunchFlowInput, prepared: PreparedLaunch): PreparedAttemptInput {
  return {
    attemptId: input.attemptId || input.uuid,
    launchUuid: input.uuid,
    project: input.project,
    repository: input.repository,
    role: input.role,
    target: input.target,
    inputRevision: input.inputRevision,
    branch: input.worktree.branch,
    ...(input.worktree.baseBranch === undefined ? {} : { baseBranch: input.worktree.baseBranch }),
    worktreePath: input.intendedWorktreePath,
    agentName: prepared.agentName,
    workspaceLabel: input.workspaceLabel,
    promptFile: prepared.promptFile,
    promiseFile: prepared.promiseFile,
    ...(input.autoMergePolicy === undefined ? {} : { autoMergePolicy: input.autoMergePolicy }),
    ...(input.reviewHistoryRequired === undefined ? {} : { reviewHistoryRequired: input.reviewHistoryRequired }),
    ...(input.requiredVerification === undefined ? {} : { requiredVerification: input.requiredVerification }),
    ...(input.reviewClaim === undefined ? {} : { reviewClaim: input.reviewClaim }),
  };
}

function canonicalWorktreePath(value: string): string {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function priorWorkspaceIdentities(runsRoot: string, currentRunDir: string, worktreePath: string): AttemptRecord[] {
  const canonicalExpected = canonicalWorktreePath(worktreePath);
  const matches: AttemptRecord[] = [];
  for (const entry of fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : []) {
    const candidateDir = path.join(runsRoot, entry);
    if (candidateDir === currentRunDir) continue;
    try {
      const candidate = readAttemptRecord(candidateDir) as AttemptRecord;
      if (canonicalWorktreePath(candidate.worktreePath) === canonicalExpected) matches.push(candidate);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Attempt record is missing:")) continue;
      throw new Error(`cannot prove launch freshness because prior attempt journal ${candidateDir} is malformed`, { cause: error });
    }
  }
  return matches;
}

function assertFreshWorkspaceIdentity(
  launch: { workspaceId: string; tabId: string; rootPaneId: string; worktreePath: string },
  prior: AttemptRecord[],
): void {
  for (const candidate of prior) {
    if (candidate.workspaceId && candidate.workspaceId === launch.workspaceId) throw new Error("Herdr returned a workspace ID used by a prior attempt on this worktree");
    if (candidate.tabId && candidate.tabId === launch.tabId) throw new Error("Herdr returned a tab ID used by a prior attempt on this worktree");
    if (candidate.rootPaneId && candidate.rootPaneId === launch.rootPaneId) throw new Error("Herdr returned a root pane ID used by a prior attempt on this worktree");
  }
}

function samePreparedIdentity(record: AttemptRecord, expected: PreparedAttemptInput): boolean {
  return record.attemptId === expected.attemptId && record.launchUuid === expected.launchUuid
    && record.project === expected.project && record.repository === expected.repository && record.role === expected.role
    && record.target.kind === expected.target.kind && record.target.number === expected.target.number
    && record.inputRevision.head.toLowerCase() === expected.inputRevision.head.toLowerCase()
    && String(record.inputRevision.base || "").toLowerCase() === String(expected.inputRevision.base || "").toLowerCase()
    && record.branch === expected.branch && record.baseBranch === expected.baseBranch
    && path.resolve(record.worktreePath) === path.resolve(expected.worktreePath)
    && record.agentName === expected.agentName && record.workspaceLabel === expected.workspaceLabel
    && path.resolve(record.promptFile) === path.resolve(expected.promptFile)
    && path.resolve(record.promiseFile) === path.resolve(expected.promiseFile)
    && record.autoMergePolicy === expected.autoMergePolicy
    && record.reviewHistoryRequired === expected.reviewHistoryRequired
    && JSON.stringify(record.requiredVerification) === JSON.stringify(expected.requiredVerification)
    && JSON.stringify(record.reviewClaim) === JSON.stringify(expected.reviewClaim);
}

/** Persist the launch intent before a GitHub claim, label, comment, or runner mutation. */
function prepareAgentLaunchFlow(input: AgentLaunchFlowInput, ops: AgentLaunchFlowOps): PreparedLaunch {
  if (input.role === "worker" && !input.requiredVerification) {
    throw new Error("Worker launch requires a resolved required verification contract");
  }
  const prepared = launchPaths(input);
  const expected = preparedRecordInput(input, prepared);
  ops.mkdirSync(prepared.runDir, { recursive: true, mode: 0o700 });
  const runsRoot = path.dirname(prepared.runDir);
  for (const entry of fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : []) {
    const candidateDir = path.join(runsRoot, entry);
    if (candidateDir === prepared.runDir) continue;
    try {
      const candidate = readAttemptRecord(candidateDir);
      if (candidate.agentName === prepared.agentName && candidate.launchUuid !== input.uuid) {
        throw new Error(`Herdr agent name collides with attempt ${candidate.attemptId}: ${prepared.agentName}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Attempt record is missing:")) continue;
      throw error;
    }
  }
  const file = attemptRecordPath(prepared.runDir);
  try {
    const existing = readAttemptRecord(prepared.runDir);
    if (!samePreparedIdentity(existing, expected)) throw new Error("attempt run directory identity does not match this launch");
    if (existing.phase !== "prepared" && existing.phase !== "github_claimed") {
      throw new Error(`attempt phase ${existing.phase} cannot resume launch preparation`);
    }
    writeWorkerContractSnapshot(prepared.runDir, expected);
    return prepared;
  } catch (error) {
    if (error instanceof Error && !error.message.startsWith("Attempt record is missing:")) throw error;
  }
  writeWorkerContractSnapshot(prepared.runDir, expected);
  createPreparedAttempt(prepared.runDir, expected);
  if (!file) throw new Error("attempt record path is unavailable");
  return prepared;
}

/**
 * Roles whose attempt journal must carry the GitHub request claim they consumed. Their prepared
 * identity includes that claim, so the claim has to exist before the journal is written.
 */
const CLAIM_BOUND_AGENT_ROLES = ["reviewer", "branch-update"];

function recordAgentLaunchGithubClaimed(input: AgentLaunchFlowInput): AttemptRecord {
  const prepared = launchPaths(input);
  const existing = readAttemptRecord(prepared.runDir);
  if (!samePreparedIdentity(existing, preparedRecordInput(input, prepared))) {
    throw new Error("attempt run directory identity does not match this claim");
  }
  if (CLAIM_BOUND_AGENT_ROLES.includes(String(existing.role)) && !existing.reviewClaim) {
    throw new Error(`${existing.role} GitHub claim cannot be recorded without an immutable review claim contract`);
  }
  if (existing.phase === "github_claimed") return existing;
  if (existing.phase !== "prepared") throw new Error(`attempt phase ${existing.phase} cannot record a GitHub claim`);
  return transitionPersistedAttempt(prepared.runDir, "github_claimed");
}

function ensureFreshCheckout(input: AgentLaunchFlowInput, runner: RunnerAdapter): void {
  const expectedPath = path.resolve(input.intendedWorktreePath);
  const worktrees = runner.listWorktrees(input.repoPath);
  const branchMatches = worktrees.filter((worktree) => String(worktree.branch || "") === input.worktree.branch);
  const checkoutMatches = worktrees.filter((worktree) =>
    typeof worktree.path === "string" && path.resolve(worktree.path) === expectedPath
  );
  const openWorktree = [...branchMatches, ...checkoutMatches].find((worktree) => Boolean(worktree.workspaceId));
  const openWorkspace = runner.listWorkspaces().find((workspace) =>
    typeof workspace.worktreePath === "string" && path.resolve(workspace.worktreePath) === expectedPath
  );
  if (openWorktree || openWorkspace) {
    throw new Error(`worktree ${input.worktree.branch} already has an open attempt workspace`);
  }
  if (input.worktree.mode === "open") {
    if (branchMatches.length !== 1 || checkoutMatches.length !== 1 || branchMatches[0] !== checkoutMatches[0]) {
      throw new Error(`worktree ${input.worktree.branch} does not resolve to the recorded canonical checkout`);
    }
  } else if (branchMatches.length || checkoutMatches.length) {
    throw new Error(`worktree ${input.worktree.branch} already exists before create`);
  }
}

function prepareWorktree(input: AgentLaunchFlowInput, runner: RunnerAdapter) {
  ensureFreshCheckout(input, runner);
  if (input.worktree.mode === "create") {
    return runner.createWorktree({
      repoPath: input.repoPath,
      branch: input.worktree.branch,
      baseBranch: input.worktree.baseBranch,
      label: input.workspaceLabel,
      intendedPath: input.intendedWorktreePath,
    });
  }
  return runner.openWorktree({ repoPath: input.repoPath, branch: input.worktree.branch });
}

function recordWorkspaceOpened(runDir: string, launch: {
  workspaceId: string;
  tabId: string;
  rootPaneId: string;
  worktreePath: string;
}): void {
  const claimed = readAttemptRecord(runDir);
  if (claimed.phase !== "github_claimed") throw new Error(`attempt phase ${claimed.phase} cannot record workspace ownership`);
  const opened = {
    ...claimed,
    workspaceId: launch.workspaceId,
    tabId: launch.tabId,
    rootPaneId: launch.rootPaneId,
    worktreePath: launch.worktreePath,
    phase: "workspace_opened" as const,
    lastSuccessfulPhase: "workspace_opened" as const,
  };
  writeAttemptRecordAtomically(attemptRecordPath(runDir), opened);
}

function launchAgentFlow(input: AgentLaunchFlowInput, ops: AgentLaunchFlowOps): AgentLaunchFlowResult {
  const runner = ops.runner || createHerdrRunner();
  const prepared = prepareAgentLaunchFlow(input, ops);
  let workspaceMayExist = false;
  try {
    const record = readAttemptRecord(prepared.runDir);
    if (record.phase !== "github_claimed") throw new Error(`attempt phase ${record.phase} cannot launch a workspace`);
    const launch = prepareWorktree(input, runner);
    workspaceMayExist = true;
    if (input.worktree.mode === "open" && path.resolve(launch.worktreePath) !== path.resolve(input.intendedWorktreePath)) {
      throw new Error("Herdr returned a worktree path outside the recorded attempt checkout");
    }
    const priorAttempts = priorWorkspaceIdentities(path.join(input.stateDir, "runs"), prepared.runDir, launch.worktreePath);
    assertFreshWorkspaceIdentity(launch, priorAttempts);
    recordWorkspaceOpened(prepared.runDir, launch);
    runner.renameWorkspace(launch.workspaceId, input.workspaceLabel);

    const liveNames = runner.listAgents().map((agent) => String(agent.name || "")).filter(Boolean);
    if (liveNames.includes(prepared.agentName)) {
      throw new Error(`Herdr agent name ${prepared.agentName} is already live; refusing duplicate launch`);
    }

    let worktreeHead: string | undefined;
    if (input.resolveWorktreeHead) {
      worktreeHead = ops.runText(["git", "-C", launch.worktreePath, "rev-parse", "--verify", "HEAD^{commit}"]).trim();
      if (!/^[0-9a-f]{40}$/i.test(worktreeHead)) throw new Error("created worktree HEAD is not an exact commit SHA");
      if (worktreeHead.toLowerCase() !== input.inputRevision.head.toLowerCase()) {
        throw new Error("created worktree HEAD does not match the recorded input revision");
      }
    }
    ops.writeFileSync(
      prepared.promptFile,
      input.renderPrompt({ promiseFile: prepared.promiseFile, worktreePath: launch.worktreePath, worktreeHead }),
      "utf8",
    );

    ops.beforeAgentStart?.();
    const launchOutput = ops.runText([
      "node", path.join(input.automationDir, "launch-agent.ts"),
      "--agent", input.agent,
      "--name", prepared.agentName,
      "--cwd", launch.worktreePath,
      "--repo-path", input.repoPath,
      "--level", input.level,
      "--model", input.model,
      "--uuid", input.uuid,
      "--prompt-file", prepared.promptFile,
      "--pane", launch.rootPaneId,
    ]);
    const occupants = runner.listAgents().filter((agent) => agent.name === prepared.agentName);
    if (occupants.length !== 1 || occupants[0].paneId !== launch.rootPaneId
      || !occupants[0].cwd || path.resolve(occupants[0].cwd) !== path.resolve(launch.worktreePath)) {
      throw new Error("Herdr did not confirm the launched agent in the recorded root pane");
    }
    transitionPersistedAttempt(prepared.runDir, "agent_started");
    return {
      ...launch,
      promptFile: prepared.promptFile,
      promiseFile: prepared.promiseFile,
      attemptRecordFile: attemptRecordPath(prepared.runDir),
      agentName: prepared.agentName,
      launchOutput,
    };
  } catch (error) {
    try {
      const current = readAttemptRecord(prepared.runDir);
      if (current.phase !== "launch_failed") {
        transitionPersistedAttempt(
          prepared.runDir,
          "launch_failed",
          `${workspaceMayExist ? "workspace may be retained; " : ""}${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } catch {}
    throw error;
  }
}

module.exports = { CLAIM_BOUND_AGENT_ROLES, launchAgentFlow, prepareAgentLaunchFlow, recordAgentLaunchGithubClaimed };
