const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const WORKER_REQUIRED_VERIFICATION_FILE = "required-verification.json";
const authenticatedRecords = new WeakSet();
function nonEmpty(value) { return typeof value === "string" && Boolean(value.trim()); }
function validSha(value) { return nonEmpty(value) && /^[0-9a-f]{40}$/i.test(value); }
function assertContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("required verification persisted contract is missing");
  if (!nonEmpty(value.command)) throw new Error("required verification blocked: zero_targets");
  if (!nonEmpty(value.repository) || !validSha(value.baseRevision)) throw new Error("required verification persisted contract binding is invalid");
  if (!value.source || typeof value.source !== "object" || !["local", "repo_policy"].includes(value.source.kind) || !nonEmpty(value.source.location)) throw new Error("required verification persisted contract source is invalid");
}
function requiredVerificationBinding(contract, targetCommit) {
  assertContract(contract); if (!validSha(targetCommit)) throw new Error("required verification target commit is invalid");
  return { repository: contract.repository, targetCommit, command: contract.command, source: contract.source, baseRevision: contract.baseRevision };
}
function workerRequiredVerificationPath(attemptRecordFile) { return path.join(path.dirname(attemptRecordFile), WORKER_REQUIRED_VERIFICATION_FILE); }
function cleanWorkerOutput(worktree, outputRevision) {
  if (git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]).toLowerCase() !== outputRevision.toLowerCase()) return false;
  return !git(worktree, ["status", "--porcelain", "--untracked-files=all", "--", ".",
    ":(exclude).deadloop", ":(exclude).deadloop/**", ":(exclude).pi-subagents", ":(exclude).pi-subagents/**"]);
}
function readRequiredVerificationRecord(file) {
  let persisted;
  try { persisted = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
  if (!persisted || typeof persisted !== "object" || Array.isArray(persisted) || persisted.version !== 1
    || !nonEmpty(persisted.startedAt) || !Number.isFinite(persisted.durationMs) || persisted.durationMs < 0 || !nonEmpty(persisted.logPath)
    || persisted.outcome !== "passed" || persisted.exitCode !== 0) return persisted;
  const runDir = path.dirname(file);
  let attempt; let report;
  try {
    attempt = JSON.parse(fs.readFileSync(path.join(runDir, "attempt.json"), "utf8"));
    report = JSON.parse(fs.readFileSync(attempt.promiseFile, "utf8"));
  } catch { return persisted; }
  const outputRevision = report?.result?.outputRevision;
  if (!validSha(outputRevision) || !attempt?.requiredVerification || !cleanWorkerOutput(attempt.worktreePath, outputRevision)) {
    throw new Error("fresh required verification output binding failed");
  }
  const stateDir = path.dirname(path.dirname(runDir));
  const script = path.join(__dirname, "../extensions/deadloop/automations/run-project-check.ts");
  const started = Date.now();
  const result = childProcess.spawnSync(process.execPath, [script,
    "--cwd", attempt.worktreePath, "--timeout-ms", String(10 * 60_000),
    "--command", attempt.requiredVerification.command,
    "--quarantine-root", path.join(stateDir, "check-quarantine"),
  ], { encoding: "utf8", timeout: 11 * 60_000, killSignal: "SIGKILL" });
  if (result.status !== 0 || !cleanWorkerOutput(attempt.worktreePath, outputRevision)) {
    throw new Error(String(result.stderr || result.stdout || "fresh required verification failed").trim());
  }
  const record = {
    version: 1, binding: requiredVerificationBinding(attempt.requiredVerification, outputRevision),
    outcome: "passed", exitCode: 0, startedAt: new Date(started).toISOString(),
    durationMs: Math.max(0, Date.now() - started), logPath: persisted.logPath,
  };
  authenticatedRecords.add(record);
  return record;
}
function writeRequiredVerificationRecord(file, record) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); fs.renameSync(temporary, file); }
function git(repoPath, args) { const result = childProcess.spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8", timeout: 30000 }); if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "git command failed").trim()); return String(result.stdout || "").trim(); }
function assertCurrentWorkerContract(attempt, projectRepo, localConfigPath) {
  assertContract(attempt.requiredVerification); const contract = attempt.requiredVerification; const baseBranch = attempt.baseBranch || "origin/main";
  const separator = baseBranch.indexOf("/");
  if (separator <= 0 || separator === baseBranch.length - 1) throw new Error("required verification blocked: stale_policy; trusted base is not a remote-tracking branch");
  const remote = baseBranch.slice(0, separator); const branch = baseBranch.slice(separator + 1);
  git(projectRepo, ["fetch", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  const currentBase = git(projectRepo, ["rev-parse", "--verify", `${baseBranch}^{commit}`]);
  if (currentBase.toLowerCase() !== contract.baseRevision.toLowerCase()) throw new Error("required verification blocked: stale_policy; trusted base revision changed");

  const persistedLocalSource = contract.source.kind === "local" ? contract.source : contract.override?.source?.kind === "local" ? contract.override.source : undefined;
  const configFile = localConfigPath;
  const localSources = [];
  if (configFile && fs.existsSync(configFile)) {
    let config; try { config = JSON.parse(fs.readFileSync(configFile, "utf8")); } catch { throw new Error("required verification blocked: stale_policy; local policy is malformed"); }
    if (!config || typeof config !== "object" || Array.isArray(config) || (config.projects !== undefined && !Array.isArray(config.projects))) {
      throw new Error("required verification blocked: stale_policy; local policy is malformed");
    }
    const selected = (config.projects || []).find((project) => project && typeof project === "object" && (project.id === attempt.project || project.githubRepo === attempt.repository));
    if (selected && Object.prototype.hasOwnProperty.call(selected, "checkCommand")) {
      localSources.push({ kind: "local", location: `${configFile}#project=${attempt.project}`, command: selected.checkCommand });
    }
  } else if (persistedLocalSource) {
    throw new Error("required verification blocked: stale_policy; local policy is unavailable");
  }

  let policyText;
  try { policyText = git(projectRepo, ["show", `${contract.baseRevision}:deadloop.json`]); }
  catch { policyText = undefined; }
  let policy;
  if (policyText !== undefined) {
    try { policy = JSON.parse(policyText); }
    catch { throw new Error("required verification blocked: stale_policy; trusted policy is malformed"); }
  }
  if (policy !== undefined && (!policy || typeof policy !== "object" || Array.isArray(policy))) {
    throw new Error("required verification blocked: stale_policy; trusted policy is malformed");
  }
  const sharedSources = policy && Object.prototype.hasOwnProperty.call(policy, "checkCommand")
    ? [{ kind: "repo_policy", location: "deadloop.json", command: policy.checkCommand }]
    : [];
  const sourcesConflict = (sources) => new Set(sources.map((source) => source.command)).size > 1;
  if (sourcesConflict(localSources) || sourcesConflict(sharedSources)) throw new Error("required verification blocked: stale_policy; current policy is conflicted");
  const selected = localSources[0] || sharedSources[0];
  if (!selected || typeof selected.command !== "string" || !selected.command.trim()) throw new Error("required verification blocked: stale_policy; current policy is unresolved");
  const replaced = localSources.length ? sharedSources[0] : undefined;
  const current = {
    repository: attempt.repository,
    command: selected.command,
    source: { kind: selected.kind, location: selected.location },
    baseRevision: currentBase,
    ...(replaced && replaced.command !== selected.command ? { override: { source: { kind: replaced.kind, location: replaced.location }, command: replaced.command } } : {}),
  };
  if (!isDeepStrictEqual(current, contract)) throw new Error("required verification blocked: stale_policy; current policy differs from the fixed attempt contract");
  return current;
}
function assertWorkerCompletionAuthorized(attempt, report, record, currentContract) {
  if (attempt.role !== "worker" || report.role !== "worker" || report.status !== "complete") throw new Error("Worker completion gate requires a complete Worker report");
  assertContract(attempt.requiredVerification); assertContract(currentContract);
  if (!isDeepStrictEqual(attempt.requiredVerification, currentContract)) throw new Error("required verification blocked: stale_policy; start a new attempt");
  if (attempt.requiredVerification.repository !== attempt.repository) throw new Error("required verification persisted contract repository does not match attempt");
  if (!record || typeof record !== "object" || Array.isArray(record) || record.version !== 1) throw new Error("required verification passed record is missing");
  if (!nonEmpty(record.startedAt) || !Number.isFinite(record.durationMs) || record.durationMs < 0 || !nonEmpty(record.logPath)) throw new Error("required verification record is invalid");
  if (record.outcome !== "passed" || record.exitCode !== 0) throw new Error("required verification record did not pass");
  if (!isDeepStrictEqual(record.binding, requiredVerificationBinding(attempt.requiredVerification, report.result.outputRevision))) throw new Error("required verification record does not match the Worker output commit and fixed contract");
  if (!authenticatedRecords.has(record)) throw new Error("required verification host execution authenticity is missing");
  return { outputRevision: report.result.outputRevision, record };
}
module.exports = { WORKER_REQUIRED_VERIFICATION_FILE, assertCurrentWorkerContract, assertWorkerCompletionAuthorized, readRequiredVerificationRecord, requiredVerificationBinding, workerRequiredVerificationPath, writeRequiredVerificationRecord };
