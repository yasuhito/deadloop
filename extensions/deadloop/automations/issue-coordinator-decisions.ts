#!/usr/bin/env node
// Deterministic decisions for issue-coordinator automation. CommonJS-shaped so
// it can run directly with `node issue-coordinator-decisions.ts`.

const fs = require("node:fs") as typeof import("node:fs");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { passesIssueLabelGate } = require("../../../src/issue-eligibility.cjs");
const { MAX_DRIVER_REVALIDATION_MS } = require("../../../src/driver-enablement.cjs");

type IssueDecisionRecord = Record<string, any>;

type IssueDecisionConfig = {
  readyLabel: string;
  implementLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
  humanLabel: string;
  needsInfoLabel: string;
  wontfixLabel: string;
};

const DEFAULT_READY_LABEL = "ready-for-agent";
const DEFAULT_IMPLEMENT_LABEL = "agent:implement";
const DEFAULT_IN_PROGRESS_LABEL = "agent:in-progress";
const DEFAULT_BLOCKED_LABEL = "agent:blocked";
const DEFAULT_HUMAN_LABEL = "ready-for-human";
const DEFAULT_NEEDS_INFO_LABEL = "needs-info";
const DEFAULT_WONTFIX_LABEL = "wontfix";

const INLINE_DEPENDENCY_RE = /(?:Depends on|Blocked by|依存:|ブロック:)\s*#(\d+)/gi;
const DEPENDENCY_SECTION_RE = /^##\s*(?:Blocked by|Depends on|依存|ブロック)\b[\s\S]*?(?=^##|(?![\s\S]))/gim;
const NONE_LINE_RE = /^\s*none\s*(?:-|$)/im;
const ISSUE_REFERENCE_RE = /#(\d+)/g;
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

