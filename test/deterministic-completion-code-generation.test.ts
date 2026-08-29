import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { applyDeterministicAttemptMonitoring, runDeterministicCompletion } = require("../src/deterministic-attempt-monitor-runtime.cts");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// A stand-in completion script for one code generation: it reports its generation and the
// automation directory the host handed it, which its sibling scripts would be resolved from.
function automationDir(generation: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `deadloop-completion-${generation}-`));
  roots.push(root);
  const dir = path.join(root, "automations");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "complete-deterministic-issue-attempt.cts"), [
    'const handoff = JSON.parse(require("node:fs").readFileSync(0, "utf8"));',
    `process.stdout.write(JSON.stringify({ applied: true, result: ${JSON.stringify(generation)}, automationDir: handoff.input.automationDir }) + "\\n");`,
    "",
  ].join("\n"));
  return dir;
}

function handoffLaunchedFrom(dir: string) {
  return { kind: "issue", input: { automationDir: dir, attemptRecordFile: path.join(dir, "attempt.json") } };
}

describe("deterministic completion code generation (ADR 0036)", () => {
  it("runs the completion from the code the host currently loads, not the launch-time snapshot", () => {
    const launched = automationDir("launched");
    const current = automationDir("current");
    const application = runDeterministicCompletion(handoffLaunchedFrom(launched), { automationDir: current });
    expect(application.result).toBe("current");
  });

  it("hands the current automation directory to the completion for its sibling scripts", () => {
    const launched = automationDir("launched");
    const current = automationDir("current");
    const application = runDeterministicCompletion(handoffLaunchedFrom(launched), { automationDir: current });
    expect(application.automationDir).toBe(current);
  });

  it("keeps the launch-time snapshot when no current code is supplied", () => {
    const launched = automationDir("launched");
    const application = runDeterministicCompletion(handoffLaunchedFrom(launched));
    expect(application.result).toBe("launched");
  });

  it("applies a completion directive through the current code", () => {
    const launched = automationDir("launched");
    const current = automationDir("current");
    const application = applyDeterministicAttemptMonitoring(
      handoffLaunchedFrom(launched),
      { action: "completion" },
      () => true,
      { automationDir: current },
    );
    expect(application.result).toBe("current");
  });
});
