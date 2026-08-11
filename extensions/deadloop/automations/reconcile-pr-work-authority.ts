#!/usr/bin/env node

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { createCommandRunner, createHerdrRunnerFromCommandRunner, driverResult } = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { readAttemptRecord, releasePersistedAttemptAuthority, releasesAttemptOwnership } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { applyPrWorkAuthorityReconciliation, migrationDecision } = require("../../../src/pr-work-authority-reconciliation.ts");
const { activeReviewRequest, classifyActiveReviewClaim } = require("./pr-review-claim.ts");

type JsonObject = Record<string, any>;

function parseArgs(argv: string[]): JsonObject {
  const result: JsonObject = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    result[token.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = argv[++index] || "";
  }
  return result;
}

function labels(value: JsonObject): string[] {
  return (value.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label.name || "")).filter(Boolean);
}

function reconciledLabelReplacement(current: string[], next: string[], managedLabels: string[]): string[] {
  const managed = new Set(managedLabels);
  return [...new Set([
    ...current.filter((label) => !managed.has(label)),
    ...next.filter((label) => managed.has(label)),
  ])];
}

function loadAttempts(stateDir: string, projectId: string, repository: string): { valid: JsonObject[]; malformed: JsonObject[] } {
  const valid: JsonObject[] = [];
  const malformed: JsonObject[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(path.join(stateDir, "runs")); } catch { return { valid, malformed }; }
  for (const entry of entries) {
    const runDir = path.join(stateDir, "runs", entry);
    const file = path.join(runDir, "attempt.json");
    if (!fs.existsSync(file)) continue;
    try {
      const record = readAttemptRecord(runDir);
      if (record.project === projectId && record.repository === repository && !releasesAttemptOwnership(record.phase)) {
        valid.push({ ...record, runDir });
      }
    } catch {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (raw?.project === projectId && raw?.repository === repository && raw?.target?.kind === "pull-request") malformed.push(raw);
      } catch {}
    }
  }
  return { valid, malformed };
}

