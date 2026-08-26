type GithubTimelineEvent = Record<string, any>;

/** Immutable event identity used as GitHub's deterministic same-timestamp tie-breaker. */
function githubTimelineEventId(event: GithubTimelineEvent): string {
  return String(event.id || event.node_id || "");
}

/** Server timestamp used as the primary order for GitHub timeline events. */
function githubTimelineEventTime(event: GithubTimelineEvent): number {
  return Date.parse(String(event.created_at || event.createdAt || ""));
}

/** GitHub timeline order: server timestamp first, immutable event ID second. */
function compareGithubTimelineEvents(left: GithubTimelineEvent, right: GithubTimelineEvent): number {
  const time = githubTimelineEventTime(left) - githubTimelineEventTime(right);
  return time || githubTimelineEventId(left).localeCompare(
    githubTimelineEventId(right), undefined, { numeric: true },
  );
}

module.exports = { compareGithubTimelineEvents };
