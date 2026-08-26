import { describe, expect, it } from "vitest";

const { containsStorageExhaustion, isStorageExhaustionError, reportNamesStorageExhaustion } = require("../src/storage-exhaustion.cjs");

describe("the deterministic storage-exhaustion judgment (ADR 0018)", () => {
  it("recognizes a Node write failure carrying ENOSPC", () => {
    expect(isStorageExhaustionError({ code: "ENOSPC", message: "write failed" })).toBe(true);
  });

  it("recognizes an EDQUOT error code", () => {
    expect(isStorageExhaustionError({ code: "EDQUOT", message: "quota exceeded" })).toBe(true);
  });

  it("keeps other filesystem errors generic", () => {
    expect(isStorageExhaustionError({ code: "EACCES", message: "permission denied" })).toBe(false);
  });

  it("reads the code embedded in a wrapped error message", () => {
    expect(isStorageExhaustionError(new Error("ENOSPC: no space left on device, write"))).toBe(true);
  });

  it("finds the code inside a recorded launch error text", () => {
    expect(containsStorageExhaustion("worktree create failed: EDQUOT: disk quota exceeded")).toBe(true);
  });

  it("does not match codes that merely contain the letters", () => {
    expect(containsStorageExhaustion("the MONOSPC counter drifted")).toBe(false);
  });

  it("treats a blocked report naming ENOSPC as observed storage exhaustion", () => {
    const report = { status: "blocked", result: { reason: "ENOSPC", explanation: "the host ran out of storage" } };
    expect(reportNamesStorageExhaustion(report)).toBe(true);
  });

  it("treats an ordinary blocked report as unrelated to storage", () => {
    const report = { status: "blocked", result: { reason: "merge_conflict", explanation: "head moved" } };
    expect(reportNamesStorageExhaustion(report)).toBe(false);
  });
});
