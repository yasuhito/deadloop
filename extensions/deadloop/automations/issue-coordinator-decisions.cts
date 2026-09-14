#!/usr/bin/env node
// Deterministic decisions for issue-coordinator automation. CommonJS-shaped so
// it can run directly with `node issue-coordinator-decisions.cts`.

const fs = require("node:fs") as typeof import("node:fs");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { passesIssueLabelGate } = require("../../../src/issue-eligibility.cjs");
const { issueRecoveryRequestIsEligible } = require("../../../src/issue-request-transition.cts");
const { MAX_DRIVER_REVALIDATION_MS } = require("../../../src/driver-enablement.cjs");

type IssueDecisionRecord = Record<string, any>;

type IssueDecisionConfig = {
  readyLabel: string;
  exploreLabel: string;
  implementLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
  humanLabel: string;
  needsInfoLabel: string;
  wontfixLabel: string;
};

const DEFAULT_READY_LABEL = "ready-for-agent";
const DEFAULT_EXPLORE_LABEL = "agent:explore";
const DEFAULT_IMPLEMENT_LABEL = "agent:implement";
const DEFAULT_IN_PROGRESS_LABEL = "agent:in-progress";
const DEFAULT_BLOCKED_LABEL = "agent:blocked";
const DEFAULT_HUMAN_LABEL = "ready-for-human";
const DEFAULT_NEEDS_INFO_LABEL = "needs-info";
const DEFAULT_WONTFIX_LABEL = "wontfix";

// One GitHub-native blocker of a candidate Issue. `repository` is set only for blockers that live
// in another repository; their state is judged the same way as local ones.
type BlockedByNode = { number: number; state: string; repository?: string };

const DEPENDENCY_QUERY_TIMEOUT_MS = 5_000;
const BLOCKED_BY_FIRST = 20;

class IssueDecisionDeadlineError extends Error {}

function issueDecisionDeadline(now = Date.now()): number {
  return now + MAX_DRIVER_REVALIDATION_MS;
}

function remainingIssueDecisionTimeout(deadline: number | undefined, now = Date.now()): number {
  if (deadline === undefined) return DEPENDENCY_QUERY_TIMEOUT_MS;
  const remaining = deadline - now;
  if (remaining <= 0) throw new IssueDecisionDeadlineError("issue launch revalidation deadline exceeded");
  return Math.min(DEPENDENCY_QUERY_TIMEOUT_MS, remaining);
}

function defaultIssueDecisionConfig(overrides: Partial<IssueDecisionConfig> = {}): IssueDecisionConfig {
  return {
    readyLabel: DEFAULT_READY_LABEL,
    exploreLabel: DEFAULT_EXPLORE_LABEL,
    implementLabel: DEFAULT_IMPLEMENT_LABEL,
    inProgressLabel: DEFAULT_IN_PROGRESS_LABEL,
    blockedLabel: DEFAULT_BLOCKED_LABEL,
    humanLabel: DEFAULT_HUMAN_LABEL,
    needsInfoLabel: DEFAULT_NEEDS_INFO_LABEL,
    wontfixLabel: DEFAULT_WONTFIX_LABEL,
    ...overrides,
  };
}

function runTextForIssueDecision(args: string[], options: { check?: boolean; deadline?: number } = {}): string {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: remainingIssueDecisionTimeout(options.deadline),
    killSignal: "SIGKILL",
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new IssueDecisionDeadlineError("issue dependency query timed out");
  }
  if (options.check !== false && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `command failed: ${args.join(" ")}`).trim());
  }
  return result.stdout || "";
}

function runJsonForIssueDecision(args: string[], deadline?: number): any {
  return JSON.parse(runTextForIssueDecision(args, { deadline }));
}

function labelsOfIssue(issue: IssueDecisionRecord): Set<string> {
  const names = new Set<string>();
  for (const label of issue.labels || []) {
    if (typeof label === "string") names.add(label);
    else if (label && typeof label === "object" && label.name) names.add(String(label.name));
  }
  return names;
}

function issueNumberForDecision(issue: IssueDecisionRecord): number {
  const number = Number(issue.number);
  return Number.isFinite(number) ? number : 0;
}

