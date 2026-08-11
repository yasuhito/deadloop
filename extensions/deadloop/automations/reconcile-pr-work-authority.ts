#!/usr/bin/env node

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { createCommandRunner, createHerdrRunnerFromCommandRunner, driverResult } = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { readAttemptRecord, releasePersistedAttemptAuthority, releasesAttemptOwnership } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { applyPrWorkAuthorityReconciliation, migrationDecision } = require("../../../src/pr-work-authority-reconciliation.ts");
const { classifyActiveReviewClaim, classifyReviewClaimTimeStatus, parseReviewClaim } = require("./pr-review-claim.ts");

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

function moveReconciledLabels(github: any, repository: string, number: number, current: string[], next: string[], managedLabels: string[]): string[] {
  const desired = reconciledLabelReplacement(current, next, managedLabels);
  const remove = current.filter((label) => !desired.includes(label));
  const add = desired.filter((label) => !current.includes(label));
  github.movePrLabels(repository, number, { remove, add });
  const observed = labels({ labels: github.listPrLabels(repository, number) });
  if (add.some((label) => !observed.includes(label))
    || remove.some((label) => observed.includes(label))) throw new Error("PR label recovery postcondition was not reached");
  return observed;
}

function claimCommentSnapshot(comments: JsonObject[]): string[] {
  return comments.filter((comment) => parseReviewClaim(comment.body) !== null)
    .map((comment) => JSON.stringify([comment.id || comment.databaseId, comment.created_at || comment.createdAt, comment.updated_at || comment.updatedAt, comment.body])).sort();
}

function revalidatedMissingRecordClaimKind(expectedClaimKind: string, initialComments: JsonObject[], liveComments: JsonObject[]): string {
  return JSON.stringify(claimCommentSnapshot(liveComments)) === JSON.stringify(claimCommentSnapshot(initialComments))
    ? expectedClaimKind : "ambiguous";
}

function loadAttempts(stateDir: string, projectId: string, repository: string): { valid: JsonObject[]; released: JsonObject[]; malformed: JsonObject[] } {
  const valid: JsonObject[] = [];
  const released: JsonObject[] = [];
  const malformed: JsonObject[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(path.join(stateDir, "runs")); } catch { return { valid, released, malformed }; }
  for (const entry of entries) {
    const runDir = path.join(stateDir, "runs", entry);
    const file = path.join(runDir, "attempt.json");
    if (!fs.existsSync(file)) continue;
    try {
      const record = readAttemptRecord(runDir);
      if (record.project === projectId && record.repository === repository) {
        const entry = { ...record, runDir };
        if (releasesAttemptOwnership(record.phase)) released.push(entry);
        else valid.push(entry);
      }
    } catch {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (raw?.project === projectId && raw?.repository === repository && raw?.target?.kind === "pull-request") malformed.push(raw);
      } catch {}
    }
  }
  return { valid, released, malformed };
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

function latestConfiguredRequest(events: JsonObject[], currentLabels: string[], requestLabels: string[]): JsonObject | null {
  const queued = new Set(currentLabels.filter((label) => requestLabels.includes(label)));
  return events.filter((event) => String(event.event || "").toLowerCase() === "labeled"
    && queued.has(String(event.label?.name || ""))
    && String(event.id || event.node_id || ""))
    .sort((left, right) => {
      const time = Date.parse(String(left.created_at || left.createdAt || "")) - Date.parse(String(right.created_at || right.createdAt || ""));
      return time || String(left.id || left.node_id).localeCompare(String(right.id || right.node_id), undefined, { numeric: true });
    }).at(-1) || null;
}

