#!/usr/bin/env node
// Run one monitor-side mutation while holding the enablement lock shared with
// /deadloop-disable. A disabled repository never starts the command.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const { parsePaginatedGithubJson, savedReviewClaimContract, validateActiveReviewClaim } = require("./pr-review-claim.ts");

const GUARDED_OPERATION_TIMEOUT_MS = MAX_GUARDED_OPERATION_MS;

type Args = {
  projectRepo: string;
  githubRepo: string;
  stateDir: string;
  enabledAt: number;
  targetKind: "issue" | "pull-request";
  command: string[];
  attemptRecord?: string;
  reviewClaim?: Record<string, unknown>;
};

type SavedClaimLoader = (
  attemptRecord: string,
  supplied: unknown,
  authority: { stateDir: string; githubRepo: string; targetNumber: number },
) => Record<string, unknown>;

type ApprovedOperation = { positional: number; valueFlags: Set<string> };

const APPROVED_GH_OPERATIONS = new Map<string, ApprovedOperation>([
  ["issue edit", { positional: 1, valueFlags: new Set(["--add-label", "--remove-label"]) }],
  ["issue comment", { positional: 1, valueFlags: new Set(["--body", "--body-file"]) }],
  ["pr edit", { positional: 1, valueFlags: new Set(["--remove-label"]) }],
  ["pr comment", { positional: 1, valueFlags: new Set(["--body", "--body-file"]) }],
]);

