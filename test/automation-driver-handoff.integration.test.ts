import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { deliverPendingDriverHandoff, runScheduledAutomation, type AutomationState } from "../src/automation-runner";
import { normalizeProject, type AutomationFileResolution } from "../src/core";

function foundFile(requested: string | undefined): AutomationFileResolution {
  const name = requested || "";
  return { requested: name, resolved: name, found: name.length > 0 };
}

describe("real driver handoff across disable and re-enable", () => {
  it("hands a completed pre-disable worker to a monitor bound to the re-enabled generation", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-driver-handoff-"));
    const statePath = path.join(root, "state.json");
    const project = normalizeProject({
      id: "demo",
      repoPath: "/repo path",
      githubRepo: "owner/repo",
      automations: [{
        id: "demo:issue-coordinator",
        name: "issue coordinator",
        precheckFile: "issue-coordinator.precheck.sh",
        driverFile: "issue-coordinator-driver.ts",
      }],
    });
    const state: AutomationState = { automations: {} };
    const sent: string[] = [];
    let enabled = true;

    try {
      await runScheduledAutomation(project, project.automations[0], 123, state, {
        isEnabled: () => enabled,
        now: () => 456,
        readPrompt: () => "unused",
        resolveAutomationFileInDir: (_kind, _automation, requested) => foundFile(requested),
        runDriver: async () => {
          const result = spawnSync(
            "node",
            [
              "extensions/deadloop/automations/issue-coordinator-driver.ts",
              "--fixture",
              "test/fixtures/issue-coordinator/driver-ready-worker.json",
            ],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              env: {
                ...process.env,
                DEADLOOP_PROJECT_ID: "demo",
                DEADLOOP_REPO_PATH: "/repo path",
                DEADLOOP_GITHUB_REPO: "owner/repo",
                DEADLOOP_STATE_DIR: root,
                DEADLOOP_ENABLED_AT: "1",
              },
            },
          );
          enabled = false;
          return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
        },
        runPrecheck: async () => ({ code: 0, stdout: "", stderr: "" }),
        saveState: (next) => writeFileSync(statePath, JSON.stringify(next)),
        sendUserMessage: (prompt) => sent.push(prompt),
      });

      const reloaded = JSON.parse(readFileSync(statePath, "utf8")) as AutomationState;
      const entry = reloaded.automations["demo:demo:issue-coordinator"];
      const handoff = entry.pendingDriverHandoff as { monitorHandoff: { input: { promiseFile: string } } };
      mkdirSync(path.dirname(handoff.monitorHandoff.input.promiseFile), { recursive: true });
      writeFileSync(handoff.monitorHandoff.input.promiseFile, JSON.stringify({ status: "complete", reason: "implemented" }));
      const sentWhileDisabled = [...sent];
      enabled = true;
      deliverPendingDriverHandoff(entry, reloaded, "issue coordinator", {
        enabledAt: () => 2,
        isEnabled: () => enabled,
        now: () => 789,
        revalidatePendingDriverHandoff: () => true,
        saveState: (next) => writeFileSync(statePath, JSON.stringify(next)),
        sendUserMessage: (prompt) => sent.push(prompt),
      });

      expect({
        sentWhileDisabled,
        queuedCurrentGeneration: sent.length === 1 && sent[0].includes("--enabled-at 2"),
        result: entry.lastResult,
        pending: entry.pendingDriverHandoff,
      }).toEqual({
        sentWhileDisabled: [],
        queuedCurrentGeneration: true,
        result: "driver_needs_llm_queued",
        pending: undefined,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
