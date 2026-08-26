const { createHash } = require("node:crypto") as typeof import("node:crypto");
const path = require("node:path") as typeof import("node:path");

type IssueRequiredVerificationStopPhase = "before_launch" | "completion";
type IssueRequiredVerificationStopDiagnosis = {
  status: "blocked";
  reason: "source_conflict" | "no_source" | "zero_targets" | "missing_base_revision" | "stale_policy";
  repository: string;
  baseRevision: string;
  sources: Array<{ kind: "local" | "repo_policy"; location: string; command: string }>;
  sourceScope?: "current" | "fixed";
  detail?: string;
};

type GithubIssue = {
  number?: number;
  labels?: Array<string | { name?: string }>;
  comments?: Array<{ body?: string | null }>;
};

type StopLabels = { implement: string; inProgress: string; blocked: string };
type PrStopLabels = StopLabels & { review: string; updateBranch: string; human?: string };

type StopPlan = {
  removeLabels: string[];
  addLabels: string[];
  comment?: string;
  fingerprint: string;
};

function labelNames(issue: GithubIssue): Set<string> {
  return new Set((issue.labels || []).map((label) => typeof label === "string" ? label : String(label.name || "")).filter(Boolean));
}

function recoveryText(diagnosis: IssueRequiredVerificationStopDiagnosis): string {
  if (diagnosis.reason === "no_source") return "Add a repository-owned aggregate `checkCommand` to the trusted `deadloop.json`, then run `/deadloop-enable`.";
  if (diagnosis.reason === "source_conflict") return "Resolve the conflicting same-priority `checkCommand` values, then run `/deadloop-enable`.";
  if (diagnosis.reason === "zero_targets") return "Replace the empty required-verification command with a non-empty aggregate command, then run `/deadloop-enable`.";
  if (diagnosis.reason === "missing_base_revision") return "Restore access to the trusted base revision, then run `/deadloop-enable`.";
  return "Restore one resolved required-verification policy and start a new attempt; the existing attempt will not adopt a changed policy.";
}

function fingerprintInput(diagnosis: IssueRequiredVerificationStopDiagnosis): object {
  return {
    reason: diagnosis.reason,
    sources: diagnosis.sources.map((source) => ({ kind: source.kind, location: source.location, command: source.command })),
    sourceScope: diagnosis.sourceScope,
    recovery: recoveryText(diagnosis),
  };
}

function requiredVerificationStopFingerprint(diagnosis: IssueRequiredVerificationStopDiagnosis): string {
  return createHash("sha256").update(JSON.stringify(fingerprintInput(diagnosis))).digest("hex");
}

function requiredVerificationStopMarker(issueNumber: number, diagnosis: IssueRequiredVerificationStopDiagnosis): string {
  return `<!-- deadloop:required-verification-blocked:v1 target=issue-${issueNumber} fingerprint=${requiredVerificationStopFingerprint(diagnosis)} -->`;
}

function prRequiredVerificationStopMarker(prNumber: number, diagnosis: IssueRequiredVerificationStopDiagnosis): string {
  return `<!-- deadloop:required-verification-blocked:v1 target=pr-${prNumber} fingerprint=${requiredVerificationStopFingerprint(diagnosis)} -->`;
}

function isRequiredVerificationStopComment(body: unknown): boolean {
  return /<!-- deadloop:required-verification-blocked:v1 target=(?:issue|pr)-\d+ fingerprint=[0-9a-f]{64} -->/.test(String(body || ""));
}

function isPrRequiredVerificationStopComment(body: unknown): boolean {
  return /<!-- deadloop:required-verification-blocked:v1 target=pr-\d+ fingerprint=[0-9a-f]{64} -->/.test(String(body || ""));
}

function hasRequiredVerificationStopMarker(issue: GithubIssue, diagnosis: IssueRequiredVerificationStopDiagnosis): boolean {
  const marker = requiredVerificationStopMarker(Number(issue.number || 0), diagnosis);
  return (issue.comments || []).some((comment) => String(comment.body || "").includes(marker));
}

function isExactRequiredVerificationStop(
  issue: GithubIssue & { state?: string },
  diagnosis: IssueRequiredVerificationStopDiagnosis,
  labels: StopLabels,
): boolean {
  const names = labelNames(issue);
  return String(issue.state || "").toUpperCase() === "OPEN"
    && names.has(labels.blocked)
    && !names.has(labels.implement)
    && !names.has(labels.inProgress)
    && hasRequiredVerificationStopMarker(issue, diagnosis);
}

function applyIssueRequiredVerificationStop(
  github: { commentIssue(repo: string, issueNumber: string | number, body: string): void; moveIssueLabels(repo: string, issueNumber: string | number, move: { remove: string[]; add: string[] }): void },
  repository: string,
  issueNumber: string | number,
  plan: StopPlan,
): void {
  // Publish the durable fingerprint before releasing ownership. If either write fails,
  // the next pass can safely resume from the marked, still-claimed Issue.
  if (plan.comment) github.commentIssue(repository, issueNumber, plan.comment);
  if (plan.removeLabels.length || plan.addLabels.length) {
    github.moveIssueLabels(repository, issueNumber, { remove: plan.removeLabels, add: plan.addLabels });
  }
}

function publicSourceLocation(source: IssueRequiredVerificationStopDiagnosis["sources"][number]): string {
  if (source.kind !== "local") return source.location;
  const [file, ...fragment] = source.location.split("#");
  return `${path.basename(file)}${fragment.length ? `#${fragment.join("#")}` : ""}`;
}

function renderSources(diagnosis: IssueRequiredVerificationStopDiagnosis): string[] {
  if (!diagnosis.sources.length) return ["- none"];
  return diagnosis.sources.map((source) => `- \`${source.kind}:${publicSourceLocation(source)}\`: \`${source.command || "<empty>"}\``);
}