function skipIssueForDecision(reason: string, issue: IssueDecisionRecord): IssueDecisionRecord {
  return { number: issue.number, reason };
}

function dependencyStatesClosed(
  blockers: BlockedByNode[],
): { closed: boolean; openDependencies: IssueDecisionRecord[] } {
  const openDependencies: IssueDecisionRecord[] = [];
  for (const blocker of [...blockers].sort((left, right) => left.number - right.number)) {
    const state = String(blocker.state || "").toUpperCase() || "UNKNOWN";
    if (state !== "CLOSED") {
      openDependencies.push({
        number: blocker.number,
        state,
        ...(blocker.repository ? { repository: blocker.repository } : {}),
      });
    }
  }
  return { closed: openDependencies.length === 0, openDependencies };
}

function selectIssueForImplementation(
  issues: IssueDecisionRecord[],
  config: IssueDecisionConfig,
  blockedBy: (issue: IssueDecisionRecord) => BlockedByNode[],
  timelineEvents: (issue: IssueDecisionRecord) => IssueDecisionRecord[] = (issue) => issue.timelineEvents || [],
): IssueDecisionRecord {
  const skipLabels = [config.inProgressLabel, config.needsInfoLabel, config.humanLabel, config.wontfixLabel];
  const skipped: IssueDecisionRecord[] = [];
  const sorted = [...issues].sort((left, right) => issueNumberForDecision(left) - issueNumberForDecision(right));
  // Every Issue is visited once per requested role, and its timeline cannot change between those
  // passes, so a blocked candidate must cost at most one paginated timeline query per decision.
  const timelineByIssue = new Map<number, IssueDecisionRecord[]>();
  const cachedTimelineEvents = (issue: IssueDecisionRecord): IssueDecisionRecord[] => {
    const number = issueNumberForDecision(issue);
    const cached = timelineByIssue.get(number);
    if (cached) return cached;
    const events = timelineEvents(issue);
    timelineByIssue.set(number, events);
    return events;
  };

  for (const request of [
    { label: config.exploreLabel, role: "explorer" },
    { label: config.implementLabel, role: "worker" },
  ]) for (const issue of sorted) {
    const labels = labelsOfIssue(issue);
    if (!labels.has(request.label)) {
      skipped.push(skipIssueForDecision("missing_required_label", issue));
      continue;
    }
    if (!passesIssueLabelGate(issue, { required: [request.label], blocked: skipLabels })) {
      skipped.push(skipIssueForDecision("skip_label", issue));
      continue;
    }
    if (labels.has(config.blockedLabel)
      && !issueRecoveryRequestIsEligible(cachedTimelineEvents(issue), request.label, config.blockedLabel)) {
      skipped.push(skipIssueForDecision("stale_blocked_request", issue));
      continue;
    }

    let blockers: BlockedByNode[] = [];
    if (request.role === "worker") {
      blockers = blockedBy(issue);
      const { closed, openDependencies } = dependencyStatesClosed(blockers);
      if (!closed) {
        skipped.push({
          ...skipIssueForDecision("open_dependency", issue),
          dependencies: openDependencies,
        });
        continue;
      }
    }

    return {
      selected: true,
      number: issue.number,
      role: request.role,
      requestLabel: request.label,
      reason: "selectable",
      dependencies: blockers.map((blocker) => blocker.number).sort((left, right) => left - right),
      skipped,
    };
  }

  return { selected: false, reason: "no_candidate", skipped };
}

function parseBlockedByMap(data: IssueDecisionRecord): Map<number, BlockedByNode[]> {
  const blockedBy = data.blockedBy || {};
  const parsed = new Map<number, BlockedByNode[]>();
  for (const [number, nodes] of Object.entries(blockedBy)) {
    parsed.set(Number(number), ((nodes as any[]) || []).map((node) => ({
      number: Number(node.number),
      state: String(node.state || ""),
      ...(node.repository ? { repository: String(node.repository) } : {}),
    })));
  }
  return parsed;
}

function fixtureDecision(file: string, config: IssueDecisionConfig): IssueDecisionRecord {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const blockedBy = parseBlockedByMap(data);
  return selectIssueForImplementation(
    (data.issues || []).filter((issue: unknown) => issue && typeof issue === "object"),
    config,
    (issue) => blockedBy.get(issueNumberForDecision(issue)) || [],
  );
}

