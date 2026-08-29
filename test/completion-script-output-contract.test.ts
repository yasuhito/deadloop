import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The deterministic completion runs every step as `ops.run(script)`, which parses the script's
// stdout as JSON. A step that succeeds silently therefore fails the whole completion with
// "Unexpected end of JSON input" after its side effect (push, PR, merge) already happened.
const automationDir = path.resolve("extensions/deadloop/automations");

function scriptsRunBy(file: string): string[] {
  const source = readFileSync(path.join(automationDir, file), "utf8");
  return [...source.matchAll(/ops\.run\("([a-z-]+\.cts)"/g)].map((match) => match[1]);
}

const completionScripts = [...new Set([
  ...scriptsRunBy("complete-deterministic-issue-attempt.cts"),
  ...scriptsRunBy("complete-deterministic-pr-attempt.cts"),
])].sort();

describe("scripts the deterministic completion parses as JSON", () => {
  it("discovers the completion steps from both completion scripts", () => {
    expect(completionScripts).toContain("guarded-push.cts");
  });

  it.each(completionScripts)("%s writes its result to stdout", (script) => {
    expect(readFileSync(path.join(automationDir, script), "utf8")).toContain("process.stdout.write(");
  });
});