function renderComment(
  issueNumber: number,
  diagnosis: IssueRequiredVerificationStopDiagnosis,
  phase: IssueRequiredVerificationStopPhase,
): string {
  const skipped = phase === "before_launch"
    ? "No Worker, branch, push, or pull request was created."
    : "No push, pull request creation, or success label transition was performed.";
  return [
    requiredVerificationStopMarker(issueNumber, diagnosis),
    "## Required verification blocked",
    "",
    `reason: ${diagnosis.reason}`,
    `trusted base revision: ${diagnosis.baseRevision || "unknown"}`,
    ...(diagnosis.reason === "stale_policy" && diagnosis.detail ? [`detail: ${diagnosis.detail}`] : []),
    "",
    diagnosis.reason === "stale_policy" && diagnosis.sourceScope !== "current" ? "Confirmed fixed-contract sources:" : "Inspected sources:",
    ...renderSources(diagnosis),
    "",
    "Operations not performed:",
    `- ${skipped}`,
    "- The required-verification stop did not consume an implementation retry allowance.",
    "",
    "Recovery:",
    `1. ${recoveryText(diagnosis)}`,
    "2. Run `/deadloop-doctor` and use the target-specific requeue command only after required verification resolves.",
  ].join("\n");
}

function requiredVerificationStopDiagnosis(attempt: Record<string, any>, error: unknown): IssueRequiredVerificationStopDiagnosis {
  const contract = attempt.requiredVerification || {};
  const inspectedSources = error instanceof Error
    ? (error as Error & { requiredVerificationSources?: IssueRequiredVerificationStopDiagnosis["sources"] }).requiredVerificationSources
    : undefined;
  const fixedSources = [
    ...(contract.source ? [{ ...contract.source, command: String(contract.command || "") }] : []),
    ...(contract.override?.source ? [{ ...contract.override.source, command: String(contract.override.command || "") }] : []),
  ];
  return {
    status: "blocked",
    reason: "stale_policy",
    repository: String(attempt.repository || ""),
    baseRevision: String(contract.baseRevision || attempt.inputRevision?.head || "unknown"),
    sources: inspectedSources || fixedSources,
    sourceScope: inspectedSources ? "current" : "fixed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

function planIssueRequiredVerificationStop(input: {
  issue: GithubIssue;
  resolution: IssueRequiredVerificationStopDiagnosis;
  phase: IssueRequiredVerificationStopPhase;
  labels: StopLabels;
}): StopPlan {
  const number = Number(input.issue.number || 0);
  if (!Number.isInteger(number) || number <= 0) throw new Error("required-verification stop requires an Issue number");
  const names = labelNames(input.issue);
  const marker = requiredVerificationStopMarker(number, input.resolution);
  const duplicate = (input.issue.comments || []).some((comment) => String(comment.body || "").includes(marker));
  return {
    removeLabels: [input.labels.implement, input.labels.inProgress].filter((label) => names.has(label)),
    addLabels: names.has(input.labels.blocked) ? [] : [input.labels.blocked],
    ...(duplicate ? {} : { comment: renderComment(number, input.resolution, input.phase) }),
    fingerprint: requiredVerificationStopFingerprint(input.resolution),
  };
}

function renderPrComment(prNumber: number, diagnosis: IssueRequiredVerificationStopDiagnosis): string {
  return [
    prRequiredVerificationStopMarker(prNumber, diagnosis),
    "## Required verification blocked",
    "",
    `reason: ${diagnosis.reason}`,
    `trusted base revision: ${diagnosis.baseRevision || "unknown"}`,
    ...(diagnosis.detail ? [`detail: ${diagnosis.detail}`] : []),
    "",
    diagnosis.sourceScope === "current" ? "Inspected sources:" : "Confirmed fixed-contract sources:",
    ...renderSources(diagnosis),
    "",
    "Operations not performed:",
    "- No automatic repair, approval, human handoff, or merge transition was performed.",
    "",
    "Recovery:",
    `1. ${recoveryText(diagnosis)}`,
    "2. Run `/deadloop-doctor` and use the PR-specific requeue command only after required verification resolves.",
  ].join("\n");
}

function planPrRequiredVerificationStop(input: {
  pr: GithubIssue;
  resolution: IssueRequiredVerificationStopDiagnosis;
  labels: PrStopLabels;
}): StopPlan {
  const number = Number(input.pr.number || 0);
  if (!Number.isInteger(number) || number <= 0) throw new Error("required-verification stop requires a pull request number");
  const names = labelNames(input.pr);
  const marker = prRequiredVerificationStopMarker(number, input.resolution);
  const duplicate = (input.pr.comments || []).some((comment) => String(comment.body || "").includes(marker));
  const removeLabels = [input.labels.implement, input.labels.updateBranch, input.labels.inProgress, input.labels.human]
    .filter((label): label is string => Boolean(label) && names.has(String(label)));
  const addLabels = [input.labels.review, input.labels.blocked].filter((label) => !names.has(label));
  return {
    removeLabels,
    addLabels,
    ...(duplicate ? {} : { comment: renderPrComment(number, input.resolution) }),
    fingerprint: requiredVerificationStopFingerprint(input.resolution),
  };
}

module.exports = {
  applyIssueRequiredVerificationStop,
  hasRequiredVerificationStopMarker,
  isExactRequiredVerificationStop,
  isPrRequiredVerificationStopComment,
  isRequiredVerificationStopComment,
  planIssueRequiredVerificationStop,
  planPrRequiredVerificationStop,
  prRequiredVerificationStopMarker,
  requiredVerificationStopDiagnosis,
  requiredVerificationStopFingerprint,
  requiredVerificationStopMarker,
};
