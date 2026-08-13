const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");

import type { PrRequestRole } from "../../../src/pr-request-selection";
const { canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");

const CLAIM_MARKER_RE = /<!--\s*deadloop:review-claim\s+v1=([A-Za-z0-9_-]+)\s*-->/g;

const CLAIM_KEYS = [
  "activeState",
  "authority",
  "owner",
  "repository",
  "repositoryId",
  "requestEventId",
  "revision",
  "role",
  "schemaVersion",
  "targetKind",
  "targetNumber",
].sort();
const AUTHORITY_KEYS = ["durationSeconds"];
const ACTIVE_STATE_KEYS = ["managedLabels", "requestLabel", "requiredLabels"];

type JsonObject = Record<string, any>;

type ReviewClaimActiveState = {
  managedLabels: string[];
  requestLabel: string;
  requiredLabels: string[];
};

type ReviewClaimBinding = {
  repositoryId: string;
  repository: string;
  targetNumber: number;
  requestEventId: string;
  role: PrRequestRole;
  revision: string;
  owner: string;
  authority: { durationSeconds: number };
  activeState: ReviewClaimActiveState;
};

type LiveReviewTarget = {
  repositoryId: string;
  repository: string;
  targetNumber: number;
};

function eventTime(event: JsonObject): number {
  return Date.parse(String(event.created_at || event.createdAt || ""));
}

function activeReviewRequest(events: JsonObject[], requestLabel = "agent:review"): JsonObject | null {
  const matching = events.filter((event) =>
    String(event.event || "").toLowerCase() === "labeled"
    && String(event.label?.name || "") === requestLabel
    && String(event.id || event.node_id || ""),
  );
  matching.sort((left, right) => {
    const time = eventTime(left) - eventTime(right);
    return time || String(left.id || left.node_id).localeCompare(String(right.id || right.node_id), undefined, { numeric: true });
  });
  return matching.at(-1) || null;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === "string" && item.length > 0)
    && new Set(value).size === value.length;
}

function normalizedClaimAuthority(binding: ReviewClaimBinding): { durationSeconds: number } | null {
  return binding.authority && typeof binding.authority === "object" && !Array.isArray(binding.authority)
    && JSON.stringify(Object.keys(binding.authority).sort()) === JSON.stringify(AUTHORITY_KEYS)
    && Number.isFinite(binding.authority.durationSeconds) && binding.authority.durationSeconds > 0
    ? { durationSeconds: binding.authority.durationSeconds }
    : null;
}

function normalizedActiveState(binding: ReviewClaimBinding): ReviewClaimActiveState | null {
  if (binding.activeState && typeof binding.activeState === "object" && !Array.isArray(binding.activeState)
    && JSON.stringify(Object.keys(binding.activeState).sort()) === JSON.stringify(ACTIVE_STATE_KEYS)
    && stringArray(binding.activeState.managedLabels) && binding.activeState.managedLabels.length === 5
    && typeof binding.activeState.requestLabel === "string" && binding.activeState.requestLabel.length > 0
    && binding.activeState.managedLabels.includes(binding.activeState.requestLabel)
    && stringArray(binding.activeState.requiredLabels) && binding.activeState.requiredLabels.length === 1
    && binding.activeState.requiredLabels.every((label) => binding.activeState.managedLabels.includes(label))) {
    return {
      managedLabels: [...binding.activeState.managedLabels],
      requestLabel: binding.activeState.requestLabel,
      requiredLabels: [...binding.activeState.requiredLabels],
    };
  }
  return null;
}

function claimPayload(binding: ReviewClaimBinding): JsonObject {
  const authority = normalizedClaimAuthority(binding);
  const activeState = normalizedActiveState(binding);
  if (!authority || !activeState) throw new Error("review claim duration and active-state contracts must be explicit and valid");
  return {
    schemaVersion: 1,
    repositoryId: binding.repositoryId,
    repository: binding.repository,
    targetKind: "pull-request",
    targetNumber: binding.targetNumber,
    requestEventId: binding.requestEventId,
    role: binding.role,
    revision: binding.revision.toLowerCase(),
    owner: binding.owner,
    authority,
    activeState,
  };
}

function renderReviewClaimComment(binding: ReviewClaimBinding): string {
  const encoded = Buffer.from(JSON.stringify(claimPayload(binding))).toString("base64url");
  return `deadloop is claiming this review request.\n\n<!-- deadloop:review-claim v1=${encoded} -->`;
}

