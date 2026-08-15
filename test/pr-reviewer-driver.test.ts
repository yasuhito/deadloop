import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  consumeRequestEvent,
  resolveAuthorizedAutomationLogins,
} = require("../extensions/deadloop/automations/pr-reviewer-driver.ts");

type RaceStage = "add-in-progress" | "delete-implement" | "delete-blocked" | "delete-selected";
type Race = { stage: RaceStage; label: string; action: "labeled" | "unlabeled"; actor?: string };

function scenario(options: {
  labels?: string[];
  races?: Race[];
  deleteStatus?: Partial<Record<RaceStage, number>>;
  extraComments?: Record<string, unknown>[];
} = {}) {
  const head = "a".repeat(40);
  const labels = new Set(options.labels || ["agent:review", "agent:implement", "agent:blocked", "customer:keep"]);
  const events: Record<string, any>[] = [
    { id: "implement-20", event: "labeled", created_at: "2026-07-20T09:59:00Z", label: { name: "agent:implement" } },
    { id: "review-22", event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } },
  ];
  let eventSequence = 30;
  let commentsWritten = 0;
  const operations: string[] = [];
  const pr: any = {
    number: 24, state: "OPEN", headRefName: "feature", headRefOid: head,
    labels: [...labels].map((name) => ({ name })), comments: options.extraComments || [],
  };
  const syncLabels = () => { pr.labels = [...labels].map((name) => ({ name })); };
  const applyRaces = (stage: RaceStage) => {
    for (const race of (options.races || []).filter((candidate) => candidate.stage === stage)) {
      eventSequence += 1;
      events.push({
        id: `race-${eventSequence}`,
        event: race.action,
        created_at: `2026-07-20T10:00:${eventSequence}Z`,
        actor: { login: race.actor || "human" },
        label: { name: race.label },
      });
      race.action === "labeled" ? labels.add(race.label) : labels.delete(race.label);
    }
    syncLabels();
  };
  const stageForLabel = (label: string): RaceStage => label === "agent:review"
    ? "delete-selected"
    : label === "agent:blocked" ? "delete-blocked" : "delete-implement";
  const github = {
    getRepositoryIdentity: () => ({ id: "R_repo", nameWithOwner: "owner/repo" }),
    getPr: () => ({ ...pr, labels: [...labels].map((name) => ({ name })) }),
    listPrTimelineEvents: () => [...events],
    listPrLabels: () => [...labels].map((name) => ({ name })),
    addPrLabel: (_repo: string, _number: number, label: string) => {
      operations.push(`add:${label}`);
      labels.add(label);
      applyRaces("add-in-progress");
    },
    deletePrLabel: (_repo: string, _number: number, label: string) => {
      const stage = stageForLabel(label);
      operations.push(`delete:${label}`);
      applyRaces(stage);
      const status = options.deleteStatus?.[stage] ?? (labels.has(label) ? 200 : 404);
      if (status === 200) {
        labels.delete(label);
        eventSequence += 1;
        events.push({
          id: `operation-${eventSequence}`,
          event: "unlabeled",
          created_at: `2026-07-20T10:00:${eventSequence}Z`,
          actor: { login: "deadloop-bot" },
          label: { name: label },
        });
      }
      syncLabels();
      return { status };
    },
    movePrLabels: (_repo: string, _number: number, move: { add?: string[]; remove?: string[] }) => {
      operations.push(`move:${JSON.stringify(move)}`);
      for (const label of move.add || []) labels.add(label);
      for (const label of move.remove || []) labels.delete(label);
      syncLabels();
    },
    commentPr: () => { commentsWritten += 1; },
  };
  const env = {
    githubRepo: "owner/repo", githubRepositoryId: "R_repo", automationLogin: "deadloop-bot",
    authorizedAutomationLogins: ["deadloop-bot"], reviewLabel: "agent:review",
    implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch",
    inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    stateDir: path.join(tmpdir(), "missing-deadloop-state"), projectId: "demo",
  };
  try {
    const consumed = consumeRequestEvent(github, pr, env, "reviewer", () => "deadloop-bot");
    return { consumed, labels: [...labels], commentsWritten, operations };
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    Object.assign(error, { labels: [...labels], operations });
    throw error;
  }
}