function bodyDependencyNumbers(body: string | undefined | null): Set<number> {
  const text = body || "";
  const dependencies = new Set(numbersFromMatches(INLINE_DEPENDENCY_RE, text));
  DEPENDENCY_SECTION_RE.lastIndex = 0;
  for (let match = DEPENDENCY_SECTION_RE.exec(text); match; match = DEPENDENCY_SECTION_RE.exec(text)) {
    const section = match[0];
    if (NONE_LINE_RE.test(section)) continue;
    for (const number of numbersFromMatches(ISSUE_REFERENCE_RE, section)) dependencies.add(number);
  }
  return dependencies;
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
): IssueDecisionRecord {
  const requiredLabels = [config.readyLabel, config.implementLabel];
  const skipLabels = [config.inProgressLabel, config.blockedLabel, config.needsInfoLabel, config.humanLabel, config.wontfixLabel];
  const skipped: IssueDecisionRecord[] = [];

  for (const issue of [...issues].sort((left, right) => issueNumberForDecision(left) - issueNumberForDecision(right))) {
    const labels = labelsOfIssue(issue);
    if (!requiredLabels.every((label) => labels.has(label))) {
      skipped.push(skipIssueForDecision("missing_required_label", issue));
      continue;
    }
    if (!passesIssueLabelGate(issue, { required: requiredLabels, blocked: skipLabels })) {
      skipped.push(skipIssueForDecision("skip_label", issue));
      continue;
    }

    const dependencies = bodyDependencyNumbers(issue.body || "");
    for (const number of relationshipDependencies(issue)) dependencies.add(number);
    const { closed, openDependencies } = dependencyStatesClosed(dependencies, dependencyState);
    if (!closed) {
      skipped.push({ ...skipIssueForDecision("open_dependency", issue), dependencies: openDependencies });
      continue;
    }

    return {
      selected: true,
      number: issue.number,
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

function fixtureDecision(file: string, config: IssueDecisionConfig): IssueDecisionRecord {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const states = parseDependencyStateMap(data);
  const relationships = parseRelationshipDependencyMap(data);
  return selectIssueForImplementation(
    (data.issues || []).filter((issue: unknown) => issue && typeof issue === "object"),
    config,
    (issue) => relationships.get(issueNumberForDecision(issue)) || new Set(),
    (number) => states.get(number),
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

function loadIssues(file: string | undefined): IssueDecisionRecord[] {
  const data = JSON.parse(file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8"));
  if (!Array.isArray(data)) throw new Error("issue JSON must be a list");
  return data.filter((issue: unknown) => issue && typeof issue === "object");
}

const ISSUE_DECISION_VALUE_FLAGS = new Set([
  "--input",
  "--fixture",
  "--repo",
  "--ready-label",
  "--implement-label",
  "--in-progress-label",
  "--blocked-label",
  "--human-label",
  "--needs-info-label",
  "--wontfix-label",
]);

function issueDecisionHelp(): string {
  return [
    "Usage: issue-coordinator-decisions.ts [--input FILE | --fixture FILE] [--repo owner/name] [--json] [--exit-code]",
    "",
    "Options:",
    "  --input FILE                    Path to issue JSON. Defaults to stdin.",
    "  --fixture FILE                  Load issues and dependency states from fixture JSON.",
    "  --repo owner/name               GitHub repository for live dependency checks.",
    "  --ready-label LABEL             Ready label. Default: ready-for-agent.",
    "  --implement-label LABEL         Implement label. Default: agent:implement.",
    "  --in-progress-label LABEL       In-progress label. Default: agent:in-progress.",
    "  --blocked-label LABEL           Blocked label. Default: agent:blocked.",
    "  --human-label LABEL             Human handoff label. Default: ready-for-human.",
    "  --needs-info-label LABEL        Needs-info label. Default: needs-info.",
    "  --wontfix-label LABEL           Wontfix label. Default: wontfix.",
    "  --json                          Print JSON output.",
    "  --exit-code                     Exit 0 only when an issue is selected.",
  ].join("\n");
}

function parseArgsForIssueDecision(argv: string[]): IssueDecisionRecord {
  const parsed: IssueDecisionRecord = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--exit-code") {
      parsed.exitCode = true;
      continue;
    }
    if (!ISSUE_DECISION_VALUE_FLAGS.has(token)) throw new Error(`unknown flag: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    parsed[key] = argv[index + 1] || "";
    index += 1;
  }
  return parsed;
}

function configFromIssueArgs(args: IssueDecisionRecord): IssueDecisionConfig {
  return defaultIssueDecisionConfig({
    readyLabel: args.readyLabel || process.env.DEADLOOP_READY_LABEL || DEFAULT_READY_LABEL,
    implementLabel: args.implementLabel || process.env.DEADLOOP_IMPLEMENT_LABEL || DEFAULT_IMPLEMENT_LABEL,
    inProgressLabel: args.inProgressLabel || process.env.DEADLOOP_IN_PROGRESS_LABEL || DEFAULT_IN_PROGRESS_LABEL,
    blockedLabel: args.blockedLabel || process.env.DEADLOOP_BLOCKED_LABEL || DEFAULT_BLOCKED_LABEL,
    humanLabel: args.humanLabel || process.env.DEADLOOP_HUMAN_LABEL || DEFAULT_HUMAN_LABEL,
    needsInfoLabel: args.needsInfoLabel || process.env.DEADLOOP_NEEDS_INFO_LABEL || DEFAULT_NEEDS_INFO_LABEL,
    wontfixLabel: args.wontfixLabel || process.env.DEADLOOP_WONTFIX_LABEL || DEFAULT_WONTFIX_LABEL,
  });
}

function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgsForIssueDecision(argv);
  if (args.help) {
    process.stdout.write(`${issueDecisionHelp()}\n`);
    return 0;
  }
  const config = configFromIssueArgs(args);
  let decision: IssueDecisionRecord;
  if (args.fixture) {
    decision = fixtureDecision(args.fixture, config);
  } else {
    const repo = args.repo || process.env.DEADLOOP_GITHUB_REPO || "";
    if (!repo) throw new Error("--repo or DEADLOOP_GITHUB_REPO is required");
    const issues = loadIssues(args.input);
    const deadline = issueDecisionDeadline();
    decision = selectIssueForImplementation(
      issues,
      config,
      (issue) => issueBlockedByNumbers(repo, issueNumberForDecision(issue), deadline),
      (number) => liveDependencyState(repo, number, deadline),
    );
  }

  if (args.json) process.stdout.write(`${JSON.stringify(decision)}\n`);
  else if (decision.selected) process.stdout.write(`selected issue #${decision.number}\n`);
  else process.stdout.write("no selectable issue\n");
  return args.exitCode && !decision.selected ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`issue-coordinator-decisions.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

module.exports = {
  bodyDependencyNumbers,
  defaultIssueDecisionConfig,
  fixtureDecision,
  DEPENDENCY_QUERY_TIMEOUT_MS,
  IssueDecisionDeadlineError,
  issueBlockedByNumbers,
  issueDecisionDeadline,
  issueNumberForDecision,
  liveDependencyState,
  remainingIssueDecisionTimeout,
  selectIssueForImplementation,
};
