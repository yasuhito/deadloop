import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const {
  DEPENDENCY_QUERY_TIMEOUT_MS,
  defaultIssueDecisionConfig,
  issueRequestStopResult,
  remainingIssueDecisionTimeout,
  selectIssueForImplementation,
} = require("../extensions/deadloop/automations/issue-coordinator-decisions.cts");
const decisionScript = "extensions/deadloop/automations/issue-coordinator-decisions.cts";

function runDecision(args: string[]) {
  return spawnSync("node", [decisionScript, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

describe("issue coordinator selection", () => {
  it("prefers exploration when one Issue requests both roles", () => {
    const decision = selectIssueForImplementation(
      [{ number: 1, body: "", labels: [{ name: "agent:explore" }, { name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => "CLOSED",
    );

    expect(decision.role).toBe("explorer");
  });

  it("selects implementation when exploration is not requested", () => {
    const decision = selectIssueForImplementation(
      [{ number: 1, body: "", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => "CLOSED",
    );

    expect(decision.role).toBe("worker");
  });

  it("selects a recovery request ordered after an Issue block", () => {
    const decision = selectIssueForImplementation(
      [{
        number: 1,
        body: "",
        labels: [{ name: "agent:explore" }, { name: "agent:blocked" }],
        timelineEvents: [
          { id: "10", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
          { id: "11", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:explore" } },
        ],
      }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => "CLOSED",
    );

    expect(decision.number).toBe(1);
  });

  it("queries a blocked Issue timeline once for both requested roles", () => {
    let queries = 0;
    selectIssueForImplementation(
      [{
        number: 1,
        body: "",
        labels: [{ name: "agent:explore" }, { name: "agent:implement" }, { name: "agent:blocked" }],
      }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => "CLOSED",
      () => {
        queries += 1;
        return [{ id: "10", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } }];
      },
    );

    expect(queries).toBe(1);
  });

  it("rejects a blocked request ordered before the Issue block", () => {
    const decision = selectIssueForImplementation(
      [{
        number: 1,
        body: "",
        labels: [{ name: "agent:explore" }, { name: "agent:blocked" }],
        timelineEvents: [
          { id: "10", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:explore" } },
          { id: "11", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
        ],
      }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => "CLOSED",
    );

    expect(decision.selected).toBe(false);
  });

  it("skips an invalid blocked candidate before selecting another Issue", () => {
    const decision = selectIssueForImplementation(
      [
        {
          number: 1,
          body: "",
          labels: [{ name: "agent:explore" }, { name: "agent:blocked" }],
          timelineEvents: [
            { id: "10", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:explore" } },
            { id: "11", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
          ],
        },
        { number: 2, body: "", labels: [{ name: "agent:explore" }] },
      ],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => "CLOSED",
    );

    expect(decision.number).toBe(2);
  });

  it("shows CLI help without requiring a repo", () => {
    expect(runDecision(["--help"]).status).toBe(0);
  });

  it("rejects unknown CLI flags", () => {
    expect(runDecision(["--typo"]).status).toBe(2);
  });

  it("caps each dependency query below the overall revalidation deadline", () => {
    expect(remainingIssueDecisionTimeout(12_000, 10_000)).toBe(2_000);
  });

  it("gives ordinary dependency queries a strict timeout", () => {
    expect(remainingIssueDecisionTimeout(undefined, 10_000)).toBe(DEPENDENCY_QUERY_TIMEOUT_MS);
  });

  it("stops dependency queries once the overall deadline expires", () => {
    expect(() => remainingIssueDecisionTimeout(10_000, 10_000)).toThrow("deadline exceeded");
  });
});

describe("issue request stop results", () => {
  it("reports an ambiguous consumption stop as completed work", () => {
    expect(issueRequestStopResult("ambiguous_blocked", "implementation", 42).driverAction)
      .toBe("ambiguous_request_consumption_blocked");
  });

  it("reports a stop that raced in after consumption with its own action", () => {
    expect(issueRequestStopResult("blocked_after_consumption", "implementation", 42).driverAction)
      .toBe("request_consumed_before_stop");
  });

  it("does not call a consumed request an untouched Issue", () => {
    expect(issueRequestStopResult("blocked_after_consumption", "implementation", 42).message)
      .toBe("Issue #42 implementation request was consumed before a stop; left recovery guidance");
  });

  it("reports a consumption superseded by a concurrent role with its own action", () => {
    expect(issueRequestStopResult("superseded", "exploration", 42).driverAction)
      .toBe("request_consumed_by_concurrent_attempt");
  });

  it("names the attempt that owns the active state when a consumption is superseded", () => {
    expect(issueRequestStopResult("superseded", "exploration", 42).message)
      .toBe("Issue #42 exploration request was consumed by a concurrent attempt that owns the active state; left recovery guidance");
  });

  it("skips an Issue blocked again before its request was consumed", () => {
    expect(issueRequestStopResult("recovery_blocked", "exploration", 42).driverAction)
      .toBe("recovery_block_raced");
  });

  it("names the role of a cancelled request", () => {
    expect(issueRequestStopResult("cancelled", "exploration", 42).driverAction)
      .toBe("exploration_request_cancelled");
  });

  it("names the role of a raced request", () => {
    expect(issueRequestStopResult("raced", "implementation", 42).driverAction)
      .toBe("implementation_request_raced");
  });

  it("leaves an unrelated launch failure to the caller", () => {
    expect(issueRequestStopResult("consumed", "implementation", 42)).toBeNull();
  });
});
