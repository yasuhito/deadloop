#!/usr/bin/env node
// Convert one repair promise plus the finalizer receipt into an idempotent
// public result. This handler never pushes or launches work.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { validatePromise } = require("./extract-worker-promise.ts");
const { publicText, renderRepairSuccessComment, repairResultCommentExists } = require("./pr-review-comments.ts");
const { createCommandRunner, driverResult } = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { runHerdrCompatibilityPreflight } = require("../../../src/herdr-preflight.cjs");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { assertAttemptProjectBinding, canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");
const { renderAttemptPersistenceMarker } = require("../../../src/attempt-persistence-marker.cjs");
const { readGithubRestResponseHeaders, validateActiveReviewClaim, validateRepairAuthorityTransition } = require("./pr-review-claim.ts");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit";

function parseArgs(argv: string[]): JsonObject {
  const values: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const name of ["promise", "attemptRecord", "projectId", "result", "contract", "projectRepo", "githubRepo", "stateDir", "enabledAt", "pr", "branch", "expectedHead", "attemptKey", "reviewLabel", "reviewingLabel", "inProgressLabel", "blockedLabel", "reviewClaim"]) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

function recoveryComment(args: JsonObject, reason: string, summary: string): string {
  return `## Automatic review repair stopped

- Review findings from: \`${String(args.expectedHead).toLowerCase()}\`
- Reason: ${publicText(reason, "The bounded repair could not safely complete.")}
- Detail: ${publicText(summary, "The bounded repair could not safely complete.")}

## Recovery steps
Inspect the current PR head and checks, correct the branch without rewriting published history, push a new commit, then remove \`${args.blockedLabel}\` so review can resume.

<!-- deadloop:review-repair-stop key=${String(args.attemptKey).toLowerCase()} -->`;
}

function readJson(filePath: string): JsonObject | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function sameFindingTitles(repairs: JsonObject[], findingTitles: unknown): boolean {
  if (!Array.isArray(findingTitles) || repairs.length !== findingTitles.length) return false;
  const actual = repairs.map((repair) => String(repair.title)).sort();
  const expected = findingTitles.map(String).sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function completion(args: JsonObject): DriverResult {
  let reviewClaim: JsonObject;
  try {
    reviewClaim = typeof args.reviewClaim === "string" ? JSON.parse(args.reviewClaim) : args.reviewClaim;
  } catch {
    throw new Error("active review claim must be valid JSON before repair completion");
  }
  if (!reviewClaim || typeof reviewClaim !== "object" || Array.isArray(reviewClaim)) {
    throw new Error("active review claim is required before repair completion");
  }
  const runner = createCommandRunner();
  runHerdrCompatibilityPreflight({ run: (command: string, commandArgs: string[]) => runner.runText([command, ...commandArgs]) });
  const location = canonicalAttemptLocation(args);
  const record = readAttemptRecord(location.runDir);
  assertAttemptProjectBinding(record, args);
  for (const [field, value, basename] of [
    ["promise", args.promise, "promise.json"],
    ["result", args.result, "finalizer-result.json"],
    ["contract", args.contract, "review-contract.json"],
  ] as const) {
    const expected = path.join(location.runDir, basename);
    const supplied = path.resolve(String(value));
    if (supplied !== expected || (fs.existsSync(supplied) && fs.realpathSync(supplied) !== expected)) {
      throw new Error(`${field} must be the canonical ${basename} in the attempt run directory`);
    }
  }
  if (record.role !== "review-repair" || record.target.kind !== "pull-request"
    || record.target.number !== Number(args.pr) || record.branch !== String(args.branch)
    || String(record.inputRevision.head).toLowerCase() !== String(args.expectedHead).toLowerCase()
    || record.attemptId !== String(args.attemptKey)) {
    throw new Error("attempt journal does not exactly bind the requested repair completion");
  }
  const validation = validatePromise(String(args.promise), location.attemptRecord);
  const receipt = readJson(String(args.result));
  const contract = readJson(String(args.contract));
  const expectedHead = String(args.expectedHead).toLowerCase();
  const receiptHead = String(receipt?.headOid || "").toLowerCase();
  const successfulReceipt =
    validation.status === "complete"
    && validation.promise?.reason === "repair_pushed"
    && receipt?.action === "pushed"
    && contract?.attemptKey === args.attemptKey
    && String(contract?.expectedHead || "").toLowerCase() === expectedHead
    && sameFindingTitles(validation.promise.repairs, contract?.findingTitles)
    && String(receipt.originalHeadOid || "").toLowerCase() === expectedHead
    && /^[0-9a-f]{40}$/.test(receiptHead)
    && receiptHead !== expectedHead
    && JSON.stringify(validation.promise.checks) === JSON.stringify(receipt.checks);
  const project = {
    repoPath: String(args.projectRepo),
    githubRepo: String(args.githubRepo),
    stateDir: String(args.stateDir),
    enabledAt: Number(args.enabledAt),
  };

  return withEnabledDriverLock(project, (_enabled: unknown, recheck: () => void) => {
    const automationLogin = successfulReceipt ? runner.runText(["gh", "api", "user", "--jq", ".login"]).trim() : "";
    if (successfulReceipt && !automationLogin) throw new Error("authenticated GitHub identity is unavailable");
    const pr = runner.runJson([
      "gh", "pr", "view", String(args.pr), "-R", String(args.githubRepo),
      "--json", "state,headRefName,headRefOid,isCrossRepository,labels,comments",
    ]);
    const liveHead = String(pr.headRefOid || "").toLowerCase();
    const labels = (pr.labels || []).map((label: JsonObject) => String(label.name || label));
    const targetOpen =
      String(pr.state || "").toUpperCase() === "OPEN"
      && !Boolean(pr.isCrossRepository)
      && String(pr.headRefName || "") === String(args.branch);
    if (!targetOpen) {
      return driverResult("done", `PR #${args.pr} changed before repair completion; left untouched`, { driverAction: "repair_target_changed" });
    }

    const staleConfirmed =
      validation.status === "complete"
      && validation.promise?.reason === "stale_head"
      && receipt?.action === "stale_head"
      && contract?.attemptKey === args.attemptKey
      && String(contract?.expectedHead || "").toLowerCase() === expectedHead
      && String(receipt.originalHeadOid || "").toLowerCase() === expectedHead
      && Boolean(liveHead)
      && liveHead !== expectedHead;
    if (staleConfirmed) {
      return driverResult("done", `PR #${args.pr} repair became stale; no public success was posted`, { driverAction: "repair_stale_head" });
    }

    const expectedLiveHead = receipt?.action === "pushed" ? receiptHead : expectedHead;
    const workflowActive =
      labels.includes(String(args.inProgressLabel))
      && labels.includes(String(args.reviewingLabel))
      && !labels.includes(String(args.blockedLabel));
    if (!workflowActive || !expectedLiveHead || liveHead !== expectedLiveHead) {
      return driverResult("done", `PR #${args.pr} repair completion was superseded; left untouched`, { driverAction: "repair_target_changed" });
    }

    const comments = (pr.comments || []) as JsonObject[];
    const observation = createGithubOperations(runner);
    const reauthorize = () => {
      const current = observation.getPr(String(args.githubRepo), String(args.pr));
      if (String(current.headRefOid || "").toLowerCase() !== liveHead) {
        throw new Error("active review claim could not be reauthorized before repair completion mutation");
      }
      const events = observation.listPrTimelineEvents(String(args.githubRepo), String(args.pr));
      const currentComments = observation.listPrComments(String(args.githubRepo), String(args.pr));
      const headers = readGithubRestResponseHeaders(runner, String(args.githubRepo));
      const authorized = liveHead === String(reviewClaim.binding?.revision || "").toLowerCase()
        ? validateActiveReviewClaim(current, events, currentComments, headers, reviewClaim)
        : successfulReceipt && validateRepairAuthorityTransition(current, events, currentComments, headers, reviewClaim, receipt || {});
      if (!authorized) throw new Error("active review claim could not be reauthorized before repair completion mutation");
    };
    reauthorize();
    const github = createGithubOperations(runner, () => { recheck(); reauthorize(); });

    if (successfulReceipt) {
      if (repairResultCommentExists(comments, String(args.attemptKey), receiptHead, automationLogin)) {
        github.movePrLabels(String(args.githubRepo), String(args.pr), {
          remove: [String(args.inProgressLabel), String(args.reviewingLabel)], add: String(args.reviewLabel),
        });
        return driverResult("done", `PR #${args.pr} repair result was already posted; re-review is pending`, { driverAction: "repair_result_duplicate" });
      }
      const marker = renderAttemptPersistenceMarker(
        record,
        JSON.parse(fs.readFileSync(String(args.promise), "utf8")),
        { pushRecorded: true, successClaimRecorded: true, validationPassed: true },
      );
      const comment = `${renderRepairSuccessComment({
        attemptKey: args.attemptKey,
        originalHeadOid: args.expectedHead,
        newHeadOid: receipt.headOid,
        repairs: validation.promise.repairs,
        checks: receipt.checks,
      })}${marker ? `\n${marker}` : ""}`;
      github.commentPr(String(args.githubRepo), String(args.pr), comment);
      github.movePrLabels(String(args.githubRepo), String(args.pr), {
        remove: [String(args.inProgressLabel), String(args.reviewingLabel)], add: String(args.reviewLabel),
      });
      return driverResult("done", `PR #${args.pr} repair result posted; re-review is pending`, { driverAction: "repair_result_posted", comment });
    }

    const stopMarker = `<!-- deadloop:review-repair-stop key=${String(args.attemptKey).toLowerCase()} -->`;
    if (comments.some((comment) => String(comment?.body || "").includes(stopMarker))) {
      github.movePrLabels(String(args.githubRepo), String(args.pr), {
        remove: [String(args.inProgressLabel), String(args.reviewingLabel)],
        add: [String(args.reviewLabel), String(args.blockedLabel)],
      });
      return driverResult("done", `PR #${args.pr} repair stop was already posted`, { driverAction: "repair_stop_duplicate" });
    }
    const reason = validation.promise?.reason || validation.error || receipt?.reason || "inconclusive_repair_completion";
    const summary = validation.promise?.summary || "The finalizer receipt and structured repair report did not confirm the same successful push.";
    const comment = recoveryComment(args, reason, summary);
    github.commentPr(String(args.githubRepo), String(args.pr), comment);
    github.movePrLabels(String(args.githubRepo), String(args.pr), {
      remove: [String(args.inProgressLabel), String(args.reviewingLabel)],
      add: [String(args.reviewLabel), String(args.blockedLabel)],
    });
    return driverResult("done", `PR #${args.pr} repair requires human recovery`, { driverAction: "repair_human_blocked", comment });
  });
}

function main(): void {
  try {
    process.stdout.write(`${JSON.stringify(completion(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`,
    );
  }
}

if (require.main === module) main();

module.exports = { completion, parseArgs, readJson, recoveryComment, sameFindingTitles };
