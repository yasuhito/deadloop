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
  | { kind: "recovery_blocked"; requestEventId: string }
  | { kind: "blocked_after_consumption"; requestEventId: string }
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

type PersistFailedExplorationInput = Omit<PersistSuccessfulExplorationInput, "resultBody"> & {
  requestLabels: string[];
  blockedLabel: string;
  failure: { reason: string; explanation: string; recovery: string };
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

function issueLabelIsActive(events: JsonObject[], label: string): boolean {
  return String(labelEvent(events, label)?.event || "").toLowerCase() === "labeled";
}

function issueRecoveryBlockCanBeCleared(
  events: JsonObject[],
  requestLabel: string,
  requestEventId: string,
  blockedLabel: string,
): boolean {
  const request = events.find((event) => eventId(event) === requestEventId
    && String(event.event || "").toLowerCase() === "labeled"
    && String(event.label?.name || "") === requestLabel);
  const block = labelEvent(events, blockedLabel);
  return Boolean(request && block
    && String(block.event || "").toLowerCase() === "labeled"
    && compareIssueTimelineEvents(request, block) > 0);
}

function issueRecoveryRequestIsEligible(events: JsonObject[], requestLabel: string, blockedLabel: string): boolean {
  const request = activeIssueRequestEvent(events, requestLabel);
  return Boolean(request && issueRecoveryBlockCanBeCleared(events, requestLabel, eventId(request), blockedLabel));
}

type IssueRequestObservation = {
  events: JsonObject[];
  labels: Set<string>;
  latest: JsonObject | null;
};

function observeRequest(input: ConsumeIssueRequestInput): IssueRequestObservation {
  const events = input.github.listIssueTimelineEvents(input.repository, input.issueNumber);
  const labels = new Set(input.github.listIssueLabels(input.repository, input.issueNumber).map(labelName).filter(Boolean));
  return { events, labels, latest: labelEvent(events, input.requestLabel) };
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function leftoverActiveStateGuidance(input: ConsumeIssueRequestInput): string[] {
  return [
    "",
    `deadloop could not prove removal of \`${input.inProgressLabel}\`, so this stop and that active state are visible together. Remove the active state before requesting a new attempt:`,
    "",
    "```bash",
    `gh issue edit ${input.issueNumber} -R ${quoteShell(input.repository)} --remove-label ${quoteShell(input.inProgressLabel)}`,
    "```",
  ];
}

function ambiguousComment(input: ConsumeIssueRequestInput, leftoverActiveState = false): string {
  return [
    `<!-- deadloop:ambiguous-request-consumption:v1 attempt=${input.attemptId} -->`,
    "## Agent request consumption could not be proven",
    "",
    `deadloop stopped before it could durably prove whether the selected \`${input.requestLabel}\` request was consumed. No agent was launched.`,
    "",
    "The request was not restored because removing it may have been a person's cancellation.",
    "To request a new attempt, add a new Agent request:",
    "",
    "```bash",
    `gh issue edit ${input.issueNumber} -R ${quoteShell(input.repository)} --add-label ${quoteShell(input.requestLabel)}`,
    "```",
    ...(leftoverActiveState ? leftoverActiveStateGuidance(input) : []),
  ].join("\n");
}

function blockedConsumptionComment(input: ConsumeIssueRequestInput, leftoverActiveState = false): string {
  return [
    `<!-- deadloop:blocked-request-consumption:v1 attempt=${input.attemptId} -->`,
    "## Agent request was consumed before a stop",
    "",
    `deadloop consumed the selected \`${input.requestLabel}\` request, then observed \`${input.blockedLabel}\` again before the attempt started. No agent was launched.`,
    "",
    "The consumed request was not restored because a stop holds no waiting Agent request.",
    "To request a new attempt, resolve the reported stop, then add a new Agent request:",
    "",
    "```bash",
    `gh issue edit ${input.issueNumber} -R ${quoteShell(input.repository)} --add-label ${quoteShell(input.requestLabel)}`,
    "```",
    ...(leftoverActiveState ? leftoverActiveStateGuidance(input) : []),
  ].join("\n");
}

type IssueStopObservation = {
  events: JsonObject[];
  labels: Set<string>;
  comments: JsonObject[];
};

function observeStopState(input: ConsumeIssueRequestInput): IssueStopObservation {
  return {
    events: input.github.listIssueTimelineEvents(input.repository, input.issueNumber),
    labels: new Set(input.github.listIssueLabels(input.repository, input.issueNumber).map(labelName).filter(Boolean)),
    comments: input.github.listIssueComments(input.repository, input.issueNumber),
  };
}

function automationAuthoredActiveBlock(
  observation: IssueStopObservation,
  input: ConsumeIssueRequestInput,
): boolean {
  const latest = labelEvent(observation.events, input.blockedLabel);
  return observation.labels.has(input.blockedLabel)
    && String(latest?.event || "").toLowerCase() === "labeled"
    && String(latest?.actor?.login || "").toLowerCase() === input.automationLogin.toLowerCase();
}

function blockAmbiguousConsumption(
  input: ConsumeIssueRequestInput,
  leftoverActiveState = false,
): IssueRequestTransitionOutcome {
  if (!input.automationLogin.trim()) throw new Error("authorized Automation host login is required");
  const body = ambiguousComment(input, leftoverActiveState);
  let observation = observeStopState(input);
  if (!automationAuthoredActiveBlock(observation, input)) {
    if (observation.labels.has(input.blockedLabel)) {
      throw new Error("ambiguous request-consumption block could not be proven");
    }
    input.github.addIssueLabel(input.repository, input.issueNumber, input.blockedLabel);
    observation = observeStopState(input);
  }
  if (!automationAuthoredActiveBlock(observation, input)) {
    throw new Error("ambiguous request-consumption block could not be proven");
  }
  if (!trustedExactComment(observation.comments, input.automationLogin, body)) {
    input.github.commentIssue(input.repository, input.issueNumber, body);
    observation = observeStopState(input);
  }
  if (!automationAuthoredActiveBlock(observation, input)
    || !trustedExactComment(observation.comments, input.automationLogin, body)) {
    throw new Error("ambiguous request-consumption recovery explanation could not be proven");
  }
  return { kind: "ambiguous_blocked", requestEventId: input.requestEventId };
}

/**
 * Explain a stop that raced in after the selected request was provably consumed.
 *
 * The consumed generation cannot be restored, so the operator-visible recovery interface is a new
 * Agent request. The stop label is owned by whoever raised it; this seam only proves its own exact
 * recovery explanation and never mutates a label.
 */
function stopConsumedRequest(
  input: ConsumeIssueRequestInput,
  leftoverActiveState = false,
): IssueRequestTransitionOutcome {
  if (!input.automationLogin.trim()) throw new Error("authorized Automation host login is required");
  const body = blockedConsumptionComment(input, leftoverActiveState);
  let observation = observeStopState(input);
  if (!trustedExactComment(observation.comments, input.automationLogin, body)) {
    input.github.commentIssue(input.repository, input.issueNumber, body);
    observation = observeStopState(input);
  }
  if (!trustedExactComment(observation.comments, input.automationLogin, body)) {
    throw new Error("consumed-request stop explanation could not be proven");
  }
  return { kind: "blocked_after_consumption", requestEventId: input.requestEventId };
}

function selectedRequestEvent(observation: IssueRequestObservation, input: ConsumeIssueRequestInput): JsonObject | null {
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

function trustedExactComment(comments: JsonObject[], automationLogin: string, body: string): JsonObject | null {
  return comments.find((comment) => {
    const login = String(comment.user?.login || comment.author?.login || "").toLowerCase();
    const created = String(comment.created_at || comment.createdAt || "");
    const updated = String(comment.updated_at || comment.updatedAt || "");
    return login === automationLogin.toLowerCase()
      && Boolean(created)
      && created === updated
      && String(comment.body || "") === body;
  }) || null;
}

function trustedExplorationResultComment(
  comments: JsonObject[],
  input: PersistSuccessfulExplorationInput,
): JsonObject | null {
  return trustedExactComment(comments, input.automationLogin, explorationResultBody(input));
}

function observeExplorationCompletion(input: PersistSuccessfulExplorationInput | PersistFailedExplorationInput) {
  const events = input.github.listIssueTimelineEvents(input.repository, input.issueNumber);
  const labels = new Set(input.github.listIssueLabels(input.repository, input.issueNumber).map(labelName).filter(Boolean));
  const comments = input.github.listIssueComments(input.repository, input.issueNumber);
  return { events, labels, comments };
}

function ownedActiveState(
  observation: ReturnType<typeof observeExplorationCompletion>,
  input: PersistSuccessfulExplorationInput | PersistFailedExplorationInput,
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

function failedExplorationBody(input: PersistFailedExplorationInput): string {
  return [
    `<!-- deadloop:issue-exploration-stop:v1 attempt=${input.attemptId} request=${input.requestEventId} reason=${input.failure.reason} -->`,
    "## deadloop exploration stopped",
    "",
    input.failure.explanation.trim(),
    "",
    input.failure.recovery.trim(),
    "",
    `To request a new exploration attempt, add \`${input.requestLabel}\` again.`,
  ].join("\n");
}

function terminalBlockEvent(
  observation: ReturnType<typeof observeExplorationCompletion>,
  activeState: NonNullable<ReturnType<typeof ownedActiveState>>,
  input: PersistFailedExplorationInput,
): JsonObject | null {
  return [...observation.events]
    .filter((event) => compareIssueTimelineEvents(event, activeState.activation) > 0
      && String(event.event || "").toLowerCase() === "labeled"
      && String(event.label?.name || "") === input.blockedLabel
      && String(event.actor?.login || "").toLowerCase() === input.automationLogin.toLowerCase())
    .sort(compareIssueTimelineEvents)[0] || null;
}

function activeLabelEventAfter(events: JsonObject[], label: string, cutoff: JsonObject): JsonObject | null {
  const latest = labelEvent(events, label);
  return latest && compareIssueTimelineEvents(latest, cutoff) > 0
    && String(latest.event || "").toLowerCase() === "labeled" ? latest : null;
}

/**
 * Persist one terminal exploration stop while preserving recovery requests ordered after its block.
 */
function persistFailedExploration(input: PersistFailedExplorationInput): { kind: "blocked"; requestEventId: string } {
  if (!input.automationLogin.trim()) throw new Error("authorized Automation host login is required");
  let observation = observeExplorationCompletion(input);
  let activeState = ownedActiveState(observation, input);
  if (!activeState) throw new Error("exploration active state is not owned by this attempt");

  let block = terminalBlockEvent(observation, activeState, input);
  if (!block) {
    if (!activeState.active) throw new Error("exploration block is missing after active state removal");
    input.github.addIssueLabel(input.repository, input.issueNumber, input.blockedLabel);
    observation = observeExplorationCompletion(input);
    activeState = ownedActiveState(observation, input);
    if (!activeState) throw new Error("exploration active state changed while blocking");
    block = terminalBlockEvent(observation, activeState, input);
    if (!block) throw new Error("exploration terminal block could not be proven");
  }

  const body = failedExplorationBody(input);
  if (!trustedExactComment(observation.comments, input.automationLogin, body)) {
    input.github.commentIssue(input.repository, input.issueNumber, body);
    observation = observeExplorationCompletion(input);
    activeState = ownedActiveState(observation, input);
    if (!activeState || !trustedExactComment(observation.comments, input.automationLogin, body)) {
      throw new Error("exploration stop explanation could not be proven");
    }
  }

  for (const requestLabel of input.requestLabels) {
    let latest = labelEvent(observation.events, requestLabel);
    const erasedPostBlockRequest = [...observation.events]
      .filter((event) => compareIssueTimelineEvents(event, block) > 0
        && String(event.event || "").toLowerCase() === "labeled"
        && String(event.label?.name || "") === requestLabel)
      .sort(compareIssueTimelineEvents).at(-1);
    if (erasedPostBlockRequest && !observation.labels.has(requestLabel)
      && String(latest?.event || "").toLowerCase() === "unlabeled"
      && String(latest?.actor?.login || "").toLowerCase() === input.automationLogin.toLowerCase()
      && compareIssueTimelineEvents(latest, erasedPostBlockRequest) > 0) {
      input.github.addIssueLabel(input.repository, input.issueNumber, requestLabel);
      observation = observeExplorationCompletion(input);
      activeState = ownedActiveState(observation, input);
      if (!activeState) throw new Error("exploration active state changed while restoring a recovery request");
      latest = labelEvent(observation.events, requestLabel);
    }
    if (!latest || compareIssueTimelineEvents(latest, block) > 0
      || String(latest.event || "").toLowerCase() !== "labeled"
      || !observation.labels.has(requestLabel)) continue;
    const deletion = input.github.deleteIssueLabel(input.repository, input.issueNumber, requestLabel);
    if (deletion.status !== 200 && deletion.status !== 404) {
      throw new Error("pre-block exploration request removal could not be proven");
    }
    observation = observeExplorationCompletion(input);
    activeState = ownedActiveState(observation, input);
    if (!activeState) throw new Error("exploration active state changed while clearing requests");
    const postBlockRequest = [...observation.events]
      .filter((event) => compareIssueTimelineEvents(event, block) > 0
        && String(event.event || "").toLowerCase() === "labeled"
        && String(event.label?.name || "") === requestLabel)
      .sort(compareIssueTimelineEvents).at(-1);
    const current = labelEvent(observation.events, requestLabel);
    if (postBlockRequest && !observation.labels.has(requestLabel)
      && String(current?.event || "").toLowerCase() === "unlabeled"
      && String(current?.actor?.login || "").toLowerCase() === input.automationLogin.toLowerCase()) {
      input.github.addIssueLabel(input.repository, input.issueNumber, requestLabel);
      observation = observeExplorationCompletion(input);
      activeState = ownedActiveState(observation, input);
      if (!activeState) throw new Error("exploration active state changed while restoring a recovery request");
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

  const requestsAreTerminal = input.requestLabels.every((label) =>
    !observation.labels.has(label) || Boolean(activeLabelEventAfter(observation.events, label, block)));
  if (!activeState || activeState.active || !activeState.removed
    || !observation.labels.has(input.blockedLabel) || !requestsAreTerminal
    || !trustedExactComment(observation.comments, input.automationLogin, body)) {
    throw new Error("exploration terminal GitHub persistence could not be proven");
  }
  input.persistGithub();
  return { kind: "blocked", requestEventId: input.requestEventId };
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
  if (before.labels.has(input.blockedLabel) || issueLabelIsActive(before.events, input.blockedLabel)) {
    return { kind: "recovery_blocked", requestEventId: input.requestEventId };
  }

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

  let after: IssueRequestObservation;
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
  if (after.labels.has(input.blockedLabel) || issueLabelIsActive(after.events, input.blockedLabel)) {
    return stopConsumedRequest(input);
  }

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

  return createActiveState(input, selected);
}

/**
 * Create the active state for a consumed request and prove it before the durable receipt.
 *
 * The receipt is last on purpose: an interruption anywhere in here leaves a still-prepared attempt
 * that reconciliation owns, never a durably claimed attempt with no workspace. A block or a newer
 * request observed after the active state exists releases that state again and stops.
 *
 * An active state this attempt did not create is never adopted. GitHub exposes no attempt identity
 * on a label, so a pre-existing `agent:in-progress` may belong to another host that consumed the
 * other role in the same gap. Adopting it would let two attempts launch and would let this stop
 * delete their state, so an unproven active state fails closed and is left untouched.
 */
function createActiveState(
  input: ConsumeIssueRequestInput,
  selected: JsonObject,
): IssueRequestTransitionOutcome {
  let observation: IssueRequestObservation;
  try {
    if (observeRequest(input).labels.has(input.inProgressLabel)) {
      return blockAmbiguousConsumption(input, true);
    }
    input.github.addIssueLabel(input.repository, input.issueNumber, input.inProgressLabel);
    observation = observeRequest(input);
  } catch {
    return blockAmbiguousConsumption(input, !releaseActiveState(input));
  }
  const blocked = observation.labels.has(input.blockedLabel)
    || issueLabelIsActive(observation.events, input.blockedLabel);
  const newerRequest = observation.labels.has(input.requestLabel)
    || observation.events.some((event) => compareIssueTimelineEvents(event, selected) > 0
      && String(event.event || "").toLowerCase() === "labeled"
      && String(event.label?.name || "") === input.requestLabel
      && eventId(event) !== input.requestEventId);
  if (blocked || newerRequest || !observation.labels.has(input.inProgressLabel)) {
    const released = releaseActiveState(input);
    if (blocked) return stopConsumedRequest(input, !released);
    if (!released) return blockAmbiguousConsumption(input, true);
    if (newerRequest) return { kind: "raced", requestEventId: input.requestEventId };
    return blockAmbiguousConsumption(input);
  }

  try {
    input.persistConsumed();
  } catch {
    return blockAmbiguousConsumption(input, !releaseActiveState(input));
  }
  return { kind: "consumed", requestEventId: input.requestEventId };
}

/**
 * Remove the active state this transition created and prove it is gone.
 *
 * A stop must never be reported beside a live active state: the caller releases the prepared
 * attempt, so an Issue left in progress would carry no live and no durable attempt. When removal
 * cannot be proven the stop says so instead of claiming a clean release. Only the label this
 * transition created is removed; the unbound case never reaches here.
 */
function releaseActiveState(input: ConsumeIssueRequestInput): boolean {
  try {
    if (!observeRequest(input).labels.has(input.inProgressLabel)) return true;
    const deletion = input.github.deleteIssueLabel(input.repository, input.issueNumber, input.inProgressLabel);
    if (deletion.status !== 200 && deletion.status !== 404) return false;
    return !observeRequest(input).labels.has(input.inProgressLabel);
  } catch {
    return false;
  }
}

module.exports = {
  activeIssueRequestEvent,
  compareIssueTimelineEvents,
  consumeIssueRequest,
  explorationResultBody,
  failedExplorationBody,
  issueLabelIsActive,
  issueRecoveryBlockCanBeCleared,
  issueRecoveryRequestIsEligible,
  persistFailedExploration,
  persistSuccessfulExploration,
  trustedExplorationResultComment,
};
