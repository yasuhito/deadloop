#!/usr/bin/env node
// Deterministic decisions for pr-reviewer automation. CommonJS-shaped so the
// script can run directly with `node pr-reviewer-decisions.cts` in this package.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { readAttemptRecord, releasesAttemptOwnership } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { parseAttemptPersistenceMarkers } = require("../../../src/attempt-persistence-marker.cjs");
const { selectPrRequest } = require("../../../src/pr-request-selection.cts");

type AnyRecord = Record<string, any>;

type ReviewDecisionConfig = {
  reviewLabel: string;
  implementLabel: string;
  updateBranchLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
  autoMerge: boolean;
  externalReviewEnabled: boolean;
  externalReviewWaitSeconds: number;
  projectId: string;
  automationLogin: string;
  servedRoles: string[];
  defersBlockedRecovery: boolean;
  now: Date;
};

const PENDING_CHECK_STATES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING"]);
const EXTERNAL_REVIEW_MARKER_RE = /<!--\s*deadloop:external-review-request\s+head=([0-9a-fA-F]+)\s*-->/g;
const REPAIR_RESULT_MARKER_RE = /<!--\s*deadloop:review-repair-result\s+key=[0-9a-fA-F]+\s+head=([0-9a-fA-F]{40})\s*-->/g;

function defaultDecisionConfig(overrides: Partial<ReviewDecisionConfig> = {}): ReviewDecisionConfig {
  return {
    reviewLabel: "agent:review",
    implementLabel: "agent:implement",
    updateBranchLabel: "agent:update-branch",
    inProgressLabel: "agent:in-progress",
    blockedLabel: "agent:blocked",
    autoMerge: false,
    externalReviewEnabled: false,
    externalReviewWaitSeconds: 1800,
    projectId: "",
    automationLogin: "",
    // A `review-repair` request relaunches the stopped repair contract its published evidence
    // names; the launcher refuses it when no such contract can be proven instead of guessing a
    // new one, and never falls back to the review request queued behind it.
    servedRoles: ["branch-update", "review-repair", "reviewer"],
    // Whether a request post-dates the block that stopped a pull request is a timeline question.
    // A caller that reads labels only cannot answer it, so it sets this and leaves a blocked pull
    // request carrying a request to the caller that can. A gate must never skip work its authority
    // would take.
    defersBlockedRecovery: false,
    now: new Date(),
    ...overrides,
  };
}

