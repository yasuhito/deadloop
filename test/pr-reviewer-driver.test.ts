import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  consumeRequestEvent,
  resolveAuthorizedAutomationLogins,
} = require("../extensions/deadloop/automations/pr-reviewer-driver.ts");

function scenario(
  extraComments: Record<string, unknown>[] = [],
  concurrentRequestLabel?: string,
  concurrentBoundary: "replacement" | "after-live-read" = "replacement",
  cancelConcurrentRequest = false,
) {
  const head = "a".repeat(40);
  const request = { id: "request-22", event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } };
  const events: Record<string, unknown>[] = [request];
  const pr: any = {
    number: 24, state: "OPEN", headRefName: "feature", headRefOid: head,
    labels: [{ name: "agent:review" }, { name: "customer:keep" }], comments: extraComments,
  };
  let commentsWritten = 0;
  let concurrentInserted = false;
  const insertConcurrentRequest = () => {
    if (!concurrentRequestLabel || concurrentInserted) return;
    concurrentInserted = true;
    events.push({ id: "request-23", event: "labeled", created_at: "2026-07-20T10:00:01Z", actor: { login: "human" }, label: { name: concurrentRequestLabel } });
    if (cancelConcurrentRequest) {
      events.push({ id: "request-24", event: "unlabeled", created_at: "2026-07-20T10:00:02Z", actor: { login: "human" }, label: { name: concurrentRequestLabel } });
    }
  };
  const github = {
    getRepositoryIdentity: () => ({ id: "R_repo", nameWithOwner: "owner/repo" }),
    getPr: () => {
      if (concurrentBoundary === "after-live-read") insertConcurrentRequest();
      return pr;
    },
    listPrTimelineEvents: () => events,
    listPrLabels: () => pr.labels,
    replacePrLabels: (_repo: string, _number: number, next: string[]) => {
      if (concurrentBoundary === "replacement") {
        insertConcurrentRequest();
        if (concurrentRequestLabel && !cancelConcurrentRequest) {
          events.push({ id: "request-25", event: "unlabeled", created_at: "2026-07-20T10:00:03Z", actor: { login: "deadloop-bot" }, label: { name: concurrentRequestLabel } });
        }
      }
      pr.labels = next.map((name) => ({ name }));
    },
    movePrLabels: (_repo: string, _number: number, move: { add?: string[]; remove?: string[] }) => {
      const labels = new Set(pr.labels.map((label: { name: string }) => label.name));
      for (const label of move.add || []) labels.add(label);
      for (const label of move.remove || []) labels.delete(label);
      pr.labels = [...labels].map((name) => ({ name }));
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
    return { consumed, pr, commentsWritten };
  } catch (error) {
    Object.assign(error instanceof Error ? error : new Error(String(error)), {
      labels: pr.labels.map((label: { name: string }) => label.name),
    });
    throw error;
  }
}

describe("PR request consumption", () => {
  it("authorizes no login when automationLogins is empty", () => {
    expect(resolveAuthorizedAutomationLogins([])).toEqual([]);
  });

  it("binds consumption to the latest request event id", () => {
    expect(scenario().consumed.requestEventId).toBe("request-22");
  });

  it("does not publish a machine-readable claim comment", () => {
    expect(scenario().commentsWritten).toBe(0);
  });

  it("preserves unrelated labels while consuming the request", () => {
    expect(scenario().pr.labels.map((label: { name: string }) => label.name)).toContain("customer:keep");
  });

  it("ignores an old claim comment left on the pull request", () => {
    expect(scenario([{ id: 101, body: "<!-- deadloop:review-claim v1=obsolete -->" }]).consumed.requestEventId).toBe("request-22");
  });

  it("stops review consumption when a newer branch-update request races the label replacement", () => {
    expect(() => scenario([], "agent:update-branch")).toThrow("request changed after label transition");
  });

  it("restores a newer branch-update request erased by review label replacement", () => {
    let labels: string[] = [];
    try { scenario([], "agent:update-branch"); } catch (error) {
      labels = ((error as Error & { labels?: string[] }).labels || []);
    }
    expect(labels).toContain("agent:update-branch");
  });

  it("stops review consumption for a concurrently cancelled branch-update request", () => {
    expect(() => scenario([], "agent:update-branch", "replacement", true)).toThrow("request changed after label transition");
  });

  it.each(["agent:update-branch", "agent:implement", "agent:review"])(
    "does not restore a concurrently cancelled %s request",
    (label) => {
      let labels: string[] = [];
      try { scenario([], label, "replacement", true); } catch (error) {
        labels = ((error as Error & { labels?: string[] }).labels || []);
      }
      expect(labels).not.toContain(label);
    },
  );

  it("stops when branch-update arrives after the live PR read but before the former event baseline", () => {
    expect(() => scenario([], "agent:update-branch", "after-live-read")).toThrow("request changed after label transition");
  });

  it("restores branch-update arriving after the live PR read but before the former event baseline", () => {
    let labels: string[] = [];
    try { scenario([], "agent:update-branch", "after-live-read"); } catch (error) {
      labels = ((error as Error & { labels?: string[] }).labels || []);
    }
    expect(labels).toContain("agent:update-branch");
  });

});
