#!/usr/bin/env node
// Persist an attempt-bound marker only after the role's existing GitHub result is independently confirmed.
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { createCommandRunner, driverResult } = require("../../../src/automation-driver-kit.ts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { assertLocallyEnabled } = require("../../../src/enabled-operation.cjs");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { validatePromise } = require("./extract-worker-promise.ts");
const { parseAttemptPersistenceMarkers, renderAttemptPersistenceMarker } = require("../../../src/attempt-persistence-marker.cjs");
const { assertAttemptProjectBinding, assertWorktreeBelongsToProject, canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");
const {
  assertCurrentWorkerContract,
  assertWorkerCompletionAuthorized,
  readRequiredVerificationRecord,
  workerRequiredVerificationPath,
} = require("../../../src/worker-required-verification-runtime.cjs");

type JsonObject = Record<string, any>;
function parseArgs(argv: string[]) {
  const values: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) values[String(argv[index]).slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = argv[index + 1];
  for (const name of ["attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "enabledAt", "reviewLabel"]) if (!values[name]) throw new Error(`--${name} is required`);
  return values;
}
function labels(item: JsonObject) { return (item.labels || []).map((label: any) => typeof label === "string" ? label : String(label.name || "")); }
function workerPrIsPersisted(record: JsonObject, report: JsonObject, pr: JsonObject, reviewLabel: string): boolean {
  const closes = (pr.closingIssuesReferences || []).some((item: JsonObject) => Number(item.number) === record.target.number)
    || new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${record.target.number}\\b`, "i").test(String(pr.body || ""));
  return String(pr.headRefName) === record.branch
    && String(pr.headRefOid).toLowerCase() === String(report.result.outputRevision).toLowerCase()
    && String(pr.baseRefName) === String(record.baseBranch || "").replace(/^origin\//, "")
    && closes
    && labels(pr).includes(reviewLabel);
}
function runMarkerMutationBoundary(recheck: () => void, authorize: () => void, confirm: () => void, mutate: () => void): void {
  recheck();
  authorize();
  confirm();
  mutate();
}
function canonicalAttemptRunDir(args: JsonObject): { attemptRecord: string; runDir: string } {
  const { attemptRecord, runDir } = canonicalAttemptLocation(args);
  return { attemptRecord, runDir };
}
function persist(args: JsonObject) {
  const runner = createCommandRunner();
  runHerdrPreflight({ run: (command: string, commandArgs: string[]) => runner.runText([command, ...commandArgs]) });
  const { attemptRecord, runDir } = canonicalAttemptLocation(args);
  const record = readAttemptRecord(runDir);
  assertAttemptProjectBinding(record, args);
  const validation = validatePromise(record.promiseFile, attemptRecord);
  if (validation.evidenceStrength !== "strong") return driverResult("done", "strong report is required", { driverAction: "result_not_persisted" });
  const report = JSON.parse(fs.readFileSync(record.promiseFile, "utf8"));
  if (report.status !== "complete" || !["worker", "branch-update"].includes(record.role)) return driverResult("done", "role result is not marker-eligible", { driverAction: "result_not_persisted" });
  const authorizeWorker = () => {
    const enabled = assertLocallyEnabled({ repoPath: String(args.projectRepo), githubRepo: String(args.githubRepo), stateDir: String(args.stateDir), enabledAt: Number(args.enabledAt) });
    const configFile = process.env.DEADLOOP_CONFIG || path.join(String(args.stateDir), "projects.json");
    assertCurrentWorkerContract(record, String(args.projectRepo), configFile, enabled.githubRepositoryId);
    const verification = readRequiredVerificationRecord(workerRequiredVerificationPath(attemptRecord));
    const current = assertCurrentWorkerContract(record, String(args.projectRepo), configFile, enabled.githubRepositoryId);
    assertWorkerCompletionAuthorized(record, report, verification, current);
  };
  if (record.role === "worker") authorizeWorker();
  const project = { id: String(args.projectId), repoPath: path.resolve(String(args.projectRepo)), githubRepo: String(args.githubRepo), stateDir: path.resolve(String(args.stateDir)), enabledAt: Number(args.enabledAt) };
  return withEnabledDriverLock(project, (_enabled: unknown, recheck: () => void) => {
    let pr: JsonObject;
    if (record.role === "worker") {
      const prs = runner.runJson(["gh", "pr", "list", "-R", record.repository, "--state", "open", "--head", record.branch,
        "--json", "number,state,headRefName,headRefOid,baseRefName,body,labels,closingIssuesReferences,comments"]);
      if (!Array.isArray(prs) || prs.length !== 1) throw new Error("exactly one open Worker PR is required");
      pr = prs[0];
      if (!workerPrIsPersisted(record, report, pr, String(args.reviewLabel))) throw new Error("Worker GitHub result is not fully persisted");
    } else {
      pr = runner.runJson(["gh", "pr", "view", String(record.target.number), "-R", record.repository, "--json", "number,state,headRefName,headRefOid,comments"]);
      if (report.result.outcome === "stale_head") return driverResult("done", "stale head needs no success marker", { driverAction: "result_persisted" });
      if (String(pr.state).toUpperCase() !== "OPEN" || String(pr.headRefName) !== record.branch
        || String(pr.headRefOid).toLowerCase() !== String(report.result.outputRevision).toLowerCase()) throw new Error("branch-update GitHub head is not persisted");
    }
    const comments = pr.comments || [];
    if (parseAttemptPersistenceMarkers(comments).some((marker: JsonObject) => marker.attemptId === record.attemptId)) {
      return driverResult("done", "attempt result marker already exists", { driverAction: "result_persisted" });
    }
    const marker = renderAttemptPersistenceMarker(record, report, record.role === "branch-update"
      ? { pushRecorded: true, successClaimRecorded: true, validationPassed: true } : {});
    assertWorktreeBelongsToProject(runner, record, args);
    let alreadyPersisted = false;
    runMarkerMutationBoundary(
      recheck,
      record.role === "worker" ? authorizeWorker : () => {},
      () => {
        if (record.role === "worker") {
          const current = runner.runJson(["gh", "pr", "view", String(pr.number), "-R", record.repository,
            "--json", "number,state,headRefName,headRefOid,baseRefName,body,labels,closingIssuesReferences,comments"]);
          if (String(current.state).toUpperCase() !== "OPEN" || !workerPrIsPersisted(record, report, current, String(args.reviewLabel))) {
            throw new Error("Worker GitHub result changed at the success marker boundary");
          }
          alreadyPersisted = parseAttemptPersistenceMarkers(current.comments || []).some((entry: JsonObject) => entry.attemptId === record.attemptId);
        } else {
          const current = runner.runJson(["gh", "pr", "view", String(record.target.number), "-R", record.repository, "--json", "number,state,headRefName,headRefOid,comments"]);
          if (String(current.state).toUpperCase() !== "OPEN" || String(current.headRefName) !== record.branch
            || String(current.headRefOid).toLowerCase() !== String(report.result.outputRevision).toLowerCase()) {
            throw new Error("branch-update GitHub head changed at the success marker boundary");
          }
          alreadyPersisted = parseAttemptPersistenceMarkers(current.comments || []).some((entry: JsonObject) => entry.attemptId === record.attemptId);
        }
      },
      () => { if (!alreadyPersisted) runner.runText(["gh", "pr", "comment", String(pr.number), "-R", record.repository, "--body", marker]); },
    );
    return driverResult("done", alreadyPersisted ? "attempt result marker already exists" : "attempt result marker persisted", { driverAction: "result_persisted" });
  });
}
function main() { try { process.stdout.write(`${JSON.stringify(persist(parseArgs(process.argv.slice(2))))}\n`); } catch (error) { process.stdout.write(`${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`); } }
if (require.main === module) main();
module.exports = { canonicalAttemptRunDir, parseArgs, persist, runMarkerMutationBoundary, workerPrIsPersisted };