function writeJsonAtomically(file: string, value: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function recoveryReceiptPath(stateDir: string, repositoryId: string, number: number): string {
  return path.join(stateDir, "work-authority-reconciliation", `${repositoryId}-${number}.json`);
}

function closeReceiptPath(record: JsonObject): string {
  return path.join(record.runDir, "authority-release-started.json");
}

function validCloseReceipt(record: JsonObject): boolean {
  try {
    const receipt = JSON.parse(fs.readFileSync(closeReceiptPath(record), "utf8"));
    return receipt?.schemaVersion === 1 && receipt?.attemptId === record.attemptId
      && receipt?.workspaceId === record.workspaceId && receipt?.worktreePath === record.worktreePath;
  } catch { return false; }
}

function runtimeForAttempt(runner: any, record: JsonObject, projectRepo = ""): { kind: string } {
  const workspaces = runner.listWorkspaces();
  const agents = runner.listAgents();
  const matchingWorkspaces = workspaces.filter((workspace: JsonObject) => String(workspace.workspaceId || "") === String(record.workspaceId || "")
    && String(workspace.worktreePath || "") === String(record.worktreePath || ""));
  const matchingAgents = agents.filter((agent: JsonObject) => String(agent.name || "") === String(record.agentName || "")
    && String(agent.paneId || "") === String(record.rootPaneId || "")
    && String(agent.cwd || "") === String(record.worktreePath || ""));
  if (matchingWorkspaces.length === 0 && validCloseReceipt(record) && projectRepo) {
    const retained = runner.listWorktrees(projectRepo).some((worktree: JsonObject) => String(worktree.path || "") === String(record.worktreePath));
    const active = matchingAgents.some((agent: JsonObject) => String(agent.status || "").toLowerCase() === "working");
    return retained && !active ? { kind: "stopped_owned" } : { kind: "ambiguous" };
  }
  if (matchingWorkspaces.length !== 1 || matchingAgents.length > 1) return { kind: "ambiguous" };
  if (matchingAgents.length === 1 && String(matchingAgents[0].status || "").toLowerCase() === "working") {
    return { kind: "live_matching_owner" };
  }
  const foreignActive = agents.some((agent: JsonObject) => String(agent.paneId || "") === String(record.rootPaneId || "")
    && String(agent.status || "").toLowerCase() === "working");
  return foreignActive ? { kind: "ambiguous" } : { kind: "stopped_owned" };
}

async function reconcile(args: JsonObject, commandRunner = createCommandRunner()): Promise<JsonObject> {
  const enabledEnv = {
    repoPath: args.projectRepo,
    githubRepo: args.githubRepo,
    stateDir: args.stateDir,
    enabledAt: Number(args.enabledAt),
  };
  const guarded = <T>(operation: () => T): T => withEnabledDriverLock(enabledEnv, (_enabled: unknown, recheck: () => void) => {
    recheck();
    return operation();
  });
  const github = createGithubOperations(commandRunner);
  const requestLabels = [args.updateBranchLabel || "agent:update-branch", args.implementLabel || "agent:implement", args.reviewLabel || "agent:review"];
  const inProgressLabel = args.inProgressLabel || "agent:in-progress";
  const blockedLabel = args.blockedLabel || "agent:blocked";
  const automationLogin = String(commandRunner.runText(["gh", "api", "user", "--jq", ".login"])).trim().toLowerCase();
  if (!automationLogin || args.automationLogin && automationLogin !== String(args.automationLogin).trim().toLowerCase()) {
    throw new Error("authenticated GitHub identity does not match the enabled reconciliation identity");
  }
  const repositoryIdentity = github.getRepositoryIdentity(args.githubRepo);
  const attempts = loadAttempts(args.stateDir, args.projectId, args.githubRepo);
  const prs = github.listOpenPrs(args.githubRepo);
  const runner = createHerdrRunnerFromCommandRunner(commandRunner);
  const results: JsonObject[] = [];

  for (const pr of prs.filter((candidate: JsonObject) => labels(candidate).includes(inProgressLabel)
    || fs.existsSync(recoveryReceiptPath(args.stateDir, String(repositoryIdentity.id || ""), Number(candidate.number))))) {
    const number = Number(pr.number);
    const matching = attempts.valid.filter((attempt) => attempt.target?.kind === "pull-request" && Number(attempt.target.number) === number);
    const malformed = attempts.malformed.filter((attempt) => Number(attempt.target?.number) === number);
    const events = github.listPrTimelineEvents(args.githubRepo, number);
    const comments = github.listPrComments(args.githubRepo, number);
    let claim: { kind: string };
    let runtime: { kind: string };
    let record: JsonObject | undefined;

    if (malformed.length || matching.length > 1) {
      claim = { kind: "ambiguous" };
      runtime = { kind: "ambiguous" };
    } else if (matching.length === 0) {
      claim = { kind: "missing" };
      runtime = { kind: "ambiguous" };
    } else {
      record = matching[0];
      const latestRequest = activeReviewRequest(events, args.reviewLabel || "agent:review");
      if (!record.reviewClaim) claim = { kind: "missing" };
      else if (latestRequest && String(latestRequest.id || latestRequest.node_id || "") !== String(record.reviewClaim.binding?.requestEventId || "")) {
        claim = { kind: "superseded" };
      } else {
        const classified = classifyActiveReviewClaim(
          pr,
          events,
          comments,
          github.readRestResponseHeaders(args.githubRepo),
          record.reviewClaim,
          { repositoryId: String(repositoryIdentity.id || ""), repository: String(repositoryIdentity.nameWithOwner || ""), targetNumber: number },
        );
        claim = classified.kind === "claim_invalid" ? { kind: "malformed" }
          : classified.kind === "binding_mismatch" ? { kind: "ambiguous" }
            : classified;
      }
      try { runtime = runtimeForAttempt(runner, record, args.projectRepo); }
      catch { runtime = { kind: "unreachable" }; }
    }

    const input = { pr: { ...pr, labels: labels(pr) }, claim, runtime, requestLabels, inProgressLabel, blockedLabel, journalPhase: record?.phase };
    const recoveryFile = recoveryReceiptPath(args.stateDir, String(repositoryIdentity.id || ""), number);
    const result = await applyPrWorkAuthorityReconciliation(input, {
      automationLogin,
      recordBlockStarted: (started: JsonObject) => writeJsonAtomically(recoveryFile, {
        schemaVersion: 1, repository: args.githubRepo, repositoryId: String(repositoryIdentity.id || ""),
        prNumber: number, headRefOid: String(pr.headRefOid || ""), attemptId: record?.attemptId,
        ...started,
      }),
      completeBlock: record ? undefined : () => fs.rmSync(recoveryFile, { force: true }),
      listTimelineEvents: () => github.listPrTimelineEvents(args.githubRepo, number),
      listComments: () => github.listPrComments(args.githubRepo, number),
      replaceLabels: (next: string[]) => guarded(() => {
        const current = labels({ labels: github.listPrLabels(args.githubRepo, number) });
        const managed = [...requestLabels, inProgressLabel, blockedLabel];
        return github.replacePrLabels(args.githubRepo, number, reconciledLabelReplacement(current, next, managed));
      }),
      comment: (body: string) => guarded(() => github.createPrComment(args.githubRepo, number, body)),
      closeOwnedWorkspace: record && runtime.kind === "stopped_owned" ? () => guarded(() => {
        if (runtimeForAttempt(runner, record!, args.projectRepo).kind !== "stopped_owned") return false;
        writeJsonAtomically(closeReceiptPath(record!), {
          schemaVersion: 1, attemptId: record!.attemptId, workspaceId: record!.workspaceId,
          worktreePath: record!.worktreePath, startedAt: new Date().toISOString(),
        });
        const alreadyAbsent = !runner.listWorkspaces().some((workspace: JsonObject) => String(workspace.workspaceId || "") === String(record!.workspaceId));
        if (!alreadyAbsent) runner.closeWorkspace(record!.workspaceId);
        const absent = !runner.listWorkspaces().some((workspace: JsonObject) => String(workspace.workspaceId || "") === String(record!.workspaceId));
        const retained = runner.listWorktrees(args.projectRepo).some((worktree: JsonObject) => String(worktree.path || "") === String(record!.worktreePath));
        return absent && retained;
      }) : undefined,
      releaseLocalOwnership: record ? (cutoffEventId?: string) => {
        releasePersistedAttemptAuthority(record!.runDir, new Date().toISOString(), cutoffEventId);
        fs.rmSync(recoveryFile, { force: true });
      } : undefined,
    });
    results.push({ prNumber: number, ...result });
  }

  const migrationReceiptPath = path.join(args.stateDir, "github-state-migration-v1.json");
  let migrationDeployed = false;
  let migrationReceipt: JsonObject = {};
  try {
    migrationReceipt = JSON.parse(fs.readFileSync(migrationReceiptPath, "utf8"));
    migrationDeployed = migrationReceipt?.schemaVersion === 1
      && migrationReceipt?.repository === args.githubRepo
      && migrationReceipt?.repositoryId === String(repositoryIdentity.id || "")
      && migrationReceipt?.confirmation === "updated-hosts-stopped";
  } catch {}
  const completedMigrations = new Set((Array.isArray(migrationReceipt.completedPrs) ? migrationReceipt.completedPrs : []).map(Number));
  const migrations: JsonObject[] = [];
  for (const pr of prs) {
    const migration = migrationDecision({
      repository: args.githubRepo,
      number: Number(pr.number),
      deployed: migrationDeployed,
      conflicting: String(pr.mergeable || "").toUpperCase() === "CONFLICTING",
    });
    const currentMigrationLabels = labels(pr);
    if (migration.action !== "request" || completedMigrations.has(Number(pr.number))
      || !currentMigrationLabels.includes(blockedLabel) || currentMigrationLabels.includes(inProgressLabel)) continue;
    const retained = attempts.valid.filter((attempt) => attempt.target?.kind === "pull-request" && Number(attempt.target.number) === Number(pr.number));
    const malformed = attempts.malformed.filter((attempt) => Number(attempt.target?.number) === Number(pr.number));
    if (malformed.length) continue;
    let cleanupSafe = true;
    for (const record of retained) {
      let observed: { kind: string };
      try { observed = runtimeForAttempt(runner, record, args.projectRepo); } catch { observed = { kind: "unreachable" }; }
      if (observed.kind === "live_matching_owner" || observed.kind === "ambiguous" || observed.kind === "unreachable") {
        cleanupSafe = false;
        break;
      }
      const closed = guarded(() => {
        if (runtimeForAttempt(runner, record, args.projectRepo).kind !== "stopped_owned") return false;
        writeJsonAtomically(closeReceiptPath(record), {
          schemaVersion: 1, attemptId: record.attemptId, workspaceId: record.workspaceId,
          worktreePath: record.worktreePath, startedAt: new Date().toISOString(),
        });
        const alreadyAbsent = !runner.listWorkspaces().some((workspace: JsonObject) => String(workspace.workspaceId || "") === String(record.workspaceId));
        if (!alreadyAbsent) runner.closeWorkspace(record.workspaceId);
        const absent = !runner.listWorkspaces().some((workspace: JsonObject) => String(workspace.workspaceId || "") === String(record.workspaceId));
        const retainedWorktree = runner.listWorktrees(args.projectRepo).some((worktree: JsonObject) => String(worktree.path || "") === String(record.worktreePath));
        return absent && retainedWorktree;
      });
      if (!closed) { cleanupSafe = false; break; }
      releasePersistedAttemptAuthority(record.runDir, new Date().toISOString());
    }
    if (!cleanupSafe) continue;
    const migrated = guarded(() => {
      const livePr = github.getPr(args.githubRepo, pr.number);
      if (String(livePr.state || "").toUpperCase() !== "OPEN") return false;
      let requestLabel = migration.requestLabel;
      if (Number(pr.number) === 228) {
        const mergeable = String(livePr.mergeable || "").toUpperCase();
        if (mergeable === "UNKNOWN" || !mergeable) return false;
        requestLabel = mergeable === "CONFLICTING" ? args.updateBranchLabel || "agent:update-branch" : args.reviewLabel || "agent:review";
      }
      const current = labels({ labels: github.listPrLabels(args.githubRepo, pr.number) });
      if (!current.includes(blockedLabel) || current.includes(inProgressLabel)) return false;
      const managed = new Set([...requestLabels, inProgressLabel, blockedLabel]);
      const replacement = [...current.filter((label) => !managed.has(label)), requestLabel];
      github.replacePrLabels(args.githubRepo, pr.number, [...new Set(replacement)]);
      migration.requestLabel = requestLabel;
      return true;
    });
    if (!migrated) continue;
    completedMigrations.add(Number(pr.number));
    writeJsonAtomically(migrationReceiptPath, { ...migrationReceipt, completedPrs: [...completedMigrations].sort((left, right) => left - right) });
    migrations.push({ prNumber: Number(pr.number), requestLabel: migration.requestLabel });
  }
  return driverResult("done", `reconciled ${results.length} active PR work state(s)`, { driverAction: "pr_work_authority_reconciled", results, migrations });
}

async function main(): Promise<void> {
  try { process.stdout.write(`${JSON.stringify(await reconcile(parseArgs(process.argv.slice(2))))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "pr_work_authority_reconciliation_failed" }))}\n`); }
}

if (require.main === module) void main();
module.exports = { loadAttempts, reconcile, reconciledLabelReplacement, runtimeForAttempt };
