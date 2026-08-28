import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHECK_COMMAND,
  DEFAULT_WORKER_LAUNCH_POLICY,
  automationEnvironment,
  cronSlotAt,
  decideDueSlot,
  isLinkedGitWorktree,
  nextSlotAfter,
  normalizeProject,
  parseProjectsConfig,
  parseEveryMinutes,
  projectsFromConfig,
  REPO_POLICY_FILE,
  renderTemplate,
  resolveConfigPath,
  resolveProjectForTick,
  sanitizeId,
  templateValues,
} from "../src/core";

describe("deterministic extension core", () => {
  it("identifies a linked worktree whose common git directory belongs to another checkout", () => {
    expect(isLinkedGitWorktree("/worktrees/repo/feature", "/repos/repo/.git/worktrees/feature", "/repos/repo/.git")).toBe(true);
  });

  it("does not identify a primary checkout as a linked worktree", () => {
    expect(isLinkedGitWorktree("/repos/repo", ".git", ".git")).toBe(false);
  });

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
      workerModel: "openai-codex/gpt-5.6-sol",
      reviewerModel: "openai-codex/gpt-5.6-sol",
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
      checkCommand: DEFAULT_CHECK_COMMAND,
      requiredVerification: {
        status: "blocked",
        reason: "missing_base_revision",
        repository: "owner/repo",
        baseRevision: "unknown",
        sources: [{ kind: "default", location: "deadloop", command: "npm run check" }],
      },
      autoMerge: false,
      externalReview: {
        enabled: false,
        waitSeconds: 1800,
      },
      workerInstructions:
        "Start by reading AGENTS.md, CONTEXT.md, README.md, and docs relevant to the change. Follow repository-local instructions first.",
      workerLaunchPolicy:
        "Choose the Worker level from issue difficulty: low for simple docs, small test fixes, and local code changes; medium for ordinary implementation; high for cross-component work, design judgment, migrations, or difficult bugs. Add one line to the Worker prompt explaining the choice.",
      workerAgent: "pi",
      workerModel: "openai-codex/gpt-5.6-sol",
      explorerModel: "openai-codex/gpt-5.6-sol",
      repairModel: "openai-codex/gpt-5.6-sol",
      branchUpdateModel: "openai-codex/gpt-5.6-sol",
      reviewerAgent: "pi",
      reviewerModel: "openai-codex/gpt-5.6-sol",
      automationLogins: [],
      labels: {
        ready: "agent-ready",
        explore: "agent:explore",
        implement: "agent:implement",
        updateBranch: "agent:update-branch",
        inProgress: "agent:in-progress",
        blocked: "agent:blocked",
        review: "agent:review",
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
          driverFile: undefined,
          precheckTimeoutSeconds: 60,
          maxRuntimeSeconds: 86_400,
          shutdownGraceSeconds: 300,
          initialLastScheduledAt: 0,
        },
      ],
      configSource: {
        localPath: undefined,
        repoPolicyPath: REPO_POLICY_FILE,
        repoPolicyBaseBranch: "origin/main",
        repoPolicyStatus: "not-read",
        repoPolicyAppliedKeys: [],
        repoPolicyBaseRevision: "unknown",
      },
    });
  });

  it("uses standard automations when project configuration omits them", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", id: "demo" });

    expect(project.automations.map((automation) => automation.id)).toEqual(["demo:issue-coordinator", "demo:pr-reviewer"]);
  });

  it("keeps explicit empty automations disabled", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", id: "demo", automations: [] });

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

    expect(decideDueSlot(automation, entry, 21 * 60_000 + 30_000).kind).toBe("missed");
  });

  it("returns the missed slot as a new entry value", () => {
    const automation = {
      schedule: "*/10 * * * *",
      graceMinutes: 1,
      initialLastScheduledAt: 0,
    };
    const entry: Record<string, unknown> = { lastScheduledAt: 0 };

    expect(decideDueSlot(automation, entry, 21 * 60_000 + 30_000)).toEqual({
      kind: "missed",
      entry: {
        lastScheduledAt: 20 * 60_000,
        lastResult: "missed_outside_grace",
        updatedAt: 21 * 60_000 + 30_000,
      },
    });
  });

  it("leaves the given entry unchanged when a slot is missed", () => {
    const automation = {
      schedule: "*/10 * * * *",
      graceMinutes: 1,
      initialLastScheduledAt: 0,
    };
    const entry: Record<string, unknown> = { lastScheduledAt: 0 };

    decideDueSlot(automation, entry, 21 * 60_000 + 30_000);

    expect(entry).toEqual({ lastScheduledAt: 0 });
  });

  it("returns the due slot when the grace window still holds", () => {
    const automation = {
      schedule: "*/10 * * * *",
      graceMinutes: 1,
      initialLastScheduledAt: 0,
    };

    expect(decideDueSlot(automation, { lastScheduledAt: 0 }, 20 * 60_000 + 30_000)).toEqual({ kind: "due", dueSlot: 20 * 60_000 });
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
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
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

  it("builds automation script environment from the shared runtime values", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
      id: "demo",
      repoPath: "/repo",
      githubRepo: "owner/repo",
      autoMerge: true,
      automations: [{ id: "demo:issue", name: "issue coordinator" }],
    });

    expect(automationEnvironment(project, project.automations[0])).toMatchObject({
      DEADLOOP_PROJECT_ID: "demo",
      DEADLOOP_REPO_PATH: "/repo",
      DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_AUTO_MERGE: "1",
      DEADLOOP_READY_LABEL: "ready-for-agent",
      DEADLOOP_AUTOMATION_ID: "demo:issue",
    });
  });

  it("passes the selected projects.json path to completion automations", () => {
    const project = projectsFromConfig(
      { projects: [{ id: "demo", workerModel: "repo-model", reviewerModel: "review-model", automations: [{}] }] },
      undefined,
      { configPath: "/extension/projects.json" },
    )[0];

    expect(automationEnvironment(project, project.automations[0]).DEADLOOP_CONFIG).toBe("/extension/projects.json");
  });

  it("does not expose the retired CI fallback auto-merge environment variable", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", automations: [{}] });

    expect(automationEnvironment(project, project.automations[0])).not.toHaveProperty(
      "DEADLOOP_CI_FALLBACK_ALLOW_AUTO_MERGE",
    );
  });

  it("builds worker instructions from custom instruction files", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", workerInstructionFiles: ["docs/agents.md", "docs/testing.md"] });

    expect(project.workerInstructions).toBe(
      "Start by reading docs/agents.md, docs/testing.md, and docs relevant to the change. Follow repository-local instructions first.",
    );
  });

  it("keeps explicit worker instructions above instruction files", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
      workerInstructions: "Follow these repository-specific instructions.",
      workerInstructionFiles: ["docs/agents.md"],
    });

    expect(project.workerInstructions).toBe("Follow these repository-specific instructions.");
  });

  it("defaults the worker agent to pi", () => {
    expect(normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",}).workerAgent).toBe("pi");
  });

  it("preserves the pi worker agent selection", () => {
    expect(normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", workerAgent: "pi" }).workerAgent).toBe("pi");
  });

  it("preserves the claude worker agent selection", () => {
    expect(normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", workerAgent: "claude" }).workerAgent).toBe("claude");
  });

  it("preserves the omp worker agent selection", () => {
    expect(normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", workerAgent: "omp" }).workerAgent).toBe("omp");
  });

  it("rejects invalid worker agent values", () => {
    expect(() => normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", workerAgent: "codex" })).toThrow(/invalid workerAgent/);
  });

  it("defaults the reviewer agent to pi", () => {
    expect(normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",}).reviewerAgent).toBe("pi");
  });

  it("preserves the claude reviewer agent selection", () => {
    expect(normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", reviewerAgent: "claude" }).reviewerAgent).toBe("claude");
  });

  it("preserves the omp reviewer agent selection", () => {
    expect(normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", reviewerAgent: "omp" }).reviewerAgent).toBe("omp");
  });

  it("rejects invalid reviewer agent values", () => {
    expect(() => normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", reviewerAgent: "codex" })).toThrow(/invalid reviewerAgent/);
  });

  it("keeps the default worker launch policy independent of pi thinking flags", () => {
    expect(DEFAULT_WORKER_LAUNCH_POLICY).not.toContain("--thinking");
  });

  it("preserves the operator-designated worker model verbatim", () => {
    const project = normalizeProject({ reviewerModel: "review-model", workerModel: "anthropic/claude-opus-4-8" });

    expect(project.workerModel).toBe("anthropic/claude-opus-4-8");
  });

  it("preserves the operator-designated reviewer model verbatim", () => {
    const project = normalizeProject({ workerModel: "anthropic/claude-opus-4-8", reviewerModel: "openai-codex/gpt-5.2-codex" });

    expect(project.reviewerModel).toBe("openai-codex/gpt-5.2-codex");
  });

  it("exposes worker and reviewer models to prompt templates", () => {
    const project = normalizeProject({ reviewerModel: "review-model", workerModel: "anthropic/claude-opus-4-8", automations: [{}] });
    const values = templateValues(project, project.automations[0], "/auto");

    expect(renderTemplate("{{workerModel}}|{{reviewerModel}}", values)).toBe("anthropic/claude-opus-4-8|review-model");
  });

  it("exposes the worker agent to prompt templates", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", workerAgent: "claude", automations: [{}] });

    expect(renderTemplate("{{workerAgent}}", templateValues(project, project.automations[0], "/auto"))).toBe("claude");
  });

  it("exposes the reviewer agent to prompt templates", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", reviewerAgent: "claude", automations: [{}] });

    expect(renderTemplate("{{reviewerAgent}}", templateValues(project, project.automations[0], "/auto"))).toBe(
      "claude",
    );
  });

  it("retains overrides from a project whose obsolete enabled field is false", () => {
    const [project] = projectsFromConfig({
      projects: [{
        id: "configured",
        enabled: false,
        repoPath: "/repo",
        githubRepo: "owner/repo",
        baseBranch: "origin/release",
        checkCommand: "npm run verify",
        workerModel: "test-model",
        reviewerModel: "review-model",
        worktreeRoot: "/worktrees/configured",
        autoMerge: true,
        automations: [],
      }],
    });

    expect(project).toMatchObject({
      id: "configured",
      enabled: true,
      baseBranch: "origin/release",
      checkCommand: "npm run verify",
      worktreeRoot: "/worktrees/configured",
      autoMerge: true,
      automations: [],
    });
  });

  it("blocks a directly normalized local command without base revision evidence", () => {
    expect(normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
      id: "demo",
      githubRepo: "owner/repo",
      checkCommand: "npm run local",
    }).requiredVerification).toMatchObject({
      status: "blocked",
      reason: "missing_base_revision",
      sources: [{ kind: "local", location: "projects.json#project=demo", command: "npm run local" }],
    });
  });

  it("binds a local check command to the trusted base revision", () => {
    const revision = "a".repeat(40);
    const result = parseProjectsConfig(
      JSON.stringify({ projects: [{ id: "demo", workerModel: "repo-model", reviewerModel: "review-model", githubRepo: "owner/repo", checkCommand: "npm run local" }] }),
      undefined,
      {
        configPath: "/state/projects.json",
        repoPolicyProvider: () => ({ status: "missing", baseRevision: revision }),
      },
    );

    expect(result.ok && result.projects[0].requiredVerification).toMatchObject({
      status: "resolved",
      contract: { command: "npm run local", baseRevision: revision },
    });
  });

  it("defaults auto merge to disabled", () => {
    expect(normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",}).autoMerge).toBe(false);
  });

  it("preserves explicitly enabled auto merge", () => {
    expect(normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", autoMerge: true }).autoMerge).toBe(true);
  });

  it("rejects removed legacy CI fallback settings", () => {
    expect(() => projectsFromConfig({ projects: [{ ciFallback: { enabled: true } }] })).toThrow(/legacy CI fallback/);
  });

  it("defaults external review to disabled", () => {
    expect(normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",}).externalReview).toEqual({ enabled: false, waitSeconds: 1800 });
  });

  it("carries the shared-policy CI-equivalent command into automation environment", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", automations: [{}] }, {
      repoPolicyPath: "deadloop.json",
      repoPolicyBaseBranch: "origin/main",
      repoPolicyStatus: "loaded",
      repoPolicyAppliedKeys: ["ciEquivalentCommand"],
      repoPolicyBaseRevision: "base",
    } as never);

    expect(project.ciEquivalentCommand).toBeUndefined();
    const configured = normalizeProject({ ciEquivalentCommand: "make ci", workerModel: "test-model", reviewerModel: "review-model", automations: [{}] });
    expect(automationEnvironment(configured, configured.automations[0]).DEADLOOP_CI_EQUIVALENT_COMMAND).toBe("make ci");
  });

  it("exposes auto merge state to prompt templates", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", automations: [{}] });

    expect(renderTemplate("{{autoMerge}}", templateValues(project, project.automations[0], "/auto"))).toBe("false");
  });

  it("exposes external review state to prompt templates", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", externalReview: { enabled: true, waitSeconds: 60 }, automations: [{}] });

    expect(renderTemplate("{{externalReviewEnabled}}|{{externalReviewWaitSeconds}}", templateValues(project, project.automations[0], "/auto"))).toBe("true|60");
  });

  it("preserves an automation driver file from project config", () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model", automations: [{ driverFile: "issue-coordinator-driver.cts" }] });

    expect(project.automations[0].driverFile).toBe("issue-coordinator-driver.cts");
  });

  it("uses reloaded project settings during tick resolution", () => {
    const configTexts = ["old-model", "new-model"].map((workerModel) =>
      JSON.stringify({ projects: [{ id: "demo", reviewerModel: "review-model", repoPath: "/repo", workerModel }] }),
    );
    const workerModels = configTexts.map((configText) => {
      const result = resolveProjectForTick({ cwd: "/repo", configText });
      return result.ok ? result.project.workerModel : "";
    });

    expect(workerModels).toEqual(["old-model", "new-model"]);
  });

  it("reports a config error when no model is available from local config or repo policy", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", reviewerModel: "review-model", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({ status: "missing" }),
    });

    expect(result.ok).toBe(false);
  });

  it("uses the trusted repo policy worker model when local config omits it", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", workerModel: "repo-model", reviewerModel: "review-model", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({ status: "loaded", text: JSON.stringify({ workerModel: "repo-model" }) }),
    });

    expect(result.ok && result.projects[0].workerModel).toBe("repo-model");
  });

  it("blocks a loaded shared verification command without base revision evidence", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", workerModel: "repo-model", reviewerModel: "review-model", githubRepo: "owner/repo" }] }), "", {
      repoPolicyProvider: () => ({ status: "loaded", text: JSON.stringify({ checkCommand: "npm run shared" }) }),
    });

    expect(result.ok && result.projects[0].requiredVerification).toMatchObject({
      status: "blocked",
      reason: "missing_base_revision",
    });
  });

  it("allows trusted repo policy to provide worker instruction files", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", workerModel: "repo-model", reviewerModel: "review-model", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({
        status: "loaded",
        text: JSON.stringify({ workerInstructionFiles: ["docs/agents.md"] }),
      }),
    });

    expect(result.ok && result.projects[0].workerInstructions).toBe(
      "Start by reading docs/agents.md, and docs relevant to the change. Follow repository-local instructions first.",
    );
  });

  it("keeps the local worker model above the trusted repo policy", () => {
    const result = parseProjectsConfig(
      JSON.stringify({ projects: [{ id: "demo", reviewerModel: "review-model", repoPath: "/repo", workerModel: "local-model" }] }),
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
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", workerModel: "repo-model", reviewerModel: "review-model", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({ status: "loaded", text: JSON.stringify({ automations: [] }) }),
    });

    expect(result.ok && result.projects[0].automations).toEqual([]);
  });

  it("allows trusted repo policy to provide locally omitted automations", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", workerModel: "repo-model", reviewerModel: "review-model", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({
        status: "loaded",
        text: JSON.stringify({ automations: [{ id: "demo:auto", promptFile: "issue-coordinator.prompt.md" }] }),
      }),
    });

    expect(result.ok && result.projects[0].automations[0].id).toBe("demo:auto");
  });

  it("allows trusted repo policy to provide automation driver files", () => {
    const result = parseProjectsConfig(
      JSON.stringify({ projects: [{ id: "demo", workerModel: "repo-model", reviewerModel: "review-model", repoPath: "/repo", automations: [{ id: "demo:auto" }] }] }),
      "",
      {
        repoPolicyProvider: () => ({
          status: "loaded",
          text: JSON.stringify({ automations: [{ id: "demo:auto", driverFile: "issue-coordinator-driver.cts" }] }),
        }),
      },
    );

    expect(result.ok && result.projects[0].automations[0].driverFile).toBe("issue-coordinator-driver.cts");
  });

  it("uses trusted repo policy external review settings", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", workerModel: "repo-model", reviewerModel: "review-model", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({ status: "loaded", text: JSON.stringify({ externalReview: { enabled: true } }) }),
    });

    expect(result.ok && result.projects[0].externalReview.enabled).toBe(true);
  });

  it("rejects forbidden trusted repo policy keys", () => {
    const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", workerModel: "repo-model", reviewerModel: "review-model", repoPath: "/repo" }] }), "", {
      repoPolicyProvider: () => ({ status: "loaded", text: JSON.stringify({ autoMerge: true }) }),
    });

    expect(result.ok).toBe(false);
  });

  it("asks the repo policy provider for the configured base branch", () => {
    let requested = "";

    parseProjectsConfig(
      JSON.stringify({ projects: [{ id: "demo", workerModel: "repo-model", reviewerModel: "review-model", repoPath: "/repo", baseBranch: "origin/master" }] }),
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
        configText: JSON.stringify({ projects: [{ id: "new-demo", repoPath: "/repo", workerModel: "m", reviewerModel: "r" }] }),
        lockedProjectId: "demo",
      }),
    ).toMatchObject({ ok: false, reason: "active project changed since scheduler lock was acquired" });
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
