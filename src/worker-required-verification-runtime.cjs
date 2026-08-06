const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const WORKER_REQUIRED_VERIFICATION_FILE = "required-verification.json";
const authenticatedRecords = new WeakSet();
const HOST_VERIFICATION_EVIDENCE_DIRECTORY = "required-verification-evidence";
const HOST_WORKER_CONTRACT_DIRECTORY = "worker-contract-snapshots";
const ATTEMPT_RUN_DIR = Symbol.for("deadloop.attemptRunDir");
function nonEmpty(value) { return typeof value === "string" && Boolean(value.trim()); }
function validSha(value) { return nonEmpty(value) && /^[0-9a-f]{40}$/i.test(value); }
function sanitizeId(value) {
  return String(value || "project").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
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
function workerContractSnapshotPath(runDir) {
  const stateDir = path.dirname(path.dirname(runDir));
  const attemptKey = crypto.createHash("sha256").update(path.resolve(runDir)).digest("hex");
  return path.join(stateDir, HOST_WORKER_CONTRACT_DIRECTORY, `${attemptKey}.json`);
}
function workerContractSnapshot(attempt) {
  assertContract(attempt.requiredVerification);
  return {
    version: 1,
    identity: {
      attemptId: attempt.attemptId,
      launchUuid: attempt.launchUuid,
      project: attempt.project,
      repository: attempt.repository,
      role: attempt.role,
      target: attempt.target,
      inputRevision: attempt.inputRevision,
    },
    contract: attempt.requiredVerification,
  };
}
function writeWorkerContractSnapshot(runDir, attempt) {
  if (!attempt.requiredVerification) return;
  const trustedRunDir = path.resolve(runDir);
  if (attempt[ATTEMPT_RUN_DIR] === undefined) Object.defineProperty(attempt, ATTEMPT_RUN_DIR, { value: trustedRunDir, enumerable: false });
  if (attempt[ATTEMPT_RUN_DIR] !== trustedRunDir) throw new Error("required verification launch contract snapshot attempt location is invalid");
  const file = workerContractSnapshotPath(trustedRunDir); const snapshot = workerContractSnapshot(attempt);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const descriptor = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(descriptor, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fsyncDirectory(path.dirname(file));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let existing; let stat;
    try { stat = fs.lstatSync(file); existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("required verification launch contract snapshot is invalid"); }
    if (!stat.isFile() || stat.isSymbolicLink() || !isDeepStrictEqual(existing, snapshot)) throw new Error("required verification launch contract snapshot does not match this attempt");
  }
}
function readWorkerContractSnapshot(attempt) {
  const runDir = attempt[ATTEMPT_RUN_DIR];
  if (!nonEmpty(runDir) || path.dirname(attempt.promiseFile) !== runDir) throw new Error("required verification launch contract snapshot attempt location is invalid");
  const file = workerContractSnapshotPath(runDir);
  let snapshot; let stat;
  try { stat = fs.lstatSync(file); snapshot = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("required verification launch contract snapshot is missing or invalid"); }
  const expected = workerContractSnapshot(attempt);
  if (!stat.isFile() || stat.isSymbolicLink() || !isDeepStrictEqual(snapshot, expected)) {
    throw new Error("required verification blocked: stale_policy; attempt contract differs from the authenticated launch snapshot");
  }
  return snapshot.contract;
}
function cleanWorkerOutput(worktree, outputRevision) {
  if (git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]).toLowerCase() !== outputRevision.toLowerCase()) return false;
  if (git(worktree, ["ls-files", "-v"]).split(/\r?\n/).some((line) => /^[a-zS]/.test(line))) return false;
  return !git(worktree, ["status", "--porcelain", "--untracked-files=all", "--", ".",
    ":(exclude).deadloop", ":(exclude).deadloop/**", ":(exclude).pi-subagents", ":(exclude).pi-subagents/**"]);
}
function fsyncDirectory(directory) { const descriptor = fs.openSync(directory, "r"); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } }
function durableWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file); fsyncDirectory(path.dirname(file));
}
function durableWriteLog(file, contents) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, contents, "utf8"); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fsyncDirectory(path.dirname(file));
}
function hostEvidenceDirectory(runDir) {
  const stateDir = path.dirname(path.dirname(runDir));
  const attemptKey = crypto.createHash("sha256").update(path.resolve(runDir)).digest("hex");
  return path.join(stateDir, HOST_VERIFICATION_EVIDENCE_DIRECTORY, attemptKey);
}
function executeAndRecordGateVerification(file, attempt, outputRevision) {
  const runDir = path.dirname(file); const stateDir = path.dirname(path.dirname(runDir));
  const evidenceDir = hostEvidenceDirectory(runDir); fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const executionId = crypto.randomUUID(); const logPath = path.join(evidenceDir, `${executionId}.log`); const recordPath = path.join(evidenceDir, `${executionId}.json`);
  const script = path.join(__dirname, "../extensions/deadloop/automations/run-project-check.ts"); const started = Date.now();
  const result = childProcess.spawnSync(process.execPath, [script,
    "--cwd", attempt.worktreePath, "--timeout-ms", String(10 * 60_000),
    "--command", attempt.requiredVerification.command,
    "--quarantine-root", path.join(stateDir, "check-quarantine"),
  ], { encoding: "utf8", timeout: 11 * 60_000, killSignal: "SIGKILL" });
  let outputFailure;
  try { if (!cleanWorkerOutput(attempt.worktreePath, outputRevision)) throw new Error("fresh required verification output binding failed"); }
  catch (error) { outputFailure = error; }
  const timedOut = result.status === 124 || (result.error && "code" in result.error && result.error.code === "ETIMEDOUT");
  const outcome = timedOut ? "timed_out" : result.status === 0 && !result.error && !outputFailure ? "passed" : "failed";
  const terminationReason = timedOut ? "timeout" : result.error ? "runner_failure" : outputFailure ? "output_not_clean" : result.signal ? "signal" : undefined;
  const runnerEvidence = result.error ? `required verification runner failed: ${result.error.message}\n` : "";
  const outputEvidence = outputFailure ? `required verification post-check binding failed: ${outputFailure.message}\n` : "";
  durableWriteLog(logPath, `${result.stdout || ""}${result.stderr || ""}${runnerEvidence}${outputEvidence}`);
  const record = {
    version: 1, binding: requiredVerificationBinding(attempt.requiredVerification, outputRevision), outcome,
    exitCode: timedOut || result.error ? null : result.status, ...(terminationReason ? { terminationReason } : {}),
    ...(result.signal ? { terminationSignal: result.signal } : {}), startedAt: new Date(started).toISOString(),
    durationMs: Math.max(0, Date.now() - started), logPath,
    provenance: { kind: "host_gate_execution", recordPath },
  };
  durableWriteJson(recordPath, record); writeRequiredVerificationRecord(file, record); authenticatedRecords.add(record);
  if (outcome !== "passed") throw new Error(String(result.stderr || result.stdout || result.error?.message || outputFailure?.message || "fresh required verification failed").trim());
  return record;
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
  return executeAndRecordGateVerification(file, attempt, outputRevision);
}
function writeRequiredVerificationRecord(file, record) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); fs.renameSync(temporary, file); }
function git(repoPath, args) { const result = childProcess.spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8", timeout: 30000 }); if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "git command failed").trim()); return String(result.stdout || "").trim(); }
function githubRepoFromRemote(remote) {
  const match = /^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote);
  return match ? match[1] : "";
}
function authenticatedFetchUrl(projectRepo, remote, repository, repositoryId) {
  if (!nonEmpty(repositoryId)) return remote;
  const urls = git(projectRepo, ["remote", "get-url", "--all", remote]).split(/\r?\n/).filter(Boolean);
  if (urls.length !== 1) throw new Error("required verification blocked: stale_policy; trusted fetch source is ambiguous");
  const identity = githubRepoFromRemote(urls[0]);
  if (!identity) throw new Error("required verification blocked: stale_policy; trusted fetch source is not GitHub");
  const result = childProcess.spawnSync("gh", ["repo", "view", identity, "--json", "id"], { encoding: "utf8", timeout: 30000 });
  let actualId = "";
  try { actualId = result.status === 0 ? String(JSON.parse(result.stdout || "{}").id || "") : ""; } catch {}
  if (actualId !== repositoryId) {
    throw new Error(`required verification blocked: stale_policy; trusted fetch source repository identity differs from ${repository}`);
  }
  return urls[0];
}
function assertCurrentWorkerContract(attempt, projectRepo, localConfigPath, repositoryId) {
  const contract = readWorkerContractSnapshot(attempt); const baseBranch = attempt.baseBranch || "origin/main";
  const remoteRef = baseBranch.startsWith("refs/remotes/") ? baseBranch.slice("refs/remotes/".length) : baseBranch;
  const separator = remoteRef.indexOf("/");
  const remotes = new Set(git(projectRepo, ["remote"]).split(/\r?\n/).filter(Boolean));
  const remote = separator > 0 ? remoteRef.slice(0, separator) : "";
  if (remotes.has(remote)) {
    const branch = remoteRef.slice(separator + 1);
    if (!branch) throw new Error("required verification blocked: stale_policy; trusted remote branch is invalid");
    const fetchUrl = authenticatedFetchUrl(projectRepo, remote, attempt.repository, repositoryId);
    git(projectRepo, ["fetch", "--no-tags", fetchUrl, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  }
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
    const matches = (config.projects || []).filter((project) => project && typeof project === "object"
      && sanitizeId(project.id || project.githubRepo || project.repoPath) === attempt.project && project.githubRepo === attempt.repository);
    if (matches.length > 1) throw new Error("required verification blocked: stale_policy; local policy project identity is ambiguous");
    const selected = matches[0];
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
  if (!authenticatedRecords.has(record)) {
    const provenance = record.provenance;
    if (!provenance || provenance.kind !== "host_gate_execution" || !nonEmpty(provenance.recordPath) || !nonEmpty(attempt.promiseFile)) {
      throw new Error("required verification host execution authenticity is missing");
    }
    const expectedDirectory = hostEvidenceDirectory(path.dirname(attempt.promiseFile));
    if (path.dirname(provenance.recordPath) !== expectedDirectory) throw new Error("required verification host execution authenticity is missing");
    let persisted; let stat;
    try { stat = fs.lstatSync(provenance.recordPath); persisted = JSON.parse(fs.readFileSync(provenance.recordPath, "utf8")); }
    catch { throw new Error("required verification host execution authenticity is missing"); }
    if (!stat.isFile() || stat.isSymbolicLink() || !isDeepStrictEqual(persisted, record)) {
      throw new Error("required verification host execution authenticity is missing");
    }
  }
  return { outputRevision: report.result.outputRevision, record };
}
module.exports = { WORKER_REQUIRED_VERIFICATION_FILE, assertCurrentWorkerContract, assertWorkerCompletionAuthorized, executeAndRecordGateVerification, readRequiredVerificationRecord, readWorkerContractSnapshot, requiredVerificationBinding, workerContractSnapshotPath, workerRequiredVerificationPath, writeRequiredVerificationRecord, writeWorkerContractSnapshot };
