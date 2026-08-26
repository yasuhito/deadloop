import { describe, expect, it } from "vitest";

const {
  consumeIssueRequest,
  issueRecoveryBlockCanBeCleared,
  persistIssueAttemptStop,
  persistSuccessfulExploration,
} = require("../src/issue-request-transition.cts");

type Event = {
  id: string;
  event: "labeled" | "unlabeled";
  created_at: string;
  actor: { login: string };
  label: { name: string };
};

function scenario(options: {
  requestLabel?: "agent:implement" | "agent:explore";
  requestLabels?: string[];
  beforeDelete?: (state: ReturnType<typeof createState>) => void;
  duringDelete?: (state: ReturnType<typeof createState>) => void;
  afterActiveState?: (state: ReturnType<typeof createState>) => void;
  afterFinishedExploration?: boolean;
  foreignActiveStateDuringAdd?: boolean;
  activeStateAlreadyPresent?: boolean;
  activeStateReleaseFails?: boolean;
  observationFailsAfterActiveState?: boolean;
  deleteStatus?: number;
  persistError?: string;
  blockDuringObservation?: boolean;
  removeBlockAfterAdd?: boolean;
  copiedComment?: { body: string; login: string };
  automationLogins?: string[];
  automationLogin?: string;
  retry?: boolean;
} = {}) {
  const state = createState();
  const automationLogin = options.automationLogin ?? "deadloop-bot";
  let persisted = false;
  let launches = 0;
  if (options.activeStateAlreadyPresent) state.label("agent:in-progress", automationLogin);
  if (options.afterFinishedExploration) {
    state.unlabel("agent:explore", automationLogin);
    state.label("agent:in-progress", automationLogin);
    state.unlabel("agent:in-progress", automationLogin);
  }
  if (options.copiedComment) {
    const timestamp = "2026-08-16T00:00:30Z";
    state.comments.push({
      id: "copied-comment",
      body: options.copiedComment.body,
      user: { login: options.copiedComment.login },
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  const trace: string[] = [];
  let pendingObservationFailures = 0;
  const github = {
    listIssueLabels: () => {
      if (pendingObservationFailures > 0) {
        pendingObservationFailures -= 1;
        throw new Error("observation unavailable");
      }
      if (options.blockDuringObservation) state.label("agent:blocked", "human");
      return [...state.labels].map((name) => ({ name }));
    },
    listIssueTimelineEvents: () => [...state.events],
    listIssueComments: () => state.comments,
    addIssueLabel: (_repo: string, _number: number, label: string) => {
      trace.push(`add:${label}`);
      // A person adds the active label inside the gap between the pre-add check and this addition,
      // so deadloop's own addition becomes the idempotent no-op GitHub records no event for.
      if (label === "agent:in-progress" && options.foreignActiveStateDuringAdd) state.label(label, "human");
      state.label(label, automationLogin);
      if (label === "agent:blocked" && options.removeBlockAfterAdd) state.unlabel(label, "human");
      if (label === "agent:in-progress") {
        if (options.observationFailsAfterActiveState) pendingObservationFailures = 1;
        options.afterActiveState?.(state);
      }
    },
    deleteIssueLabel: (_repo: string, _number: number, label: string) => {
      trace.push(`delete:${label}`);
      if (label === "agent:in-progress" && options.activeStateReleaseFails) return { status: 500 };
      options.beforeDelete?.(state);
      if (!state.labels.has(label)) return { status: 404 };
      state.unlabel(label, "deadloop-bot");
      options.duringDelete?.(state);
      return { status: options.deleteStatus ?? 200 };
    },
    commentIssue: (_repo: string, _number: number, body: string) => {
      const timestamp = "2026-08-16T00:01:00Z";
      state.comments.push({
        id: `comment-${state.comments.length + 1}`,
        body,
        user: { login: automationLogin },
        created_at: timestamp,
        updated_at: timestamp,
      });
    },
  };
  const requestLabel = options.requestLabel || "agent:implement";
  const input = {
    github,
    repository: "owner/repo",
    issueNumber: 42,
    requestLabels: options.requestLabels || ["agent:explore", "agent:implement"],
    requestLabel,
    requestEventId: requestLabel === "agent:explore" ? "2" : "1",
    inProgressLabel: "agent:in-progress",
    blockedLabel: "agent:blocked",
    automationLogin,
    automationLogins: options.automationLogins ?? [automationLogin],
    attemptId: "attempt-42",
    persistConsumed: () => {
      trace.push("persist");
      if (options.persistError) throw new Error(options.persistError);
      persisted = true;
    },
  };
  let outcome = consumeIssueRequest(input);
  if (options.retry) outcome = consumeIssueRequest(input);
  if (outcome.kind === "consumed") launches += 1;
  return { outcome, labels: [...state.labels], events: state.events, comments: state.comments, persisted, launches, trace };
}

function createState() {
  const labels = new Set(["agent:implement", "agent:explore", "customer:urgent"]);
  const events: Event[] = [
    { id: "1", event: "labeled", created_at: "2026-08-16T00:00:00Z", actor: { login: "human" }, label: { name: "agent:implement" } },
    { id: "2", event: "labeled", created_at: "2026-08-16T00:00:00Z", actor: { login: "human" }, label: { name: "agent:explore" } },
    { id: "3", event: "labeled", created_at: "2026-08-16T00:00:00Z", actor: { login: "human" }, label: { name: "customer:urgent" } },
  ];
  const comments: Array<{
    id: string;
    body: string;
    user: { login: string };
    created_at: string;
    updated_at: string;
  }> = [];
  let nextId = 10;
  const emit = (event: "labeled" | "unlabeled", label: string, login: string) => events.push({
    id: String(nextId++), event, created_at: "2026-08-16T00:00:01Z", actor: { login }, label: { name: label },
  });
  return {
    labels,
    events,
    comments,
    label(label: string, login: string, createdAt?: string) {
      if (!labels.has(label)) {
        labels.add(label);
        const before = events.length;
        emit("labeled", label, login);
        if (createdAt && events[before]) events[before].created_at = createdAt;
      }
    },
    unlabel(label: string, login: string, createdAt?: string) {
      if (labels.delete(label)) {
        const before = events.length;
        emit("unlabeled", label, login);
        if (createdAt && events[before]) events[before].created_at = createdAt;
      }
    },
  };
}

// Two Automation hosts consume the two Issue roles for one Issue at the same time. The interleaving
// is the reported race: the first host passes its pre-add active-state check, the second host then
// runs its whole transition, and only afterwards does the first host's idempotent addition land.
function concurrentRolesScenario(options: {
  firstRole?: "agent:explore" | "agent:implement";
  copiedComment?: { body: string; login: string };
  racedGenerationAfterLoss?: boolean;
  explorerLogin?: string;
  implementLogin?: string;
} = {}) {
  const state = createState();
  // Two hosts can serve one repository under different authorized GitHub identities, so each role
  // writes as its own host and both identities are authorized for the project.
  const explorerLogin = options.explorerLogin ?? "deadloop-bot";
  const implementLogin = options.implementLogin ?? "deadloop-bot";
  const automationLogins = [...new Set([explorerLogin, implementLogin])];
  const loginFor = (role: string) => role === "agent:explore" ? explorerLogin : implementLogin;
  const firstRole = options.firstRole || "agent:explore";
  const secondRole = firstRole === "agent:explore" ? "agent:implement" : "agent:explore";
  let actingLogin = loginFor(firstRole);
  if (options.copiedComment) {
    const timestamp = "2026-08-16T00:00:30Z";
    state.comments.push({
      id: "copied-comment",
      body: options.copiedComment.body,
      user: { login: options.copiedComment.login },
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  const trace: string[] = [];
  const receipts: string[] = [];
  let interleaved = false;
  let second: { kind: string } | null = null;
  function inputFor(role: string) {
    return {
      github,
      repository: "owner/repo",
      issueNumber: 42,
      requestLabels: ["agent:explore", "agent:implement"],
      requestLabel: role,
      requestEventId: role === "agent:explore" ? "2" : "1",
      inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
      automationLogin: loginFor(role),
      automationLogins,
      attemptId: `attempt-${role}`,
      persistConsumed: () => { receipts.push(role); },
    };
  }
  const github = {
    listIssueLabels: () => [...state.labels].map((name) => ({ name })),
    listIssueTimelineEvents: () => [...state.events],
    listIssueComments: () => state.comments,
    addIssueLabel: (_repo: string, _number: number, label: string) => {
      trace.push(`add:${label}`);
      if (label === "agent:in-progress" && !interleaved) {
        interleaved = true;
        actingLogin = loginFor(secondRole);
        second = consumeIssueRequest(inputFor(secondRole));
        actingLogin = loginFor(firstRole);
        // A person adds and cancels this role's request while the losing host is still deciding, so
        // the newest event for that label is no longer the removal it proved.
        if (options.racedGenerationAfterLoss) {
          state.label(firstRole, "human");
          state.unlabel(firstRole, "human");
        }
      }
      state.label(label, actingLogin);
    },
    deleteIssueLabel: (_repo: string, _number: number, label: string) => {
      trace.push(`delete:${label}`);
      if (!state.labels.has(label)) return { status: 404 };
      state.unlabel(label, actingLogin);
      return { status: 200 };
    },
    commentIssue: (_repo: string, _number: number, body: string) => {
      const timestamp = "2026-08-16T00:01:00Z";
      state.comments.push({
        id: `comment-${state.comments.length + 1}`,
        body,
        user: { login: actingLogin },
        created_at: timestamp,
        updated_at: timestamp,
      });
    },
  };
  const first = consumeIssueRequest(inputFor(firstRole));
  const outcomes: Record<string, { kind: string } | null> = { [firstRole]: first, [secondRole]: second };
  return {
    explore: outcomes["agent:explore"] as { kind: string },
    implement: outcomes["agent:implement"] as { kind: string },
    launches: [first, second].filter((outcome) => outcome?.kind === "consumed").length,
    receipts,
    labels: [...state.labels],
    comments: state.comments,
    trace,
  };
}

function explorationCompletionScenario(options: {
  requestBeforeCompletion?: string;
  copiedResultLogin?: string;
  requestDuringComment?: string;
  requestDuringDelete?: string;
  interruptAfterComment?: boolean;
  interruptAfterDelete?: boolean;
  newerAttemptBeforeRetry?: boolean;
  retry?: boolean;
} = {}) {
  const state = createState();
  state.unlabel("agent:explore", "deadloop-bot");
  state.label("agent:in-progress", "deadloop-bot");
  if (options.requestDuringComment) state.unlabel(options.requestDuringComment, "human");
  if (options.requestDuringDelete) state.unlabel(options.requestDuringDelete, "human");
  if (options.requestBeforeCompletion) state.label(options.requestBeforeCompletion, "human");
  const comments: Array<{ id: string; body: string; user: { login: string }; created_at: string; updated_at: string }> = [];
  if (options.copiedResultLogin) {
    const timestamp = "2026-08-16T00:00:30Z";
    comments.push({
      id: "copied-comment",
      body: "## deadloop exploration\n\nResult.\n\n<!-- deadloop:issue-exploration-result:v1 attempt=attempt-42 request=2 -->",
      user: { login: options.copiedResultLogin },
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  let persisted = false;
  let commentInterrupted = false;
  let deleteInterrupted = false;
  const github = {
    listIssueLabels: () => [...state.labels].map((name) => ({ name })),
    listIssueTimelineEvents: () => state.events,
    listIssueComments: () => comments,
    addIssueLabel: (_repo: string, _number: number, label: string) => state.label(label, "deadloop-bot"),
    deleteIssueLabel: (_repo: string, _number: number, label: string) => {
      if (!state.labels.has(label)) return { status: 404 };
      state.unlabel(label, "deadloop-bot");
      if (options.requestDuringDelete) state.label(options.requestDuringDelete, "human");
      if (options.interruptAfterDelete && !deleteInterrupted) {
        deleteInterrupted = true;
        throw new Error("interrupted after label deletion");
      }
      return { status: 200 };
    },
    commentIssue: (_repo: string, _number: number, body: string) => {
      const timestamp = "2026-08-16T00:01:00Z";
      comments.push({ id: `comment-${comments.length + 1}`, body, user: { login: "deadloop-bot" }, created_at: timestamp, updated_at: timestamp });
      if (options.requestDuringComment) state.label(options.requestDuringComment, "human");
      if (options.interruptAfterComment && !commentInterrupted) {
        commentInterrupted = true;
        throw new Error("interrupted after comment");
      }
    },
  };
  const input = {
    github,
    repository: "owner/repo",
    issueNumber: 42,
    requestLabel: "agent:explore",
    requestEventId: "2",
    inProgressLabel: "agent:in-progress",
    automationLogin: "deadloop-bot",
    automationLogins: ["deadloop-bot"],
    attemptId: "attempt-42",
    resultBody: "## deadloop exploration\n\nResult.",
    persistGithub: () => { persisted = true; },
  };
  let outcome;
  try { outcome = persistSuccessfulExploration(input); } catch (error) { outcome = { kind: "interrupted", error }; }
  if (options.newerAttemptBeforeRetry) state.label("agent:in-progress", "deadloop-bot");
  if (options.retry) outcome = persistSuccessfulExploration(input);
  return { comments, labels: [...state.labels], outcome, persisted };
}

function failedExplorationScenario(options: {
  requestDuringBlock?: string;
  interruptAfterBlock?: boolean;
  blockRemovedAfterAdd?: boolean;
  interruptAfterRequestDelete?: boolean;
  raceRequestDuringDelete?: string;
  retry?: boolean;
  eventTime?: string;
} = {}) {
  const state = createState();
  state.unlabel("agent:explore", "deadloop-bot");
  state.label("agent:in-progress", "deadloop-bot");
  let persisted = false;
  let blockInterrupted = false;
  let blockRemoved = false;
  let requestDeleteInterrupted = false;
  const comments: Array<{ body: string; user: { login: string }; created_at: string; updated_at: string }> = [];
  const github = {
    listIssueLabels: () => [...state.labels].map((name) => ({ name })),
    listIssueTimelineEvents: () => state.events,
    listIssueComments: () => comments,
    addIssueLabel: (_repo: string, _number: number, label: string) => {
      state.label(label, "deadloop-bot", options.eventTime);
      if (label === "agent:blocked" && options.requestDuringBlock) {
        state.label(options.requestDuringBlock, "human", options.eventTime);
      }
      // A person removes the terminal block between its addition and the next observation, so the
      // recorded block event survives on the timeline while the stop itself is no longer visible.
      if (label === "agent:blocked" && options.blockRemovedAfterAdd && !blockRemoved) {
        blockRemoved = true;
        state.unlabel(label, "human", options.eventTime);
      }
      if (label === "agent:blocked" && options.interruptAfterBlock && !blockInterrupted) {
        blockInterrupted = true;
        throw new Error("interrupted after block");
      }
    },
    deleteIssueLabel: (_repo: string, _number: number, label: string) => {
      if (!state.labels.has(label)) return { status: 404 };
      if (options.raceRequestDuringDelete === label && !requestDeleteInterrupted) {
        state.unlabel(label, "human", options.eventTime);
        state.label(label, "human", options.eventTime);
      }
      state.unlabel(label, "deadloop-bot", options.eventTime);
      if (label !== "agent:in-progress" && options.interruptAfterRequestDelete && !requestDeleteInterrupted) {
        requestDeleteInterrupted = true;
        throw new Error("interrupted after request deletion");
      }
      return { status: 200 };
    },
    commentIssue: (_repo: string, _number: number, body: string) => {
      const timestamp = "2026-08-16T00:02:00Z";
      comments.push({ body, user: { login: "deadloop-bot" }, created_at: timestamp, updated_at: timestamp });
    },
  };
  const input = {
    github,
    repository: "owner/repo",
    issueNumber: 42,
    requestLabels: ["agent:explore", "agent:implement"],
    requestLabel: "agent:explore",
    requestEventId: "2",
    inProgressLabel: "agent:in-progress",
    blockedLabel: "agent:blocked",
    automationLogin: "deadloop-bot",
    automationLogins: ["deadloop-bot"],
    attemptId: "attempt-42",
    failure: {
      reason: "exploration_failed",
      explanation: "The explorer could not prove a safe result.",
      recovery: "Correct the cause, then add the exploration request again.",
    },
    stopNoun: "exploration",
    persistGithub: () => { persisted = true; },
  };
  let outcome;
  try { outcome = persistIssueAttemptStop(input); } catch (error) { outcome = { kind: "interrupted", error }; }
  if (options.retry) outcome = persistIssueAttemptStop(input);
  return { comments, events: state.events, labels: [...state.labels], outcome, persisted };
}

describe("Issue Agent request transition", () => {
  it("persists consumption after the selected request is removed", () => {
    expect(scenario().persisted).toBe(true);
  });

  it("removes only the selected request label", () => {
    expect(scenario().labels).toEqual(["agent:explore", "customer:urgent", "agent:in-progress"]);
  });

  it("emits the production unlabeled event for consumption", () => {
    expect(scenario().events.filter((event) => event.event === "unlabeled" && event.label.name === "agent:implement"))
      .toHaveLength(1);
  });

  it("creates the active state for a consumed request", () => {
    expect(scenario().labels).toContain("agent:in-progress");
  });

  it("proves the active state before writing the durable receipt", () => {
    expect(scenario().trace.indexOf("add:agent:in-progress")).toBeLessThan(scenario().trace.indexOf("persist"));
  });

  it("stops instead of launching when a block races the active state", () => {
    expect(scenario({ afterActiveState: (state) => state.label("agent:blocked", "human") }).outcome.kind)
      .toBe("blocked_after_consumption");
  });

  it("releases the active state it created when a block races it", () => {
    expect(scenario({ afterActiveState: (state) => state.label("agent:blocked", "human") }).labels)
      .not.toContain("agent:in-progress");
  });

  it("writes no durable receipt when a block races the active state", () => {
    expect(scenario({ afterActiveState: (state) => state.label("agent:blocked", "human") }).persisted).toBe(false);
  });

  it("yields to a newer request that races the active state", () => {
    expect(scenario({ afterActiveState: (state) => state.label("agent:implement", "human") }).outcome.kind)
      .toBe("raced");
  });

  it("releases the active state it created when a newer request races it", () => {
    expect(scenario({ afterActiveState: (state) => state.label("agent:implement", "human") }).labels)
      .not.toContain("agent:in-progress");
  });

  it("fails closed on an active state this attempt did not create", () => {
    expect(scenario({ activeStateAlreadyPresent: true }).outcome.kind).toBe("ambiguous_blocked");
  });

  it("does not adopt an active state this attempt did not create", () => {
    expect(scenario({ activeStateAlreadyPresent: true }).trace.filter((entry) => entry === "add:agent:in-progress"))
      .toHaveLength(0);
  });

  it("leaves an active state it does not own in place", () => {
    expect(scenario({ activeStateAlreadyPresent: true }).labels).toContain("agent:in-progress");
  });

  it("writes no durable receipt for an active state it does not own", () => {
    expect(scenario({ activeStateAlreadyPresent: true }).persisted).toBe(false);
  });

  it("names the foreign active state in its stop explanation", () => {
    expect(scenario({ activeStateAlreadyPresent: true }).comments[0].body)
      .toContain("--remove-label 'agent:in-progress'");
  });

  it("launches at most one of two roles consumed in the same gap", () => {
    expect(concurrentRolesScenario().launches).toBe(1);
  });

  it("launches at most one when implementation is consumed before exploration", () => {
    expect(concurrentRolesScenario({ firstRole: "agent:implement" }).launches).toBe(1);
  });

  it("hands the active state to exploration when both roles are consumed in the same gap", () => {
    expect(concurrentRolesScenario().explore.kind).toBe("consumed");
  });

  it("keeps exploration's win when it is consumed second", () => {
    expect(concurrentRolesScenario({ firstRole: "agent:implement" }).explore.kind).toBe("consumed");
  });

  it("supersedes implementation consumed beside an exploration consumption", () => {
    expect(concurrentRolesScenario().implement.kind).toBe("superseded");
  });

  it("supersedes implementation consumed first when exploration follows in the same gap", () => {
    expect(concurrentRolesScenario({ firstRole: "agent:implement" }).implement.kind).toBe("superseded");
  });

  it("writes one durable receipt for two roles consumed in the same gap", () => {
    expect(concurrentRolesScenario().receipts).toEqual(["agent:explore"]);
  });

  it("leaves the winning active state in place", () => {
    expect(concurrentRolesScenario().labels).toContain("agent:in-progress");
  });

  it("never releases an active state another consumption owns", () => {
    expect(concurrentRolesScenario().trace.filter((entry) => entry === "delete:agent:in-progress"))
      .toHaveLength(0);
  });

  it("keeps the implementation request queued when exploration wins", () => {
    expect(concurrentRolesScenario().labels).toContain("agent:implement");
  });

  it("tells a person nothing is needed for a restored implementation request", () => {
    expect(concurrentRolesScenario().comments[0].body)
      .toContain("deadloop restored `agent:implement`, so this work stays queued");
  });

  it("does not guess back a superseded request whose generation changed on GitHub", () => {
    expect(concurrentRolesScenario({ firstRole: "agent:implement", racedGenerationAfterLoss: true }).labels)
      .not.toContain("agent:implement");
  });

  it("explains how to ask again when a superseded request cannot be restored", () => {
    expect(concurrentRolesScenario({ firstRole: "agent:implement", racedGenerationAfterLoss: true }).comments[0].body)
      .toContain("--add-label 'agent:implement'");
  });

  it("launches at most one when two authorized identities consume the two roles", () => {
    expect(concurrentRolesScenario({ explorerLogin: "deadloop-explorer", implementLogin: "deadloop-worker" }).launches)
      .toBe(1);
  });

  it("hands the active state to exploration across two authorized identities", () => {
    expect(concurrentRolesScenario({ explorerLogin: "deadloop-explorer", implementLogin: "deadloop-worker" }).explore.kind)
      .toBe("consumed");
  });

  it("supersedes a peer identity's implementation consumption instead of stopping it", () => {
    expect(concurrentRolesScenario({ explorerLogin: "deadloop-explorer", implementLogin: "deadloop-worker" }).implement.kind)
      .toBe("superseded");
  });

  it("leaves no stop beside the active state a peer identity created", () => {
    expect(concurrentRolesScenario({ explorerLogin: "deadloop-explorer", implementLogin: "deadloop-worker" }).labels)
      .not.toContain("agent:blocked");
  });

  it("rejects a host login outside the authorized automation identities", () => {
    expect(() => scenario({ automationLogins: ["other-bot"] }))
      .toThrow("this Automation host login must be one of the authorized automation identities");
  });

  it("fails closed on an active state a person created in the check-and-add gap", () => {
    expect(scenario({ foreignActiveStateDuringAdd: true }).outcome.kind).toBe("ambiguous_blocked");
  });

  it("leaves an active state a person created in the check-and-add gap in place", () => {
    expect(scenario({ foreignActiveStateDuringAdd: true }).labels).toContain("agent:in-progress");
  });

  it("writes no durable receipt for an active state a person created in the check-and-add gap", () => {
    expect(scenario({ foreignActiveStateDuringAdd: true }).persisted).toBe(false);
  });

  it("does not trust a copied superseded explanation from another commenter", () => {
    const body = concurrentRolesScenario().comments[0].body;
    expect(concurrentRolesScenario({ copiedComment: { body, login: "intruder" } }).comments).toHaveLength(2);
  });

  it("launches implementation after an exploration attempt released its active state", () => {
    expect(scenario({ afterFinishedExploration: true }).outcome.kind).toBe("consumed");
  });

  it("rejects a selected request label outside the Issue Agent request labels", () => {
    expect(() => scenario({ requestLabels: ["agent:explore"] }))
      .toThrow("the selected Agent request label must be one of the Issue Agent request labels");
  });

  it("removes the active state when the durable receipt fails", () => {
    expect(scenario({ persistError: "interrupted" }).labels).not.toContain("agent:in-progress");
  });

  it("stops when the observation right after active-state creation fails", () => {
    expect(scenario({ observationFailsAfterActiveState: true }).outcome.kind).toBe("ambiguous_blocked");
  });

  it("removes the active state when the observation right after its creation fails", () => {
    expect(scenario({ observationFailsAfterActiveState: true }).labels).not.toContain("agent:in-progress");
  });

  it("names the active state left behind when observation and release both fail", () => {
    expect(scenario({ observationFailsAfterActiveState: true, activeStateReleaseFails: true }).comments[0].body)
      .toContain("--remove-label 'agent:in-progress'");
  });

  it("reports a consumed-request stop when it cannot remove the active state beside a block", () => {
    expect(scenario({
      afterActiveState: (state) => state.label("agent:blocked", "human"),
      activeStateReleaseFails: true,
    }).outcome.kind).toBe("blocked_after_consumption");
  });

  it("names the active state it could not remove beside a block", () => {
    expect(scenario({
      afterActiveState: (state) => state.label("agent:blocked", "human"),
      activeStateReleaseFails: true,
    }).comments[0].body).toContain("--remove-label 'agent:in-progress'");
  });

  it("does not report a race beside an active state it could not remove", () => {
    expect(scenario({
      afterActiveState: (state) => state.label("agent:implement", "human"),
      activeStateReleaseFails: true,
    }).outcome.kind).toBe("ambiguous_blocked");
  });

  it("names the active state left behind by a failed receipt release", () => {
    expect(scenario({ persistError: "interrupted", activeStateReleaseFails: true }).comments[0].body)
      .toContain("--remove-label 'agent:in-progress'");
  });

  it("treats a request removed at the mutation boundary as cancellation", () => {
    expect(scenario({ beforeDelete: (state) => state.unlabel("agent:implement", "human") }).outcome.kind).toBe("cancelled");
  });

  it("does not launch after cancellation", () => {
    expect(scenario({ beforeDelete: (state) => state.unlabel("agent:implement", "human") }).launches).toBe(0);
  });

  it("preserves a newer request generation raced before deletion", () => {
    expect(scenario({ beforeDelete: (state) => { state.unlabel("agent:implement", "human"); state.label("agent:implement", "human"); } }).labels).toContain("agent:implement");
  });

  it("does not launch the selected attempt when a newer generation races before deletion", () => {
    expect(scenario({ beforeDelete: (state) => { state.unlabel("agent:implement", "human"); state.label("agent:implement", "human"); } }).launches).toBe(0);
  });

  it("preserves a newer request generation raced during deletion", () => {
    expect(scenario({ duringDelete: (state) => state.label("agent:implement", "human") }).labels).toContain("agent:implement");
  });

  it("does not resurrect a newer request cancelled during deletion", () => {
    expect(scenario({ duringDelete: (state) => { state.label("agent:implement", "human"); state.unlabel("agent:implement", "human"); } }).labels).not.toContain("agent:implement");
  });

  it("blocks when consumption succeeded but its durable receipt failed", () => {
    expect(scenario({ persistError: "interrupted" }).outcome.kind).toBe("ambiguous_blocked");
  });

  it("leaves recovery guidance for ambiguous consumption", () => {
    expect(scenario({ persistError: "interrupted" }).comments[0].body).toContain("--add-label 'agent:implement'");
  });

  it("does not launch after ambiguous consumption", () => {
    expect(scenario({ persistError: "interrupted" }).launches).toBe(0);
  });

  it("keeps ambiguous recovery guidance idempotent after interruption", () => {
    expect(scenario({ persistError: "interrupted", retry: true }).comments).toHaveLength(1);
  });

  it("refuses to report an ambiguous stop when its block is removed during persistence", () => {
    expect(() => scenario({ persistError: "interrupted", removeBlockAfterAdd: true }))
      .toThrow("ambiguous request-consumption block could not be proven");
  });

  it("does not trust copied ambiguous recovery guidance from another commenter", () => {
    const body = scenario({ persistError: "interrupted" }).comments[0].body;
    expect(scenario({ persistError: "interrupted", copiedComment: { body, login: "intruder" } }).comments)
      .toHaveLength(2);
  });

  it("does not let missing automation identity authorize actorless stop evidence", () => {
    expect(() => scenario({ persistError: "interrupted", automationLogin: "" }))
      .toThrow("authorized Automation host login is required");
  });

  it("uses role-neutral wording when ambiguous exploration consumption stops", () => {
    expect(scenario({ requestLabel: "agent:explore", persistError: "interrupted" }).comments[0].body)
      .toContain("No agent was launched.");
  });

  it("cancels exploration removed before its consumption", () => {
    expect(scenario({
      requestLabel: "agent:explore",
      beforeDelete: (state) => state.unlabel("agent:explore", "human"),
    }).outcome.kind).toBe("cancelled");
  });

  it("preserves a raced exploration generation for a later attempt", () => {
    expect(scenario({
      requestLabel: "agent:explore",
      duringDelete: (state) => state.label("agent:explore", "human"),
    }).labels).toContain("agent:explore");
  });

  it("treats an unprovable DELETE response as ambiguous", () => {
    expect(scenario({ deleteStatus: 0 }).outcome.kind).toBe("ambiguous_blocked");
  });

  it("does not consume a request when a block races into its first observation", () => {
    expect(scenario({ blockDuringObservation: true }).outcome.kind).toBe("recovery_blocked");
  });

  it("reports a stop bound to the consumed request when a block appears during deletion", () => {
    expect(scenario({ duringDelete: (state) => state.label("agent:blocked", "human") }).outcome.kind)
      .toBe("blocked_after_consumption");
  });

  it("does not launch when a block appears after the request was consumed", () => {
    expect(scenario({ duringDelete: (state) => state.label("agent:blocked", "human") }).launches).toBe(0);
  });

  it("leaves recovery guidance when a block appears after the request was consumed", () => {
    expect(scenario({ duringDelete: (state) => state.label("agent:blocked", "human") }).comments[0].body)
      .toContain("--add-label 'agent:implement'");
  });

  it("says the request was consumed when a block appears after consumption", () => {
    expect(scenario({ duringDelete: (state) => state.label("agent:blocked", "human") }).comments[0].body)
      .toContain("consumed the selected `agent:implement` request");
  });

  it("does not trust copied consumed-request stop guidance from another commenter", () => {
    const body = scenario({ duringDelete: (state) => state.label("agent:blocked", "human") }).comments[0].body;
    expect(scenario({
      duringDelete: (state) => state.label("agent:blocked", "human"),
      copiedComment: { body, login: "intruder" },
    }).comments).toHaveLength(2);
  });

  it("does not clear a recovery block newer than the selected request", () => {
    expect(issueRecoveryBlockCanBeCleared([
      { id: "10", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:explore" } },
      { id: "11", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
    ], "agent:explore", "10", "agent:blocked")).toBe(false);
  });
});

describe("failed Issue exploration transition", () => {
  it("turns a failed exploration into a visible block", () => {
    expect(failedExplorationScenario().labels).toContain("agent:blocked");
  });

  it("posts one recovery explanation", () => {
    expect(failedExplorationScenario({ interruptAfterBlock: true, retry: true }).comments).toHaveLength(1);
  });

  it("restores the terminal block a person removed during persistence", () => {
    expect(failedExplorationScenario({ blockRemovedAfterAdd: true, retry: true }).labels).toContain("agent:blocked");
  });

  it("persists the terminal exploration stop after its removed block is recreated", () => {
    expect(failedExplorationScenario({ blockRemovedAfterAdd: true, retry: true }).persisted).toBe(true);
  });

  it("posts one recovery explanation when a removed block is recreated", () => {
    expect(failedExplorationScenario({ blockRemovedAfterAdd: true, retry: true }).comments).toHaveLength(1);
  });

  it("keeps the active state until its terminal block is live", () => {
    expect(failedExplorationScenario({ blockRemovedAfterAdd: true }).labels).toContain("agent:in-progress");
  });

  it("clears an implementation request that predates the terminal block", () => {
    expect(failedExplorationScenario().labels).not.toContain("agent:implement");
  });

  it("preserves a request ordered after the terminal block", () => {
    expect(failedExplorationScenario({ requestDuringBlock: "agent:explore" }).labels).toContain("agent:explore");
  });

  it("orders same-second block and recovery request by stable event ID", () => {
    expect(failedExplorationScenario({
      requestDuringBlock: "agent:explore",
      eventTime: "2026-08-16T00:00:01Z",
    }).labels).toContain("agent:explore");
  });

  it("does not erase a post-block request when retrying after the block", () => {
    expect(failedExplorationScenario({
      requestDuringBlock: "agent:explore",
      interruptAfterBlock: true,
      retry: true,
    }).labels).toContain("agent:explore");
  });

  it("restores a post-block request when retrying after its deletion", () => {
    expect(failedExplorationScenario({
      raceRequestDuringDelete: "agent:implement",
      interruptAfterRequestDelete: true,
      retry: true,
    }).labels).toContain("agent:implement");
  });

  it("proves the terminal GitHub state before advancing the attempt", () => {
    expect(failedExplorationScenario().persisted).toBe(true);
  });
});

describe("successful Issue exploration transition", () => {
  it("posts the exact authorized human-readable result", () => {
    expect(explorationCompletionScenario().comments[0]).toMatchObject({ user: { login: "deadloop-bot" }, body: "## deadloop exploration\n\nResult.\n\n<!-- deadloop:issue-exploration-result:v1 attempt=attempt-42 request=2 -->" });
  });

  it("does not trust an exact result copied by another commenter", () => {
    expect(explorationCompletionScenario({ copiedResultLogin: "other-user" }).comments.at(-1)?.user.login).toBe("deadloop-bot");
  });

  it("removes only the completed attempt's active label", () => {
    expect(explorationCompletionScenario().labels).toEqual(["agent:implement", "customer:urgent"]);
  });

  it("preserves an exploration request added while the explorer runs", () => {
    const data = explorationCompletionScenario({ requestBeforeCompletion: "agent:explore" });
    expect(data.labels).toContain("agent:explore");
  });

  it("preserves an implementation request added while the result comment is posted", () => {
    const data = explorationCompletionScenario({ requestDuringComment: "agent:implement" });
    expect(data.labels).toContain("agent:implement");
  });

  it("preserves an exploration request added while active state is removed", () => {
    const data = explorationCompletionScenario({ requestDuringDelete: "agent:explore" });
    expect(data.labels).toContain("agent:explore");
  });

  it("does not duplicate the result comment after a comment interruption", () => {
    expect(explorationCompletionScenario({ interruptAfterComment: true, retry: true }).comments).toHaveLength(1);
  });

  it("continues after active-label deletion was interrupted", () => {
    expect(explorationCompletionScenario({ interruptAfterDelete: true, retry: true }).outcome.kind).toBe("persisted");
  });

  it("does not remove active state belonging to a newer attempt on retry", () => {
    expect(explorationCompletionScenario({
      interruptAfterDelete: true,
      newerAttemptBeforeRetry: true,
      retry: true,
    }).labels).toContain("agent:in-progress");
  });

  it("proves GitHub persistence before advancing the attempt", () => {
    expect(explorationCompletionScenario().persisted).toBe(true);
  });
});
