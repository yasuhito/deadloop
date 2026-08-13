import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const helperPath = "extensions/deadloop/automations/extract-worker-promise.ts";

function runPromise(filePath: string, style: "separate" | "equals" = "separate") {
  const args = style === "equals" ? [helperPath, `--file=${filePath}`] : [helperPath, "--file", filePath];
  const result = spawnSync("node", args, { cwd: process.cwd(), encoding: "utf8" });
  return { code: result.status, ...JSON.parse(result.stdout) };
}

function runHelper(filePath: string, style: "separate" | "equals" = "separate") {
  const { code, status } = runPromise(filePath, style);
  return { code, status };
}

function withTempFile(content: string, callback: (filePath: string) => void) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "deadloop-promise-"));
  try {
    const filePath = path.join(tempRoot, "promise.json");
    writeFileSync(filePath, content);
    callback(filePath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const inputHead = "a".repeat(40);
const outputHead = "b".repeat(40);

function reviewerReport(result: Record<string, unknown>) {
  return JSON.stringify({
    schemaVersion: 1,
    attemptId: "a",
    role: "reviewer",
    target: { repository: "octo/demo", kind: "pull-request", number: 1 },
    inputRevision: { head: inputHead },
    status: "complete",
    summary: "reviewed",
    result: { reviewedHead: inputHead, ...result },
    evidence: { reviewed: ["diff"] },
  });
}

function workerReport(attemptId = "expected") {
  return {
    schemaVersion: 1,
    attemptId,
    role: "worker",
    target: { repository: "octo/demo", kind: "issue", number: 1 },
    inputRevision: { head: inputHead },
    status: "complete",
    summary: "done",
    result: { outputRevision: outputHead },
    evidence: { validations: ["npm test passed"] },
  };
}

function canonicalAttemptRecord(promiseFile: string) {
  return {
    attemptId: "expected",
    launchUuid: "launch-001",
    project: "demo",
    repository: "octo/demo",
    role: "worker",
    target: { kind: "issue", number: 1 },
    inputRevision: { head: inputHead },
    branch: "agent/issue-1",
    baseBranch: "main",
    worktreePath: "/worktrees/issue-1",
    agentName: "dl-w-1-123456789abc",
    workspaceLabel: "Issue #1",
    promptFile: path.join(path.dirname(promiseFile), "worker-prompt.md"),
    promiseFile,
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    rootPaneId: "pane-1",
  };
}

describe("extract worker promise helper", () => {
  it("rejects a V1 report with an unknown status", () => {
    withTempFile('{"schemaVersion":1,"attemptId":"a","role":"worker","target":{"repository":"octo/demo","kind":"issue","number":1},"inputRevision":{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"status":"unknown","summary":"done","result":{"outputRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"evidence":{"validations":["npm test"]}}', (filePath) => {
      expect(runHelper(filePath).status).toBe("invalid");
    });
  });

  it("rejects an unknown completion-report version", () => {
    withTempFile('{"schemaVersion":2,"status":"complete"}', (filePath) => {
      expect(runHelper(filePath).status).toBe("invalid");
    });
  });

  it("normalizes a V1 reviewer result for the existing review workflow", () => {
    withTempFile(
      '{"schemaVersion":1,"attemptId":"a","role":"reviewer","target":{"repository":"octo/demo","kind":"pull-request","number":1},"inputRevision":{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"status":"complete","summary":"reviewed","result":{"outcome":"approved","reviewedHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","findings":[]},"evidence":{"reviewed":["diff"]}}',
      (filePath) => {
        expect(runPromise(filePath).promise.outcome).toBe("approved");
      },
    );
  });

  it("rejects malformed V1 reviewer findings", () => {
    withTempFile(
      '{"schemaVersion":1,"attemptId":"a","role":"reviewer","target":{"repository":"octo/demo","kind":"pull-request","number":1},"inputRevision":{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"status":"complete","summary":"reviewed","result":{"outcome":"changes_requested","reviewedHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","findings":[{"title":"Bug","body":"","severity":"major"}]},"evidence":{"reviewed":["diff"]}}',
      (filePath) => {
        expect(runPromise(filePath).error).toBe("invalid_reviewer_findings");
      },
    );
  });

  it("rejects V1 changes_requested findings without severity", () => {
    withTempFile(
      '{"schemaVersion":1,"attemptId":"a","role":"reviewer","target":{"repository":"octo/demo","kind":"pull-request","number":1},"inputRevision":{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"status":"complete","summary":"reviewed","result":{"outcome":"changes_requested","reviewedHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","findings":[{"title":"Bug","body":"Fix it"}]},"evidence":{"reviewed":["diff"]}}',
      (filePath) => {
        expect(runPromise(filePath).error).toBe("changes_requested_requires_finding_severity");
      },
    );
  });

  it("rejects a V1 approved result that still carries a required finding", () => {
    withTempFile(
      reviewerReport({ outcome: "approved", findings: [{ title: "Bug", body: "Fix it", severity: "major" }] }),
      (filePath) => {
        expect(runPromise(filePath).error).toBe("approved_requires_no_findings");
      },
    );
  });

  it("accepts a V1 approved result with advisory observations", () => {
    withTempFile(
      reviewerReport({ outcome: "approved", findings: [], advisories: [{ title: "Naming", body: "A clearer name would help" }] }),
      (filePath) => {
        expect(runPromise(filePath).promise.advisories).toHaveLength(1);
      },
    );
  });

  it("rejects malformed V1 advisory observations", () => {
    withTempFile(
      reviewerReport({ outcome: "approved", findings: [], advisories: [{ title: "Naming", body: "" }] }),
      (filePath) => {
        expect(runPromise(filePath).error).toBe("invalid_reviewer_advisories");
      },
    );
  });

  it("rejects V1 changes_requested without a prior-finding disposition", () => {
    withTempFile(
      reviewerReport({ outcome: "changes_requested", findings: [{ title: "Bug", body: "Fix it", severity: "major" }] }),
      (filePath) => {
        expect(runPromise(filePath).error).toBe("changes_requested_requires_prior_finding_disposition");
      },
    );
  });

  it("rejects an unknown V1 prior-finding disposition", () => {
    withTempFile(
      reviewerReport({ outcome: "approved", findings: [], priorRequiredFindings: "probably_fine" }),
      (filePath) => {
        expect(runPromise(filePath).error).toBe("invalid_prior_finding_disposition");
      },
    );
  });

  it("accepts a V1 changes_requested result that reports repair progress", () => {
    withTempFile(
      reviewerReport({
        outcome: "changes_requested",
        findings: [{ title: "Bug", body: "Fix it", severity: "major" }],
        priorRequiredFindings: "all_resolved",
      }),
      (filePath) => {
        expect(runPromise(filePath).promise.priorRequiredFindings).toBe("all_resolved");
      },
    );
  });

  it("accepts a receipt-bound V1 repair result", () => {
    const head = "a".repeat(40);
    const output = "b".repeat(40);
    withTempFile(JSON.stringify({
      schemaVersion: 1, attemptId: "a", role: "review-repair",
      target: { repository: "octo/demo", kind: "pull-request", number: 1 }, inputRevision: { head },
      status: "complete", summary: "repaired",
      result: { outcome: "repair_pushed", outputRevision: output, repairs: [{ title: "Bug", summary: "Fixed", paths: ["src/a.ts"] }] },
      evidence: {
        finalizer: { action: "pushed", reason: "repair_pushed", originalHeadOid: head, headOid: output, checks: [{ command: "npm test", result: "passed" }] },
        validations: [{ command: "npm test", result: "passed" }],
      },
    }), (filePath) => {
      expect(runPromise(filePath).status).toBe("complete");
    });
  });

  it("requires stale V1 repair outputRevision", () => {
    const head = "a".repeat(40);
    withTempFile(JSON.stringify({
      schemaVersion: 1, attemptId: "a", role: "review-repair",
      target: { repository: "octo/demo", kind: "pull-request", number: 1 }, inputRevision: { head },
      status: "complete", summary: "stale", result: { outcome: "stale_head" },
      evidence: { finalizer: { action: "stale_head", reason: "head_sha_changed", originalHeadOid: head, currentRemoteHeadOid: "b".repeat(40) } },
    }), (filePath) => {
      expect(runPromise(filePath).error).toBe("stale_requires_output_revision");
    });
  });

  it("accepts the branch_update_pushed V1 outcome", () => {
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const output = "c".repeat(40);
    withTempFile(JSON.stringify({
      schemaVersion: 1, attemptId: "a", role: "branch-update",
      target: { repository: "octo/demo", kind: "pull-request", number: 1 }, inputRevision: { head, base },
      status: "complete", summary: "updated", result: { outcome: "branch_update_pushed", outputRevision: output },
      evidence: {
        finalizer: { action: "pushed", reason: "branch_update_pushed", originalHeadOid: head, baseHeadOid: base, headOid: output, checks: [{ command: "npm test", result: "passed" }] },
        validations: [{ command: "npm test", result: "passed" }],
      },
    }), (filePath) => {
      expect(runPromise(filePath).status).toBe("complete");
    });
  });

  it("rejects the retired branch_updated V1 outcome", () => {
    withTempFile(
      '{"schemaVersion":1,"attemptId":"a","role":"branch-update","target":{"repository":"octo/demo","kind":"pull-request","number":1},"inputRevision":{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","base":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"status":"complete","summary":"updated","result":{"outcome":"branch_updated","outputRevision":"cccccccccccccccccccccccccccccccccccccccc"},"evidence":{"finalizer":{}}}',
      (filePath) => {
        expect(runPromise(filePath).error).toBe("invalid_branch_update_outcome");
      },
    );
  });

  it("rejects a V1 report that mismatches its journal", () => {
    withTempFile(JSON.stringify(workerReport("other")), (filePath) => {
      writeFileSync(path.join(path.dirname(filePath), "attempt.json"), JSON.stringify(canonicalAttemptRecord(filePath)));

      expect(runHelper(filePath).status).toBe("invalid");
    });
  });

  it("accepts a journal-bound V1 worker report as strong evidence", () => {
    withTempFile(JSON.stringify(workerReport()), (filePath) => {
      writeFileSync(path.join(path.dirname(filePath), "attempt.json"), JSON.stringify(canonicalAttemptRecord(filePath)));

      expect(runPromise(filePath).evidenceStrength).toBe("strong");
    });
  });

  it("does not promote a partial adjacent attempt record", () => {
    withTempFile(JSON.stringify(workerReport()), (filePath) => {
      writeFileSync(path.join(path.dirname(filePath), "attempt.json"), JSON.stringify({
        attemptId: "expected",
        role: "worker",
        repository: "octo/demo",
        target: { kind: "issue", number: 1 },
        inputRevision: { head: inputHead },
      }));

      expect(runPromise(filePath).status).toBe("invalid");
    });
  });

  it("does not promote a canonical record for another promise path", () => {
    withTempFile(JSON.stringify(workerReport()), (filePath) => {
      writeFileSync(path.join(path.dirname(filePath), "attempt.json"), JSON.stringify({
        ...canonicalAttemptRecord(filePath),
        promiseFile: path.join(path.dirname(filePath), "another-promise.json"),
      }));

      expect(runPromise(filePath).error).toBe("attempt_promise_file_mismatch");
    });
  });

  it("does not promote an invalid successful phase relationship", () => {
    withTempFile(JSON.stringify(workerReport()), (filePath) => {
      writeFileSync(path.join(path.dirname(filePath), "attempt.json"), JSON.stringify({
        ...canonicalAttemptRecord(filePath),
        phase: "workspace_opened",
        lastSuccessfulPhase: "prepared",
      }));

      expect(runPromise(filePath).status).toBe("invalid");
    });
  });

  it("promotes only a canonical record bound to the exact promise path", () => {
    withTempFile(JSON.stringify(workerReport()), (filePath) => {
      writeFileSync(path.join(path.dirname(filePath), "attempt.json"), JSON.stringify(canonicalAttemptRecord(filePath)));

      expect(runPromise(filePath).evidenceStrength).toBe("strong");
    });
  });

  it("rejects a V1 Worker report with a symbolic revision", () => {
    withTempFile(JSON.stringify({ ...workerReport(), inputRevision: { head: "origin/main" } }), (filePath) => {
      expect(runPromise(filePath).error).toBe("invalid_input_revision");
    });
  });

  it("rejects changes_requested without findings", () => {
    withTempFile(
      '{"status":"complete","outcome":"changes_requested","reason":"","summary":"missing findings"}',
      (filePath) => {
        expect(runHelper(filePath).status).toBe("invalid");
      },
    );
  });

  it("rejects changes_requested findings without severity", () => {
    withTempFile(
      '{"status":"complete","outcome":"changes_requested","reason":"","summary":"missing severity","findings":[{"title":"Unsafe fallback","body":"Remove the fallback"}]}',
      (filePath) => {
        expect(runHelper(filePath).status).toBe("invalid");
      },
    );
  });

  it("rejects a successful repair without per-finding summaries", () => {
    withTempFile(
      '{"status":"complete","reason":"repair_pushed","summary":"fixed","checks":[{"command":"npm test","result":"passed"}]}',
      (filePath) => {
        expect(runHelper(filePath).status).toBe("invalid");
      },
    );
  });

  it("reports none for missing promise files", () => {
    const filePath = path.join(tmpdir(), `deadloop-missing-${Date.now()}.json`);

    expect(runHelper(filePath)).toEqual({ code: 1, status: "none" });
  });

  it("reports invalid for malformed JSON", () => {
    withTempFile("{", (filePath) => {
      expect(runHelper(filePath)).toEqual({ code: 1, status: "invalid" });
    });
  });

  it("reports invalid when status is missing", () => {
    withTempFile('{"reason":"","summary":"実装した。検証した。残作業なし。"}', (filePath) => {
      expect(runHelper(filePath)).toEqual({ code: 1, status: "invalid" });
    });
  });
});
