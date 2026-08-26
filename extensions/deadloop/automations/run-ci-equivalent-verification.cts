#!/usr/bin/env node
// Run the CI-equivalent verification contract against one exact tree (ADR 0030).
//
// Mode "merge" verifies the prospective merge tree of an exact PR head and current base using the
// same semantic integration as a normal merge (git merge-tree --write-tree); mode "base" diagnoses
// the fixed trusted base itself after a produced-revision failure. Nothing is pushed: the temporary
// tree exists only inside a detached worktree under the state directory, and every execution
// persists its record outside any worktree, bound to repository, head, base, tree, command,
// derivation, policy source, and policy base revision.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const { observeTrustedBaseContract } = require("../../../src/ci-equivalent-contract.cts") as {
  observeTrustedBaseContract: (input: { projectRepo: string; baseRevision: string; runText?: (args: string[]) => string }) => any;
};
const store = require("../../../src/ci-fallback-store.cjs");

type JsonObject = Record<string, any>;
type CommandResult = { status: number; stdout: string; stderr: string; timedOut?: boolean };
type RunnerOps = {
  runGit(args: string[], options?: { cwd?: string }): CommandResult;
  runCommand(command: string, cwd: string, timeoutMs: number): CommandResult;
  now(): Date;
};

function defaultRunGit(args: string[], options?: { cwd?: string }): CommandResult {
  const result = spawnSync("git", ["-C", options?.cwd || process.cwd(), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function defaultRunCommand(command: string, cwd: string, timeoutMs: number): CommandResult {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("DEADLOOP_")) environment[key] = value;
  }
  const result = spawnSync("bash", ["-lc", command], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    timedOut: Boolean(result.error && String((result.error as NodeJS.ErrnoException).message || "").includes("ETIMEDOUT")),
  };
}

function gitOrThrow(ops: RunnerOps, args: string[], cwd?: string): string {
  const result = ops.runGit(args, cwd ? { cwd } : undefined);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

/**
 * The prospective merge tree of exact base and head, integrated with git's own merge machinery.
 * A conflict is a typed verification failure before any command runs.
 */
function prospectiveMergeTree(ops: RunnerOps, projectRepo: string, baseOid: string, headOid: string): { treeOid: string; conflicted: boolean; files: string[] } {
  const result = ops.runGit(["merge-tree", "--write-tree", "--name-only", "-z", baseOid, headOid], { cwd: projectRepo });
  const fields = String(result.stdout || "").split("\0").filter(Boolean);
  const conflictedCount = Number(fields[1] || "0");
  const files = fields.slice(2);
  if (result.status === 0) return { treeOid: fields[0] || "", conflicted: false, files: [] };
  return { treeOid: "", conflicted: true, files: conflictedCount > 0 ? files : [] };
}

function writeLog(stateDir: string, projectId: string, prNumber: number, headOid: string, body: string): string {
  const logPath = store.newLogIdentity(stateDir, projectId, prNumber, headOid);
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(logPath, body, { encoding: "utf8", mode: 0o600 });
  return logPath;
}

function persistConflictRecord(input: Record<string, any>, contract: JsonObject, ops: RunnerOps): JsonObject {
  const logPath = writeLog(
    input.stateDir, input.projectId, input.prNumber, input.headOid,
    `git merge-tree reported conflicts between ${input.baseOid} and ${input.headOid}:\n${input.conflictFiles.map((file: string) => `- ${file}`).join("\n")}\n`,
  );
  const record = store.buildVerificationRecord({
    role: "merge_candidate",
    repository: input.githubRepo,
    prNumber: input.prNumber,
    headOid: input.headOid,
    baseOid: input.baseOid,
    treeOid: "",
    command: contract.command,
    derivation: contract.derivation,
    policySource: contract.policySource,
    policyBaseRevision: input.policyBaseRevision,
    outcome: "failed",
    exitCode: 1,
    startedAt: ops.now().toISOString(),
    durationMs: 0,
    logPath,
    terminationEvidence: { kind: "integration_conflict" },
  });
  const recordPath = store.writeMergeCandidateRecord(input.stateDir, input.projectId, record);
  return { ok: true, action: "verified", outcome: "failed", reason: "integration_conflict", recordPath, record };
}

function runVerification(input: {
  mode: "merge" | "base";
  projectRepo: string;
  projectId: string;
  githubRepo: string;
  prNumber: number;
  headOid: string;
  baseOid: string;
  policyBaseRevision: string;
  stateDir: string;
  timeoutSeconds: number;
}, ops: RunnerOps): JsonObject {
  // One complete contract from the fixed trusted base: explicit repo policy wins, then the npm
  // convention. Anything else leaves fallback unavailable.
  const contract = observeTrustedBaseContract({ projectRepo: input.projectRepo, baseRevision: input.policyBaseRevision });
  if (contract.status !== "resolved") {
    return { ok: true, action: "contract_unavailable", reason: contract.reason };
  }

  let role: string;
  let targetHead: string;
  let targetBase: string;
  let treeOid: string;

  if (input.mode === "merge") {
    const merge = prospectiveMergeTree(ops, input.projectRepo, input.baseOid, input.headOid);
    role = "merge_candidate";
    targetHead = input.headOid;
    targetBase = input.baseOid;
    if (merge.conflicted) return persistConflictRecord({ ...input, conflictFiles: merge.files }, contract as unknown as JsonObject, ops);
    treeOid = merge.treeOid;
  } else {
    role = "base_diagnosis";
    targetHead = input.baseOid;
    targetBase = input.baseOid;
    treeOid = gitOrThrow(ops, ["rev-parse", `${input.baseOid}^{tree}`], input.projectRepo);
  }

  // The temporary tree lives only inside a detached worktree under the state directory; nothing is
  // pushed and the worktree is removed before this process exits.
  const worktreesParent = path.join(store.ciFallbackDirectory(input.stateDir, input.projectId), "merge-trees");
  fs.mkdirSync(worktreesParent, { recursive: true, mode: 0o700 });
  const worktreePath = path.join(worktreesParent, `merge-${process.pid}-${Date.now()}`);
  const commitArgs = ["commit-tree", treeOid, "-m", `deadloop CI-equivalent verification (${role})`, "-p", targetBase];
  if (role === "merge_candidate") commitArgs.push("-p", targetHead);
  const verificationCommit = gitOrThrow(ops, commitArgs, input.projectRepo);

  const startedAt = ops.now();
  let exitCode: number;
  let timedOut = false;
  let logPath = "";
  try {
    gitOrThrow(ops, ["worktree", "add", "--detach", worktreePath, verificationCommit], input.projectRepo);
    const result = ops.runCommand(contract.command, worktreePath, Math.max(1, input.timeoutSeconds) * 1000);
    exitCode = result.status;
    timedOut = Boolean(result.timedOut);
    logPath = writeLog(
      input.stateDir, input.projectId, input.prNumber, input.headOid,
      `command: ${contract.command}\nworktree commit: ${verificationCommit} (temporary, not pushed)\nexit code: ${result.status}\ntimed out: ${timedOut}\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
    );
  } finally {
    ops.runGit(["worktree", "remove", "--force", worktreePath], { cwd: input.projectRepo });
    ops.runGit(["worktree", "prune"], { cwd: input.projectRepo });
  }

  const durationMs = ops.now().getTime() - startedAt.getTime();
  const record = store.buildVerificationRecord({
    role,
    repository: input.githubRepo,
    prNumber: input.prNumber,
    headOid: targetHead,
    baseOid: targetBase,
    treeOid,
    command: contract.command,
    derivation: contract.derivation,
    policySource: contract.policySource,
    policyBaseRevision: input.policyBaseRevision,
    outcome: exitCode === 0 && !timedOut ? "passed" : "failed",
    exitCode,
    startedAt: startedAt.toISOString(),
    durationMs,
    logPath,
    terminationEvidence: timedOut ? { kind: "command_timeout" } : { kind: "exit_status" },
  });
  const recordPath = role === "merge_candidate"
    ? store.writeMergeCandidateRecord(input.stateDir, input.projectId, record)
    : store.writeDiagnosisRecord(input.stateDir, input.projectId, record);
  return {
    ok: true,
    action: "verified",
    outcome: record.outcome,
    role,
    recordPath,
    record,
    ...(timedOut ? { reason: "command_timeout" } : {}),
  };
}

function requiredValue(values: Record<string, string>, name: string): string {
  if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  return values[name];
}

function parseArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  return values;
}

function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseArgs(argv);
    const mode = requiredValue(args, "mode");
    if (mode !== "merge" && mode !== "base") throw new Error("--mode must be merge or base");
    const ops: RunnerOps = { runGit: defaultRunGit, runCommand: defaultRunCommand, now: () => new Date() };
    const result = runVerification({
      mode,
      projectRepo: path.resolve(requiredValue(args, "repoPath")),
      projectId: requiredValue(args, "projectId"),
      githubRepo: requiredValue(args, "githubRepo"),
      prNumber: Number(requiredValue(args, "pr")),
      headOid: requiredValue(args, "head"),
      baseOid: requiredValue(args, "base"),
      policyBaseRevision: args.policyBaseRevision || requiredValue(args, "base"),
      stateDir: path.resolve(requiredValue(args, "stateDir")),
      timeoutSeconds: Number(args.timeoutSeconds || 3600),
    }, ops);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    console.error(`run-ci-equivalent-verification.cts: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 2;
  }
}

if (require.main === module) main();

module.exports = { main, parseArgs, prospectiveMergeTree, runVerification };
