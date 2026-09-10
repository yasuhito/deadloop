import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Each case drives the pure child-output boundary with one fixture shape, so a known waiting,
// completion, reasoned-stop, or not-applicable result can no longer fall to an unknown host-log
// line and only an unrecognized output keeps an explicit unknown-result (#445).
const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-reconcile-log-"));
let reconcileDriverLogClassification: (recovered: unknown) => { result: string; reason: string };

beforeAll(async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.resetModules();
  // @ts-expect-error Vitest transforms this runtime extension import.
  ({ reconcileDriverLogClassification } = await import("../extensions/deadloop/index"));
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

function driverResult(driverAction: string, summary: string, action = "done") {
  return { action, summary, driverAction };
}

describe("reconcile driver log classification", () => {
  it("maps a persisted completion to its driverAction with the child reason", () => {
    const classified = reconcileDriverLogClassification(
      driverResult("report_received_persisted", "report_received attempt persisted deterministically: complete"),
    );
    expect(classified).toEqual({
      result: "report_received_persisted",
      reason: "report_received attempt persisted deterministically: complete",
    });
  });

  it("maps a retained wait to recovery_retained instead of unknown", () => {
    const classified = reconcileDriverLogClassification(
      driverResult("recovery_retained", "report_received attempt retained while the execution runtime reports working"),
    );
    expect(classified).toEqual({
      result: "recovery_retained",
      reason: "report_received attempt retained while the execution runtime reports working",
    });
  });

  it("maps a completion-pending wait to report_received_completion_pending", () => {
    const classified = reconcileDriverLogClassification(
      driverResult("report_received_completion_pending", "report_received attempt kept pending by the deterministic completion chain: blocked"),
    );
    expect(classified).toEqual({
      result: "report_received_completion_pending",
      reason: "report_received attempt kept pending by the deterministic completion chain: blocked",
    });
  });

  it("maps a newer-owner retention to recovery_retained_newer_owner", () => {
    const classified = reconcileDriverLogClassification(
      driverResult("recovery_retained_newer_owner", "report_received attempt retained because another attempt owns the checkout (attempt-2)"),
    );
    expect(classified).toEqual({
      result: "recovery_retained_newer_owner",
      reason: "report_received attempt retained because another attempt owns the checkout (attempt-2)",
    });
  });

  it("maps a reasoned stop to report_received_stopped", () => {
    const classified = reconcileDriverLogClassification(
      driverResult("report_received_stopped", "report_received attempt attempt-1 stopped because its completion report could not be read back from full storage"),
    );
    expect(classified).toEqual({
      result: "report_received_stopped",
      reason: "report_received attempt attempt-1 stopped because its completion report could not be read back from full storage",
    });
  });

  it("maps a not-applicable result to recovery_not_applicable", () => {
    const classified = reconcileDriverLogClassification(
      driverResult("recovery_not_applicable", "attempt is already authority_released"),
    );
    expect(classified).toEqual({ result: "recovery_not_applicable", reason: "attempt is already authority_released" });
  });

  it("maps a driver exception to the exception result with its message", () => {
    const classified = reconcileDriverLogClassification(driverResult("exception", "spawn node ENOENT", "error"));
    expect(classified).toEqual({ result: "exception", reason: "spawn node ENOENT" });
  });

  it("keeps a known classification readable when the child reports no summary", () => {
    const classified = reconcileDriverLogClassification(driverResult("recovery_retained", ""));
    expect(classified).toEqual({
      result: "recovery_retained",
      reason: "the reconcile driver reported recovery_retained without an explanation",
    });
  });

  it("redacts a local path from a driver exception reason", () => {
    const classified = reconcileDriverLogClassification(
      driverResult("exception", "Cannot find module '/home/yasuhito/Work/deadloop/extensions/deadloop/automations/reconcile-report-received-attempt.cts'", "error"),
    );
    expect(classified.reason).not.toContain("/home/yasuhito");
  });

  it("falls to an explicit unknown-result for an unrecognized driverAction while keeping the diagnostic", () => {
    const classified = reconcileDriverLogClassification(driverResult("recovery_wobbled", "dangling claim"));
    expect(classified).toEqual({
      result: "unknown",
      reason: "the reconcile driver returned an unrecognized result: dangling claim",
    });
  });

  it("falls to an explicit unknown-result for no parsable output", () => {
    expect(reconcileDriverLogClassification(null)).toEqual({
      result: "unknown",
      reason: "the reconcile driver returned no parsable result",
    });
  });

  it("redacts a local path from an unknown-result diagnostic", () => {
    const classified = reconcileDriverLogClassification(
      driverResult("recovery_wobbled", "dangling claim in /tmp/journal"),
    );
    expect(classified).toEqual({
      result: "unknown",
      reason: "the reconcile driver returned an unrecognized result: dangling claim in [internal path omitted]",
    });
  });

  it("binds the host vocabulary to every driverAction the reconcile script publishes", () => {
    const script = fs.readFileSync(
      "extensions/deadloop/automations/reconcile-report-received-attempt.cts",
      "utf8",
    );
    const publishedActions = [...new Set([...script.matchAll(/driverAction: "([a-z_]+)"/g)].map((match) => match[1]))];
    expect(publishedActions.filter((action) => reconcileDriverLogClassification(driverResult(action, "")).result !== action))
      .toEqual([]);
  });
});
