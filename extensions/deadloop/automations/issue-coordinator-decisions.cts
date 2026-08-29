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

type DependencyRef = { repository: string | null; number: number };

const INLINE_DEPENDENCY_RE = /(?:Depends on|Blocked by|依存:|ブロック:)\s*#(\d+)/gi;
const DEPENDENCY_SECTION_RE = /^##\s*(?:Blocked by|Depends on|依存|ブロック)\b[\s\S]*?(?=^##|(?![\s\S]))/gim;
const NONE_LINE_RE = /^\s*none\s*(?:-|$)/im;
const ISSUE_REFERENCE_RE = /#(\d+)/g;
// A dependency section can reference Issues by bare number, by `owner/repo#123`, or by a GitHub
// Issue/pull request URL (bare or wrapped in a markdown link). Qualified references belong to their
// own repository's number space and must not be read as target-repository numbers.
const MARKDOWN_ISSUE_LINK_RE = /\[[^\]]*\]\(\s*(https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pulls)\/(\d+))[^)]*\)/gi;
const GITHUB_ISSUE_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pulls)\/(\d+)/gi;
const QUALIFIED_NUMBER_RE = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g;
const DEPENDENCY_QUERY_TIMEOUT_MS = 5_000;

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

function numbersFromMatches(regex: RegExp, text: string): number[] {
  const values: number[] = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match; match = regex.exec(text)) values.push(Number(match[1]));
  return values;
}

function normalizeRepository(value: string): string {
  return value.trim().toLowerCase();
}

function refsFromSectionText(section: string): DependencyRef[] {
  const refs: DependencyRef[] = [];
  const rest = section
    .replace(MARKDOWN_ISSUE_LINK_RE, (_match, _url, owner, name, number) => {
      refs.push({ repository: `${owner}/${name}`, number: Number(number) });
      return " ";
    })
    .replace(GITHUB_ISSUE_URL_RE, (_match, owner, name, number) => {
      refs.push({ repository: `${owner}/${name}`, number: Number(number) });
      return " ";
    })
    .replace(QUALIFIED_NUMBER_RE, (_match, repository, number) => {
      refs.push({ repository, number: Number(number) });
      return " ";
    });
  for (const number of numbersFromMatches(ISSUE_REFERENCE_RE, rest)) refs.push({ repository: null, number });
  return refs;
}

function bodyDependencyRefs(body: string | undefined | null): DependencyRef[] {
  const text = body || "";
  const refs = new Map<string, DependencyRef>();
  const add = (ref: DependencyRef) => {
    const key = `${ref.repository ? normalizeRepository(ref.repository) : ""}#${ref.number}`;
    if (!refs.has(key)) refs.set(key, ref);
  };
  for (const number of numbersFromMatches(INLINE_DEPENDENCY_RE, text)) add({ repository: null, number });
  DEPENDENCY_SECTION_RE.lastIndex = 0;
  for (let match = DEPENDENCY_SECTION_RE.exec(text); match; match = DEPENDENCY_SECTION_RE.exec(text)) {
    const section = match[0];
    if (NONE_LINE_RE.test(section)) continue;
    for (const ref of refsFromSectionText(section)) add(ref);
  }
  return [...refs.values()];
}

// A bare number resolves inside the target repository. A URL or `owner/repo#123` naming the target
// repository also resolves locally; any other qualified reference names another repository and is not
// a dependency of this repository's loop.
function resolveDependencyRef(ref: DependencyRef, targetRepository?: string): { local: boolean; key: string } {
  if (!ref.repository) return { local: true, key: `#${ref.number}` };
  const normalized = normalizeRepository(ref.repository);
  if (targetRepository && normalized === normalizeRepository(targetRepository)) return { local: true, key: `#${ref.number}` };
  return { local: false, key: `${normalized}#${ref.number}` };
}

function skipIssueForDecision(reason: string, issue: IssueDecisionRecord): IssueDecisionRecord {
  return { number: issue.number, reason };
}

function dependencyStatesClosed(
  dependencies: Set<number>,
  dependencyState: (number: number) => string | null | undefined,
): { closed: boolean; openDependencies: IssueDecisionRecord[] } {
  const openDependencies: IssueDecisionRecord[] = [];
  for (const number of [...dependencies].sort((left, right) => left - right)) {
    const state = dependencyState(number);
    if (String(state || "OPEN").toUpperCase() !== "CLOSED") {
      openDependencies.push({ number, state: state || "UNKNOWN" });
    }
  }
  return { closed: openDependencies.length === 0, openDependencies };
}

