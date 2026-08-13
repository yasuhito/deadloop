import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runScheduledAutomation } from "../src/automation-runner";
import { normalizeProject } from "../src/core";
import { parseHerdrVersions } from "../src/herdr-version";

const { runHerdrPreflight } = require("../src/herdr-preflight.cjs");

const extensionSource = readFileSync("extensions/deadloop/index.ts", "utf8");
const completionSource = readFileSync("extensions/deadloop/automations/complete-attempt-workspace.ts", "utf8");

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  const next = source.indexOf("\n  function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("Herdr 0.8.0 activation", () => {
  it("keeps the bare-node preflight equal to the typed version parser", () => {
    const client = "herdr 0.8.0+build.1\n";
    const server = "version: 0.8.0\n";
    const runtime = runHerdrPreflight({ run: (_command: string, args: string[]) => args[0] === "--version" ? client : server });
    expect(runtime).toEqual(parseHerdrVersions(client, server));
  });

  it.each([
    ["old client", "herdr 0.7.9\n", "version: 0.8.0\n"],
    ["old server", "herdr 0.8.0\n", "version: 0.7.9\n"],
    ["client prerelease", "herdr 0.8.0-rc.1\n", "version: 0.8.0\n"],
    ["server prerelease", "herdr 0.8.0\n", "version: 0.8.0-beta.1\n"],
    ["malformed client", "v0.8.0\n", "version: 0.8.0\n"],
    ["malformed server", "herdr 0.8.0\n", "server 0.8.0\n"],
  ])("keeps direct preflight rejection equal for %s", (_name, client, server) => {
    const rejected = (operation: () => unknown) => { try { operation(); return false; } catch { return true; } };
    expect(rejected(() => runHerdrPreflight({ run: (_command: string, args: string[]) => args[0] === "--version" ? client : server }))).toBe(
      rejected(() => parseHerdrVersions(client, server)),
    );
  });

  it("runs the host startup gate before enablement reads and scheduler mutation", () => {
    const startup = functionSource(extensionSource, "startScheduler");
    const preflight = startup.indexOf("preflight()");
    const enablement = startup.indexOf("isProjectEnabled(project)");
    expect(preflight >= 0 && enablement >= 0 && preflight < enablement).toBe(true);
  });

  it("runs restart reconciliation before pending handoff and candidate selection", () => {
    const tick = functionSource(extensionSource, "tick");
    expect(tick.indexOf("reconcilePersistedAttemptJournals") < tick.indexOf("deliverPendingDriverHandoff")).toBe(true);
  });

  it("holds the enablement guard around workspace closure", () => {
    expect(/withEnabledDriverLock[\s\S]*recheck\(\);[\s\S]*closeWorkspace/.test(completionSource)).toBe(true);
  });

  it("does not fabricate GitHub state during workspace closure", () => {
    expect(/runText\(\["gh"[\s\S]*"comment"/.test(completionSource)).toBe(false);
  });

  it("rejects a tick before precheck, candidate driver, state mutation, or prompt delivery", async () => {
    const calls: string[] = [];
    const project = normalizeProject({ id: "demo", repoPath: "/repo", githubRepo: "owner/repo", automations: [{ id: "a", name: "a" }] });
    try {
      await runScheduledAutomation(project, project.automations[0], 1, { automations: {} }, {
        herdrPreflight: () => { calls.push("preflight"); throw new Error("unsupported"); },
        now: () => 1,
        prepareExecutionSupply: () => ({ codeIdentity: "a".repeat(40), lockHash: "b".repeat(64), packageRoot: "/snapshot", automationDir: "/snapshot/automations", dependencyRoot: "/dependencies" }),
        readPrompt: () => "",
        resolveAutomationFileInDir: () => ({ requested: "", resolved: "", found: true }),
        runDriver: async () => (calls.push("driver"), { code: 0 }),
        runPrecheck: async () => (calls.push("precheck"), { code: 0 }),
        saveState: () => { calls.push("state"); },
        sendUserMessage: () => { calls.push("prompt"); },
      });
    } catch {}
    expect(calls).toEqual(["preflight"]);
  });
});
