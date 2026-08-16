const CLAIM_MARKER_RE = /<!--\s*deadloop:issue-claim\s+v1=([A-Za-z0-9_-]+)\s*-->/g;

type JsonObject = Record<string, any>;

type IssueClaimBinding = {
  repositoryId: string;
  repository: string;
  targetNumber: number;
  requestEventId: string;
  role: "explorer" | "worker";
  revision: string;
  owner: string;
  authority: { durationSeconds: number };
  activeState: { managedLabels: string[]; requestLabel: string; requiredLabels: string[] };
};

function eventTime(event: JsonObject): number {
  return Date.parse(String(event.created_at || event.createdAt || ""));
}

function compareIssueEvents(left: JsonObject, right: JsonObject): number {
  return eventTime(left) - eventTime(right)
    || String(left.id || left.node_id).localeCompare(String(right.id || right.node_id), undefined, { numeric: true });
}

function issueLabelState(events: JsonObject[], label: string): { active: boolean; event: JsonObject | null } {
  const matching = events.filter((event) => ["labeled", "unlabeled"].includes(String(event.event || "").toLowerCase())
    && String(event.label?.name || "") === label && String(event.id || event.node_id || ""));
  matching.sort(compareIssueEvents);
  const event = matching.at(-1) || null;
  return { active: String(event?.event || "").toLowerCase() === "labeled", event };
}

function activeIssueRequest(events: JsonObject[], requestLabel: string): JsonObject | null {
  const matching = events.filter((event) => String(event.event || "").toLowerCase() === "labeled"
    && String(event.label?.name || "") === requestLabel && String(event.id || event.node_id || ""));
  matching.sort(compareIssueEvents);
  return matching.at(-1) || null;
}

function issueRequestGenerations(events: JsonObject[], labels: string[]): Map<string, string> {
  return new Map(labels.map((label) => {
    const event = activeIssueRequest(events, label);
    return [label, String(event?.id || event?.node_id || "")];
  }));
}

function issueRequestVersions(events: JsonObject[], labels: string[]): Map<string, string> {
  return new Map(labels.map((label) => {
    const event = issueLabelState(events, label).event;
    return [label, String(event?.id || event?.node_id || "")];
  }));
}

function changedIssueRequestLabels(before: Map<string, string>, events: JsonObject[]): string[] {
  return [...before].flatMap(([label, version]) => {
    const event = issueLabelState(events, label).event;
    return String(event?.id || event?.node_id || "") !== version ? [label] : [];
  });
}

function racedIssueRequestLabels(before: Map<string, string>, events: JsonObject[]): string[] {
  return changedIssueRequestLabels(before, events).filter((label) => issueLabelState(events, label).active);
}

function observeIssueRequestLabels(github: JsonObject, repository: string, number: number): { events: JsonObject[]; labels: Set<string> } {
  const events = github.listIssueTimelineEvents(repository, number);
  const labels = new Set<string>((github.listIssueLabels(repository, number) || [])
    .map((label: JsonObject | string) => typeof label === "string" ? label : String(label.name || ""))
    .filter(Boolean));
  return { events, labels };
}

function claimedIssueRequestGenerationIsCurrent(
  observation: { events: JsonObject[]; labels: Set<string> }, requestLabel: string, requestEventId: string,
): boolean {
  const state = issueLabelState(observation.events, requestLabel);
  return observation.labels.has(requestLabel) && state.active
    && String(state.event?.id || state.event?.node_id || "") === requestEventId;
}

function issueRequestRevision(request: JsonObject): string {
  const revision = String(request.created_at || request.createdAt || "");
  if (!Number.isFinite(Date.parse(revision))) throw new Error("Issue request event revision is unavailable");
  return revision;
}

function claimPayload(binding: IssueClaimBinding): JsonObject {
  if (!binding.repositoryId || !binding.repository || !binding.targetNumber || !binding.requestEventId
    || !["explorer", "worker"].includes(binding.role) || !binding.revision || !binding.owner
    || !Number.isFinite(binding.authority?.durationSeconds) || binding.authority.durationSeconds <= 0
    || !Array.isArray(binding.activeState?.managedLabels) || !binding.activeState.managedLabels.includes(binding.activeState.requestLabel)
    || binding.activeState.requiredLabels.length !== 1
    || !binding.activeState.managedLabels.includes(binding.activeState.requiredLabels[0])) {
    throw new Error("issue claim binding is incomplete");
  }
  return { schemaVersion: 1, targetKind: "issue", ...binding };
}

function renderIssueClaimComment(binding: IssueClaimBinding): string {
  const action = binding.role === "explorer" ? "exploration" : "implementation";
  const encoded = Buffer.from(JSON.stringify(claimPayload(binding))).toString("base64url");
  return `deadloop is claiming this ${action} request.\n\n<!-- deadloop:issue-claim v1=${encoded} -->`;
}

function parseIssueClaim(body: unknown): JsonObject | null {
  CLAIM_MARKER_RE.lastIndex = 0;
  const matches = [...String(body || "").matchAll(CLAIM_MARKER_RE)];
  if (matches.length !== 1) return null;
  try {
    const value = JSON.parse(Buffer.from(matches[0][1], "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      && value.schemaVersion === 1 && value.targetKind === "issue" ? value : null;
  } catch { return null; }
}

function commentId(comment: JsonObject): string { return String(comment.databaseId || comment.id || ""); }
function commentTime(comment: JsonObject): number { return Date.parse(String(comment.createdAt || comment.created_at || "")); }
function commentLogin(comment: JsonObject): string { return String(comment.author?.login || comment.user?.login || "").toLowerCase(); }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function sharedRequestBinding(value: JsonObject): JsonObject {
  const { owner: _owner, ...shared } = value;
  return shared;
}

function selectIssueClaimWinner(
  comments: JsonObject[], binding: IssueClaimBinding, authorizedLogins: string[], now: Date,
): JsonObject | null {
  const expected = sharedRequestBinding(claimPayload(binding));
  const authorized = new Set(authorizedLogins.map((login) => login.toLowerCase()));
  const valid = comments.filter((comment) => {
    const marker = parseIssueClaim(comment.body);
    const created = commentTime(comment);
    const updated = Date.parse(String(comment.updatedAt || comment.updated_at || ""));
    return Boolean(commentId(comment)) && Number.isFinite(created) && created === updated
      && created <= now.getTime() && now.getTime() < created + binding.authority.durationSeconds * 1000
      && authorized.has(commentLogin(comment)) && marker !== null
      && stableJson(sharedRequestBinding(marker)) === stableJson(expected)
      && typeof marker.owner === "string" && Boolean(marker.owner);
  });
  valid.sort((left, right) => commentTime(left) - commentTime(right)
    || commentId(left).localeCompare(commentId(right), undefined, { numeric: true }));
  return valid[0] || null;
}

module.exports = {
  activeIssueRequest,
  changedIssueRequestLabels,
  claimedIssueRequestGenerationIsCurrent,
  compareIssueEvents,
  issueLabelState,
  issueRequestGenerations,
  issueRequestRevision,
  issueRequestVersions,
  observeIssueRequestLabels,
  parseIssueClaim,
  racedIssueRequestLabels,
  renderIssueClaimComment,
  selectIssueClaimWinner,
};
