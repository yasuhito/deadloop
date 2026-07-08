import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const script = "extensions/pi-looper/automations/ci-fallback-decision.ts";
const fixtureDir = path.join(process.cwd(), "test/fixtures/ci-fallback");

function runDecision(fixtureName: string, options: { enabled?: boolean; mode?: string } = {}) {
  const args = [
    script,
    "--input",
    path.join(fixtureDir, fixtureName),
    "--enabled",
    options.enabled === false ? "false" : "true",
    "--mode",
    options.mode ?? "billing-only",
  ];
  const result = spawnSync("node", args, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

describe("CI fallback decision", () => {
  it("keeps fallback disabled unless explicitly enabled", () => {
    expect(runDecision("qorraq-all-jobs-immediate-failure.json", { enabled: false }).fallbackAllowed).toBe(false);
  });

  it("allows fallback for qorraq-style immediate all-job infrastructure failures", () => {
    expect(runDecision("qorraq-all-jobs-immediate-failure.json").fallbackAllowed).toBe(true);
  });

  it("classifies qorraq-style immediate all-job failures as CI infrastructure failure", () => {
    expect(runDecision("qorraq-all-jobs-immediate-failure.json").classification).toBe("ci_infrastructure_failure");
  });

  it("does not allow fallback for ordinary test failures", () => {
    expect(runDecision("qorraq-test-failure.json").fallbackAllowed).toBe(false);
  });

  it("classifies ordinary test failures separately", () => {
    expect(runDecision("qorraq-test-failure.json").classification).toBe("ordinary_ci_failure");
  });

  it("allows fallback when logs explicitly mention billing limits", () => {
    expect(runDecision("explicit-billing-message.json").fallbackAllowed).toBe(true);
  });

  it("does not allow fallback when only one check fails immediately and another check passed", () => {
    expect(runDecision("mixed-success-immediate-failure.json").fallbackAllowed).toBe(false);
  });

  it("does not allow fallback when an immediate failure has executed job steps", () => {
    expect(runDecision("immediate-failure-with-successful-step.json").fallbackAllowed).toBe(false);
  });
});
