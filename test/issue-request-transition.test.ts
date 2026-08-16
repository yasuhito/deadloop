import { describe, expect, it } from "vitest";

const { consumeIssueRequest, persistSuccessfulExploration } = require("../src/issue-request-transition.ts");

type Event = {
  id: string;
  event: "labeled" | "unlabeled";
  created_at: string;
  actor: { login: string };
  label: { name: string };
};

function scenario(options: {
  requestLabel?: "agent:implement" | "agent:explore";
  beforeDelete?: (state: ReturnType<typeof createState>) => void;
  duringDelete?: (state: ReturnType<typeof createState>) => void;
  deleteStatus?: number;
  persistError?: string;
  retry?: boolean;
} = {}) {
  const state = createState();
  let persisted = false;
  let launches = 0;
  const github = {
    listIssueLabels: () => [...state.labels].map((name) => ({ name })),
    listIssueTimelineEvents: () => state.events,
    listIssueComments: () => state.comments,
    addIssueLabel: (_repo: string, _number: number, label: string) => state.label(label, "deadloop-bot"),
    deleteIssueLabel: (_repo: string, _number: number, label: string) => {
      options.beforeDelete?.(state);
      if (!state.labels.has(label)) return { status: 404 };
      state.unlabel(label, "deadloop-bot");
      options.duringDelete?.(state);
      return { status: options.deleteStatus ?? 200 };
    },
    commentIssue: (_repo: string, _number: number, body: string) => state.comments.push({ id: `comment-${state.comments.length + 1}`, body }),
  };
  const requestLabel = options.requestLabel || "agent:implement";
  const input = {
    github,
    repository: "owner/repo",
    issueNumber: 42,
    requestLabel,
    requestEventId: requestLabel === "agent:explore" ? "2" : "1",
    inProgressLabel: "agent:in-progress",
    blockedLabel: "agent:blocked",
    automationLogin: "deadloop-bot",
    attemptId: "attempt-42",
    persistConsumed: () => {
      if (options.persistError) throw new Error(options.persistError);
      persisted = true;
    },
  };
  let outcome = consumeIssueRequest(input);
  if (options.retry) outcome = consumeIssueRequest(input);
  if (outcome.kind === "consumed") launches += 1;
  return { outcome, labels: [...state.labels], events: state.events, comments: state.comments, persisted, launches };
}

function createState() {
  const labels = new Set(["agent:implement", "agent:explore", "customer:urgent"]);
  const events: Event[] = [
    { id: "1", event: "labeled", created_at: "2026-08-16T00:00:00Z", actor: { login: "human" }, label: { name: "agent:implement" } },
    { id: "2", event: "labeled", created_at: "2026-08-16T00:00:00Z", actor: { login: "human" }, label: { name: "agent:explore" } },
    { id: "3", event: "labeled", created_at: "2026-08-16T00:00:00Z", actor: { login: "human" }, label: { name: "customer:urgent" } },
  ];
  const comments: Array<{ id: string; body: string }> = [];
  let nextId = 10;
  const emit = (event: "labeled" | "unlabeled", label: string, login: string) => events.push({
    id: String(nextId++), event, created_at: "2026-08-16T00:00:01Z", actor: { login }, label: { name: label },
  });
  return {
    labels,
    events,
    comments,
    label(label: string, login: string) { if (!labels.has(label)) { labels.add(label); emit("labeled", label, login); } },
    unlabel(label: string, login: string) { if (labels.delete(label)) emit("unlabeled", label, login); },
  };
}

function explorationCompletionScenario(options: {
  requestBeforeCompletion?: string;
  copiedResultLogin?: string;
  requestDuringComment?: string;
  requestDuringDelete?: string;
  interruptAfterComment?: boolean;
  interruptAfterDelete?: boolean;
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
    attemptId: "attempt-42",
    resultBody: "## deadloop exploration\n\nResult.",
    persistGithub: () => { persisted = true; },
  };
  let outcome;
  try { outcome = persistSuccessfulExploration(input); } catch (error) { outcome = { kind: "interrupted", error }; }
  if (options.retry) outcome = persistSuccessfulExploration(input);
  return { comments, labels: [...state.labels], outcome, persisted };
}

describe("Issue Agent request transition", () => {
  it("persists consumption after the selected request is removed", () => {
    expect(scenario().persisted).toBe(true);
  });

  it("removes only the selected request label", () => {
    expect(scenario().labels).toEqual(["agent:explore", "customer:urgent"]);
  });

  it("emits the production unlabeled event for consumption", () => {
    expect(scenario().events.at(-1)).toMatchObject({ event: "unlabeled", label: { name: "agent:implement" } });
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

  it("proves GitHub persistence before advancing the attempt", () => {
    expect(explorationCompletionScenario().persisted).toBe(true);
  });
});
