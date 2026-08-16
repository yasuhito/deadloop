type JsonObject = Record<string, any>;

type IssueRequestGithub = {
  listIssueLabels(repository: string, issueNumber: number): JsonObject[];
  listIssueTimelineEvents(repository: string, issueNumber: number): JsonObject[];
  listIssueComments(repository: string, issueNumber: number): JsonObject[];
  addIssueLabel(repository: string, issueNumber: number, label: string): unknown;
  deleteIssueLabel(repository: string, issueNumber: number, label: string): { status: number };
  commentIssue(repository: string, issueNumber: number, body: string): unknown;
};

type ConsumeIssueRequestInput = {
  github: IssueRequestGithub;
  repository: string;
  issueNumber: number;
  requestLabel: string;
  requestEventId: string;
  inProgressLabel: string;
  blockedLabel: string;
  automationLogin: string;
  attemptId: string;
  persistConsumed: () => void;
};

type IssueRequestTransitionOutcome =
  | { kind: "consumed"; requestEventId: string }
  | { kind: "cancelled"; requestEventId: string }
  | { kind: "raced"; requestEventId: string }
  | { kind: "ambiguous_blocked"; requestEventId: string };

type PersistSuccessfulExplorationInput = {
  github: IssueRequestGithub;
  repository: string;
  issueNumber: number;
  requestLabel: string;
  requestEventId: string;
  inProgressLabel: string;
  automationLogin: string;
  attemptId: string;
  resultBody: string;
  persistGithub: () => void;
};

function eventId(event: JsonObject | null | undefined): string {
  return String(event?.id || event?.node_id || "");
}

function eventTime(event: JsonObject): number {
  return Date.parse(String(event.created_at || event.createdAt || ""));
}

function compareIssueTimelineEvents(left: JsonObject, right: JsonObject): number {
  const time = eventTime(left) - eventTime(right);
  return time || eventId(left).localeCompare(eventId(right), undefined, { numeric: true });
}

function labelName(label: JsonObject | string): string {
  return typeof label === "string" ? label : String(label?.name || "");
}

function labelEvent(events: JsonObject[], label: string): JsonObject | null {
  const matches = events.filter((event) =>
    ["labeled", "unlabeled"].includes(String(event.event || "").toLowerCase())
    && String(event.label?.name || "") === label
    && eventId(event),
  );
  matches.sort(compareIssueTimelineEvents);
  return matches.at(-1) || null;
}

function activeIssueRequestEvent(events: JsonObject[], label: string): JsonObject | null {
  const latest = labelEvent(events, label);
  return String(latest?.event || "").toLowerCase() === "labeled" ? latest : null;
}

