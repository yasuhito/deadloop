import { describe, expect, it } from "vitest";

const { parseProviderRetryAt } = require("../src/model-availability.cts");
const { MODEL_WAIT_RETRY_PROMPT, createModelSessionRetry } = require("../src/model-wait.cts");

const now = Date.parse("2026-08-21T00:00:00.000Z");
const record = { agentName: "reviewer-1", rootPaneId: "pane-1", worktreePath: "/wt" };

describe("provider retry timing parsing", () => {
  it("parses a relative provider duration into an absolute retry time", () => {
    expect(parseProviderRetryAt("Error: quota exceeded. Try again in 12h30m.", now)).toBe(
      new Date(now + 12 * 3_600_000 + 30 * 60_000).toISOString(),
    );
  });

  it("parses HTTP-style retry-after seconds into an absolute retry time", () => {
    expect(parseProviderRetryAt("HTTP/1.1 429; retry-after: 90", now)).toBe(new Date(now + 90_000).toISOString());
  });

  it("parses an absolute provider timestamp into that retry time", () => {
    expect(parseProviderRetryAt("Try again after 2026-08-21T01:00:00Z", now)).toBe("2026-08-21T01:00:00.000Z");
  });

  it("returns null when terminal evidence states no provider timing", () => {
    expect(parseProviderRetryAt("credit balance is too low", now)).toBeNull();
  });

  it("returns null for non-string evidence", () => {
    expect(parseProviderRetryAt(undefined, now)).toBeNull();
  });
});

function retryFixture(turn: Record<string, unknown>) {
  const prompts: Array<{ agentName: string; text: string }> = [];
  const dependencies = {
    turnOf: () => turn,
    submitPrompt: (agentName: string, text: string) => {
      prompts.push({ agentName, text });
    },
  };
  return { prompts, retry: createModelSessionRetry(dependencies) };
}

describe("model wait session retry", () => {
  it("submits one fixed continuation prompt to the recorded agent session", () => {
    const state = retryFixture({ kind: "terminal", status: "done", agent: { name: "reviewer-1" } });

    expect({ reused: state.retry(record), prompts: state.prompts }).toEqual({
      reused: true,
      prompts: [{ agentName: "reviewer-1", text: MODEL_WAIT_RETRY_PROMPT }],
    });
  });

  it("reports reuse without prompting when the agent resumed working on its own", () => {
    const state = retryFixture({ kind: "working", agent: {} });

    expect({ reused: state.retry(record), prompts: state.prompts }).toEqual({ reused: true, prompts: [] });
  });

  it("refuses to reuse when the recorded agent no longer answers under its identity", () => {
    const state = retryFixture({ kind: "owner_absent" });

    expect({ reused: state.retry(record), prompts: state.prompts }).toEqual({ reused: false, prompts: [] });
  });

  it("refuses an ambiguous runtime without prompting", () => {
    const state = retryFixture({ kind: "ambiguous" });

    expect({ reused: state.retry(record), prompts: state.prompts }).toEqual({ reused: false, prompts: [] });
  });

  it("treats a rejected prompt submission as an unusable session", () => {
    const prompts: string[] = [];
    const retry = createModelSessionRetry({
      turnOf: () => ({ kind: "terminal", status: "blocked", agent: {} }),
      submitPrompt: (agentName) => {
        prompts.push(agentName);
        throw new Error("agent_blocked");
      },
    });

    expect({ reused: retry(record), prompts }).toEqual({ reused: false, prompts: ["reviewer-1"] });
  });
});
