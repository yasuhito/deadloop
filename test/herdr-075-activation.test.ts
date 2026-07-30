import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runScheduledAutomation } from "../src/automation-runner";
import { normalizeProject } from "../src/core";
import { parseHerdr075Compatibility } from "../src/herdr-075-compat";

const { runHerdrCompatibilityPreflight } = require("../src/herdr-preflight.cjs");

const extensionSource = readFileSync("extensions/deadloop/index.ts", "utf8");
const completionSource = readFileSync("extensions/deadloop/automations/complete-attempt-workspace.ts", "utf8");

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  const next = source.indexOf("\n  function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("Herdr 0.7.5 activation", () => {
  it("keeps the bare-node preflight equal to the typed compatibility parser", () => {
    const client = "herdr 0.7.5+build.1\n";
    const server = "version: 0.8.0\ncompatible: yes\n";
    const runtime = runHerdrCompatibilityPreflight({ run: (_command: string, args: string[]) => args[0] === "--version" ? client : server });
    expect(runtime).toEqual(parseHerdr075Compatibility(client, server));
  });

  it.each([
    ["old client", "herdr 0.7.4\n", "version: 0.7.5\ncompatible: yes\n"],
    ["old server", "herdr 0.7.5\n", "version: 0.7.4\ncompatible: yes\n"],
    ["client prerelease", "herdr 0.7.5-rc.1\n", "version: 0.7.5\ncompatible: yes\n"],
    ["server prerelease", "herdr 0.7.5\n", "version: 0.8.0-beta.1\ncompatible: yes\n"],
    ["protocol mismatch", "herdr 0.7.5\n", "version: 0.7.5\ncompatible: yes\nprotocol_mismatch\n"],
    ["incompatible", "herdr 0.7.5\n", "version: 0.7.5\ncompatible: no\n"],
    ["malformed client", "v0.7.5\n", "version: 0.7.5\ncompatible: yes\n"],
    ["malformed server", "herdr 0.7.5\n", "server 0.7.5\ncompatible: yes\n"],
  ])("keeps direct preflight rejection equal for %s", (_name, client, server) => {
    const rejected = (operation: () => unknown) => { try { operation(); return false; } catch { return true; } };
    expect(rejected(() => runHerdrCompatibilityPreflight({ run: (_command: string, args: string[]) => args[0] === "--version" ? client : server }))).toBe(
      rejected(() => parseHerdr075Compatibility(client, server)),
    );
  });

  it("runs the host startup gate before enablement reads and scheduler mutation", () => {
    const startup = functionSource(extensionSource, "startScheduler");
    expect(startup.indexOf("compatibilityPreflight()") < startup.indexOf("isProjectEnabled(project)")).toBe(true);
  });

  it("runs restart reconciliation before pending handoff and candidate selection", () => {
    const tick = functionSource(extensionSource, "tick");
    expect(tick.indexOf("reconcilePersistedAttemptJournals") < tick.indexOf("deliverPendingDriverHandoff")).toBe(true);
  });

  it("holds the enablement guard around workspace closure without fabricating GitHub state", () => {
    expect({ guardedClose: /withEnabledDriverLock[\s\S]*recheck\(\);[\s\S]*closeWorkspace/.test(completionSource), writesComment: /runText\(\["gh"[\s\S]*"comment"/.test(completionSource) }).toEqual({ guardedClose: true, writesComment: false });
  });

  it("rejects a tick before precheck, candidate driver, state mutation, or prompt delivery", async () => {
    const calls: string[] = [];
    const project = normalizeProject({ id: "demo", repoPath: "/repo", githubRepo: "owner/repo", automations: [{ id: "a", name: "a" }] });
    try {
      await runScheduledAutomation(project, project.automations[0], 1, { automations: {} }, {
        compatibilityPreflight: () => { calls.push("compatibility"); throw new Error("unsupported"); },
        now: () => 1,
        readPrompt: () => "",
        resolveAutomationFileInDir: () => ({ requested: "", resolved: "", found: true }),
        runDriver: async () => (calls.push("driver"), { code: 0 }),
        runPrecheck: async () => (calls.push("precheck"), { code: 0 }),
        saveState: () => { calls.push("state"); },
        sendUserMessage: () => { calls.push("prompt"); },
      });
    } catch {}
    expect(calls).toEqual(["compatibility"]);
  });
});