function parseReviewClaim(body: unknown): JsonObject | null {
  CLAIM_MARKER_RE.lastIndex = 0;
  const matches = [...String(body || "").matchAll(CLAIM_MARKER_RE)];
  if (matches.length !== 1) return null;
  try {
    const value = JSON.parse(Buffer.from(matches[0][1], "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(CLAIM_KEYS)
      || !value.authority || typeof value.authority !== "object" || Array.isArray(value.authority)
      || JSON.stringify(Object.keys(value.authority).sort()) !== JSON.stringify(AUTHORITY_KEYS)
      || !Number.isFinite(value.authority.durationSeconds) || value.authority.durationSeconds <= 0
      || !value.activeState || typeof value.activeState !== "object" || Array.isArray(value.activeState)
      || JSON.stringify(Object.keys(value.activeState).sort()) !== JSON.stringify(ACTIVE_STATE_KEYS)
      || !stringArray(value.activeState.managedLabels) || value.activeState.managedLabels.length !== 5
      || typeof value.activeState.requestLabel !== "string" || !value.activeState.managedLabels.includes(value.activeState.requestLabel)
      || !stringArray(value.activeState.requiredLabels) || value.activeState.requiredLabels.length !== 1
      || !value.activeState.requiredLabels.every((label: string) => value.activeState.managedLabels.includes(label))) return null;
    return value;
  } catch {
    return null;
  }
}

function commentIdentity(comment: JsonObject): string {
  return String(comment.author?.login || comment.user?.login || "").toLowerCase();
}

function commentTime(comment: JsonObject): number {
  return Date.parse(String(comment.createdAt || comment.created_at || ""));
}

function hasUneditedCommentEvidence(comment: JsonObject): boolean {
  const createdAt = String(comment.createdAt || comment.created_at || "");
  const updatedAt = String(comment.updatedAt || comment.updated_at || "");
  return Boolean(createdAt)
    && createdAt === updatedAt
    && Number.isFinite(Date.parse(createdAt))
    && Number.isFinite(Date.parse(updatedAt));
}

function serverCommentId(comment: JsonObject): string {
  return String(comment.databaseId || comment.id || "");
}

function sameBinding(marker: JsonObject, expected: ReviewClaimBinding): boolean {
  const authority = normalizedClaimAuthority(expected);
  const activeState = normalizedActiveState(expected);
  return authority !== null && activeState !== null
    && marker.schemaVersion === 1
    && marker.repositoryId === expected.repositoryId
    && marker.repository === expected.repository
    && marker.targetKind === "pull-request"
    && marker.targetNumber === expected.targetNumber
    && marker.requestEventId === expected.requestEventId
    && marker.role === expected.role
    && String(marker.revision || "").toLowerCase() === expected.revision.toLowerCase()
    && typeof marker.owner === "string"
    && marker.owner.length > 0
    && stableJson(marker.authority) === stableJson(authority)
    && stableJson(marker.activeState) === stableJson(activeState);
}

function consistentSavedClaimContract(contract: JsonObject): boolean {
  if (!contract?.binding || typeof contract.binding !== "object" || Array.isArray(contract.binding)) return false;
  const binding = contract.binding as ReviewClaimBinding;
  const authority = normalizedClaimAuthority(binding);
  const activeState = normalizedActiveState(binding);
  if (!authority || !activeState) return false;
  // Every role shares one managed-label set, so the claim's own request label is
  // identified by name rather than by its position inside that set.
  const managed = new Set(activeState.managedLabels);
  return typeof contract.authoritySeconds === "number"
    && contract.authoritySeconds === authority.durationSeconds
    && contract.requestLabel === activeState.requestLabel
    && managed.has(String(contract.inProgressLabel))
    && managed.has(String(contract.blockedLabel))
    && contract.inProgressLabel !== contract.blockedLabel
    && contract.requestLabel !== contract.inProgressLabel
    && contract.requestLabel !== contract.blockedLabel
    && stableJson(activeState.requiredLabels) === stableJson([contract.inProgressLabel])
    && (contract.managedLabels === undefined
      || stableJson(contract.managedLabels) === stableJson(activeState.managedLabels));
}

function claimContractMatchesConfiguration(
  contract: JsonObject,
  configuration: JsonObject,
): boolean {
  if (!consistentSavedClaimContract(contract)) return false;
  const activeState = normalizedActiveState(contract.binding as ReviewClaimBinding);
  if (!activeState) return false;
  return configuration.authoritySeconds === contract.authoritySeconds
    && stableJson(configuration.managedLabels) === stableJson(activeState.managedLabels)
    && configuration.requestLabel === activeState.requestLabel
    && stableJson(configuration.requiredLabels) === stableJson(activeState.requiredLabels);
}

function assertClaimMatchesCurrentConfiguration(contract: JsonObject, configuration: JsonObject): void {
  if (!claimContractMatchesConfiguration(contract, configuration)
    || contract.reviewerMaxRuntimeSeconds !== configuration.reviewerMaxRuntimeSeconds
    || contract.cleanupGraceSeconds !== configuration.cleanupGraceSeconds
    || contract.authoritySeconds !== contract.reviewerMaxRuntimeSeconds + contract.cleanupGraceSeconds
    || contract.binding?.repositoryId !== configuration.repositoryId
    || contract.binding?.repository !== configuration.repository
    || stableJson((contract.authorizedLogins || []).map((value: unknown) => String(value).toLowerCase()).sort())
      !== stableJson(configuration.authorizedLogins)
    || String(contract.automationLogin || "").toLowerCase() !== configuration.authenticatedLogin
    || String(contract.reviewerAgent || "") !== configuration.reviewerAgent) {
    throw new Error("active review claim no longer matches current enablement and normalized configuration");
  }
}

function reviewClaimCommentMatchesContract(comment: JsonObject, contract: JsonObject): boolean {
  if (!consistentSavedClaimContract(contract)
    || serverCommentId(comment) !== String(contract.commentId || "")
    || !hasUneditedCommentEvidence(comment)) return false;
  const authorized = new Set((Array.isArray(contract.authorizedLogins) ? contract.authorizedLogins : [])
    .map((login: unknown) => String(login).toLowerCase()).filter(Boolean));
  const marker = parseReviewClaim(comment.body);
  return authorized.has(commentIdentity(comment))
    && marker !== null
    && sameBinding(marker, contract.binding as ReviewClaimBinding)
    && marker.owner === contract.binding?.owner;
}

function readGithubRestResponseHeaders(commandRunner: { runText(args: string[]): string }, repo: string): string {
  return commandRunner.runText(["gh", "api", "--include", `repos/${repo}`]);
}

function parseGithubRestDate(headers: unknown, notBefore: Date): Date | null {
  if (Number.isNaN(notBefore.getTime())) return null;
  const matches = [...String(headers || "").matchAll(/^date:\s*(.+)$/gim)];
  const value = matches.at(-1)?.[1]?.trim() || "";
  const serverNow = new Date(value);
  if (!value || Number.isNaN(serverNow.getTime()) || serverNow.getTime() < notBefore.getTime()) return null;
  return serverNow;
}

function matchesLiveReviewTarget(contract: JsonObject, liveTarget: LiveReviewTarget): boolean {
  return typeof liveTarget?.repositoryId === "string"
    && liveTarget.repositoryId.length > 0
    && typeof liveTarget.repository === "string"
    && liveTarget.repository.length > 0
    && Number.isInteger(liveTarget.targetNumber)
    && liveTarget.targetNumber > 0
    && contract.binding?.repositoryId === liveTarget.repositoryId
    && contract.binding?.repository === liveTarget.repository
    && contract.binding?.targetNumber === liveTarget.targetNumber;
}

type ReviewClaimValidation =
  | { kind: "authorized" }
  | { kind: "claim_invalid" }
  | { kind: "binding_mismatch" }
  | { kind: "expired" }
  | { kind: "server_time_unverifiable" };

function exactManagedStateMatches(pr: JsonObject, activeState: ReviewClaimActiveState): boolean {
  const labels = new Set((pr.labels || []).map((label: JsonObject | string) =>
    typeof label === "string" ? label : String(label.name || "")));
  return stableJson(activeState.managedLabels.filter((label) => labels.has(label))) === stableJson(activeState.requiredLabels);
}

function earliestBoundClaimWithoutTime(comments: JsonObject[], contract: JsonObject): JsonObject | null {
  const authorized = new Set((Array.isArray(contract.authorizedLogins) ? contract.authorizedLogins : [])
    .map((login: unknown) => String(login).toLowerCase()).filter(Boolean));
  const valid = comments.filter((comment) => {
    const marker = parseReviewClaim(comment.body);
    return Boolean(serverCommentId(comment))
      && hasUneditedCommentEvidence(comment)
      && Number.isFinite(commentTime(comment))
      && authorized.has(commentIdentity(comment))
      && marker !== null
      && sameBinding(marker, contract.binding as ReviewClaimBinding);
  });
  valid.sort((left, right) => commentTime(left) - commentTime(right)
    || serverCommentId(left).localeCompare(serverCommentId(right), undefined, { numeric: true }));
  return valid[0] || null;
}

function classifyBoundReviewClaim(
  pr: JsonObject,
  events: JsonObject[],
  comments: JsonObject[],
  restHeaders: unknown,
  contract: JsonObject,
  liveTarget: LiveReviewTarget,
  expectedHead: string,
): ReviewClaimValidation {
  if (!consistentSavedClaimContract(contract)) return { kind: "claim_invalid" };
  if (!matchesLiveReviewTarget(contract, liveTarget)) return { kind: "binding_mismatch" };
  const configuredState = normalizedActiveState(contract.binding as ReviewClaimBinding);
  if (!configuredState) return { kind: "binding_mismatch" };
  const request = activeReviewRequest(events, configuredState.requestLabel);
  const claimComment = comments.find((comment) => serverCommentId(comment) === String(contract.commentId || ""));
  if (!claimComment || !reviewClaimCommentMatchesContract(claimComment, contract)) return { kind: "claim_invalid" };
  if (!request
    || String(pr.state || "").toUpperCase() !== "OPEN"
    || String(pr.headRefOid || "").toLowerCase() !== expectedHead
    || String(request.id || request.node_id || "") !== String(contract.binding?.requestEventId || "")
    || !exactManagedStateMatches(pr, configuredState)
    || serverCommentId(earliestBoundClaimWithoutTime(comments, contract) || {}) !== String(contract.commentId || "")) {
    return { kind: "binding_mismatch" };
  }
  const serverNow = parseGithubRestDate(restHeaders, new Date(Math.max(eventTime(request), commentTime(claimComment))));
  if (!serverNow) return { kind: "server_time_unverifiable" };
  if (serverNow.getTime() >= commentTime(claimComment) + Number(contract.authoritySeconds) * 1000) return { kind: "expired" };
  const winner = selectReviewClaimWinner(
    comments,
    contract.binding as ReviewClaimBinding,
    Array.isArray(contract.authorizedLogins) ? contract.authorizedLogins : [],
    serverNow,
    Number(contract.authoritySeconds),
  );
  return serverCommentId(winner || {}) === String(contract.commentId || "")
    ? { kind: "authorized" }
    : { kind: "binding_mismatch" };
}

function classifyReviewClaimTimeStatus(
  pr: JsonObject,
  events: JsonObject[],
  comments: JsonObject[],
  restHeaders: unknown,
  contract: JsonObject,
  liveTarget: LiveReviewTarget,
): ReviewClaimValidation {
  if (!consistentSavedClaimContract(contract)) return { kind: "claim_invalid" };
  if (!matchesLiveReviewTarget(contract, liveTarget)) return { kind: "binding_mismatch" };
  const configuredState = normalizedActiveState(contract.binding as ReviewClaimBinding);
  if (!configuredState) return { kind: "binding_mismatch" };
  const request = events.find((event) => String(event.id || event.node_id || "") === String(contract.binding?.requestEventId || "")
    && String(event.event || "").toLowerCase() === "labeled"
    && String(event.label?.name || "") === configuredState.requestLabel);
  const claimComment = comments.find((comment) => serverCommentId(comment) === String(contract.commentId || ""));
  if (!request || !claimComment || !reviewClaimCommentMatchesContract(claimComment, contract)) return { kind: "claim_invalid" };
  if (String(pr.state || "").toUpperCase() !== "OPEN"
    || String(pr.headRefOid || "").toLowerCase() !== String(contract.binding?.revision || "").toLowerCase()
    || serverCommentId(earliestBoundClaimWithoutTime(comments, contract) || {}) !== String(contract.commentId || "")) {
    return { kind: "binding_mismatch" };
  }
  const serverNow = parseGithubRestDate(restHeaders, new Date(Math.max(eventTime(request), commentTime(claimComment))));
  if (!serverNow) return { kind: "server_time_unverifiable" };
  return serverNow.getTime() >= commentTime(claimComment) + Number(contract.authoritySeconds) * 1000
    ? { kind: "expired" }
    : { kind: "authorized" };
}

function classifyActiveReviewClaim(
  pr: JsonObject,
  events: JsonObject[],
  comments: JsonObject[],
  restHeaders: unknown,
  contract: JsonObject,
  liveTarget: LiveReviewTarget,
): ReviewClaimValidation {
  return classifyBoundReviewClaim(
    pr, events, comments, restHeaders, contract, liveTarget,
    String(contract.binding?.revision || "").toLowerCase(),
  );
}

function validateActiveReviewClaim(
  pr: JsonObject,
  events: JsonObject[],
  comments: JsonObject[],
  restHeaders: unknown,
  contract: JsonObject,
  liveTarget: LiveReviewTarget,
): boolean {
  return classifyActiveReviewClaim(pr, events, comments, restHeaders, contract, liveTarget).kind === "authorized";
}

function classifyPushedHeadAuthorityTransition(
  pr: JsonObject,
  events: JsonObject[],
  comments: JsonObject[],
  restHeaders: unknown,
  contract: JsonObject,
  liveTarget: LiveReviewTarget,
  transition: { originalHeadOid?: unknown; headOid?: unknown },
): ReviewClaimValidation {
  const originalHead = String(transition.originalHeadOid || "").toLowerCase();
  const repairedHead = String(transition.headOid || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(originalHead) || !/^[0-9a-f]{40}$/.test(repairedHead)
    || originalHead === repairedHead
    || originalHead !== String(contract.binding?.revision || "").toLowerCase()
    || repairedHead !== String(pr.headRefOid || "").toLowerCase()) return { kind: "binding_mismatch" };
  return classifyBoundReviewClaim(pr, events, comments, restHeaders, contract, liveTarget, repairedHead);
}

function validatePushedHeadAuthorityTransition(
  pr: JsonObject,
  events: JsonObject[],
  comments: JsonObject[],
  restHeaders: unknown,
  contract: JsonObject,
  liveTarget: LiveReviewTarget,
  transition: { originalHeadOid?: unknown; headOid?: unknown },
): boolean {
  return classifyPushedHeadAuthorityTransition(pr, events, comments, restHeaders, contract, liveTarget, transition).kind === "authorized";
}

type TimeBlockObservation = ReviewClaimValidation & { comments: JsonObject[]; labels: string[] };

function reviewClaimTimeBlockMarker(contract: JsonObject): string {
  const key = Buffer.from(JSON.stringify({
    requestEventId: String(contract.binding?.requestEventId || ""),
    claimCommentId: String(contract.commentId || ""),
  })).toString("base64url");
  return `<!-- deadloop:review-claim-time-block v1=${key} -->`;
}

function reviewClaimTimeBlockBody(contract: JsonObject): string {
  return `deadloop stopped because GitHub server-time evidence for this review claim was unavailable or unsafe to verify. Retry the review after GitHub REST Date evidence recovers.\n\n${reviewClaimTimeBlockMarker(contract)}`;
}

function reviewClaimTimeBlockCommentMatches(comment: JsonObject, contract: JsonObject): boolean {
  return Boolean(serverCommentId(comment))
    && hasUneditedCommentEvidence(comment)
    && commentIdentity(comment) === String(contract.automationLogin || "").toLowerCase()
    && String(comment.body || "") === reviewClaimTimeBlockBody(contract);
}

function visiblyBlockReviewClaimTimeFailure(operations: {
  contract: JsonObject;
  blockedLabel: string;
  observe(): TimeBlockObservation;
  comment(body: string): void;
  addBlocked(): void;
}): boolean {
  let observation = operations.observe();
  const alreadyCommented = observation.comments.some((comment) => reviewClaimTimeBlockCommentMatches(comment, operations.contract));
  if (alreadyCommented && observation.labels.includes(operations.blockedLabel)) return true;
  if (observation.kind !== "server_time_unverifiable") return false;
  if (!alreadyCommented) operations.comment(reviewClaimTimeBlockBody(operations.contract));
  observation = operations.observe();
  if (observation.kind !== "server_time_unverifiable") return false;
  if (!observation.labels.includes(operations.blockedLabel)) operations.addBlocked();
  return true;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The roles whose attempt journal carries a saved claim contract.
 *
 * This is deliberately wider than the roles that claim a request at launch. A reviewer and a branch
 * update each win their own request, while a review repair inherits the reviewer's contract, and all
 * three hold it afterwards. Reading the completion side off the launch side would drop the repair;
 * naming only the review roles, as this guard once did, drops the branch update and makes its
 * completion handler unable to run at all.
 */
const CLAIM_HOLDING_ATTEMPT_ROLES = new Set(["reviewer", "review-repair", "branch-update"]);

type SavedClaimAuthority = {
  stateDir: string;
  githubRepo?: string;
  projectId?: string;
  targetNumber?: number;
};

function savedReviewClaimContract(attemptRecordFile: string, supplied: unknown, authority: SavedClaimAuthority): JsonObject {
  const location = canonicalAttemptLocation({ stateDir: authority.stateDir, attemptRecord: attemptRecordFile });
  const record = readAttemptRecord(location.runDir);
  if (!CLAIM_HOLDING_ATTEMPT_ROLES.has(String(record.role))
    || record.target.kind !== "pull-request" || !record.reviewClaim) {
    throw new Error("saved active work claim is missing from the PR attempt record");
  }
  const contract = record.reviewClaim as JsonObject;
  if (!consistentSavedClaimContract(contract)) {
    throw new Error("saved active review claim contract is internally inconsistent");
  }
  if (supplied !== undefined && stableJson(supplied) !== stableJson(contract)) {
    throw new Error("supplied review claim does not exactly match the saved attempt contract");
  }
  if ((authority.githubRepo && record.repository !== authority.githubRepo)
    || (authority.projectId && record.project !== authority.projectId)
    || (authority.targetNumber !== undefined && record.target.number !== authority.targetNumber)
    || contract.binding?.repository !== record.repository
    || Number(contract.binding?.targetNumber) !== record.target.number
    || String(contract.binding?.revision || "").toLowerCase() !== String(record.inputRevision.head || "").toLowerCase()) {
    throw new Error("saved review claim does not match the immutable attempt identity");
  }
  return contract;
}

function parsePaginatedGithubJson(stdout: unknown): JsonObject[] {
  try {
    const pages = JSON.parse(String(stdout || "[]"));
    return Array.isArray(pages) ? pages.flat().filter((value) => value && typeof value === "object" && !Array.isArray(value)) : [];
  } catch {
    return [];
  }
}

function selectReviewClaimWinner(
  comments: JsonObject[],
  expected: ReviewClaimBinding,
  authorizedLogins: string[],
  now: Date,
  authoritySeconds: number,
): JsonObject | null {
  if (!Number.isFinite(authoritySeconds) || authoritySeconds <= 0 || Number.isNaN(now.getTime())
    || authoritySeconds !== normalizedClaimAuthority(expected)?.durationSeconds) return null;
  const authorized = new Set(authorizedLogins.map((login) => login.toLowerCase()).filter(Boolean));
  const valid = comments.filter((comment) => {
    const id = serverCommentId(comment);
    const createdAt = commentTime(comment);
    const marker = parseReviewClaim(comment.body);
    return Boolean(id)
      && hasUneditedCommentEvidence(comment)
      && Number.isFinite(createdAt)
      && createdAt <= now.getTime()
      && now.getTime() < createdAt + authoritySeconds * 1000
      && authorized.has(commentIdentity(comment))
      && marker !== null
      && sameBinding(marker, expected);
  });
  valid.sort((left, right) => commentTime(left) - commentTime(right)
    || serverCommentId(left).localeCompare(serverCommentId(right), undefined, { numeric: true }));
  return valid[0] || null;
}

module.exports = {
  activeReviewRequest,
  assertClaimMatchesCurrentConfiguration,
  classifyActiveReviewClaim,
  classifyPushedHeadAuthorityTransition,
  classifyReviewClaimTimeStatus,
  claimContractMatchesConfiguration,
  parseGithubRestDate,
  parseReviewClaim,
  parsePaginatedGithubJson,
  readGithubRestResponseHeaders,
  renderReviewClaimComment,
  reviewClaimCommentMatchesContract,
  savedReviewClaimContract,
  selectReviewClaimWinner,
  validateActiveReviewClaim,
  validatePushedHeadAuthorityTransition,
  visiblyBlockReviewClaimTimeFailure,
};
