#!/usr/bin/env node
// Convert one repair promise plus the finalizer receipt into an idempotent
// public result. This handler never pushes or launches work.

const fs = require("node:fs") as typeof import("node:fs");
const { validatePromise } = require("./extract-worker-promise.ts");
const { publicText, renderRepairSuccessComment, repairResultCommentExists } = require("./pr-review-comments.ts");
const { createCommandRunner, driverResult } = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit";

function parseArgs(argv: string[]): JsonObject {
  const values: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const name of ["promise", "result", "contract", "githubRepo", "pr", "expectedHead", "attemptKey", "reviewingLabel", "blockedLabel"]) {
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
  const runner = createCommandRunner();
  const github = createGithubOperations(runner);
  const validation = validatePromise(String(args.promise));
  const receipt = readJson(String(args.result));
  const contract = readJson(String(args.contract));
  const pr = runner.runJson([
    "gh",
    "pr",
    "view",
    String(args.pr),
    "-R",
    String(args.githubRepo),
    "--json",
    "state,headRefOid,labels,comments",
  ]);
  const comments = (pr.comments || []) as JsonObject[];
  const labelNames = (pr.labels || []).map((label: JsonObject) => String(label.name || label));
  const needsHumanLabels = labelNames.includes(String(args.reviewingLabel)) || !labelNames.includes(String(args.blockedLabel));
  const stopMarker = `<!-- deadloop:review-repair-stop key=${String(args.attemptKey).toLowerCase()} -->`;

  const expectedHead = String(args.expectedHead).toLowerCase();
  const staleConfirmed =
    validation.status === "complete" &&
    validation.promise?.reason === "stale_head" &&
    receipt?.action === "stale_head" &&
    contract?.attemptKey === args.attemptKey &&
    String(contract?.expectedHead || "").toLowerCase() === expectedHead &&
    String(receipt.originalHeadOid || "").toLowerCase() === expectedHead &&
    String(pr.state || "").toUpperCase() === "OPEN" &&
    Boolean(pr.headRefOid) &&
    String(pr.headRefOid).toLowerCase() !== expectedHead;

  if (staleConfirmed) {
    return driverResult("done", `PR #${args.pr} repair became stale; no public success was posted`, { driverAction: "repair_stale_head" });
  }

  const receiptHead = String(receipt?.headOid || "").toLowerCase();
  const successful =
    validation.status === "complete" &&
    validation.promise?.reason === "repair_pushed" &&
    receipt?.action === "pushed" &&
    contract?.attemptKey === args.attemptKey &&
    String(contract?.expectedHead || "").toLowerCase() === String(args.expectedHead).toLowerCase() &&
    sameFindingTitles(validation.promise.repairs, contract?.findingTitles) &&
    String(pr.state || "").toUpperCase() === "OPEN" &&
    String(receipt.originalHeadOid || "").toLowerCase() === expectedHead &&
    /^[0-9a-f]{40}$/.test(receiptHead) &&
    receiptHead !== expectedHead &&
    receiptHead === String(pr.headRefOid || "").toLowerCase() &&
    JSON.stringify(validation.promise.checks) === JSON.stringify(receipt.checks);

  if (successful) {
    if (repairResultCommentExists(comments, String(args.attemptKey))) {
      return driverResult("done", `PR #${args.pr} repair result was already posted`, { driverAction: "repair_result_duplicate" });
    }
    const comment = renderRepairSuccessComment({
      attemptKey: args.attemptKey,
      originalHeadOid: args.expectedHead,
      newHeadOid: receipt.headOid,
      repairs: validation.promise.repairs,
      checks: receipt.checks,
    });
    github.commentPr(String(args.githubRepo), String(args.pr), comment);
    return driverResult("done", `PR #${args.pr} repair result posted`, { driverAction: "repair_result_posted", comment });
  }

  if (comments.some((comment) => String(comment?.body || "").includes(stopMarker))) {
    if (needsHumanLabels) {
      github.movePrLabels(String(args.githubRepo), String(args.pr), {
        remove: String(args.reviewingLabel),
        add: String(args.blockedLabel),
      });
    }
    return driverResult("done", `PR #${args.pr} repair stop was already posted`, { driverAction: "repair_stop_duplicate" });
  }
  const reason = validation.promise?.reason || validation.error || receipt?.reason || "inconclusive_repair_completion";
  const summary = validation.promise?.summary || "The finalizer receipt and structured repair report did not confirm the same successful push.";
  const comment = recoveryComment(args, reason, summary);
  github.commentPr(String(args.githubRepo), String(args.pr), comment);
  if (needsHumanLabels) {
    github.movePrLabels(String(args.githubRepo), String(args.pr), {
      remove: String(args.reviewingLabel),
      add: String(args.blockedLabel),
    });
  }
  return driverResult("done", `PR #${args.pr} repair requires human recovery`, { driverAction: "repair_human_blocked", comment });
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
