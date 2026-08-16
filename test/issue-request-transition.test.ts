import { describe, expect, it } from "vitest";

const { consumeIssueRequest } = require("../src/issue-request-transition.ts");

type Event = {
  id: string;
  event: "labeled" | "unlabeled";
  created_at: string;
  actor: { login: string };
  label: { name: string };
};

function scenario(options: {
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
  const input = {
    github,
    repository: "owner/repo",
    issueNumber: 42,
    requestLabel: "agent:implement",
    requestEventId: "1",
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

  it("treats an unprovable DELETE response as ambiguous", () => {
    expect(scenario({ deleteStatus: 0 }).outcome.kind).toBe("ambiguous_blocked");
  });
});
