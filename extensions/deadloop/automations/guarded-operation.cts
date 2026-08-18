#!/usr/bin/env node
// Run one monitor-side mutation while holding the enablement lock shared with
// /deadloop-disable. A disabled repository never starts the command.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");

const GUARDED_OPERATION_TIMEOUT_MS = MAX_GUARDED_OPERATION_MS;

type Args = {
  projectRepo: string;
  githubRepo: string;
  stateDir: string;
  enabledAt: number;
  targetKind: "issue" | "pull-request";
  command: string[];
  attemptRecord?: string;
  inProgressLabel?: string;
  blockedLabel?: string;
};

type ApprovedOperation = { positional: number; valueFlags: Set<string> };

const APPROVED_GH_OPERATIONS = new Map<string, ApprovedOperation>([
  ["issue edit", { positional: 1, valueFlags: new Set(["--add-label", "--remove-label"]) }],
  ["issue comment", { positional: 1, valueFlags: new Set(["--body", "--body-file"]) }],
  ["pr edit", { positional: 1, valueFlags: new Set(["--remove-label"]) }],
  ["pr comment", { positional: 1, valueFlags: new Set(["--body", "--body-file"]) }],
]);

function assertApprovedCommand(command: string[], githubRepo: string): string {
  if (!/(^|[/\\])gh(?:\.exe)?$/.test(command[0] || "")) {
    throw new Error("guarded-operation.cts accepts only approved gh mutations; use dedicated helpers for push or branch operations");
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
    ...(values.inProgressLabel ? { inProgressLabel: values.inProgressLabel } : {}),
    ...(values.blockedLabel ? { blockedLabel: values.blockedLabel } : {}),
  };
}

function runGuarded(
  args: Args,
  spawn = spawnSync,
): number {
  const commandTarget = assertApprovedCommand(args.command, args.githubRepo);
  if (args.targetKind === "pull-request" && !args.attemptRecord) {
    throw new Error("saved attempt record is required before guarded PR mutation");
  }
  if (args.targetKind === "pull-request" && (!args.inProgressLabel || !args.blockedLabel)) {
    throw new Error("configured in-progress and blocked labels are required before guarded PR mutation");
  }
  if (args.targetKind === "issue" && args.command[1] === "pr") {
    throw new Error("issue mutation authority cannot target a pull request command");
  }
  return withEnabledProjectLock(
    { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt },
    (enabled: { automationLogin?: string; githubRepositoryId?: string; githubRepo?: string }, recheck: () => void) => {
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
        const location = canonicalAttemptLocation({ stateDir: args.stateDir, attemptRecord: args.attemptRecord });
        const record = readAttemptRecord(location.runDir);
        if (record.repository !== args.githubRepo || record.target?.kind !== "pull-request"
          || Number(record.target?.number) !== suppliedTarget) {
          throw new Error("saved attempt target does not match guarded PR mutation target");
        }
        const query = (queryArgs: string[]) => spawn("gh", queryArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GUARDED_OPERATION_TIMEOUT_MS });
        const assertCurrentPrMutationBoundary = (): void => {
          const authenticated = query(["api", "user", "--jq", ".login"]);
          const automationLogin = String(enabled.automationLogin || "").trim().toLowerCase();
          if (authenticated.status !== 0 || !automationLogin || String(authenticated.stdout || "").trim().toLowerCase() !== automationLogin) {
            throw new Error("current authenticated GitHub identity does not match enablement authority");
          }

          const repository = query(["repo", "view", args.githubRepo, "--json", "id,nameWithOwner"]);
          let identity: Record<string, unknown> = {};
          try { identity = JSON.parse(repository.stdout || "{}"); }
          catch { throw new Error("live GitHub PR target could not be verified"); }
          if (repository.status !== 0 || String(identity.id || "") !== String(enabled.githubRepositoryId || "")
            || String(identity.nameWithOwner || "") !== String(enabled.githubRepo || "")) {
            throw new Error("guarded PR mutation target changed from the attempt revision");
          }

          const pr = query(["pr", "view", commandTarget, "-R", args.githubRepo, "--json", "state,headRefOid,labels"]);
          let livePr: Record<string, unknown> = {};
          try { livePr = JSON.parse(pr.stdout || "{}"); }
          catch { throw new Error("live GitHub PR target could not be verified"); }
          if (pr.status !== 0 || String(livePr.state || "").toUpperCase() !== "OPEN"
            || String(livePr.headRefOid || "").toLowerCase() !== String(record.inputRevision?.head || "").toLowerCase()) {
            throw new Error("guarded PR mutation target changed from the attempt revision");
          }
          const labels = new Set(Array.isArray(livePr.labels)
            ? livePr.labels.map((label) => typeof label === "string" ? label : String(label?.name || "")).filter(Boolean)
            : []);
          if (!labels.has(String(args.inProgressLabel)) || labels.has(String(args.blockedLabel))) {
            throw new Error("guarded PR mutation requires the current active workflow state");
          }
        };
        assertCurrentPrMutationBoundary();
        recheck();
        assertCurrentPrMutationBoundary();
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
    console.error(`guarded-operation.cts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();
module.exports = { GUARDED_OPERATION_TIMEOUT_MS, assertApprovedCommand, parseArgs, runGuarded };
