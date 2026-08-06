const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const WORKER_REQUIRED_VERIFICATION_FILE = "required-verification.json";
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
function readRequiredVerificationRecord(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } }
function writeRequiredVerificationRecord(file, record) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); fs.renameSync(temporary, file); }
function git(repoPath, args) { const result = childProcess.spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8", timeout: 30000 }); if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "git command failed").trim()); return String(result.stdout || "").trim(); }
function assertCurrentWorkerContract(attempt, projectRepo) {
  assertContract(attempt.requiredVerification); const contract = attempt.requiredVerification; const baseBranch = attempt.baseBranch || "origin/main";
  const separator = baseBranch.indexOf("/");
  if (separator <= 0 || separator === baseBranch.length - 1) throw new Error("required verification blocked: stale_policy; trusted base is not a remote-tracking branch");
  const remote = baseBranch.slice(0, separator); const branch = baseBranch.slice(separator + 1);
  git(projectRepo, ["fetch", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  const currentBase = git(projectRepo, ["rev-parse", "--verify", `${baseBranch}^{commit}`]);
  if (currentBase.toLowerCase() !== contract.baseRevision.toLowerCase()) throw new Error("required verification blocked: stale_policy; trusted base revision changed");
  if (contract.source.kind === "repo_policy") {
    let policy; try { policy = JSON.parse(git(projectRepo, ["show", `${contract.baseRevision}:${contract.source.location}`])); } catch { throw new Error("required verification blocked: stale_policy; trusted policy is malformed"); }
    if (!policy || policy.checkCommand !== contract.command) throw new Error("required verification blocked: stale_policy; trusted policy changed");
  } else {
    let config; try { config = JSON.parse(fs.readFileSync(contract.source.location.split("#", 1)[0], "utf8")); } catch { throw new Error("required verification blocked: stale_policy; local policy is unavailable"); }
    const projects = config && Array.isArray(config.projects) ? config.projects : []; const selected = projects.find((project) => project.id === attempt.project || project.githubRepo === attempt.repository);
    if (!selected || selected.checkCommand !== contract.command) throw new Error("required verification blocked: stale_policy; local policy changed");
  }
  return contract;
}
function assertWorkerCompletionAuthorized(attempt, report, record, currentContract) {
  if (attempt.role !== "worker" || report.role !== "worker" || report.status !== "complete") throw new Error("Worker completion gate requires a complete Worker report");
  assertContract(attempt.requiredVerification); assertContract(currentContract);
  if (!isDeepStrictEqual(attempt.requiredVerification, currentContract)) throw new Error("required verification blocked: stale_policy; start a new attempt");
  if (attempt.requiredVerification.repository !== attempt.repository) throw new Error("required verification persisted contract repository does not match attempt");
  if (!record || record.version !== 1) throw new Error("required verification passed record is missing");
  if (record.outcome !== "passed" || record.exitCode !== 0) throw new Error("required verification record did not pass");
  if (!isDeepStrictEqual(record.binding, requiredVerificationBinding(attempt.requiredVerification, report.result.outputRevision))) throw new Error("required verification record does not match the Worker output commit and fixed contract");
  return { outputRevision: report.result.outputRevision, record };
}
module.exports = { WORKER_REQUIRED_VERIFICATION_FILE, assertCurrentWorkerContract, assertWorkerCompletionAuthorized, readRequiredVerificationRecord, requiredVerificationBinding, workerRequiredVerificationPath, writeRequiredVerificationRecord };
