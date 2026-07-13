#!/usr/bin/env node
// Deterministic decisions for pr-reviewer automation. CommonJS-shaped so the
// script can run directly with `node pr-reviewer-decisions.ts` in this package.

const fs = require("node:fs") as typeof import("node:fs");

type AnyRecord = Record<string, any>;

type ReviewDecisionConfig = {
  reviewLabel: string;
  reviewingLabel: string;
  humanLabel: string;
  blockedLabel: string;
  autoMerge: boolean;
  externalReviewEnabled: boolean;
  externalReviewWaitSeconds: number;
  projectId: string;
  now: Date;
};

const PENDING_CHECK_STATES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING"]);
const EXTERNAL_REVIEW_MARKER_RE = /<!--\s*deadloop:external-review-request\s+head=([0-9a-fA-F]+)\s*-->/g;

function defaultDecisionConfig(overrides: Partial<ReviewDecisionConfig> = {}): ReviewDecisionConfig {
  return {
    reviewLabel: "agent:review",
    reviewingLabel: "agent:reviewing",
    humanLabel: "ready-for-human",
    blockedLabel: "agent:blocked",
    autoMerge: false,
    externalReviewEnabled: false,
    externalReviewWaitSeconds: 1800,
    projectId: "",
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

function iterAgentsForPrReviewer(data: unknown): AnyRecord[] {
  let value = data;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as AnyRecord;
    if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) value = record.result;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const agents = (value as AnyRecord).agents;
    return Array.isArray(agents) ? agents.filter((agent: unknown) => agent && typeof agent === "object") : [];
  }
  return Array.isArray(value) ? value.filter((agent: unknown) => agent && typeof agent === "object") : [];
}

function workingReviewerPrNumbers(agents: unknown, projectId: string): Set<number> {
  if (!projectId) return new Set();
  const pattern = new RegExp(
    `^${projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-pr-(\\d+)-(?:reviewer|branch-update-[0-9a-f]+)$`,
  );
  const working = new Set<number>();
  for (const agent of iterAgentsForPrReviewer(agents)) {
    if (String(agent.agent_status || "").toLowerCase() !== "working") continue;
    const match = pattern.exec(String(agent.name || ""));
    if (match) working.add(Number(match[1]));
  }
  return working;
}

function skipForPrReviewer(reason: string, pr: AnyRecord): AnyRecord {
  return { number: pr.number, reason };
}

function selectPrForReview(prs: AnyRecord[], config: ReviewDecisionConfig = defaultDecisionConfig(), workingReviewerPrs: Set<number> = new Set()): AnyRecord {
  const candidateLabels = config.autoMerge ? new Set([config.reviewLabel, config.humanLabel]) : new Set([config.reviewLabel]);
  const skipped: AnyRecord[] = [];

  for (const pr of [...prs].sort((left, right) => prNumberForPrReviewer(left) - prNumberForPrReviewer(right))) {
    const labels = labelNamesForPrReviewer(pr);
    if (![...candidateLabels].some((label) => labels.has(label))) {
      skipped.push(skipForPrReviewer("missing_candidate_label", pr));
      continue;
    }
    if (labels.has(config.blockedLabel)) {
      skipped.push(skipForPrReviewer("blocked", pr));
      continue;
    }
    let staleReclaim = false;
    if (labels.has(config.reviewingLabel)) {
      if (workingReviewerPrs.has(prNumberForPrReviewer(pr))) {
        skipped.push(skipForPrReviewer("reviewer_working", pr));
        continue;
      }
      staleReclaim = true;
    }
    if (pr.isDraft) {
      return { selected: true, number: pr.number, action: "draft_gate", reason: "draft", staleReclaim, skipped };
    }
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
      selected: true,
      number: pr.number,
      action: "review",
      reason: staleReclaim ? "stale_reclaim" : "selectable",
      staleReclaim,
      skipped,
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
    reviewingLabel: args.reviewingLabel || "agent:reviewing",
    humanLabel: args.humanLabel || "ready-for-human",
    blockedLabel: args.blockedLabel || "agent:blocked",
    autoMerge: parseBoolForPrReviewer(args.autoMerge),
    externalReviewEnabled: parseBoolForPrReviewer(args.externalReviewEnabled),
    externalReviewWaitSeconds: parseWaitSecondsForPrReviewer(args.externalReviewWaitSeconds),
    projectId: args.projectId || "",
    now,
  });
}

function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgsForPrReviewer(argv);
  if (!["select", "external-review-gate"].includes(String(args.mode))) {
    throw new Error("--mode must be one of: select, external-review-gate");
  }
  const config = cliConfig(args);
  const decision = args.mode === "external-review-gate"
    ? externalReviewGate(loadPr(args.input), config)
    : selectPrForReview(loadPrs(args.input), config, workingReviewerPrNumbers(loadAgents(args.agents), config.projectId));
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  return args.exitCode && !decision.selected ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`pr-reviewer-decisions.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

module.exports = {
  defaultDecisionConfig,
  externalReviewGate,
  selectPrForReview,
  workingReviewerPrNumbers,
};
