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
  requestLabels: string[];
  requestLabel: string;
  requestEventId: string;
  inProgressLabel: string;
  blockedLabel: string;
  automationLogin: string;
  automationLogins: string[];
  attemptId: string;
  persistConsumed: () => void;
};

type IssueRequestTransitionOutcome =
  | { kind: "consumed"; requestEventId: string }
  | { kind: "cancelled"; requestEventId: string }
  | { kind: "raced"; requestEventId: string }
  | { kind: "recovery_blocked"; requestEventId: string }
  | { kind: "blocked_after_consumption"; requestEventId: string }
  | { kind: "superseded"; requestEventId: string }
  | { kind: "ambiguous_blocked"; requestEventId: string };

type PersistSuccessfulExplorationInput = {
  github: IssueRequestGithub;
  repository: string;
  issueNumber: number;
  requestLabel: string;
  requestEventId: string;
  inProgressLabel: string;
  automationLogin: string;
  automationLogins: string[];
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

/**
 * Answer whether an authorized Automation host wrote this event.
 *
 * A repository may be served by a fleet of hosts with different GitHub identities, all listed in the
 * project's authorized `automationLogins`. Attributing a timeline event to deadloop therefore means
 * membership in that set, not equality with the identity of the host reading it: one host must
 * recognize a peer's consumption and active state to arbitrate against it. A person's event belongs
 * to no authorized identity and stays foreign.
 */
function authorizedAutomationEvent(event: JsonObject | null | undefined, automationLogins: string[]): boolean {
  const login = String(event?.actor?.login || "").toLowerCase();
  return Boolean(login) && automationLogins.some((authorized) => authorized.trim().toLowerCase() === login);
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

function supersededConsumptionComment(input: ConsumeIssueRequestInput, restoredRequest = false): string {
  return [
    `<!-- deadloop:superseded-request-consumption:v1 attempt=${input.attemptId} -->`,
    "## Agent request was consumed by a concurrent attempt",
    "",
    `deadloop consumed the selected \`${input.requestLabel}\` request, then proved that the live \`${input.inProgressLabel}\` state belongs to another Agent request consumed in the same moment. No agent was launched for this request, and the attempt that owns that state was left running.`,
    "",
    ...(restoredRequest
      ? [
        `deadloop restored \`${input.requestLabel}\`, so this work stays queued for an attempt after the active one reports. Nothing is needed from you; remove that label to cancel it.`,
      ]
      : [
        "The consumed request was not restored because a newer generation of it had already changed on GitHub.",
        "To ask for this work again, add a new Agent request after the active attempt reports:",
        "",
        "```bash",
        `gh issue edit ${input.issueNumber} -R ${quoteShell(input.repository)} --add-label ${quoteShell(input.requestLabel)}`,
        "```",
      ]),
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
    && authorizedAutomationEvent(latest, input.automationLogins);
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
 * Prove this transition's own exact explanation for a request it already consumed.
 *
 * A consumed generation cannot be restored, so the operator-visible recovery interface is a new
 * Agent request and the explanation is the only thing that keeps the consumption visible. The
 * comment is deduplicated by authorized author and exact body, so a retry writes nothing new, and
 * no label is mutated here: every label involved is owned by whoever raised it.
 */
function proveConsumedRequestExplanation(input: ConsumeIssueRequestInput, body: string): void {
  if (!input.automationLogin.trim()) throw new Error("authorized Automation host login is required");
  let observation = observeStopState(input);
  if (!trustedExactComment(observation.comments, input.automationLogin, body)) {
    input.github.commentIssue(input.repository, input.issueNumber, body);
    observation = observeStopState(input);
  }
  if (!trustedExactComment(observation.comments, input.automationLogin, body)) {
    throw new Error("consumed-request explanation could not be proven");
  }
}

/**
 * Explain a stop that raced in after the selected request was provably consumed.
 */
function stopConsumedRequest(
  input: ConsumeIssueRequestInput,
  leftoverActiveState = false,
): IssueRequestTransitionOutcome {
  proveConsumedRequestExplanation(input, blockedConsumptionComment(input, leftoverActiveState));
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

type ExplorationCompletionObservation = {
  events: JsonObject[];
  labels: Set<string>;
  comments: JsonObject[];
};

type OwnedExplorationActiveState = {
  request: JsonObject;
  activation: JsonObject;
  active: boolean;
  removed: boolean;
};

function observeExplorationCompletion(
  input: PersistSuccessfulExplorationInput | PersistFailedExplorationInput,
): ExplorationCompletionObservation {
  const events = input.github.listIssueTimelineEvents(input.repository, input.issueNumber);
  const labels = new Set(input.github.listIssueLabels(input.repository, input.issueNumber).map(labelName).filter(Boolean));
  const comments = input.github.listIssueComments(input.repository, input.issueNumber);
  return { events, labels, comments };
}

function ownedActiveState(
  observation: ExplorationCompletionObservation,
  input: PersistSuccessfulExplorationInput | PersistFailedExplorationInput,
): OwnedExplorationActiveState | null {
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
    && authorizedAutomationEvent(event, input.automationLogins),
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

/**
 * Name this attempt's terminal block only while it is the live, newest stop on the Issue.
 *
 * The recorded block is evidence that a stop was written; it is not proof that the stop is still
 * visible. A block removed between its addition and the next observation would otherwise keep being
 * treated as terminal, so completion would clear the requests, release the active state, and then
 * fail its final proof on every retry, leaving an Issue with no workflow label at all. The live
 * block is also the request cutoff, which matches how recovery reads the newest block event.
 */
function liveTerminalBlockEvent(
  observation: ExplorationCompletionObservation,
  activeState: OwnedExplorationActiveState,
  input: PersistFailedExplorationInput,
): JsonObject | null {
  if (!observation.labels.has(input.blockedLabel)) return null;
  const latest = labelEvent(observation.events, input.blockedLabel);
  return latest && compareIssueTimelineEvents(latest, activeState.activation) > 0
    && String(latest.event || "").toLowerCase() === "labeled"
    && authorizedAutomationEvent(latest, input.automationLogins) ? latest : null;
}

function recordedTerminalBlockEvent(
  observation: ExplorationCompletionObservation,
  activeState: OwnedExplorationActiveState,
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

  // The stop must be live before anything else is cleared, and it is recreated when it was removed
  // after this attempt already wrote it: a retry has to restore the visible terminal state instead of
  // reusing an inactive historical block it can never prove again.
  let block = liveTerminalBlockEvent(observation, activeState, input);
  if (!block) {
    if (!activeState.active && !recordedTerminalBlockEvent(observation, activeState, input)) {
      throw new Error("exploration block is missing after active state removal");
    }
    input.github.addIssueLabel(input.repository, input.issueNumber, input.blockedLabel);
    observation = observeExplorationCompletion(input);
    activeState = ownedActiveState(observation, input);
    if (!activeState) throw new Error("exploration active state changed while blocking");
    block = liveTerminalBlockEvent(observation, activeState, input);
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
 *
 * `requestLabels` names every Agent request label an Issue can carry, in priority order, because the
 * roles compete for one active state: the transition must recognize the other role's consumption and
 * its rank to stay exclusive and to keep exploration ahead of implementation. `automationLogins` is
 * the authorized automation identity set that arbitration attributes events to, so a fleet of hosts
 * with different GitHub identities still resolves one winner; this host must belong to it.
 */
function consumeIssueRequest(input: ConsumeIssueRequestInput): IssueRequestTransitionOutcome {
  if (!input.requestLabels.includes(input.requestLabel)) {
    throw new Error("the selected Agent request label must be one of the Issue Agent request labels");
  }
  if (!input.automationLogin.trim()) throw new Error("authorized Automation host login is required");
  if (!authorizedAutomationEvent({ actor: { login: input.automationLogin } }, input.automationLogins)) {
    throw new Error("this Automation host login must be one of the authorized automation identities");
  }
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
      && authorizedAutomationEvent(event, input.automationLogins),
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

  return createActiveState(input, selected, ownRemoval);
}

/**
 * Start the current attempt window: the last proof on the timeline that no attempt was in flight.
 *
 * An active state that was released and a stop that was raised or cleared are deadloop's only
 * attempt boundaries on an Issue. A consumption before the newest boundary belongs to an attempt
 * that already ended, so it must not contend for the active state created afterwards; without this
 * bound the exploration consumption of a finished attempt would starve implementation forever.
 */
function attemptWindowStart(
  events: JsonObject[],
  input: ConsumeIssueRequestInput,
  activeState: JsonObject,
): JsonObject | null {
  const boundaries = events.filter((event) => {
    if (!eventId(event) || compareIssueTimelineEvents(event, activeState) >= 0) return false;
    const action = String(event.event || "").toLowerCase();
    const label = String(event.label?.name || "");
    if (label === input.inProgressLabel) return action === "unlabeled";
    return label === input.blockedLabel && (action === "labeled" || action === "unlabeled");
  });
  boundaries.sort(compareIssueTimelineEvents);
  return boundaries.at(-1) || null;
}

/**
 * Name the consumption that owns a live active state, using only stably ordered timeline facts.
 *
 * GitHub's label addition is idempotent: the second host to add `agent:in-progress` records no
 * second `labeled` event, so the label cannot say who created it, and the request-consumption
 * contract permits neither an ownership comment nor exclusion by comment time. What the timeline
 * does order is every automation-authored removal of an Agent request label, and one consumption
 * performs exactly one such removal immediately before it adds the active state.
 *
 * `requestLabels` is priority-ordered, exploration before implementation, because exploration must
 * run first so the Worker can read its persisted result. The active state therefore belongs to the
 * highest-priority role consumed inside the current attempt window, and within one role to the last
 * consumption ordered before the state's `labeled` event.
 *
 * Both directions of that rule are safe under a partial view. A host reads this timeline after its
 * own removal and its own addition, so a competitor already recorded can only take a win away: the
 * lower-priority role loses as soon as the other role's removal becomes visible, and it can never
 * gain a win by seeing more events. A competitor whose removal lands later is ordered after the
 * state's event, so it is not in the contest at all and the same rule hands the state to the earlier
 * consumption for both hosts. Plain role priority without the window would be unsafe in the other
 * direction, because a finished exploration would keep vetoing implementation.
 */
function activeStateOwner(
  events: JsonObject[],
  input: ConsumeIssueRequestInput,
  activeState: JsonObject,
): JsonObject | null {
  const start = attemptWindowStart(events, input, activeState);
  const consumptions = events.filter((event) => eventId(event)
    && String(event.event || "").toLowerCase() === "unlabeled"
    && input.requestLabels.includes(String(event.label?.name || ""))
    && authorizedAutomationEvent(event, input.automationLogins)
    && compareIssueTimelineEvents(event, activeState) < 0
    && (!start || compareIssueTimelineEvents(event, start) > 0));
  consumptions.sort(compareIssueTimelineEvents);
  let owner: JsonObject | null = null;
  let ownerPriority = input.requestLabels.length;
  for (const consumption of consumptions) {
    const priority = input.requestLabels.indexOf(String(consumption.label?.name || ""));
    if (priority <= ownerPriority) {
      owner = consumption;
      ownerPriority = priority;
    }
  }
  return owner;
}

/**
 * Create the active state for a consumed request and prove it before the durable receipt.
 *
 * The receipt is last on purpose: an interruption anywhere in here leaves a still-prepared attempt
 * that reconciliation owns, never a durably claimed attempt with no workspace. A block or a newer
 * request observed after the active state exists releases that state again and stops.
 *
 * An active state this attempt did not create is never adopted, and the check and the addition are
 * separate operations, so the addition being idempotent is not proof of creation either. A `labeled`
 * event some other author wrote in that gap therefore fails closed, and among automation-authored
 * events exclusivity comes from the timeline: exploration and implementation can be consumed by two
 * hosts in the same gap, and only the highest-priority consumption in that window may launch, so an
 * implementation consumption never takes the active state from a concurrent exploration. The loser
 * keeps its hands off the winner — no receipt, no release of that state — and puts its own request
 * back in the queue with an idempotent explanation instead of losing the work.
 */
function createActiveState(
  input: ConsumeIssueRequestInput,
  selected: JsonObject,
  ownRemoval: JsonObject,
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
  const latestActiveEvent = labelEvent(observation.events, input.inProgressLabel);
  const liveActiveState = observation.labels.has(input.inProgressLabel)
    && String(latestActiveEvent?.event || "").toLowerCase() === "labeled";
  // A person can add the active label inside the gap between the check above and the idempotent
  // addition. Only an automation-authored `labeled` event can belong to a request consumption, so a
  // foreign active state is never owned, never adopted, and never removed: it fails closed exactly
  // like an active state that was already visible before the addition.
  if (liveActiveState && !authorizedAutomationEvent(latestActiveEvent, input.automationLogins)) {
    return blockAmbiguousConsumption(input, true);
  }
  const activeState = liveActiveState ? latestActiveEvent : null;
  if (activeState) {
    const owner = activeStateOwner(observation.events, input, activeState);
    if (!owner) return blockAmbiguousConsumption(input, true);
    if (eventId(owner) !== eventId(ownRemoval)) {
      // The winner is running, so its active state is left alone: a stop would clear an Issue of the
      // state that attempt still needs, and releasing the state would strand its agent. This role's
      // intent is put back in the queue instead, so exploration keeps its documented priority
      // without the implementation request being lost.
      const restored = restoreConsumedRequest(input, ownRemoval);
      proveConsumedRequestExplanation(input, supersededConsumptionComment(input, restored));
      return { kind: "superseded", requestEventId: input.requestEventId };
    }
  }
  const blocked = observation.labels.has(input.blockedLabel)
    || issueLabelIsActive(observation.events, input.blockedLabel);
  const newerRequest = observation.labels.has(input.requestLabel)
    || observation.events.some((event) => compareIssueTimelineEvents(event, selected) > 0
      && String(event.event || "").toLowerCase() === "labeled"
      && String(event.label?.name || "") === input.requestLabel
      && eventId(event) !== input.requestEventId);
  if (blocked || newerRequest || !activeState) {
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

/**
 * Put back the request this transition removed but could not use, and prove it is queued again.
 *
 * This is not the automatic restoration the ambiguous stop forbids: there deadloop cannot tell its
 * own removal from a person's cancellation, while here it proved both its own removal event and that
 * a higher-priority consumption owns the active state. Restoring keeps the documented order for two
 * simultaneous roles — exploration runs now, this role stays queued for the attempt after it.
 *
 * A generation that changed on GitHub after this removal is never guessed back: only a timeline whose
 * newest event for the label is still this transition's own removal is restored, and a label already
 * present means a generation is queued and nothing needs adding.
 */
function restoreConsumedRequest(input: ConsumeIssueRequestInput, ownRemoval: JsonObject): boolean {
  try {
    const before = observeRequest(input);
    if (before.labels.has(input.requestLabel)) return true;
    if (eventId(labelEvent(before.events, input.requestLabel)) !== eventId(ownRemoval)) return false;
    input.github.addIssueLabel(input.repository, input.issueNumber, input.requestLabel);
    return observeRequest(input).labels.has(input.requestLabel);
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