function canonicalPath(value: unknown): string {
  const resolved = path.resolve(String(value || ""));
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function canonicalPathContains(root: unknown, candidate: unknown): boolean {
  const canonicalRoot = canonicalPath(root);
  const canonicalCandidate = canonicalPath(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function runtimeForAttempt(runner: any, record: JsonObject, projectRepo = ""): { kind: string } {
  const workspaces = runner.listWorkspaces();
  const agents = runner.listAgents();
  const checkoutWorkspaces = workspaces.filter((workspace: JsonObject) => canonicalPath(workspace.worktreePath) === canonicalPath(record.worktreePath));
  const matchingWorkspaces = checkoutWorkspaces.filter((workspace: JsonObject) => String(workspace.workspaceId || "") === String(record.workspaceId || ""));
  const checkoutAgents = agents.filter((agent: JsonObject) => canonicalPathContains(record.worktreePath, agent.cwd));
  const relatedAgents = agents.filter((agent: JsonObject) => String(agent.name || "") === String(record.agentName || "")
    || String(agent.paneId || "") === String(record.rootPaneId || "")
    || canonicalPathContains(record.worktreePath, agent.cwd));
  const matchingAgents = relatedAgents.filter((agent: JsonObject) => String(agent.name || "") === String(record.agentName || "")
    && String(agent.paneId || "") === String(record.rootPaneId || "")
    && canonicalPathContains(record.worktreePath, agent.cwd));
  if (matchingWorkspaces.length === 0 && validCloseReceipt(record) && projectRepo) {
    const retained = runner.listWorktrees(projectRepo).some((worktree: JsonObject) => canonicalPath(worktree.path) === canonicalPath(record.worktreePath));
    return retained && checkoutWorkspaces.length === 0 && relatedAgents.length === 0 && checkoutAgents.length === 0 ? { kind: "stopped_owned" } : { kind: "ambiguous" };
  }
  if (matchingWorkspaces.length !== 1 || checkoutWorkspaces.length !== 1
    || Number(matchingWorkspaces[0].tabCount) !== 1 || Number(matchingWorkspaces[0].paneCount) !== 1
    || matchingAgents.length > 1 || relatedAgents.length !== matchingAgents.length
    || checkoutAgents.length !== matchingAgents.length) return { kind: "ambiguous" };
  if (matchingAgents.length === 1) {
    const status = String(matchingAgents[0].status || "").toLowerCase();
    if (status === "working") return { kind: "live_matching_owner" };
    if (!["done", "idle", "failed", "stopped"].includes(status)) return { kind: "ambiguous" };
  }
  return { kind: "stopped_owned" };
}

function classifyClaim(
  pr: JsonObject,
  events: JsonObject[],
  comments: JsonObject[],
  restHeaders: string,
  record: JsonObject,
  requestLabels: string[],
  repositoryIdentity: JsonObject,
  repository: string,
): { claim: { kind: string }; requestEventId: string } {
  const request = latestConfiguredRequest(events, labels(pr), requestLabels);
  const requestEventId = String(request?.id || request?.node_id || "");
  if (!record.reviewClaim) return { claim: { kind: "missing" }, requestEventId };
  const target = { repositoryId: String(repositoryIdentity.id || ""), repository: String(repositoryIdentity.nameWithOwner || repository), targetNumber: Number(pr.number) };
  const timeStatus = classifyReviewClaimTimeStatus(pr, events, comments, restHeaders, record.reviewClaim, target);
  if (timeStatus.kind !== "authorized") {
    return {
      claim: timeStatus.kind === "claim_invalid" ? { kind: "malformed" }
        : timeStatus.kind === "binding_mismatch" ? { kind: "ambiguous" }
          : timeStatus,
      requestEventId,
    };
  }
  if (requestEventId && requestEventId !== String(record.reviewClaim.binding?.requestEventId || "")) {
    return { claim: { kind: "superseded" }, requestEventId };
  }
  const classified = classifyActiveReviewClaim(
    pr,
    events,
    comments,
    restHeaders,
    record.reviewClaim,
    target,
  );
  return {
    claim: classified.kind === "claim_invalid" ? { kind: "malformed" }
      : classified.kind === "binding_mismatch" ? { kind: "ambiguous" }
        : classified,
    requestEventId,
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function reconciliationAuthorityMatches(expected: JsonObject, observed: JsonObject): boolean {
  return String(observed.state || "").toUpperCase() === "OPEN"
    && String(observed.headRefOid || "").toLowerCase() === String(expected.headRefOid || "").toLowerCase()
    && observed.claimKind === expected.claimKind
    && observed.requestEventId === expected.requestEventId
    && sameStringSet(observed.managedLabels || [], expected.managedLabels || []);
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
    const recoveryFile = recoveryReceiptPath(args.stateDir, String(repositoryIdentity.id || ""), number);
    const matching = attempts.valid.filter((attempt) => attempt.target?.kind === "pull-request" && Number(attempt.target.number) === number);
    if (matching.length === 0 && fs.existsSync(recoveryFile)) {
      try {
        const receipt = JSON.parse(fs.readFileSync(recoveryFile, "utf8"));
        const released = attempts.released.find((attempt) => attempt.attemptId === receipt.attemptId && attempt.phase === "authority_released");
        if (receipt.action === "authority_release_started" && released) {
          fs.rmSync(recoveryFile, { force: true });
          continue;
        }
      } catch {}
    }
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
      claim = classifyClaim(
        { ...pr, labels: labels(pr) }, events, comments, github.readRestResponseHeaders(args.githubRepo),
        record, requestLabels, repositoryIdentity, args.githubRepo,
      ).claim;
      try { runtime = runtimeForAttempt(runner, record, args.projectRepo); }
      catch { runtime = { kind: "unreachable" }; }
    }

    const input = { pr: { ...pr, labels: labels(pr) }, claim, runtime, requestLabels, inProgressLabel, blockedLabel, journalPhase: record?.phase };
    const initialRequest = latestConfiguredRequest(events, labels(input.pr), requestLabels);
    let expectedRequestEventId = record ? classifyClaim(
      input.pr, events, comments, github.readRestResponseHeaders(args.githubRepo),
      record, requestLabels, repositoryIdentity, args.githubRepo,
    ).requestEventId : String(initialRequest?.id || initialRequest?.node_id || "");
    const managed = [...requestLabels, inProgressLabel, blockedLabel];
    const revalidate = (expectedManagedLabels: string[], expectedClaimKind: string): string[] => {
      const livePr = github.getPr(args.githubRepo, number);
      const liveLabels = labels({ labels: github.listPrLabels(args.githubRepo, number) });
      const liveEvents = github.listPrTimelineEvents(args.githubRepo, number);
      const liveComments = github.listPrComments(args.githubRepo, number);
      const liveRequest = latestConfiguredRequest(liveEvents, liveLabels, requestLabels);
      const observed = record ? classifyClaim(
        { ...livePr, labels: liveLabels }, liveEvents, liveComments, github.readRestResponseHeaders(args.githubRepo),
        record, requestLabels, repositoryIdentity, args.githubRepo,
      ) : {
        claim: {
          kind: revalidatedMissingRecordClaimKind(expectedClaimKind, comments, liveComments),
        },
        requestEventId: String(liveRequest?.id || liveRequest?.node_id || ""),
      };
      if (!reconciliationAuthorityMatches({
        state: "OPEN", headRefOid: pr.headRefOid, claimKind: expectedClaimKind,
        requestEventId: expectedRequestEventId,
        managedLabels: expectedManagedLabels.filter((label) => managed.includes(label)),
      }, {
        state: livePr.state, headRefOid: livePr.headRefOid, claimKind: observed.claim.kind,
        requestEventId: observed.requestEventId,
        managedLabels: liveLabels.filter((label) => managed.includes(label)),
      })) throw new Error("PR work authority changed before recovery mutation");
      return liveLabels;
    };
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
        const current = revalidate(input.pr.labels, claim.kind);
        input.pr.labels = moveReconciledLabels(github, args.githubRepo, number, current, next, managed);
        if (record && claim.kind !== "malformed" && claim.kind !== "superseded") claim = { kind: "ambiguous" };
        if (!next.some((label) => requestLabels.includes(label))) expectedRequestEventId = "";
      }),
      comment: (body: string) => guarded(() => {
        revalidate(input.pr.labels, claim.kind);
        return github.createPrComment(args.githubRepo, number, body);
      }),
      recordReleaseStarted: record ? () => writeJsonAtomically(recoveryFile, {
        schemaVersion: 1, action: "authority_release_started", repository: args.githubRepo,
        repositoryId: String(repositoryIdentity.id || ""), prNumber: number,
        headRefOid: String(pr.headRefOid || ""), attemptId: record!.attemptId,
        requestEventId: expectedRequestEventId,
      }) : undefined,
      closeOwnedWorkspace: record && runtime.kind === "stopped_owned" ? () => guarded(() => {
        if (runtimeForAttempt(runner, record!, args.projectRepo).kind !== "stopped_owned") return false;
        writeJsonAtomically(closeReceiptPath(record!), {
          schemaVersion: 1, attemptId: record!.attemptId, workspaceId: record!.workspaceId,
          worktreePath: record!.worktreePath, startedAt: new Date().toISOString(),
        });
        const alreadyAbsent = !runner.listWorkspaces().some((workspace: JsonObject) => String(workspace.workspaceId || "") === String(record!.workspaceId));
        if (!alreadyAbsent) runner.closeWorkspace(record!.workspaceId);
        return runtimeForAttempt(runner, record!, args.projectRepo).kind === "stopped_owned";
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
        return runtimeForAttempt(runner, record, args.projectRepo).kind === "stopped_owned";
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
module.exports = {
  claimCommentSnapshot,
  classifyClaim,
  latestConfiguredRequest,
  loadAttempts,
  moveReconciledLabels,
  reconcile,
  reconciledLabelReplacement,
  reconciliationAuthorityMatches,
  revalidatedMissingRecordClaimKind,
  runtimeForAttempt,
};