function normalizeRepositoryForNode(value: string): string {
  return String(value || "").trim().toLowerCase();
}

// One GraphQL query per candidate returns every blocker together with its state, so no per-dependency
// follow-up query is needed. Any query failure fails closed: a timeout throws the deadline error and
// every other failure propagates, so a candidate is never selected on unknown dependency state.
function issueBlockedBy(repo: string, number: number, deadline?: number): BlockedByNode[] {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) throw new Error(`invalid repository: ${repo}`);
  const data = runJsonForIssueDecision([
    "gh",
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
    "-f",
    `query=query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { issue(number:$number) { blockedBy(first:${BLOCKED_BY_FIRST}) { pageInfo { hasNextPage } nodes { number state repository { nameWithOwner } } } } } }`,
  ], deadline);
  const connection = data?.data?.repository?.issue?.blockedBy;
  if (connection?.pageInfo?.hasNextPage) {
    throw new Error(`issue #${number} has more than ${BLOCKED_BY_FIRST} blockedBy dependencies; refusing to guess`);
  }
  const nodes = connection?.nodes || [];
  return nodes
    .filter((node: unknown) => node && typeof node === "object" && (node as IssueDecisionRecord).number !== undefined)
    .map((node: IssueDecisionRecord) => {
      const repository = node.repository?.nameWithOwner;
      const crossRepository = repository
        && normalizeRepositoryForNode(repository) !== normalizeRepositoryForNode(repo);
      return {
        number: Number(node.number),
        state: String(node.state || ""),
        ...(crossRepository ? { repository } : {}),
      };
    });
}

type IssueRequestRole = "exploration" | "implementation";

type IssueRequestStopResult = {
  status: "done" | "skip";
  message: string;
  driverAction: string;
};

/**
 * Map one Issue request transition outcome onto the driver result that reports it.
 *
 * Only outcomes that describe the request itself are mapped here; an unrelated launch failure
 * returns null so the caller keeps its own staleness handling. Messages must not claim an untouched
 * Issue for an outcome that already mutated workflow state.
 */
function issueRequestStopResult(
  kind: string,
  role: IssueRequestRole,
  issueNumber: number,
): IssueRequestStopResult | null {
  if (kind === "ambiguous_blocked") {
    return {
      status: "done",
      message: `Issue #${issueNumber} ${role} request consumption was ambiguous; blocked with recovery guidance`,
      driverAction: "ambiguous_request_consumption_blocked",
    };
  }
  if (kind === "blocked_after_consumption") {
    return {
      status: "done",
      message: `Issue #${issueNumber} ${role} request was consumed before a stop; left recovery guidance`,
      driverAction: "request_consumed_before_stop",
    };
  }
  if (kind === "superseded") {
    return {
      status: "done",
      message: `Issue #${issueNumber} ${role} request was consumed by a concurrent attempt that owns the active state; left recovery guidance`,
      driverAction: "request_consumed_by_concurrent_attempt",
    };
  }
  if (kind === "recovery_blocked") {
    return {
      status: "skip",
      message: `Issue #${issueNumber} was blocked again before its ${role} request was consumed`,
      driverAction: "recovery_block_raced",
    };
  }
  if (kind === "cancelled") {
    return {
      status: "skip",
      message: `Issue #${issueNumber} ${role} request was cancelled before consumption`,
      driverAction: `${role}_request_cancelled`,
    };
  }
  if (kind === "raced") {
    return {
      status: "skip",
      message: `Issue #${issueNumber} received a newer ${role} request; the selected attempt did not launch`,
      driverAction: `${role}_request_raced`,
    };
  }
  return null;
}

module.exports = {
  dependencyStatesClosed,
  defaultIssueDecisionConfig,
  fixtureDecision,
  DEPENDENCY_QUERY_TIMEOUT_MS,
  IssueDecisionDeadlineError,
  issueBlockedBy,
  issueDecisionDeadline,
  issueNumberForDecision,
  issueRequestStopResult,
  remainingIssueDecisionTimeout,
  selectIssueForImplementation,
};
