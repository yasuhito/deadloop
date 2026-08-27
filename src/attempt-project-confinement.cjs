const fs = require("node:fs");
const path = require("node:path");

function canonicalExisting(value, field) {
  const resolved = path.resolve(String(value || ""));
  try { return fs.realpathSync(resolved); }
  catch (error) { throw new Error(`${field} is not an existing canonical path: ${resolved}`, { cause: error }); }
}

function canonicalAttemptLocation(args) {
  const stateDir = canonicalExisting(args.stateDir, "state directory");
  const runsRoot = path.join(stateDir, "runs");
  const attemptRecord = canonicalExisting(args.attemptRecord, "attempt record");
  const runDir = path.dirname(attemptRecord);
  if (path.basename(attemptRecord) !== "attempt.json" || path.dirname(runDir) !== runsRoot) {
    throw new Error("attempt record must be one direct child of the canonical runs directory");
  }
  return { stateDir, runsRoot, attemptRecord, runDir };
}

function assertAttemptProjectBinding(record, args) {
  if (record.project !== String(args.projectId)) throw new Error("attempt project does not match --project-id");
  if (record.repository !== String(args.githubRepo)) throw new Error("attempt repository does not match --github-repo");
  canonicalExisting(args.projectRepo, "project checkout");
}

function gitText(commandRunner, cwd, args) {
  return String(commandRunner.runText(["git", "-C", cwd, ...args]) || "").trim();
}

function parseWorktreePaths(porcelain) {
  return porcelain.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
}

/** Proves a live linked worktree is registered by the configured checkout and shares its Git common directory. */
function assertWorktreeBelongsToProject(commandRunner, record, args) {
  assertAttemptProjectBinding(record, args);
  const projectRepo = canonicalExisting(args.projectRepo, "project checkout");
  const worktreePath = canonicalExisting(record.worktreePath, "attempt worktree");
  const projectCommon = canonicalExisting(gitText(commandRunner, projectRepo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "project Git common directory");
  const worktreeCommon = canonicalExisting(gitText(commandRunner, worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "attempt Git common directory");
  if (projectCommon !== worktreeCommon) throw new Error("attempt worktree does not belong to the configured project checkout");
  const observedTop = canonicalExisting(gitText(commandRunner, worktreePath, ["rev-parse", "--show-toplevel"]), "attempt canonical worktree");
  if (observedTop !== worktreePath) throw new Error("attempt worktree path is not its canonical Git worktree root");
  // A registered entry whose directory is gone (a prunable leftover from any other tool) cannot be
  // the live attempt worktree proven above, so it is excluded from the proof instead of failing it.
  const registered = parseWorktreePaths(gitText(commandRunner, projectRepo, ["worktree", "list", "--porcelain"]))
    .flatMap((candidate) => {
      try { return [canonicalExisting(candidate, "registered worktree")]; }
      catch { return []; }
    });
  if (!registered.includes(worktreePath)) throw new Error("attempt worktree is not registered by the configured project checkout");
  return { projectRepo, worktreePath, commonDir: projectCommon };
}

module.exports = { assertAttemptProjectBinding, assertWorktreeBelongsToProject, canonicalAttemptLocation };