function selectIssueForImplementation(
  issues: IssueDecisionRecord[],
  config: IssueDecisionConfig,
  relationshipDependencies: (issue: IssueDecisionRecord) => Set<number>,
  dependencyState: (number: number) => string | null | undefined,
  timelineEvents: (issue: IssueDecisionRecord) => IssueDecisionRecord[] = (issue) => issue.timelineEvents || [],
  repository?: string,
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

    const dependencies = new Set<number>();
    if (request.role === "worker") {
      const externalDependencies = new Set<string>();
      for (const ref of bodyDependencyRefs(issue.body || "")) {
        const resolved = resolveDependencyRef(ref, repository);
        if (resolved.local) dependencies.add(Number(resolved.key.slice(1)));
        else externalDependencies.add(resolved.key);
      }
      for (const number of relationshipDependencies(issue)) dependencies.add(number);
      const { closed, openDependencies } = dependencyStatesClosed(dependencies, dependencyState);
      if (!closed) {
        skipped.push({
          ...skipIssueForDecision("open_dependency", issue),
          dependencies: openDependencies,
          ...(externalDependencies.size ? { externalDependencies: [...externalDependencies].sort() } : {}),
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
      dependencies: [...dependencies].sort((left, right) => left - right),
      skipped,
    };
  }

  return { selected: false, reason: "no_candidate", skipped };
}

function parseDependencyStateMap(data: IssueDecisionRecord): Map<number, string> {
  const states = data.dependencyStates || {};
  const parsed = new Map<number, string>();
  for (const [number, state] of Object.entries(states)) parsed.set(Number(number), String(state));
  return parsed;
}

function parseRelationshipDependencyMap(data: IssueDecisionRecord): Map<number, Set<number>> {
  const relationships = data.relationshipDependencies || data.blockedBy || {};
  const parsed = new Map<number, Set<number>>();
  for (const [number, dependencies] of Object.entries(relationships)) {
    parsed.set(Number(number), new Set((dependencies as any[] || []).map((value) => Number(value))));
  }
  return parsed;
}

function fixtureDecision(file: string, config: IssueDecisionConfig, repository?: string): IssueDecisionRecord {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const states = parseDependencyStateMap(data);
  const relationships = parseRelationshipDependencyMap(data);
  return selectIssueForImplementation(
    (data.issues || []).filter((issue: unknown) => issue && typeof issue === "object"),
    config,
    (issue) => relationships.get(issueNumberForDecision(issue)) || new Set(),
    (number) => states.get(number),
    undefined,
    repository,
  );
}

function issueBlockedByNumbers(repo: string, number: number, deadline?: number): Set<number> {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) return new Set();
  try {
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
      "query=query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { issue(number:$number) { blockedBy(first:20) { nodes { number } } } } }",
    ], deadline);
    const nodes = data?.data?.repository?.issue?.blockedBy?.nodes || [];
    return new Set(nodes.filter((node: unknown) => node && typeof node === "object" && (node as IssueDecisionRecord).number !== undefined).map((node: IssueDecisionRecord) => Number(node.number)));
  } catch (error) {
    if (error instanceof IssueDecisionDeadlineError) throw error;
    return new Set();
  }
}

function liveDependencyState(repo: string, number: number, deadline?: number): string | null {
  try {
    const data = runJsonForIssueDecision(["gh", "issue", "view", String(number), "-R", repo, "--json", "state"], deadline);
    return data && typeof data === "object" && data.state ? String(data.state) : null;
  } catch (error) {
    if (error instanceof IssueDecisionDeadlineError) throw error;
    return null;
  }
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
  bodyDependencyRefs,
  dependencyStatesClosed,
  normalizeRepository,
  resolveDependencyRef,
  defaultIssueDecisionConfig,
  fixtureDecision,
  DEPENDENCY_QUERY_TIMEOUT_MS,
  IssueDecisionDeadlineError,
  issueBlockedByNumbers,
  issueDecisionDeadline,
  issueNumberForDecision,
  issueRequestStopResult,
  liveDependencyState,
  remainingIssueDecisionTimeout,
  selectIssueForImplementation,
};
