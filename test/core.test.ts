import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKER_LAUNCH_POLICY,
  EXTENSION_CODE_CHANGED_WARNING,
  codeFreshnessWarning,
  cronSlotAt,
  getDueSlot,
  nextSlotAfter,
  normalizeProject,
  parseProjectsConfig,
  parseEveryMinutes,
  REPO_POLICY_FILE,
  renderTemplate,
  resolveConfigPath,
  resolveProjectForTick,
  sanitizeId,
  templateValues,
} from "../src/core";

describe("deterministic extension core", () => {
  it("uses DEADLOOP_CONFIG before default config paths", () => {
    expect(
      resolveConfigPath({
        env: { DEADLOOP_CONFIG: "/deadloop/projects.json" },
        stateDir: "/state",
        extensionDir: "/extension",
        exists: () => true,
      }),
    ).toBe("/deadloop/projects.json");
  });

  it("uses the deadloop user state config before package-local config", () => {
    expect(
      resolveConfigPath({
        env: {},
        stateDir: "/state",
        extensionDir: "/extension",
        exists: (value) => value === "/state/projects.json",
      }),
    ).toBe("/state/projects.json");
  });

  it("falls back to package-local config when user state config is missing", () => {
    expect(
      resolveConfigPath({
        env: {},
        stateDir: "/state",
        extensionDir: "/extension",
        exists: () => false,
      }),
    ).toBe("/extension/projects.json");
  });

  it("normalizes project configuration defaults from public config fields", () => {
    const project = normalizeProject({
      id: "Example Project!",
      repoPath: "/repo",
      githubRepo: "owner/repo",
      labels: { ready: "agent-ready" },
      automations: [{ name: "issue coordinator", promptFile: "issue.md" }],
    });

    expect(project).toEqual({
      id: "example-project",
      enabled: true,
      repoPath: "/repo",
      githubRepo: "owner/repo",
      baseBranch: "origin/main",
      worktreeRoot: "",
      checkCommand: "git diff --check",
      autoMerge: false,
      ciFallback: {
        enabled: false,
        mode: "billing-only",
        allowAutoMerge: false,
        localCommands: "",
      },
      workerInstructions: "AGENTS.md、CONTEXT.md、関連 docs/adr/ を読んでから作業する。",
      workerLaunchPolicy:
        "Worker 起動時は issue の難易度を見てレベルを選ぶ。単純なドキュメント修正・小さなテスト修正・局所的な実装は low、通常の実装は medium、複数コンポーネント・設計判断・データ移行・難しい不具合修正は high。判断理由を worker prompt に1行で残す。",
      workerAgent: "pi",
      workerModel: "",
      reviewerAgent: "pi",
      reviewerModel: "",
      labels: {
        ready: "agent-ready",
        implement: "agent:implement",
        inProgress: "agent:in-progress",
        blocked: "agent:blocked",
        review: "agent:review",
        reviewing: "agent:reviewing",
        human: "ready-for-human",
        needsInfo: "needs-info",
        wontfix: "wontfix",
        needsTriage: "needs-triage",
      },
      automations: [
        {
          id: "example-project:issue coordinator",
          name: "issue coordinator",
          schedule: "*/10 * * * *",
          timezone: "Asia/Tokyo",
          graceMinutes: 720,
          promptFile: "issue.md",
          precheckFile: undefined,
          precheckTimeoutSeconds: 60,
          initialLastScheduledAt: 0,
        },
      ],
      configSource: {
        localPath: undefined,
        repoPolicyPath: REPO_POLICY_FILE,
        repoPolicyBaseBranch: "origin/main",
        repoPolicyStatus: "not-read",
        repoPolicyAppliedKeys: [],
      },
    });
  });

  it("uses standard automations when project configuration omits them", () => {
    const project = normalizeProject({ id: "demo" });

    expect(project.automations.map((automation) => automation.id)).toEqual(["demo:issue-coordinator", "demo:pr-reviewer"]);
  });

  it("keeps explicit empty automations disabled", () => {
    const project = normalizeProject({ id: "demo", automations: [] });

    expect(project.automations).toEqual([]);
  });

  it("parses the supported every-N-minutes cron form", () => {
    expect(parseEveryMinutes("*/15 * * * *")).toBe(15);
  });

  it("ignores leading and trailing whitespace in supported cron schedules", () => {
    expect(parseEveryMinutes("  */5 * * * *  ")).toBe(5);
  });

  it("rejects unsupported cron schedules", () => {
    expect(parseEveryMinutes("0 * * * *")).toBeNull();
  });

  it("rejects zero-minute intervals", () => {
    expect(parseEveryMinutes("*/0 * * * *")).toBeNull();
  });

  it("returns no due slot outside the grace window", () => {
    const automation = {
      schedule: "*/10 * * * *",
      graceMinutes: 1,
      initialLastScheduledAt: 0,
    };
    const entry: Record<string, unknown> = { lastScheduledAt: 0 };

    expect(getDueSlot(automation, entry, 21 * 60_000 + 30_000)).toBeNull();
  });

  it("records missed slots outside the grace window", () => {
    const automation = {
      schedule: "*/10 * * * *",
      graceMinutes: 1,
      initialLastScheduledAt: 0,
    };
    const entry: Record<string, unknown> = { lastScheduledAt: 0 };

    getDueSlot(automation, entry, 21 * 60_000 + 30_000);

    expect(entry).toEqual({
      lastScheduledAt: 20 * 60_000,
      lastResult: "missed_outside_grace",
      updatedAt: 21 * 60_000 + 30_000,
    });
  });

  it("calculates the current cron slot", () => {
    expect(cronSlotAt(26 * 60_000 + 12_345, 10)).toBe(20 * 60_000);
  });

  it("uses the next last-scheduled slot when it is still in the future", () => {
    const automation = { schedule: "*/10 * * * *", initialLastScheduledAt: 0 };

    expect(nextSlotAfter({ lastScheduledAt: 20 * 60_000 }, automation, 25 * 60_000)).toBe(30 * 60_000);
  });

  it("uses the next cron slot when the last-scheduled candidate is stale", () => {
    const automation = { schedule: "*/10 * * * *", initialLastScheduledAt: 0 };

    expect(nextSlotAfter({ lastScheduledAt: 20 * 60_000 }, automation, 35 * 60_000)).toBe(40 * 60_000);
  });

  it("renders prompt templates from public template values", () => {
    const project = normalizeProject({
      id: "demo",
      repoPath: "/repo",
      githubRepo: "owner/repo",
      automations: [{ id: "demo:issue", name: "issue coordinator" }],
    });
    const values = templateValues(project, project.automations[0], "/ext/automations");

    expect(
      renderTemplate("{{ projectId }} {{githubRepo}} {{automationDir}} {{ missing.value }} {{readyLabel}}", values),
    ).toBe("demo owner/repo /ext/automations  ready-for-agent");
  });

  it("defaults the worker agent to pi", () => {
    expect(normalizeProject({}).workerAgent).toBe("pi");
  });

  it("preserves the pi worker agent selection", () => {
    expect(normalizeProject({ workerAgent: "pi" }).workerAgent).toBe("pi");
  });

  it("preserves the claude worker agent selection", () => {
    expect(normalizeProject({ workerAgent: "claude" }).workerAgent).toBe("claude");
  });

  it("rejects invalid worker agent values", () => {
    expect(() => normalizeProject({ workerAgent: "codex" })).toThrow(/invalid workerAgent/);
  });

  it("defaults the reviewer agent to pi", () => {
    expect(normalizeProject({}).reviewerAgent).toBe("pi");
  });

  it("preserves the claude reviewer agent selection", () => {
    expect(normalizeProject({ reviewerAgent: "claude" }).reviewerAgent).toBe("claude");
  });

  it("rejects invalid reviewer agent values", () => {
    expect(() => normalizeProject({ reviewerAgent: "codex" })).toThrow(/invalid reviewerAgent/);
  });

  it("keeps the default worker launch policy independent of pi thinking flags", () => {
    expect(DEFAULT_WORKER_LAUNCH_POLICY).not.toContain("--thinking");
  });

  it("preserves the operator-designated worker model verbatim", () => {
    const project = normalizeProject({ workerModel: "anthropic/claude-opus-4-8" });

    expect(project.workerModel).toBe("anthropic/claude-opus-4-8");
  });

  it("preserves the operator-designated reviewer model verbatim", () => {
    const project = normalizeProject({ reviewerModel: "openai-codex/gpt-5.2-codex" });

    expect(project.reviewerModel).toBe("openai-codex/gpt-5.2-codex");
  });

  it("exposes worker and reviewer models to prompt templates", () => {
    const project = normalizeProject({ workerModel: "anthropic/claude-opus-4-8", automations: [{}] });
    const values = templateValues(project, project.automations[0], "/auto");

    expect(renderTemplate("{{workerModel}}|{{reviewerModel}}", values)).toBe("anthropic/claude-opus-4-8|");
  });

  it("exposes the worker agent to prompt templates", () => {
    const project = normalizeProject({ workerAgent: "claude", automations: [{}] });

    expect(renderTemplate("{{workerAgent}}", templateValues(project, project.automations[0], "/auto"))).toBe("claude");
  });

  it("exposes the reviewer agent to prompt templates", () => {
    const project = normalizeProject({ reviewerAgent: "claude", automations: [{}] });

    expect(renderTemplate("{{reviewerAgent}}", templateValues(project, project.automations[0], "/auto"))).toBe(
      "claude",
    );
  });

  it("defaults auto merge to disabled", () => {
    expect(normalizeProject({}).autoMerge).toBe(false);
  });

  it("preserves explicitly enabled auto merge", () => {
    expect(normalizeProject({ autoMerge: true }).autoMerge).toBe(true);
  });

  it("defaults CI fallback to disabled billing-only mode", () => {
    expect(normalizeProject({}).ciFallback).toEqual({
      enabled: false,
      mode: "billing-only",
      allowAutoMerge: false,
      localCommands: "",
    });
  });

  it("normalizes CI fallback local commands for prompt templates", () => {
    const project = normalizeProject({
      ciFallback: {
        enabled: true,
        allowAutoMerge: true,
        localCommands: ["git diff --check", "npm test"],
      },
      automations: [{}],
    });

    expect(
      renderTemplate(
        "{{ciFallbackEnabled}}|{{ciFallbackAllowAutoMerge}}|{{ciFallbackLocalCommands}}",
        templateValues(project, project.automations[0], "/auto"),
      ),
    ).toBe("true|true|git diff --check\nnpm test");
  });

  it("exposes auto merge state to prompt templates", () => {
    const project = normalizeProject({ automations: [{}] });

    expect(renderTemplate("{{autoMerge}}", templateValues(project, project.automations[0], "/auto"))).toBe("false");
  });

  it("preserves an automation driver file from project config", () => {
    const project = normalizeProject({ automations: [{ driverFile: "issue-coordinator-driver.ts" }] });

    expect(project.automations[0].driverFile).toBe("issue-coordinator-driver.ts");
  });

  it("uses reloaded project settings during tick resolution", () => {
    const configTexts = ["old-model", "new-model"].map((workerModel) =>
      JSON.stringify({ projects: [{ id: "demo", repoPath: "/repo", workerModel }] }),
    );
    const workerModels = configTexts.map((configText) => {
      const result = resolveProjectForTick({ cwd: "/repo", configText });
      return result.ok ? result.project.workerModel : "";
    });

    expect(workerModels).toEqual(["old-model", "new-model"]);
  });

  it("keeps existing behavior when the trusted repo policy is absent", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({ status: "missing" }),
    });

    expect(result.ok && result.projects[0].workerModel).toBe("");
  });

  it("uses the trusted repo policy worker model when local config omits it", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({ status: "loaded", text: JSON.stringify({ workerModel: "repo-model" }) }),
    });

    expect(result.ok && result.projects[0].workerModel).toBe("repo-model");
  });

  it("keeps the local worker model above the trusted repo policy", () => {
    const result = parseProjectsConfig(
      JSON.stringify({ projects: [{ id: "demo", repoPath: "/repo", workerModel: "local-model" }] }),
      "",
      {
        repoPolicyProvider: () => ({ status: "loaded", text: JSON.stringify({ workerModel: "repo-model" }) }),
      },
    );

    expect(result.ok && result.projects[0].workerModel).toBe("local-model");
  });

  it("accepts this repository's shared policy file", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "deadloop", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({ status: "loaded", text: readFileSync("deadloop.json", "utf8") }),
    });

    expect(result.ok).toBe(true);
  });

  it("keeps trusted repo policy explicit empty automations disabled", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({ status: "loaded", text: JSON.stringify({ automations: [] }) }),
    });

    expect(result.ok && result.projects[0].automations).toEqual([]);
  });

  it("allows trusted repo policy to provide locally omitted automations", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({
        status: "loaded",
        text: JSON.stringify({ automations: [{ id: "demo:auto", promptFile: "issue-coordinator.prompt.md" }] }),
      }),
    });

    expect(result.ok && result.projects[0].automations[0].id).toBe("demo:auto");
  });

  it("allows trusted repo policy to provide automation driver files", () => {
    const result = parseProjectsConfig(
      JSON.stringify({ projects: [{ id: "demo", repoPath: "/repo", automations: [{ id: "demo:auto" }] }] }),
      "",
      {
        repoPolicyProvider: () => ({
          status: "loaded",
          text: JSON.stringify({ automations: [{ id: "demo:auto", driverFile: "issue-coordinator-driver.ts" }] }),
        }),
      },
    );

    expect(result.ok && result.projects[0].automations[0].driverFile).toBe("issue-coordinator-driver.ts");
  });

  it("rejects forbidden trusted repo policy keys", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({ status: "loaded", text: JSON.stringify({ autoMerge: true }) }),
    });

    expect(result.ok).toBe(false);
  });

  it("asks the repo policy provider for the configured base branch", () => {
    let requested = "";

    parseProjectsConfig(
      JSON.stringify({ projects: [{ id: "demo", repoPath: "/repo", baseBranch: "origin/master" }] }),
      "",
      {
        repoPolicyProvider: (project) => {
          requested = `${project.baseBranch}:${REPO_POLICY_FILE}`;
          return { status: "missing" };
        },
      },
    );

    expect(requested).toBe(`origin/master:${REPO_POLICY_FILE}`);
  });

  it("returns a status reason when project config cannot be parsed", () => {
    expect(resolveProjectForTick({ cwd: "/repo", configText: "{" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("projects.json parse error"),
    });
  });

  it("does not run a project that differs from the scheduler lock owner", () => {
    expect(
      resolveProjectForTick({
        cwd: "/repo",
        configText: JSON.stringify({ projects: [{ id: "new-demo", repoPath: "/repo" }] }),
        lockedProjectId: "demo",
      }),
    ).toMatchObject({ ok: false, reason: "active project changed since scheduler lock was acquired" });
  });

  it("warns when extension source mtime is newer than module load time", () => {
    expect(codeFreshnessWarning(1000, [{ path: "extensions/deadloop/index.ts", mtimeMs: 1001 }])).toBe(
      EXTENSION_CODE_CHANGED_WARNING,
    );
  });

  it("sanitizes display identifiers to lowercase slugs", () => {
    expect(sanitizeId("My Repo!")).toBe("my-repo");
  });

  it("sanitizes punctuation-only identifiers to the project fallback", () => {
    expect(sanitizeId("!!!")).toBe("project");
  });

  it("sanitizes empty identifiers to the project fallback", () => {
    expect(sanitizeId("")).toBe("project");
  });
});