function failedScenario(options: Parameters<typeof scenario>[0]) {
  try { scenario(options); } catch (error) { return error as Error & { labels: string[]; operations: string[] }; }
  throw new Error("scenario unexpectedly succeeded");
}

describe("PR request consumption", () => {
  it("authorizes no login when automationLogins is empty", () => {
    expect(resolveAuthorizedAutomationLogins([])).toEqual([]);
  });

  it("binds consumption to the latest selected request event id", () => {
    expect(scenario().consumed.requestEventId).toBe("review-22");
  });

  it("does not publish a machine-readable claim comment", () => {
    expect(scenario().commentsWritten).toBe(0);
  });

  it("preserves unrelated labels while consuming the request", () => {
    expect(scenario().labels).toContain("customer:keep");
  });

  it("adds in-progress before individually deleting baseline managed labels", () => {
    expect(scenario().operations.slice(0, 4)).toEqual([
      "add:agent:in-progress",
      "delete:agent:implement",
      "delete:agent:blocked",
      "delete:agent:review",
    ]);
  });

  it("ignores an old claim comment left on the pull request", () => {
    expect(scenario({ extraComments: [{ id: 101, body: "<!-- deadloop:review-claim v1=obsolete -->" }] }).consumed.requestEventId).toBe("review-22");
  });

  it("preserves a new request added while in-progress is added", () => {
    expect(failedScenario({ races: [{ stage: "add-in-progress", label: "agent:update-branch", action: "labeled" }] }).labels).toContain("agent:update-branch");
  });

  it("preserves a new nonselected request generation erased during normalization", () => {
    expect(failedScenario({ races: [
      { stage: "delete-implement", label: "agent:implement", action: "unlabeled" },
      { stage: "delete-implement", label: "agent:implement", action: "labeled" },
    ] }).labels).toContain("agent:implement");
  });

  it("does not resurrect a same-login cancellation during normalization", () => {
    expect(failedScenario({ races: [{ stage: "delete-implement", label: "agent:implement", action: "unlabeled", actor: "deadloop-bot" }] }).labels).not.toContain("agent:implement");
  });

  it("preserves a new selected request generation erased at the linearization point", () => {
    expect(failedScenario({ races: [
      { stage: "delete-selected", label: "agent:review", action: "unlabeled" },
      { stage: "delete-selected", label: "agent:review", action: "labeled" },
    ] }).labels).toContain("agent:review");
  });

  it("does not resurrect a same-login selected-request cancellation", () => {
    expect(failedScenario({ races: [{ stage: "delete-selected", label: "agent:review", action: "unlabeled", actor: "deadloop-bot" }] }).labels).not.toContain("agent:review");
  });

  it("fails closed when another host wins the selected DELETE", () => {
    expect(() => scenario({ deleteStatus: { "delete-selected": 404 } })).toThrow("documented 200");
  });

  it("fails closed when the selected DELETE response is ambiguous", () => {
    expect(() => scenario({ deleteStatus: { "delete-selected": 0 } })).toThrow("documented 200");
  });

  it("leaves in-progress visible after a partial normalization failure", () => {
    expect(failedScenario({ deleteStatus: { "delete-implement": 404 } }).labels).toContain("agent:in-progress");
  });

  it("leaves the selected request available for reprocessing after an earlier DELETE fails", () => {
    expect(failedScenario({ deleteStatus: { "delete-implement": 404 } }).labels).toContain("agent:review");
  });

  it("revalidates nonselected role generations before reaching the selected DELETE", () => {
    expect(failedScenario({ races: [{ stage: "delete-blocked", label: "agent:update-branch", action: "labeled" }] }).message).toContain("request generation changed");
  });

  it("does not reach selected consumption after a request race at the blocked-label stage", () => {
    expect(failedScenario({ races: [{ stage: "delete-blocked", label: "agent:update-branch", action: "labeled" }] }).operations).not.toContain("delete:agent:review");
  });
});