function observeRequest(input: ConsumeIssueRequestInput): {
  events: JsonObject[];
  labels: Set<string>;
  latest: JsonObject | null;
} {
  const events = input.github.listIssueTimelineEvents(input.repository, input.issueNumber);
  const labels = new Set(input.github.listIssueLabels(input.repository, input.issueNumber).map(labelName).filter(Boolean));
  return { events, labels, latest: labelEvent(events, input.requestLabel) };
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function ambiguousComment(input: ConsumeIssueRequestInput): string {
  return [
    `<!-- deadloop:ambiguous-request-consumption:v1 attempt=${input.attemptId} -->`,
    "## Agent request consumption could not be proven",
    "",
    `deadloop stopped before it could durably prove whether the selected \`${input.requestLabel}\` request was consumed. No Worker was launched.`,
    "",
    "The request was not restored because removing it may have been a person's cancellation.",
    "To request a new attempt, add a new Agent request:",
    "",
    "```bash",
    `gh issue edit ${input.issueNumber} -R ${quoteShell(input.repository)} --add-label ${quoteShell(input.requestLabel)}`,
    "```",
  ].join("\n");
}

function blockAmbiguousConsumption(input: ConsumeIssueRequestInput): IssueRequestTransitionOutcome {
  const labels = new Set(input.github.listIssueLabels(input.repository, input.issueNumber).map(labelName).filter(Boolean));
  if (!labels.has(input.blockedLabel)) input.github.addIssueLabel(input.repository, input.issueNumber, input.blockedLabel);
  const marker = `<!-- deadloop:ambiguous-request-consumption:v1 attempt=${input.attemptId} -->`;
  const comments = input.github.listIssueComments(input.repository, input.issueNumber);
  if (!comments.some((comment) => String(comment.body || "").includes(marker))) {
    input.github.commentIssue(input.repository, input.issueNumber, ambiguousComment(input));
  }
  return { kind: "ambiguous_blocked", requestEventId: input.requestEventId };
}

function selectedRequestEvent(observation: ReturnType<typeof observeRequest>, input: ConsumeIssueRequestInput): JsonObject | null {
  return observation.events.find((event) => eventId(event) === input.requestEventId
    && String(event.event || "").toLowerCase() === "labeled"
    && String(event.label?.name || "") === input.requestLabel) || null;
}

function explorationResultMarker(input: PersistSuccessfulExplorationInput): string {
  return `<!-- deadloop:issue-exploration-result:v1 attempt=${input.attemptId} request=${input.requestEventId} -->`;
}

function explorationResultBody(input: PersistSuccessfulExplorationInput): string {
  return `${input.resultBody.trim()}\n\n${explorationResultMarker(input)}`;
}

function trustedExplorationResultComment(
  comments: JsonObject[],
  input: PersistSuccessfulExplorationInput,
): JsonObject | null {
  const body = explorationResultBody(input);
  return comments.find((comment) => {
    const login = String(comment.user?.login || comment.author?.login || "").toLowerCase();
    const created = String(comment.created_at || comment.createdAt || "");
    const updated = String(comment.updated_at || comment.updatedAt || "");
    return login === input.automationLogin.toLowerCase()
      && Boolean(created)
      && created === updated
      && String(comment.body || "") === body;
  }) || null;
}

function observeExplorationCompletion(input: PersistSuccessfulExplorationInput) {
  const events = input.github.listIssueTimelineEvents(input.repository, input.issueNumber);
  const labels = new Set(input.github.listIssueLabels(input.repository, input.issueNumber).map(labelName).filter(Boolean));
  const comments = input.github.listIssueComments(input.repository, input.issueNumber);
  return { events, labels, comments };
}

function ownedActiveState(
  observation: ReturnType<typeof observeExplorationCompletion>,
  input: PersistSuccessfulExplorationInput,
): { request: JsonObject; activation: JsonObject; active: boolean; removed: boolean } | null {
  const ordered = [...observation.events].sort(compareIssueTimelineEvents);
  const request = ordered.find((event) => eventId(event) === input.requestEventId
    && String(event.event || "").toLowerCase() === "labeled"
    && String(event.label?.name || "") === input.requestLabel);
  const consumed = request && ordered.find((event) =>
    compareIssueTimelineEvents(event, request) > 0
    && String(event.event || "").toLowerCase() === "unlabeled"
    && String(event.label?.name || "") === input.requestLabel
    && String(event.actor?.login || "").toLowerCase() === input.automationLogin.toLowerCase(),
  );
  const activation = consumed && ordered.find((event) =>
    compareIssueTimelineEvents(event, consumed) > 0
    && String(event.event || "").toLowerCase() === "labeled"
    && String(event.label?.name || "") === input.inProgressLabel
    && String(event.actor?.login || "").toLowerCase() === input.automationLogin.toLowerCase(),
  );
  if (!request || !consumed || !activation) return null;
  const nextActiveStateEvent = ordered.find((event) =>
    compareIssueTimelineEvents(event, activation) > 0
    && ["labeled", "unlabeled"].includes(String(event.event || "").toLowerCase())
    && String(event.label?.name || "") === input.inProgressLabel,
  );
  if (!nextActiveStateEvent) {
    return observation.labels.has(input.inProgressLabel)
      ? { request, activation, active: true, removed: false }
      : null;
  }
  const removed = String(nextActiveStateEvent.event || "").toLowerCase() === "unlabeled"
    && String(nextActiveStateEvent.actor?.login || "").toLowerCase() === input.automationLogin.toLowerCase();
  return removed ? { request, activation, active: false, removed: true } : null;
}

/**
 * Persist one successful exploration result without replacing the Issue label set.
 *
 * The selected exploration request was consumed before launch. Completion posts one exact,
 * Automation-host-authored result, removes only that attempt's active label, proves both writes
 * from GitHub observations, and only then advances the durable attempt through `persistGithub`.
 */
function persistSuccessfulExploration(input: PersistSuccessfulExplorationInput): { kind: "persisted"; requestEventId: string } {
  if (!input.automationLogin.trim()) throw new Error("authorized Automation host login is required");
  let observation = observeExplorationCompletion(input);
  let activeState = ownedActiveState(observation, input);
  if (!activeState) throw new Error("exploration active state is not owned by this attempt");

  if (!trustedExplorationResultComment(observation.comments, input)) {
    if (!activeState.active) throw new Error("exploration result comment is missing after active state removal");
    input.github.commentIssue(input.repository, input.issueNumber, explorationResultBody(input));
    observation = observeExplorationCompletion(input);
    activeState = ownedActiveState(observation, input);
    if (!activeState || !trustedExplorationResultComment(observation.comments, input)) {
      throw new Error("exploration result comment could not be proven");
    }
  }

  if (activeState.active) {
    const deletion = input.github.deleteIssueLabel(input.repository, input.issueNumber, input.inProgressLabel);
    if (deletion.status !== 200 && deletion.status !== 404) {
      throw new Error("exploration active-state removal could not be proven");
    }
    observation = observeExplorationCompletion(input);
    activeState = ownedActiveState(observation, input);
  }

  if (!activeState || activeState.active || !activeState.removed
    || !trustedExplorationResultComment(observation.comments, input)) {
    throw new Error("exploration GitHub persistence could not be proven");
  }
  input.persistGithub();
  return { kind: "persisted", requestEventId: input.requestEventId };
}

/**
 * Consume one immutable Issue Agent-request generation.
 *
 * The caller must have durably prepared the attempt and bound `requestEventId` before calling this
 * seam. Only the selected request label is deleted. The durable receipt is written only after the
 * resulting unlabeled event is observed and no newer generation has raced with it.
 */
function consumeIssueRequest(input: ConsumeIssueRequestInput): IssueRequestTransitionOutcome {
  const before = observeRequest(input);
  const selected = selectedRequestEvent(before, input);
  if (!selected) return { kind: "cancelled", requestEventId: input.requestEventId };

  const latestId = eventId(before.latest);
  const latestAction = String(before.latest?.event || "").toLowerCase();
  if (latestId !== input.requestEventId) {
    if (latestAction === "labeled" && before.labels.has(input.requestLabel)) {
      return { kind: "raced", requestEventId: input.requestEventId };
    }
    const laterAutomationRemoval = before.events.some((event) =>
      compareIssueTimelineEvents(event, selected) > 0
      && String(event.event || "").toLowerCase() === "unlabeled"
      && String(event.label?.name || "") === input.requestLabel
      && String(event.actor?.login || "").toLowerCase() === input.automationLogin.toLowerCase(),
    );
    return laterAutomationRemoval
      ? blockAmbiguousConsumption(input)
      : { kind: "cancelled", requestEventId: input.requestEventId };
  }
  if (latestAction !== "labeled" || !before.labels.has(input.requestLabel)) {
    return { kind: "cancelled", requestEventId: input.requestEventId };
  }

  let deletion: { status: number };
  try {
    deletion = input.github.deleteIssueLabel(input.repository, input.issueNumber, input.requestLabel);
  } catch {
    return blockAmbiguousConsumption(input);
  }
  if (deletion.status === 404) return { kind: "cancelled", requestEventId: input.requestEventId };
  if (deletion.status !== 200) return blockAmbiguousConsumption(input);

  let after: ReturnType<typeof observeRequest>;
  try {
    after = observeRequest(input);
  } catch {
    return blockAmbiguousConsumption(input);
  }
  const selectedLabelEvents = after.events.filter((event) =>
    compareIssueTimelineEvents(event, selected) > 0
    && String(event.label?.name || "") === input.requestLabel,
  );
  const ownRemoval = selectedLabelEvents.find((event) =>
    String(event.event || "").toLowerCase() === "unlabeled"
    && String(event.actor?.login || "").toLowerCase() === input.automationLogin.toLowerCase(),
  );
  if (!ownRemoval) return blockAmbiguousConsumption(input);

  const newerRequest = selectedLabelEvents.find((event) =>
    String(event.event || "").toLowerCase() === "labeled"
    && eventId(event) !== input.requestEventId,
  );
  if (newerRequest) {
    const latest = labelEvent(after.events, input.requestLabel);
    const latestAction = String(latest?.event || "").toLowerCase();
    const latestWasOurRemoval = eventId(latest) === eventId(ownRemoval);
    if (!after.labels.has(input.requestLabel) && (latestAction === "labeled" || latestWasOurRemoval)) {
      input.github.addIssueLabel(input.repository, input.issueNumber, input.requestLabel);
    }
    return { kind: "raced", requestEventId: input.requestEventId };
  }
  if (after.labels.has(input.requestLabel)) return { kind: "raced", requestEventId: input.requestEventId };

  try {
    input.persistConsumed();
  } catch {
    return blockAmbiguousConsumption(input);
  }
  return { kind: "consumed", requestEventId: input.requestEventId };
}

module.exports = {
  activeIssueRequestEvent,
  compareIssueTimelineEvents,
  consumeIssueRequest,
  explorationResultBody,
  persistSuccessfulExploration,
  trustedExplorationResultComment,
};