function parseTimeForPrReviewer(value: unknown): Date | null {
  if (!value) return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ageSecondsForPrReviewer(value: unknown, now: Date): number | null {
  const parsed = parseTimeForPrReviewer(value);
  if (!parsed) return null;
  return (now.getTime() - parsed.getTime()) / 1000;
}

function labelNamesForPrReviewer(pr: AnyRecord): Set<string> {
  return new Set((pr.labels || []).filter((label: unknown) => label && typeof label === "object").map((label: AnyRecord) => String(label.name || "")));
}

function reviewRequestLoginForPrReviewer(request: AnyRecord): string {
  if (request.login) return String(request.login).toLowerCase();
  const nested = request.requestedReviewer;
  if (nested && typeof nested === "object") return String(nested.login || "").toLowerCase();
  return "";
}

function hasCopilotReviewRequest(pr: AnyRecord): boolean {
  return (pr.reviewRequests || []).some(
    (request: unknown) => request && typeof request === "object" && reviewRequestLoginForPrReviewer(request as AnyRecord).includes("copilot"),
  );
}

function hasPendingChecks(pr: AnyRecord): boolean {
  return (pr.statusCheckRollup || []).some((check: unknown) => {
    if (!check || typeof check !== "object") return false;
    const record = check as AnyRecord;
    const state = String(record.status || record.state || "").toUpperCase();
    return PENDING_CHECK_STATES.has(state);
  });
}

function hasCoderabbitProcessingComment(pr: AnyRecord): boolean {
  return (pr.comments || []).some((comment: unknown) => {
    if (!comment || typeof comment !== "object") return false;
    const record = comment as AnyRecord;
    const author = record.author && typeof record.author === "object" ? record.author : {};
    if (String(author.login || "").toLowerCase() !== "coderabbitai") return false;
    const body = String(record.body || "").toLowerCase();
    return body.includes("currently processing") || body.includes("review in progress");
  });
}

function matchingMarkerAges(pr: AnyRecord, now: Date): number[] {
  const head = String(pr.headRefOid || "");
  const ages: number[] = [];
  for (const comment of pr.comments || []) {
    if (!comment || typeof comment !== "object") continue;
    const record = comment as AnyRecord;
    const body = String(record.body || "");
    EXTERNAL_REVIEW_MARKER_RE.lastIndex = 0;
    for (let match = EXTERNAL_REVIEW_MARKER_RE.exec(body); match; match = EXTERNAL_REVIEW_MARKER_RE.exec(body)) {
      if (head && match[1] !== head) continue;
      const age = ageSecondsForPrReviewer(record.createdAt, now);
      if (age !== null) ages.push(age);
    }
  }
  return ages;
}

function repairResultHeads(pr: AnyRecord, automationLogin: string): Set<string> {
  const expectedAuthor = automationLogin.toLowerCase();
  const heads = new Set<string>();
  if (!expectedAuthor) return heads;
  for (const comment of pr.comments || []) {
    if (!comment || typeof comment !== "object") continue;
    const record = comment as AnyRecord;
    if (String(record.author?.login || "").toLowerCase() !== expectedAuthor) continue;
    REPAIR_RESULT_MARKER_RE.lastIndex = 0;
    for (const match of String(record.body || "").matchAll(REPAIR_RESULT_MARKER_RE)) heads.add(match[1].toLowerCase());
  }
  return heads;
}

function hasRepairRereviewProvenance(pr: AnyRecord, automationLogin: string): boolean {
  const expectedAuthor = automationLogin.toLowerCase();
  const repairedHeads = repairResultHeads(pr, automationLogin);
  const currentHead = String(pr.headRefOid || "").toLowerCase();
  if (!expectedAuthor || !currentHead || repairedHeads.size === 0) return false;
  if (repairedHeads.has(currentHead)) return true;
  return (pr.comments || []).some((comment: unknown) => {
    if (!comment || typeof comment !== "object") return false;
    const record = comment as AnyRecord;
    if (String(record.author?.login || "").toLowerCase() !== expectedAuthor) return false;
    return parseAttemptPersistenceMarkers([record]).some((marker: AnyRecord) =>
      marker.role === "branch-update"
      && marker.outcome === "branch_update_pushed"
      && repairedHeads.has(String(marker.inputRevision?.head || "").toLowerCase())
      && String(marker.outputRevision || "").toLowerCase() === currentHead
      && marker.pushRecorded === true
      && marker.successClaimRecorded === true
      && marker.validationPassed === true);
  });
}

function externalReviewWaitIsStale(pr: AnyRecord, config: ReviewDecisionConfig): boolean {
  const markerAges = matchingMarkerAges(pr, config.now);
  if (markerAges.length) return Math.min(...markerAges) >= config.externalReviewWaitSeconds;
  const updatedAge = ageSecondsForPrReviewer(pr.updatedAt, config.now);
  return updatedAge !== null && updatedAge >= config.externalReviewWaitSeconds;
}

function externalReviewGate(pr: AnyRecord, config: ReviewDecisionConfig = defaultDecisionConfig()): AnyRecord {
  const markerAges = matchingMarkerAges(pr, config.now);
  if (markerAges.length) {
    const age = Math.min(...markerAges);
    if (age >= config.externalReviewWaitSeconds) {
      return { action: "fallback_review", reason: "stale_marker", waitedSeconds: Math.floor(age) };
    }
    return {
      action: "wait_external_review",
      reason: "fresh_marker",
      remainingSeconds: Math.ceil(config.externalReviewWaitSeconds - age),
    };
  }

  if (hasCopilotReviewRequest(pr)) {
    const age = ageSecondsForPrReviewer(pr.updatedAt, config.now);
    if (age !== null && age >= config.externalReviewWaitSeconds) {
      return { action: "fallback_review", reason: "stale_review_request", waitedSeconds: Math.floor(age) };
    }
    return { action: "wait_external_review", reason: "fresh_review_request" };
  }

  return { action: "request_external_review", reason: "missing_marker" };
}

function prNumberForPrReviewer(pr: AnyRecord): number {
  const number = Number(pr.number);
  return Number.isFinite(number) ? number : 0;
}

function attemptJournalsForPrReviewer(stateDir: string): AnyRecord[] {
  const runsRoot = path.join(stateDir, "runs");
  let entries: string[];
  try { entries = fs.readdirSync(runsRoot); } catch { return []; }
  const attempts: AnyRecord[] = [];
  for (const entry of entries) {
    const file = path.join(runsRoot, entry, "attempt.json");
    if (!fs.existsSync(file)) continue;
    try { attempts.push(readAttemptRecord(path.dirname(file)) as AnyRecord); }
    catch (error) { throw new Error(`cannot safely classify live PR ownership because ${file} is malformed`, { cause: error }); }
  }
  return attempts;
}

function workingReviewerPrNumbers(
  _agents: unknown,
  projectId: string,
  attempts: AnyRecord[] = [],
  githubRepo = "",
): Set<number> {
  if (!projectId) return new Set();
  const owned = new Set<number>();
  for (const attempt of attempts) {
    if (attempt.project !== projectId || (githubRepo && attempt.repository !== githubRepo)) continue;
    if (!["reviewer", "review-repair", "branch-update"].includes(String(attempt.role || ""))) continue;
    if (attempt.target?.kind !== "pull-request" || !Number.isInteger(attempt.target?.number)) continue;
    if (releasesAttemptOwnership(attempt.phase)) continue;
    owned.add(Number(attempt.target.number));
  }
  return owned;
}

function skipForPrReviewer(reason: string, pr: AnyRecord): AnyRecord {
  return { number: pr.number, reason };
}

const REQUEST_ROLE_ACTIONS: Record<string, string> = {
  "branch-update": "branch_update",
  "review-repair": "review_repair",
  reviewer: "review",
};

function requestLabelsOf(config: ReviewDecisionConfig): AnyRecord {
  return { updateBranch: config.updateBranchLabel, implement: config.implementLabel, review: config.reviewLabel };
}

/**
 * Picks the one pending Agent request to consume next. Lowest PR number first,
 * and inside a pull request the fixed request order. Only the review role waits
 * for CI and external review: a conflicted head and an unrepaired head are both
 * states no check result can make reviewable.
 */
function selectPrRequestTarget(
  prs: AnyRecord[],
  config: ReviewDecisionConfig = defaultDecisionConfig(),
  workingReviewerPrs: Set<number> = new Set(),
): AnyRecord {
  const skipped: AnyRecord[] = [];

  for (const pr of [...prs].sort((left, right) => prNumberForPrReviewer(left) - prNumberForPrReviewer(right))) {
    const labels = labelNamesForPrReviewer(pr);
    const request = selectPrRequest(labels, requestLabelsOf(config));
    if (!request) {
      skipped.push(skipForPrReviewer("missing_candidate_label", pr));
      continue;
    }
    if (labels.has(config.blockedLabel) && !config.defersBlockedRecovery) {
      skipped.push(skipForPrReviewer("blocked", pr));
      continue;
    }
    if (!config.servedRoles.includes(request.role)) {
      skipped.push(skipForPrReviewer("unserved_request", pr));
      continue;
    }
    const hasInProgressLabel = labels.has(config.inProgressLabel);
    // A retained journal suppresses work only while GitHub still exposes its
    // active claim. An ordinary queued request without that claim stays eligible.
    if (hasInProgressLabel && workingReviewerPrs.has(prNumberForPrReviewer(pr))) {
      skipped.push(skipForPrReviewer("reviewer_working", pr));
      continue;
    }
    const selection = {
      selected: true,
      number: pr.number,
      role: request.role,
      requestLabel: request.label,
      action: REQUEST_ROLE_ACTIONS[request.role],
      skipped,
    };
    if (request.role !== "reviewer") {
      return { ...selection, reason: hasInProgressLabel ? "stale_reclaim" : "selectable", staleReclaim: hasInProgressLabel };
    }
    // What a re-review answers is written on the pull request: a repair result deadloop published
    // for this exact head. Local attempt journals take no part in the launch decision (ADR 0020).
    const repairRereview = hasRepairRereviewProvenance(pr, config.automationLogin);
    const staleReclaim = hasInProgressLabel && !repairRereview;
    if (config.externalReviewEnabled && hasCopilotReviewRequest(pr) && !externalReviewWaitIsStale(pr, config)) {
      skipped.push(skipForPrReviewer("external_review_wait", pr));
      continue;
    }
    if (hasPendingChecks(pr)) {
      skipped.push(skipForPrReviewer("pending_checks", pr));
      continue;
    }
    if (config.externalReviewEnabled && hasCoderabbitProcessingComment(pr) && !externalReviewWaitIsStale(pr, config)) {
      skipped.push(skipForPrReviewer("external_review_wait", pr));
      continue;
    }
    return {
      ...selection,
      reason: staleReclaim ? "stale_reclaim" : repairRereview ? "repair_rereview" : "selectable",
      staleReclaim,
    };
  }

  return { selected: false, reason: "no_candidate", skipped };
}

function parseBoolForPrReviewer(value: string | undefined): boolean {
  return String(value || "").toLowerCase() === "1" || String(value || "").toLowerCase() === "true" || String(value || "").toLowerCase() === "yes" || String(value || "").toLowerCase() === "on";
}

function loadJsonForPrReviewer(file: string | undefined): unknown {
  return JSON.parse(file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8"));
}

function loadPrs(file: string | undefined): AnyRecord[] {
  const data = loadJsonForPrReviewer(file);
  if (!Array.isArray(data)) throw new Error("PR JSON must be a list");
  return data.filter((pr: unknown) => pr && typeof pr === "object");
}

function loadPr(file: string | undefined): AnyRecord {
  const data = loadJsonForPrReviewer(file);
  if (data && typeof data === "object" && !Array.isArray(data)) return data as AnyRecord;
  if (Array.isArray(data) && data.length && data[0] && typeof data[0] === "object") return data[0] as AnyRecord;
  throw new Error("PR JSON must be an object or a non-empty list");
}

function loadAgents(file: string | undefined): unknown {
  return file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function parseArgsForPrReviewer(argv: string[]): AnyRecord {
  const parsed: AnyRecord = { mode: "select", autoMerge: "0", externalReviewEnabled: "0", externalReviewWaitSeconds: "1800" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--exit-code") {
      parsed.exitCode = true;
      continue;
    }
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    parsed[key] = argv[index + 1] || "";
    index += 1;
  }
  return parsed;
}

function parseWaitSecondsForPrReviewer(value: unknown): number {
  const seconds = Number(value || 1800);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("--external-review-wait-seconds must be a non-negative number");
  return seconds;
}

function cliConfig(args: AnyRecord): ReviewDecisionConfig {
  const now = args.now ? parseTimeForPrReviewer(args.now) : new Date();
  if (!now) throw new Error("--now must be an ISO-8601 timestamp");
  return defaultDecisionConfig({
    reviewLabel: args.reviewLabel || "agent:review",
    implementLabel: args.implementLabel || "agent:implement",
    updateBranchLabel: args.updateBranchLabel || "agent:update-branch",
    inProgressLabel: args.inProgressLabel || "agent:in-progress",
    blockedLabel: args.blockedLabel || "agent:blocked",
    defersBlockedRecovery: parseBoolForPrReviewer(args.defersBlockedRecovery),
    autoMerge: parseBoolForPrReviewer(args.autoMerge),
    externalReviewEnabled: parseBoolForPrReviewer(args.externalReviewEnabled),
    externalReviewWaitSeconds: parseWaitSecondsForPrReviewer(args.externalReviewWaitSeconds),
    projectId: args.projectId || "",
    automationLogin: args.automationLogin || "",
    now,
  });
}

function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgsForPrReviewer(argv);
  if (!["select", "external-review-gate"].includes(String(args.mode))) {
    throw new Error("--mode must be one of: select, external-review-gate");
  }
  const config = cliConfig(args);
  const attempts = args.stateDir ? attemptJournalsForPrReviewer(args.stateDir) : [];
  const decision = args.mode === "external-review-gate"
    ? externalReviewGate(loadPr(args.input), config)
    : selectPrRequestTarget(
      loadPrs(args.input),
      config,
      workingReviewerPrNumbers(loadAgents(args.agents), config.projectId, attempts, args.githubRepo || ""),
    );
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  return args.exitCode && !decision.selected ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`pr-reviewer-decisions.cts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

module.exports = {
  defaultDecisionConfig,
  externalReviewGate,
  selectPrRequestTarget,
  attemptJournalsForPrReviewer,
  workingReviewerPrNumbers,
};