function assertApprovedCommand(command: string[], githubRepo: string): string {
  if (!/(^|[/\\])gh(?:\.exe)?$/.test(command[0] || "")) {
    throw new Error("guarded-operation.ts accepts only approved gh mutations; use dedicated helpers for push or branch operations");
  }
  const approved = APPROVED_GH_OPERATIONS.get(`${command[1] || ""} ${command[2] || ""}`);
  if (!approved) {
    throw new Error("GitHub operation is not approved; merge and branch deletion require dedicated helpers");
  }

  const positional: string[] = [];
  let repository = "";
  let repositoryTargets = 0;
  for (let index = 3; index < command.length; index += 1) {
    const token = command[index];
    const equals = token.match(/^(--repo)=([\s\S]+)$/);
    if (token === "-R" || token === "--repo") {
      const value = command[index + 1];
      if (!value) throw new Error("GitHub repository target is missing");
      repository = value;
      repositoryTargets += 1;
      index += 1;
    } else if (equals) {
      repository = equals[2];
      repositoryTargets += 1;
    } else if (approved.valueFlags.has(token)) {
      if (command[index + 1] === undefined) throw new Error(`value is missing for ${token}`);
      index += 1;
    } else if ([...approved.valueFlags].some((flag) => token.startsWith(`${flag}=`))) {
      continue;
    } else if (token.startsWith("-")) {
      throw new Error(`option is not approved for guarded GitHub mutation: ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (repositoryTargets !== 1 || repository !== githubRepo) {
    throw new Error("GitHub repository target does not match enabled repository");
  }
  if (positional.length !== approved.positional || positional.some((value) => !/^\d+$/.test(value))) {
    throw new Error("guarded GitHub mutation has an invalid target");
  }
  return positional[0];
}

function parseArgs(argv: string[]): Args {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("a command is required after --");
  const values: Record<string, string> = {};
  for (let index = 0; index < separator; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs before --");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  const enabledAt = Number(values.enabledAt);
  if (!values.projectRepo || !values.githubRepo || !values.stateDir || !Number.isFinite(enabledAt)
    || !["issue", "pull-request"].includes(values.targetKind)) {
    throw new Error("--project-repo, --github-repo, --state-dir, --enabled-at, and --target-kind are required");
  }
  return {
    projectRepo: values.projectRepo,
    githubRepo: values.githubRepo,
    stateDir: values.stateDir,
    enabledAt,
    targetKind: values.targetKind as Args["targetKind"],
    command: argv.slice(separator + 1),
    ...(values.attemptRecord ? { attemptRecord: values.attemptRecord } : {}),
    ...(values.reviewClaim ? { reviewClaim: JSON.parse(values.reviewClaim) } : {}),
  };
}

function runGuarded(args: Args, spawn = spawnSync, loadSavedClaim: SavedClaimLoader = savedReviewClaimContract): number {
  const commandTarget = assertApprovedCommand(args.command, args.githubRepo);
  if (args.targetKind === "pull-request" && !args.attemptRecord) {
    throw new Error("saved attempt record is required before guarded PR mutation");
  }
  if (args.targetKind === "issue" && args.command[1] === "pr") {
    throw new Error("issue mutation authority cannot target a pull request command");
  }
  return withEnabledProjectLock(
    { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt },
    (enabled: { automationLogin?: string }, recheck: () => void) => {
      if (args.targetKind === "issue") {
        const issue = spawn("gh", ["api", `repos/${args.githubRepo}/issues/${commandTarget}`], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GUARDED_OPERATION_TIMEOUT_MS,
        });
        let liveIssue: Record<string, unknown> = {};
        try { liveIssue = JSON.parse(issue.stdout || "{}"); } catch { throw new Error("live GitHub issue target could not be verified"); }
        if (issue.status !== 0 || Number(liveIssue.number) !== Number(commandTarget) || liveIssue.pull_request) {
          throw new Error("issue mutation authority could not verify the exact non-PR issue target");
        }
      }
      if (args.targetKind === "pull-request") {
        const suppliedTarget = Number(commandTarget);
        const savedClaim = loadSavedClaim(args.attemptRecord!, args.reviewClaim, {
          stateDir: args.stateDir,
          githubRepo: args.githubRepo,
          targetNumber: suppliedTarget,
        });
        const number = String((savedClaim.binding as { targetNumber?: unknown })?.targetNumber || "");
        if (commandTarget !== number) {
          throw new Error("active review claim target does not match guarded PR mutation target");
        }
        const query = (queryArgs: string[]) => spawn("gh", queryArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GUARDED_OPERATION_TIMEOUT_MS });
        const authenticated = query(["api", "user", "--jq", ".login"]);
        const automationLogin = String(enabled.automationLogin || "").trim().toLowerCase();
        if (authenticated.status !== 0 || !automationLogin || String(authenticated.stdout || "").trim().toLowerCase() !== automationLogin) {
          throw new Error("current authenticated GitHub identity does not match enablement authority");
        }
        recheck();
        const repository = query(["repo", "view", args.githubRepo, "--json", "id,nameWithOwner"]);
        const pr = query(["pr", "view", commandTarget, "-R", args.githubRepo, "--json", "state,headRefOid,labels"]);
        const events = query(["api", "--paginate", "--slurp", `repos/${args.githubRepo}/issues/${commandTarget}/events`]);
        const comments = query(["api", "--paginate", "--slurp", `repos/${args.githubRepo}/issues/${commandTarget}/comments`]);
        const headers = query(["api", "--include", `repos/${args.githubRepo}`]);
        const identity = JSON.parse(repository.stdout || "{}");
        if ([repository, pr, events, comments, headers].some((result) => result.status !== 0)
          || !validateActiveReviewClaim(
            JSON.parse(pr.stdout || "{}"),
            parsePaginatedGithubJson(events.stdout),
            parsePaginatedGithubJson(comments.stdout),
            headers.stdout,
            { ...savedClaim, authorizedLogins: [automationLogin] },
            { repositoryId: String(identity.id || ""), repository: String(identity.nameWithOwner || ""), targetNumber: Number(commandTarget) },
          )) {
          throw new Error("active review claim could not be reauthorized before GitHub mutation");
        }
      }
      if (args.targetKind === "issue") recheck();
      const result = spawn(args.command[0], args.command.slice(1), {
        stdio: "inherit",
        timeout: GUARDED_OPERATION_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      if (result.error) throw result.error;
      return result.status ?? 1;
    },
  );
}

function main(): void {
  try {
    process.exitCode = runGuarded(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`guarded-operation.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();
module.exports = { GUARDED_OPERATION_TIMEOUT_MS, assertApprovedCommand, parseArgs, runGuarded };
