#!/usr/bin/env node
// Validate and push a review repair. This is the repair worker's only push path.
// It always re-checks the open PR head immediately before a non-force push.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const path = require("node:path") as typeof import("node:path");

type JsonObject = Record<string, any>;
type FinalizeArgs = {
  repo: string;
  githubRepo: string;
  pr: string;
  branch: string;
  expectedHead: string;
  remote: string;
  automationDir: string;
  stateDir: string;
  checkCommand: string;
};
type CommandResult = { status: number; stdout: string; stderr: string };
type FinalizeOps = { run(args: string[]): CommandResult };

function defaultRun(args: string[]): CommandResult {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function checked(ops: FinalizeOps, args: string[]): string {
  const result = ops.run(args);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `command failed: ${args.join(" ")}`).trim());
  return result.stdout.trim();
}

function safeCommentText(value: string): string {
  return value.replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");
}

function renderRepairCompletionComment(expectedHead: string, repairHead: string, subject: string, stat: string): string {
  const fullSubject = safeCommentText(subject.trim());
  const safeSubject = fullSubject.length <= 500 ? fullSubject : `${fullSubject.slice(0, 500)}…`;
  const fullStat = safeCommentText(stat.trim()).replaceAll("```", "` ` `");
  const safeStat = fullStat.length <= 40_000 ? fullStat : `${fullStat.slice(0, 40_000)}\n… diff statistics truncated`;
  const details = safeStat
    ? `\n\n<details>\n<summary>Changed files</summary>\n\n\`\`\`text\n${safeStat}\n\`\`\`\n</details>`
    : "";
  return `## deadloop review repair completed

- Reviewed head: \`${expectedHead}\`
- Repair commit: \`${repairHead}\`
- Summary: ${safeSubject || "Applied the bounded review repair."}
- Validation: Configured project checks passed.${details}`;
}

function decideRepairPushGuard(pr: JsonObject, expectedBranch: string, expectedHead: string): JsonObject {
  if (String(pr.state || "").toUpperCase() !== "OPEN") return { action: "blocked", reason: "pr_not_open" };
  if (Boolean(pr.isCrossRepository)) return { action: "blocked", reason: "cross_repository_pr" };
  if (String(pr.headRefName || "") !== expectedBranch) return { action: "blocked", reason: "head_branch_changed" };
  if (String(pr.headRefOid || "").toLowerCase() !== expectedHead.toLowerCase()) return { action: "stale_head", reason: "head_sha_changed" };
  return { action: "push", reason: "head_unchanged" };
}

function finalizeReviewRepair(args: FinalizeArgs, ops: FinalizeOps = { run: defaultRun }): JsonObject {
  checked(ops, ["git", "check-ref-format", "--branch", args.branch]);
  if (ops.run(["git", "-C", args.repo, "merge-base", "--is-ancestor", args.expectedHead, "HEAD"]).status !== 0) {
    throw new Error("repair branch does not contain the expected PR head");
  }
  if (checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"]).toLowerCase() === args.expectedHead.toLowerCase()) {
    throw new Error("repair did not create a new commit");
  }
  if (checked(ops, ["git", "-C", args.repo, "status", "--porcelain"])) throw new Error("repair worktree is dirty before checks");

  checked(ops, [
    "node",
    path.join(args.automationDir, "run-project-check.ts"),
    "--cwd",
    args.repo,
    "--command",
    args.checkCommand,
    "--quarantine-root",
    path.join(args.stateDir, "check-quarantine"),
  ]);
  if (checked(ops, ["git", "-C", args.repo, "status", "--porcelain"])) throw new Error("repair worktree is dirty after checks");

  const pr = JSON.parse(
    checked(ops, [
      "gh",
      "pr",
      "view",
      args.pr,
      "-R",
      args.githubRepo,
      "--json",
      "state,headRefName,headRefOid,isCrossRepository",
    ]),
  );
  const guard = decideRepairPushGuard(pr, args.branch, args.expectedHead);
  if (guard.action !== "push") return guard;

  checked(ops, ["git", "-C", args.repo, "push", "--porcelain", args.remote, `HEAD:refs/heads/${args.branch}`]);
  const headOid = checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"]);
  const subjectResult = ops.run(["git", "-C", args.repo, "log", "-1", "--format=%s"]);
  const statResult = ops.run(["git", "-C", args.repo, "diff", "--stat", args.expectedHead, headOid]);
  if (subjectResult.status !== 0 || statResult.status !== 0) {
    return { action: "pushed_comment_failed", reason: "repair_comment_metadata_failed", headOid, commentPosted: false };
  }
  const subject = subjectResult.stdout;
  const stat = statResult.stdout;
  const commentArgs = [
    "gh",
    "pr",
    "comment",
    args.pr,
    "-R",
    args.githubRepo,
    "--body",
    renderRepairCompletionComment(args.expectedHead, headOid, subject, stat),
  ];
  let comment = ops.run(commentArgs);
  if (comment.status !== 0) comment = ops.run(commentArgs);
  if (comment.status !== 0) {
    return { action: "pushed_comment_failed", reason: "repair_comment_failed", headOid, commentPosted: false };
  }
  return { action: "pushed", reason: "repair_pushed", headOid, commentPosted: true };
}

function required(values: Record<string, string>, name: string): string {
  if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  return values[name];
}

function parseArgs(argv: string[]): FinalizeArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  return {
    repo: required(values, "repo"),
    githubRepo: required(values, "githubRepo"),
    pr: required(values, "pr"),
    branch: required(values, "branch"),
    expectedHead: required(values, "expectedHead"),
    remote: required(values, "remote"),
    automationDir: required(values, "automationDir"),
    stateDir: required(values, "stateDir"),
    checkCommand: required(values, "checkCommand"),
  };
}

function main(): void {
  try {
    const result = finalizeReviewRepair(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.action === "blocked") process.exitCode = 3;
  } catch (error) {
    console.error(`pr-review-repair-finalize.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = { decideRepairPushGuard, finalizeReviewRepair, parseArgs, renderRepairCompletionComment };
