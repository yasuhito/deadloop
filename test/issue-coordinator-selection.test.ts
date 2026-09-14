import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  DEPENDENCY_QUERY_TIMEOUT_MS,
  defaultIssueDecisionConfig,
  issueBlockedBy,
  issueRequestStopResult,
  remainingIssueDecisionTimeout,
  selectIssueForImplementation,
} = require("../extensions/deadloop/automations/issue-coordinator-decisions.cts");

describe("issueBlockedBy", () => {
  const roots: string[] = [];
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function stubGh(output: string, exitCode = 0): void {
    const root = path.join(os.tmpdir(), `deadloop-blockedby-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    const bin = path.join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(bin + "/gh", `#!/bin/sh
cat <<'JSON'
${output}
JSON
exit ${exitCode}
`);
    chmodSync(bin + "/gh", 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  }

  it("returns each blocker with its state, marking only cross-repository ones", () => {
    stubGh(JSON.stringify({
      data: { repository: { issue: { blockedBy: {
        pageInfo: { hasNextPage: false },
        nodes: [
          { number: 1, state: "OPEN", repository: { nameWithOwner: "Owner/Repo" } },
          { number: 348, state: "CLOSED", repository: { nameWithOwner: "qorraq/qorraq-prototype" } },
        ],
      } } } },
    }));
    try {
      expect(issueBlockedBy("owner/repo", 2)).toEqual([
        { number: 1, state: "OPEN" },
        { number: 348, state: "CLOSED", repository: "qorraq/qorraq-prototype" },
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("throws instead of returning an empty list when the query fails", () => {
    stubGh("gh: api failed", 1);
    try {
      expect(() => issueBlockedBy("owner/repo", 2)).toThrow();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("throws when more blockers exist than one page returned", () => {
    stubGh(JSON.stringify({
      data: { repository: { issue: { blockedBy: { pageInfo: { hasNextPage: true }, nodes: [] } } } },
    }));
    try {
      expect(() => issueBlockedBy("owner/repo", 2)).toThrow("blockedBy");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("issue coordinator selection", () => {
  it("prefers exploration when one Issue requests both roles", () => {
    const decision = selectIssueForImplementation(
      [{ number: 1, body: "", labels: [{ name: "agent:explore" }, { name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => [],
    );

    expect(decision.role).toBe("explorer");
  });

  it("selects implementation when exploration is not requested", () => {
    const decision = selectIssueForImplementation(
      [{ number: 1, body: "", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => [],
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
      () => [],
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
      () => [],
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
      () => [],
    );

    expect(decision.selected).toBe(false);
  });

  it("does not select an Issue whose native dependency is open", () => {
    const decision = selectIssueForImplementation(
      [{ number: 2, body: "", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      (issue) => (issue.number === 2 ? [{ number: 1, state: "OPEN" }] : []),
    );

    expect(decision.selected).toBe(false);
  });

  it("names the open dependency and its state in the skip record", () => {
    const decision = selectIssueForImplementation(
      [{ number: 2, body: "", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => [{ number: 1, state: "OPEN" }],
    );

    expect(decision.skipped.find((entry) => entry.reason === "open_dependency").dependencies)
      .toEqual([{ number: 1, state: "OPEN" }]);
  });

  it("selects an Issue whose native dependencies are all closed", () => {
    const decision = selectIssueForImplementation(
      [{ number: 2, body: "", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => [{ number: 1, state: "CLOSED" }],
    );

    expect(decision.selected).toBe(true);
  });

  it("selects an Issue whose body says Blocked by but that has no native dependency", () => {
    const decision = selectIssueForImplementation(
      [{ number: 2, body: "Blocked by #1", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => [],
    );

    expect(decision.selected).toBe(true);
  });

  it("does not select an Issue whose cross-repository dependency is open", () => {
    const decision = selectIssueForImplementation(
      [{ number: 2, body: "", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => [{ number: 348, state: "OPEN", repository: "qorraq/qorraq-prototype" }],
    );

    expect(decision.selected).toBe(false);
  });

  it("selects an Issue whose cross-repository dependency is closed", () => {
    const decision = selectIssueForImplementation(
      [{ number: 2, body: "", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => [{ number: 348, state: "CLOSED", repository: "qorraq/qorraq-prototype" }],
    );

    expect(decision.selected).toBe(true);
  });

  it("queries native dependencies exactly once per candidate", () => {
    let queries = 0;
    selectIssueForImplementation(
      [
        { number: 1, body: "", labels: [{ name: "agent:implement" }] },
        { number: 2, body: "", labels: [{ name: "agent:implement" }] },
      ],
      defaultIssueDecisionConfig(),
      () => {
        queries += 1;
        return [];
      },
    );

    expect(queries).toBe(1);
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
      () => [],
    );

    expect(decision.number).toBe(2);
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
