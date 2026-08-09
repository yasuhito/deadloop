const CLAIM_MARKER_RE = /<!--\s*deadloop:review-claim\s+v1=([A-Za-z0-9_-]+)\s*-->/g;

const CLAIM_KEYS = [
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

type JsonObject = Record<string, any>;

type ReviewClaimBinding = {
  repositoryId: string;
  repository: string;
  targetNumber: number;
  requestEventId: string;
  role: "reviewer";
  revision: string;
  owner: string;
};

function eventTime(event: JsonObject): number {
  return Date.parse(String(event.created_at || event.createdAt || ""));
}

function activeReviewRequest(events: JsonObject[], reviewLabel = "agent:review"): JsonObject | null {
  const matching = events.filter((event) =>
    String(event.event || "").toLowerCase() === "labeled"
    && String(event.label?.name || "") === reviewLabel
    && String(event.id || event.node_id || ""),
  );
  matching.sort((left, right) => {
    const time = eventTime(left) - eventTime(right);
    return time || String(left.id || left.node_id).localeCompare(String(right.id || right.node_id), undefined, { numeric: true });
  });
  return matching.at(-1) || null;
}

function claimPayload(binding: ReviewClaimBinding): JsonObject {
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
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(CLAIM_KEYS)) return null;
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

function serverCommentId(comment: JsonObject): string {
  return String(comment.databaseId || comment.id || "");
}

function sameBinding(marker: JsonObject, expected: ReviewClaimBinding): boolean {
  return marker.schemaVersion === 1
    && marker.repositoryId === expected.repositoryId
    && marker.repository === expected.repository
    && marker.targetKind === "pull-request"
    && marker.targetNumber === expected.targetNumber
    && marker.requestEventId === expected.requestEventId
    && marker.role === expected.role
    && String(marker.revision || "").toLowerCase() === expected.revision.toLowerCase()
    && typeof marker.owner === "string"
    && marker.owner.length > 0;
}

function selectReviewClaimWinner(
  comments: JsonObject[],
  expected: ReviewClaimBinding,
  authorizedLogins: string[],
  now: Date,
  authoritySeconds: number,
): JsonObject | null {
  if (!Number.isFinite(authoritySeconds) || authoritySeconds <= 0 || Number.isNaN(now.getTime())) return null;
  const authorized = new Set(authorizedLogins.map((login) => login.toLowerCase()).filter(Boolean));
  const valid = comments.filter((comment) => {
    const id = serverCommentId(comment);
    const createdAt = commentTime(comment);
    const marker = parseReviewClaim(comment.body);
    return Boolean(id)
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
  parseReviewClaim,
  renderReviewClaimComment,
  selectReviewClaimWinner,
};
