import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { runEnablementVerification } from "../src/enablement-verification";
import { schedulerLockName } from "../src/project-identity";
const { withEnabledProjectLock } = require("../src/enabled-operation.cjs");
const { projectCheckMain } = require("../src/project-check.ts") as {
  projectCheckMain: (argv: string[], runner: (input: unknown) => Promise<unknown>) => Promise<void>;
};

type CommandContext = {
  cwd: string;
  mode: string;
  hasUI?: boolean;
  ui: {
    notify: (message: string, level?: string) => void;
    setStatus: (key: string, value: string | undefined) => void;
  };
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
};
type CommandHandler = (_args: string, ctx: CommandContext) => Promise<void>;
type EventHandler = (_event: unknown, ctx: CommandContext) => Promise<void>;

const originalHome = process.env.HOME;
const originalStateDir = process.env.PI_CODING_AGENT_DIR;
const originalPath = process.env.PATH;
const originalDeadloop = process.env.DEADLOOP;
const originalDeadloopAutomations = process.env.DEADLOOP_AUTOMATIONS;
const sandboxes: string[] = [];
const retainedExtensionShutdowns: Array<() => Promise<void>> = [];
// The extension resolves its state directory when the module loads. Reusing this
// stable path lets every extension factory get fresh closure state without paying
// for a transformed module reload; fixtureRepository replaces all files per test.
const repositoryTemplates = new Map<boolean, string>();
// Execution-supply dependencies are intentionally hard-linked, so the package
// checkout and Automation host state must share a filesystem in this suite.
const fixtureParent = mkdtempSync(path.join(os.homedir(), ".cache", "deadloop-enablement-suite-"));
const enabledSafetyFields = {
  githubRepositoryId: "R_demo",
  automationLogin: "deadloop-bot",
  firstEnableAutoMerge: false,
  firstStartPending: false,
  lastObservedAutoMerge: false,
  autoMergeAcknowledged: false,
  enabled: true,
};

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

function gitReportMutationSnapshot(repoPath: string): string {
  const gitDir = git(repoPath, ["rev-parse", "--git-dir"]).trim();
  const fetchHead = path.join(repoPath, gitDir, "FETCH_HEAD");
  return JSON.stringify({
    refs: git(repoPath, ["show-ref"]),
    fetchHead: existsSync(fetchHead) ? readFileSync(fetchHead, "utf8") : null,
  });
}

function repositoryTemplate(separateGitDir: boolean): string {
  const cached = repositoryTemplates.get(separateGitDir);
  if (cached) return cached;

  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-enablement-template-"));
  const repoPath = path.join(root, "primary");
  mkdirSync(repoPath);
  const externalGitDir = path.join(root, "external.git");
  git(repoPath, ["init", "--quiet", ...(separateGitDir ? [`--separate-git-dir=${externalGitDir}`] : [])]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repoPath, "README.md"), "fixture\n");
  writeFileSync(path.join(repoPath, "deadloop.json"), `${JSON.stringify({ checkCommand: "true" })}\n`);
  git(repoPath, ["add", "README.md", "deadloop.json"]);
  git(repoPath, ["commit", "--quiet", "-m", "initial"]);
  execFileSync("git", ["clone", "--quiet", "--bare", repoPath, path.join(root, "origin.git")]);
  git(repoPath, ["remote", "add", "origin", "https://github.com/owner/demo.git"]);
  git(repoPath, ["update-ref", "refs/remotes/origin/master", "master"]);

  const binDir = path.join(root, "bin");
  mkdirSync(binDir);
  const gitPath = path.join(binDir, "git");
  writeFileSync(gitPath, `#!/bin/sh
# The immutable template already contains the fetched base ref. Avoid only the
# repeated policy refresh and keep explicit origin/refspec fetches observable
# through the real Git command.
if [ "$3" = "fetch" ] && [ "$#" -eq 4 ]; then
  exit 0
elif [ "$3 $4" = "remote get-url" ]; then
  repo="$2"
  if printf '%s\\n' "$@" | grep -qx -- '--push'; then
    urls=$(/usr/bin/git -C "$repo" config --get-all remote.origin.pushurl)
    if [ -n "$urls" ]; then printf '%s\\n' "$urls"; else /usr/bin/git -C "$repo" config --get-all remote.origin.url; fi
  else
    /usr/bin/git -C "$repo" config --get-all remote.origin.url
  fi
else
  exec /usr/bin/git "$@"
fi
`);
  chmodSync(gitPath, 0o755);
  const ghPath = path.join(binDir, "gh");
  writeFileSync(ghPath, `#!/bin/sh
case "$*" in
  "repo view other/"*" --json id") printf '%s\\n' '{"id":"R_other"}' ;;
  "repo view "*" --json id") printf '%s\\n' '{"id":"R_demo"}' ;;
  *) exit 1 ;;
esac
`);
  chmodSync(ghPath, 0o755);
  repositoryTemplates.set(separateGitDir, root);
  return root;
}

function fixtureRepository(options: { separateGitDir?: boolean; realPolicyLookup?: boolean } = {}) {
  const separateGitDir = options.separateGitDir === true;
  const templateRoot = repositoryTemplate(separateGitDir);
  const root = path.join(fixtureParent, "fixture");
  rmSync(root, { recursive: true, force: true });
  cpSync(templateRoot, root, { recursive: true });
  sandboxes.push(root);
  const repoPath = path.join(root, "primary");
  const barePath = path.join(root, "origin.git");
  if (separateGitDir) {
    writeFileSync(path.join(repoPath, ".git"), `gitdir: ${path.join(root, "external.git")}\n`);
    const configPath = path.join(root, "external.git", "config");
    writeFileSync(configPath, readFileSync(configPath, "utf8").replaceAll(templateRoot, root));
  }
  writeFileSync(path.join(root, ".gitconfig"), `[url "file://${barePath}"]
\tinsteadOf = https://github.com/owner/demo.git
\tinsteadOf = https://github.com/old/demo.git
\tinsteadOf = https://github.com/new/demo.git
`);
  if (options.realPolicyLookup) writeFileSync(path.join(root, "real-policy-lookup"), "");
  return { root, repoPath };
}

async function loadExtension(
  root: string,
  options: {
    failLabel?: boolean;
    labels?: unknown[];
    viewerPermission?: string;
    fetchRemote?: string;
    pushRemote?: string;
    canonicalRepos?: Record<string, string>;
    repositoryIds?: Record<string, string>;
    upstream?: string;
    noUpstream?: boolean;
    defaultBranch?: string;
    authenticatedLogin?: string;
    beforePrimaryCheckout?: () => Promise<void>;
    beforeGithubRepoCheck?: () => Promise<void>;
    beforeLabelLookup?: (name: string) => Promise<void>;
    beforeLabelCreate?: (name: string) => Promise<void>;
    beforeDisableLock?: () => Promise<void>;
    afterEnablementSaved?: () => Promise<void>;
    afterEnablementSchedulerStart?: () => Promise<void>;
    beforeEnablementWorktreeCreate?: (journalPath: string) => Promise<void>;
    beforeEnablementProjectCheck?: (worktreePath: string) => Promise<void>;
    runAutomationScript?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
    herdrCompatibilityPreflight?: () => void;
    schedulerLockCapabilityPreflight?: () => void;
    recoveryFixture?: {
      issues: unknown[];
      worktrees: unknown[];
      workspaces: unknown[];
      agents: unknown[];
      runNodeScript?: (args: string[]) => { code: number; stdout: string; stderr: string };
    };
  } = {},
): Promise<{ commands: Map<string, CommandHandler>; events: Map<string, EventHandler>; execCommands: string[][]; ghCommands: string[][]; messages: string[] }> {
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = path.join(root, ".pi", "agent");
  process.env.PATH = `${path.join(root, "bin")}:${originalPath || ""}`;
  const commands = new Map<string, CommandHandler>();
  const events = new Map<string, EventHandler>();
  const messages: string[] = [];
  const execCommands: string[][] = [];
  const ghCommands: string[][] = [];
  // @ts-expect-error Vitest transforms this runtime extension import.
  const extension = (await import("../extensions/deadloop/index")).default;
  extension({
    exec: async (command: string, args: string[]) => {
      execCommands.push([command, ...args]);
      if (command === "git") {
        if (args.includes("--show-toplevel")) await options.beforePrimaryCheckout?.();
        const primaryRepoPath = path.join(root, "primary");
        if (args[1] === primaryRepoPath && args[2] === "rev-parse" && args.length === 4) {
          if (args[3] === "--show-toplevel") return { code: 0, stdout: `${primaryRepoPath}\n`, stderr: "" };
          const gitFile = path.join(primaryRepoPath, ".git");
          const gitDir = existsSync(path.join(root, "external.git"))
            ? path.join(root, "external.git")
            : gitFile;
          if (gitDir && (args[3] === "--git-dir" || args[3] === "--git-common-dir")) {
            return { code: 0, stdout: `${gitDir}\n`, stderr: "" };
          }
        }
        if (args.includes("get-url")) {
          const remote = args.includes("--push") ? options.pushRemote || "https://github.com/owner/demo.git" : options.fetchRemote || "https://github.com/owner/demo.git";
          return { code: 0, stdout: `${remote}\n`, stderr: "" };
        }
        if (args.includes("--symbolic-full-name")) return options.noUpstream ? { code: 128, stdout: "", stderr: "no upstream" } : { code: 0, stdout: `${options.upstream || "origin/master"}\n`, stderr: "" };
        if (args.includes("show")) return { code: 1, stdout: "", stderr: "missing" };
        try {
          return { code: 0, stdout: execFileSync("git", args, { encoding: "utf8" }), stderr: "" };
        } catch (error) {
          return { code: 1, stdout: "", stderr: String(error) };
        }
      }
      if (command === "bash" && options.runAutomationScript) return await options.runAutomationScript(args);
      if (command === "node" && options.recoveryFixture?.runNodeScript) return options.recoveryFixture.runNodeScript(args);
      if (command === "gh") ghCommands.push(args);
      if (command === "gh" && args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
      if (command === "gh" && args[0] === "repo") {
        await options.beforeGithubRepoCheck?.();
        const requestedRepo = args[2];
        return {
          code: 0,
          stdout: JSON.stringify({
            id: options.repositoryIds?.[requestedRepo] || "R_demo",
            viewerPermission: options.viewerPermission || "WRITE",
            nameWithOwner: options.canonicalRepos?.[requestedRepo] || "owner/demo",
            defaultBranchRef: { name: options.defaultBranch || "master" },
          }),
          stderr: "",
        };
      }
      if (command === "gh" && args[0] === "issue" && args[1] === "list" && options.recoveryFixture) {
        return { code: 0, stdout: JSON.stringify(options.recoveryFixture.issues), stderr: "" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list" && options.recoveryFixture) {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (command === "gh" && args[0] === "api" && args[1] === "user") {
        return { code: 0, stdout: `${options.authenticatedLogin ?? "deadloop-bot"}\n`, stderr: "" };
      }
      if (command === "gh" && args[0] === "api") {
        const name = decodeURIComponent(args.at(-1)?.split("/").at(-1) || "");
        await options.beforeLabelLookup?.(name);
        return (options.labels || []).some((label: any) => label.name === name)
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      }
      if (command === "gh" && args[0] === "label" && args[1] === "create") {
        await options.beforeLabelCreate?.(args[2]);
        return options.failLabel ? { code: 1, stdout: "", stderr: "label denied" } : { code: 0, stdout: "", stderr: "" };
      }
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list") {
        return { code: 0, stdout: JSON.stringify({ id: "cli:worktree:list", result: { type: "worktree_list", worktrees: options.recoveryFixture?.worktrees || [] } }), stderr: "" };
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "list" && args.length === 2) {
        return { code: 0, stdout: JSON.stringify({ id: "cli:agent:list", result: { type: "agent_list", agents: options.recoveryFixture?.agents || [] } }), stderr: "" };
      }
      if (command === "herdr" && args[0] === "workspace" && args[1] === "list" && args.length === 2) {
        return { code: 0, stdout: JSON.stringify({ id: "cli:workspace:list", result: { type: "workspace_list", workspaces: options.recoveryFixture?.workspaces || [] } }), stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
    registerCommand: (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler),
    on: (name: string, handler: EventHandler) => events.set(name, handler),
    sendMessage: (message: { content: string }) => messages.push(message.content),
    sendUserMessage: () => undefined,
    testing: {
      beforeDisableLock: options.beforeDisableLock,
      afterEnablementSaved: options.afterEnablementSaved,
      afterEnablementSchedulerStart: options.afterEnablementSchedulerStart,
      beforeEnablementWorktreeCreate: options.beforeEnablementWorktreeCreate,
      beforeEnablementProjectCheck: options.beforeEnablementProjectCheck,
      herdrCompatibilityPreflight: options.herdrCompatibilityPreflight || (() => undefined),
      schedulerLockCapabilityPreflight: options.schedulerLockCapabilityPreflight,
    },
  });
  retainedExtensionShutdowns.push(async () => {
    await events.get("session_shutdown")?.({}, {
      cwd: path.join(root, "primary"),
      mode: "interactive",
      ui: { notify: () => undefined, setStatus: () => undefined },
    });
  });
  return { commands, events, execCommands, ghCommands, messages };
}

function writeConfig(root: string, repoPath: string, options: { autoMerge?: boolean; worktreeRoot?: string; githubRepo?: string; enabled?: boolean } = {}): void {
  const stateDir = path.join(root, ".pi", "agent", "deadloop");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify({
    projects: [{
      id: "demo",
      repoPath,
      githubRepo: options.githubRepo || "owner/demo",
      automations: [],
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
      ...(options.autoMerge === undefined ? {} : { autoMerge: options.autoMerge }),
      ...(options.worktreeRoot === undefined ? {} : { worktreeRoot: options.worktreeRoot }),
    }],
  }));
}

async function invoke(handler: CommandHandler, cwd: string, schedulerState: Pick<CommandContext, "isIdle" | "hasPendingMessages"> = {}): Promise<void> {
  await handler("", { cwd, mode: "interactive", ui: { notify: () => undefined, setStatus: () => undefined }, ...schedulerState });
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function enablementProgressObservation(): Promise<{
  notificationWhileVerificationRuns: string | undefined;
  statusWhileVerificationRuns: { key: string; value: string | undefined } | undefined;
  finalStatus: { key: string; value: string | undefined } | undefined;
  statuses: Array<{ key: string; value: string | undefined }>;
}> {
  const { root, repoPath } = fixtureRepository();
  let verificationStarted!: () => void;
  let finishVerification!: () => void;
  const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { finishVerification = resolve; });
  const extension = await loadExtension(root, {
    beforeEnablementProjectCheck: async () => {
      verificationStarted();
      await blocked;
    },
  });
  const notifications: string[] = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const enabling = extension.commands.get("deadloop-enable")!("", {
    cwd: repoPath,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string) => { notifications.push(message); },
      setStatus: (key: string, value: string | undefined) => { statuses.push({ key, value }); },
    },
  });

  await started;
  const notificationWhileVerificationRuns = notifications.at(-1);
  const statusWhileVerificationRuns = statuses.at(-1);
  finishVerification();
  await enabling;
  return { notificationWhileVerificationRuns, statusWhileVerificationRuns, finalStatus: statuses.at(-1), statuses };
}

afterAll(() => {
  for (const templateRoot of repositoryTemplates.values()) rmSync(templateRoot, { recursive: true, force: true });
  rmSync(fixtureParent, { recursive: true, force: true });
});

afterEach(async () => {
  for (const shutdown of retainedExtensionShutdowns.splice(0)) await shutdown();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalStateDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalStateDir;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalDeadloop === undefined) delete process.env.DEADLOOP;
  else process.env.DEADLOOP = originalDeadloop;
  if (originalDeadloopAutomations === undefined) delete process.env.DEADLOOP_AUTOMATIONS;
  else process.env.DEADLOOP_AUTOMATIONS = originalDeadloopAutomations;
  for (const sandbox of sandboxes.splice(0)) {
    execFileSync("chmod", ["-R", "u+w", sandbox]);
    rmSync(sandbox, { recursive: true, force: true });
  }
});

async function explicitNpmCommandWithoutLockfileObservation(): Promise<string | undefined> {
  const { root, repoPath } = fixtureRepository();
  writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ scripts: { verify: "true" } }));
  writeFileSync(path.join(repoPath, "deadloop.json"), JSON.stringify({ checkCommand: "npm run verify" }));
  git(repoPath, ["add", "package.json", "deadloop.json"]);
  git(repoPath, ["commit", "--quiet", "-m", "add explicit npm verification"]);
  git(repoPath, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  const extension = await loadExtension(root);

  await invoke(extension.commands.get("deadloop-enable")!, repoPath);

  return extension.messages.at(-1);
}

async function timedOutVerificationObservation(): Promise<{
  record: { outcome: string; exitCode: number | null; terminationReason?: string; timedOut: boolean; timeoutMs: number };
  log: string;
}> {
  const { root, repoPath } = fixtureRepository();
  const baseRevision = git(repoPath, ["rev-parse", "origin/master"]).trim();
  const result = await runEnablementVerification({
    stateDir: path.join(root, ".pi", "agent", "deadloop"),
    primaryRepoPath: repoPath,
    repository: "owner/demo",
    resolution: {
      status: "resolved",
      contract: {
        repository: "owner/demo",
        command: "sleep 60",
        source: { kind: "repo_policy", location: "deadloop.json" },
        baseRevision,
      },
    },
    timeoutMs: 25,
  });
  return {
    record: JSON.parse(readFileSync(result.recordPath, "utf8")),
    log: readFileSync(result.logPath, "utf8"),
  };
}

async function interruptedVerificationObservation(): Promise<{
  outcome: string;
  exitCode: number | null;
  terminationReason?: string;
}> {
  const { root, repoPath } = fixtureRepository();
  const baseRevision = git(repoPath, ["rev-parse", "origin/master"]).trim();
  const controller = new AbortController();
  controller.abort();
  const result = await runEnablementVerification({
    stateDir: path.join(root, ".pi", "agent", "deadloop"),
    primaryRepoPath: repoPath,
    repository: "owner/demo",
    resolution: {
      status: "resolved",
      contract: {
        repository: "owner/demo",
        command: "sleep 60",
        source: { kind: "repo_policy", location: "deadloop.json" },
        baseRevision,
      },
    },
    signal: controller.signal,
  });
  return JSON.parse(readFileSync(result.recordPath, "utf8"));
}

async function interruptedEnablementCommandObservation(trigger: "disable" | "shutdown"): Promise<{
  outcome: string;
  restoredArtifact: string;
  message: string | undefined;
}> {
  const { root, repoPath } = fixtureRepository();
  writeConfig(root, repoPath);
  const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.projects[0].checkCommand = "sleep 60";
  writeFileSync(configPath, JSON.stringify(config));
  let worktreePath = "";
  let projectCheckStarted!: () => void;
  const started = new Promise<void>((resolve) => { projectCheckStarted = resolve; });
  const extension = await loadExtension(root, {
    beforeEnablementProjectCheck: async (candidate) => {
      worktreePath = candidate;
      mkdirSync(path.join(candidate, ".deadloop"));
      writeFileSync(path.join(candidate, ".deadloop", "evidence"), "restored\n");
      projectCheckStarted();
    },
  });

  const enabling = invoke(extension.commands.get("deadloop-enable")!, repoPath);
  await started;
  if (trigger === "disable") {
    await invoke(extension.commands.get("deadloop-disable")!, repoPath);
  } else {
    await extension.events.get("session_shutdown")?.({}, {
      cwd: repoPath,
      mode: "interactive",
      ui: { notify: () => undefined, setStatus: () => undefined },
    });
  }
  await enabling;
  const attemptsRoot = path.join(root, ".pi", "agent", "deadloop", "required-verification", "enablement");
  const attemptDir = path.join(attemptsRoot, readdirSync(attemptsRoot)[0]);
  return {
    outcome: JSON.parse(readFileSync(path.join(attemptDir, "record.json"), "utf8")).outcome,
    restoredArtifact: readFileSync(path.join(worktreePath, ".deadloop", "evidence"), "utf8"),
    message: extension.messages.find((message) => message.startsWith("deadloop was not enabled:")),
  };
}

async function lostAutomationAuthorityObservation(): Promise<{
  report: string | undefined;
  active: boolean;
  schedulerLockRetained: boolean;
}> {
  const { root, repoPath } = fixtureRepository();
  writeConfig(root, repoPath);
  const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
  const extension = await loadExtension(root, {
    afterEnablementSaved: async () => {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      delete state.projects[0].automationLogin;
      writeFileSync(statePath, JSON.stringify(state));
    },
  });

  await invoke(extension.commands.get("deadloop-enable")!, repoPath);

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const enabled = state.projects.find((project: { repoPath: string }) => project.repoPath === repoPath);
  const lockPath = path.join(root, ".pi", "agent", "deadloop", schedulerLockName({ githubRepositoryId: "R_demo" }));
  return {
    report: extension.messages.find((message) => message.startsWith("deadloop was not enabled:")),
    active: enabled?.enabled === true,
    schedulerLockRetained: existsSync(lockPath),
  };
}

async function repeatedEnablementAuthorityLossObservation(): Promise<{
  report: string | undefined;
  before: { enabledAt: number; enableAttemptToken?: string; automationLogin?: string; baseBranch?: string };
  after: { enabledAt: number; enableAttemptToken?: string; automationLogin?: string; baseBranch?: string };
}> {
  const { root, repoPath } = fixtureRepository();
  writeConfig(root, repoPath);
  const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
  let saveCount = 0;
  const extension = await loadExtension(root, {
    afterEnablementSaved: async () => {
      saveCount += 1;
      if (saveCount !== 2) return;
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      delete state.projects[0].automationLogin;
      writeFileSync(statePath, JSON.stringify(state));
    },
  });
  await invoke(extension.commands.get("deadloop-enable")!, repoPath);
  const before = JSON.parse(readFileSync(statePath, "utf8")).projects[0];

  await invoke(extension.commands.get("deadloop-enable")!, repoPath);

  const after = JSON.parse(readFileSync(statePath, "utf8")).projects[0];
  return {
    report: extension.messages.filter((message) => message.startsWith("deadloop was not enabled:")).at(-1),
    before,
    after,
  };
}

async function dirtyFailureObservation(): Promise<{ messageIncludesLogPath: boolean; logIncludesDirtyFailure: boolean }> {
  const { root, repoPath } = fixtureRepository();
  writeConfig(root, repoPath);
  const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.projects[0].checkCommand = "touch retained-artifact; echo dirty-failure >&2; exit 23";
  writeFileSync(configPath, JSON.stringify(config));
  let logPath = "";
  const extension = await loadExtension(root, {
    beforeEnablementWorktreeCreate: async (journalPath) => {
      logPath = path.join(path.dirname(journalPath), "check.log");
    },
  });

  await invoke(extension.commands.get("deadloop-enable")!, repoPath);

  return {
    messageIncludesLogPath: (extension.messages.at(-1) || "").includes(logPath),
    logIncludesDirtyFailure: readFileSync(logPath, "utf8").includes("dirty-failure"),
  };
}

async function verifierExceptionObservation(): Promise<{
  journal: string;
  record: string;
  exitCode: number | null;
  terminationReason?: string;
  log: string;
  worktreeExists: boolean;
  message: string | undefined;
  logPath: string;
}> {
  const { root, repoPath } = fixtureRepository();
  let attemptDir = "";
  let worktreePath = "";
  const extension = await loadExtension(root, {
    beforeEnablementWorktreeCreate: async (journalPath) => {
      attemptDir = path.dirname(journalPath);
      worktreePath = JSON.parse(readFileSync(journalPath, "utf8")).worktreePath;
      const quarantineRoot = path.join(root, ".pi", "agent", "deadloop", "check-quarantine");
      mkdirSync(path.dirname(quarantineRoot), { recursive: true });
      writeFileSync(quarantineRoot, "blocks quarantine setup\n");
    },
  });

  await invoke(extension.commands.get("deadloop-enable")!, repoPath);

  const logPath = path.join(attemptDir, "check.log");
  const record = JSON.parse(readFileSync(path.join(attemptDir, "record.json"), "utf8"));
  return {
    journal: JSON.parse(readFileSync(path.join(attemptDir, "journal.json"), "utf8")).state,
    record: record.outcome,
    exitCode: record.exitCode,
    terminationReason: record.terminationReason,
    log: readFileSync(logPath, "utf8"),
    worktreeExists: existsSync(worktreePath),
    message: extension.messages.at(-1),
    logPath,
  };
}

async function launchFailedRecoveryScenario() {
  const { root, repoPath } = fixtureRepository();
  writeConfig(root, repoPath);
  const stateDir = path.join(root, ".pi", "agent", "deadloop");
  const configPath = path.join(stateDir, "projects.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.projects[0].baseBranch = "origin/master";
  config.projects[0].labels = {
    ready: "custom:ready",
    implement: "custom:implement",
    inProgress: "custom:in-progress",
    blocked: "custom:blocked",
    review: "custom:review",
    reviewing: "custom:reviewing",
    human: "custom:human",
  };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({
    projects: [{ repoPath, githubRepo: "owner/demo", ...enabledSafetyFields, enabledAt: 1 }],
  }));
  const head = git(repoPath, ["rev-parse", "HEAD"]).trim();
  const runDir = path.join(stateDir, "runs", "attempt-211");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
    attemptId: "attempt-211",
    launchUuid: "launch-211",
    project: "demo",
    repository: "owner/demo",
    role: "worker",
    target: { kind: "issue", number: 197 },
    inputRevision: { head },
    branch: "master",
    baseBranch: "origin/master",
    worktreePath: repoPath,
    agentName: "dl-w-197-123456789abc",
    workspaceLabel: "Issue 197",
    promptFile: path.join(runDir, "prompt.md"),
    promiseFile: path.join(runDir, "promise.json"),
    phase: "launch_failed",
    lastSuccessfulPhase: "workspace_opened",
    workspaceId: "workspace-211",
    tabId: "tab-211",
    rootPaneId: "pane-211",
    launchError: "agent start failed",
  }));
  const targetState = path.join(root, "target-state");
  const workspaceState = path.join(root, "workspace-state");
  writeFileSync(targetState, "claimed");
  writeFileSync(workspaceState, "open");
  const binDir = path.join(root, "bin");
  writeFileSync(path.join(binDir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ id: "R_demo" }));
} else if (args[0] === "issue" && args[1] === "view") {
  const requeued = fs.readFileSync(${JSON.stringify(targetState)}, "utf8") === "requeued";
  process.stdout.write(JSON.stringify({ number: 197, state: "OPEN", labels: (requeued ? ["custom:ready", "custom:implement"] : ["custom:ready", "custom:in-progress"]).map((name) => ({ name })) }));
} else if (args[0] === "issue" && args[1] === "edit") {
  const expected = ["issue", "edit", "197", "-R", "owner/demo", "--remove-label", "custom:in-progress", "--add-label", "custom:ready", "--add-label", "custom:implement"];
  if (JSON.stringify(args) !== JSON.stringify(expected)) process.exit(2);
  fs.writeFileSync(${JSON.stringify(targetState)}, "requeued");
} else {
  process.exit(1);
}
`);
  writeFileSync(path.join(binDir, "herdr"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const workspaceOpen = fs.readFileSync(${JSON.stringify(workspaceState)}, "utf8") === "open";
if (args.length === 1 && args[0] === "--version") process.stdout.write("herdr 0.7.5\\n");
else if (args[0] === "status" && args[1] === "server") process.stdout.write("version: 0.7.5\\ncompatible: yes\\n");
else if (args[0] === "workspace" && args[1] === "list") process.stdout.write(JSON.stringify({ result: { workspaces: workspaceOpen ? [{ workspace_id: "workspace-211", pane_count: 1, tab_count: 1, worktree: { checkout_path: ${JSON.stringify(repoPath)} } }] : [] } }));
else if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({ result: { worktrees: [{ branch: "master", path: ${JSON.stringify(repoPath)}, open_workspace_id: workspaceOpen ? "workspace-211" : null }] } }));
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({ result: { agents: [] } }));
else if (args[0] === "workspace" && args[1] === "close" && args[2] === "workspace-211") fs.writeFileSync(${JSON.stringify(workspaceState)}, "closed");
else process.exit(1);
`);
  chmodSync(path.join(binDir, "gh"), 0o755);
  chmodSync(path.join(binDir, "herdr"), 0o755);
  const recoveryFixture = {
    issues: [{ number: 197, title: "fixture", updatedAt: "2026-08-05T00:00:00Z", labels: ["custom:ready", "custom:in-progress"] }],
    worktrees: [{ branch: "master", path: repoPath, open_workspace_id: "workspace-211" }],
    workspaces: [{ workspace_id: "workspace-211", pane_count: 1, tab_count: 1, worktree: { checkout_path: repoPath } }],
    agents: [],
    runNodeScript: (args: string[]) => {
      try {
        return { code: 0, stdout: execFileSync(process.execPath, args, { encoding: "utf8" }), stderr: "" };
      } catch (error: any) {
        return { code: error.status || 1, stdout: String(error.stdout || ""), stderr: String(error.stderr || error) };
      }
    },
  };
  const extension = await loadExtension(root, { recoveryFixture });
  return { extension, repoPath, runDir, targetState };
}

async function ownedWorktreeIntentObservation(): Promise<{
  state?: string;
  repository?: string;
  primaryRepoPath?: string;
  repoPath: string;
}> {
  const { root, repoPath } = fixtureRepository();
  let preparedJournal: unknown;
  const extension = await loadExtension(root, {
    beforeEnablementWorktreeCreate: async (journalPath) => {
      preparedJournal = JSON.parse(readFileSync(journalPath, "utf8"));
    },
  });

  await invoke(extension.commands.get("deadloop-enable")!, repoPath);

  return { ...(preparedJournal as { state?: string; repository?: string; primaryRepoPath?: string }), repoPath };
}

async function retainedVerificationDoctorObservation(): Promise<{
  report: string;
  journal: Record<string, string>;
  journalPath: string;
}> {
  const { root, repoPath } = fixtureRepository();
  writeConfig(root, repoPath);
  const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.projects[0].checkCommand = "touch retained-by-verification";
  writeFileSync(configPath, JSON.stringify(config));
  let journalPath = "";
  const extension = await loadExtension(root, {
    beforeEnablementWorktreeCreate: async (value) => { journalPath = value; },
  });
  await invoke(extension.commands.get("deadloop-enable")!, repoPath);
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));

  await invoke(extension.commands.get("deadloop-doctor")!, repoPath);

  return { report: extension.messages.at(-1) || "", journal, journalPath };
}

async function dependencySetupObservation(): Promise<{
  enabled: boolean;
  retentionReported: boolean;
  cleanup: string;
}> {
  const { root, repoPath } = fixtureRepository();
  mkdirSync(path.join(repoPath, "vendor", "fixture-dependency"), { recursive: true });
  writeFileSync(path.join(repoPath, "vendor", "fixture-dependency", "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }));
  writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ dependencies: { "fixture-dependency": "file:vendor/fixture-dependency" } }));
  writeFileSync(path.join(repoPath, ".gitignore"), "node_modules/\n");
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: repoPath, stdio: "ignore" });
  rmSync(path.join(repoPath, "node_modules"), { recursive: true, force: true });
  writeFileSync(path.join(repoPath, "deadloop.json"), JSON.stringify({
    checkCommand: "npm ci --ignore-scripts --no-audit --no-fund && test -f node_modules/fixture-dependency/package.json",
  }));
  git(repoPath, ["add", ".gitignore", "package.json", "package-lock.json", "vendor", "deadloop.json"]);
  git(repoPath, ["commit", "--quiet", "-m", "add dependency verification fixture"]);
  git(repoPath, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  let journalPath = "";
  const extension = await loadExtension(root, {
    beforeEnablementWorktreeCreate: async (path) => {
      journalPath = path;
    },
  });

  await invoke(extension.commands.get("deadloop-enable")!, repoPath);

  return {
    enabled: extension.messages.at(-1)?.includes("deadloop enabled") || false,
    retentionReported: extension.messages.at(-1)?.includes(journalPath) || false,
    cleanup: JSON.parse(readFileSync(journalPath, "utf8")).state,
  };
}

async function retainedGeneralProjectCheckDoctorObservation(): Promise<{ report: string; quarantinePath: string }> {
  const { root, repoPath } = fixtureRepository();
  writeConfig(root, repoPath);
  const stateDir = path.join(root, ".pi", "agent", "deadloop");
  const extension = await loadExtension(root);
  await invoke(extension.commands.get("deadloop-enable")!, repoPath);
  const runDir = path.join(stateDir, "runs", "project-check-attempt");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
    attemptId: "attempt-project-check",
    launchUuid: "project-check-attempt",
    project: "demo",
    repository: "owner/demo",
    role: "worker",
    target: { kind: "issue", number: 198 },
    inputRevision: { head: "a".repeat(40) },
    branch: "agent/issue-198",
    worktreePath: repoPath,
    agentName: "worker",
    workspaceLabel: "worker",
    promptFile: path.join(runDir, "prompt.md"),
    promiseFile: path.join(runDir, "promise.json"),
    phase: "prepared",
    lastSuccessfulPhase: "prepared",
  }));
  const quarantinePath = path.join(stateDir, "check-quarantine", "retained");
  mkdirSync(quarantinePath, { recursive: true });
  const previousExitCode = process.exitCode;
  try {
    await projectCheckMain([
      "--cwd", repoPath,
      "--command", "true",
      "--quarantine-root", path.join(stateDir, "check-quarantine"),
    ], async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      interrupted: false,
      signal: null,
      restorationFailure: { message: "restore blocked", quarantinePath },
    }));
  } finally {
    process.exitCode = previousExitCode;
  }
  await invoke(extension.commands.get("deadloop-doctor")!, repoPath);
  return { report: extension.messages.at(-1) || "", quarantinePath };
}

async function unresolvedProjectCheckDoctorObservation(attemptRecord: "missing" | "corrupt") {
  const { root, repoPath } = fixtureRepository();
  writeConfig(root, repoPath);
  const stateDir = path.join(root, ".pi", "agent", "deadloop");
  const extension = await loadExtension(root);
  await invoke(extension.commands.get("deadloop-enable")!, repoPath);
  if (attemptRecord === "corrupt") {
    const runDir = path.join(stateDir, "runs", "corrupt-project-check-attempt");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "attempt.json"), "{malformed");
  }
  const quarantinePath = path.join(stateDir, "check-quarantine", `unresolved-${attemptRecord}`);
  mkdirSync(quarantinePath, { recursive: true });
  const previousExitCode = process.exitCode;
  try {
    await projectCheckMain([
      "--cwd", repoPath,
      "--command", "true",
      "--quarantine-root", path.join(stateDir, "check-quarantine"),
    ], async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      interrupted: false,
      signal: null,
      restorationFailure: { message: "restore blocked", quarantinePath },
    }));
  } finally {
    process.exitCode = previousExitCode;
  }
  await invoke(extension.commands.get("deadloop-doctor")!, repoPath);
  return { report: extension.messages.at(-1) || "", quarantinePath };
}

describe("enablement command integration", () => {
  it("acknowledges enablement before required verification completes", async () => {
    expect((await enablementProgressObservation()).notificationWhileVerificationRuns).toBe(
      "Enabling deadloop. Required verification may take several minutes.",
    );
  });

  it("shows required verification progress while the command is blocked", async () => {
    expect((await enablementProgressObservation()).statusWhileVerificationRuns?.value).toBe(
      "deadloop: running required verification…",
    );
  });

  it("shows GitHub access and label progress after required verification", async () => {
    expect((await enablementProgressObservation()).statuses.map(({ value }) => value)).toContain(
      "deadloop: checking GitHub access and labels…",
    );
  });

  it("clears enablement progress after the command completes", async () => {
    const observation = await enablementProgressObservation();
    expect(observation.finalStatus).toEqual({
      key: observation.statusWhileVerificationRuns?.key,
      value: undefined,
    });
  });

  it("runs the OS lock capability preflight before GitHub enablement mutations", async () => {
    const { root, repoPath } = fixtureRepository();
    const events: string[] = [];
    const extension = await loadExtension(root, {
      schedulerLockCapabilityPreflight: () => { events.push("lock-preflight"); },
      beforeLabelCreate: async () => { events.push("github-mutation"); },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect({ first: events[0], githubMutation: events.includes("github-mutation") }).toEqual({
      first: "lock-preflight", githubMutation: true,
    });
  });

  it("does not persist enablement when flock is unavailable", async () => {
    const { root, repoPath } = fixtureRepository();
    const extension = await loadExtension(root, {
      schedulerLockCapabilityPreflight: () => { throw new Error("flock executable is required (usually util-linux)"); },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"))).toBe(false);
  });

  it("writes no enable-attempt persistence when flock capability is unavailable", async () => {
    const { root, repoPath } = fixtureRepository();
    const extension = await loadExtension(root, {
      schedulerLockCapabilityPreflight: () => { throw new Error("flock unavailable"); },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const stateDir = path.join(root, ".pi", "agent", "deadloop");
    expect(existsSync(stateDir) && readdirSync(stateDir).some((name) => name.startsWith("enable-attempt-"))).toBe(false);
  });

  it("explains incompatible nonblocking FD flock behavior", async () => {
    const { root, repoPath } = fixtureRepository();
    const extension = await loadExtension(root, {
      schedulerLockCapabilityPreflight: () => { throw new Error("flock must support nonblocking file-descriptor locks"); },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("nonblocking file-descriptor locks");
  });
  it("persists the configured base branch instead of the current branch upstream", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.projects[0].baseBranch = "origin/master";
    writeFileSync(configPath, JSON.stringify(config));
    git(repoPath, ["update-ref", "refs/remotes/origin/topic", "HEAD"]);
    const extension = await loadExtension(root, { upstream: "origin/topic" });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const state = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8"));
    expect(state.projects[0].baseBranch).toBe("origin/master");
  });

  it("rejects a base branch change before scheduler startup even when both refs resolve to the same commit", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    git(repoPath, ["update-ref", "refs/remotes/origin/topic", "HEAD"]);
    const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
    const extension = await loadExtension(root, {
      afterEnablementSaved: async () => {
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        config.projects[0].baseBranch = "origin/topic";
        writeFileSync(configPath, JSON.stringify(config));
      },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("configured base branch changed since enablement");
  });

  it("persists the authenticated GitHub login as an authorized automation identity", async () => {
    const { root, repoPath } = fixtureRepository();
    const extension = await loadExtension(root, { authenticatedLogin: "Deadloop-Bot" });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const state = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8"));
    expect(state.projects[0].automationLogin).toBe("deadloop-bot");
  });

  it("repairs an older enabled record that has no authorized automation identity", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const stateDir = path.join(root, ".pi", "agent", "deadloop");
    writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({
      projects: [{
        repoPath,
        githubRepo: "owner/demo",
        githubRepositoryId: "R_demo",
        enabledAt: 1,
        disableGeneration: 0,
        enableAttemptToken: "older-enable",
        baseBranch: "origin/master",
        ...enabledSafetyFields,
        automationLogin: undefined,
      }],
    }));
    const extension = await loadExtension(root, { authenticatedLogin: "Deadloop-Bot" });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const state = JSON.parse(readFileSync(path.join(stateDir, "enabled-projects.json"), "utf8"));
    const lockPath = path.join(stateDir, schedulerLockName({ githubRepositoryId: "R_demo" }));
    expect({
      automationLogin: state.projects[0].automationLogin,
      enabled: state.projects[0].enabled,
      report: extension.messages.at(-1),
      schedulerOwned: existsSync(lockPath),
    }).toEqual({
      automationLogin: "deadloop-bot",
      enabled: true,
      report: "deadloop enabled for owner/demo; scheduler owner: this session. autoMerge is off.",
      schedulerOwned: true,
    });
  });

  it("does not restore an unauthorized older record when repaired authority is lost", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    writeFileSync(statePath, JSON.stringify({
      projects: [{
        repoPath,
        githubRepo: "owner/demo",
        githubRepositoryId: "R_demo",
        enabledAt: 1,
        disableGeneration: 0,
        enableAttemptToken: "older-enable",
        baseBranch: "origin/master",
        ...enabledSafetyFields,
        automationLogin: undefined,
      }],
    }));
    const extension = await loadExtension(root, {
      afterEnablementSaved: async () => {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        delete state.projects[0].automationLogin;
        writeFileSync(statePath, JSON.stringify(state));
      },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.projects[0].enabled).toBe(false);
  });

  it("reports failed enablement when persisted automation authority disappears before scheduler startup", async () => {
    expect((await lostAutomationAuthorityObservation()).report).toContain("automation authority changed after enablement was saved");
  });

  it("releases scheduler ownership when automation authority changes during startup", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    const extension = await loadExtension(root, {
      afterEnablementSchedulerStart: async () => {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        delete state.projects[0].automationLogin;
        writeFileSync(statePath, JSON.stringify(state));
      },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const lockPath = path.join(root, ".pi", "agent", "deadloop", schedulerLockName({ githubRepositoryId: "R_demo" }));
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not leave the repository active when persisted automation authority disappears", async () => {
    expect((await lostAutomationAuthorityObservation()).active).toBe(false);
  });

  it("does not retain scheduler ownership when persisted automation authority disappears", async () => {
    expect((await lostAutomationAuthorityObservation()).schedulerLockRetained).toBe(false);
  });

  it("restores the prior authority when repeated enablement loses its saved identity", async () => {
    const observation = await repeatedEnablementAuthorityLossObservation();
    expect({
      reportFailed: observation.report?.includes("automation authority changed after enablement was saved"),
      enabledAt: observation.after.enabledAt,
      enableAttemptToken: observation.after.enableAttemptToken,
      automationLogin: observation.after.automationLogin,
      baseBranch: observation.after.baseBranch,
    }).toEqual({
      reportFailed: true,
      enabledAt: observation.before.enabledAt,
      enableAttemptToken: observation.before.enableAttemptToken,
      automationLogin: observation.before.automationLogin,
      baseBranch: observation.before.baseBranch,
    });
  });

  it("does not enable without an authenticated GitHub login", async () => {
    const { root, repoPath } = fixtureRepository();
    const extension = await loadExtension(root, { authenticatedLogin: "" });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("authenticated GitHub login is required");
  });

  it("passes the default enablement identity to the reviewer driver environment", async () => {
    const { root, repoPath } = fixtureRepository();
    writeFileSync(path.join(repoPath, "deadloop.json"), JSON.stringify({
      checkCommand: "true",
      automations: [{
        id: "demo:pr-reviewer",
        name: "demo PR reviewer",
        promptFile: "pr-reviewer.prompt.md",
        precheckFile: "pr-reviewer.precheck.sh",
        driverFile: "pr-reviewer-driver.ts",
      }],
    }));
    git(repoPath, ["add", "deadloop.json"]);
    git(repoPath, ["commit", "--quiet", "-m", "configure reviewer fixture"]);
    git(repoPath, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    let reviewerCommand = "";
    const extension = await loadExtension(root, {
      authenticatedLogin: "Deadloop-Bot",
      runAutomationScript: async (args) => {
        const command = args.join(" ");
        if (command.includes("pr-reviewer-driver.ts")) reviewerCommand = command;
        return {
          code: 0,
          stdout: command.includes("pr-reviewer-driver.ts") ? JSON.stringify({ action: "skip", summary: "fixture" }) : "",
          stderr: "",
        };
      },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    for (let attempt = 0; attempt < 100 && !reviewerCommand; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(reviewerCommand).toContain("DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS='deadloop-bot'");
  });

  it("records prepared verification worktree intent before creation", async () => {
    expect((await ownedWorktreeIntentObservation()).state).toBe("prepared");
  });

  it("binds verification worktree intent to the repository identity", async () => {
    expect((await ownedWorktreeIntentObservation()).repository).toBe("owner/demo");
  });

  it("binds verification worktree intent to the primary repository path", async () => {
    const observation = await ownedWorktreeIntentObservation();
    expect(observation.primaryRepoPath).toBe(observation.repoPath);
  });

  it("records the trusted target revision before worktree creation", async () => {
    const { root, repoPath } = fixtureRepository();
    let targetRevision = "";
    const extension = await loadExtension(root, {
      beforeEnablementWorktreeCreate: async (journalPath) => {
        targetRevision = JSON.parse(readFileSync(journalPath, "utf8")).targetRevision;
      },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(targetRevision).toBe(git(repoPath, ["rev-parse", "origin/master"]).trim());
  });

  it("verifies the exact trusted base revision without ordinary checkout changes", async () => {
    const { root, repoPath } = fixtureRepository();
    writeFileSync(path.join(repoPath, "ordinary-uncommitted.txt"), "local only\n");
    const revision = git(repoPath, ["rev-parse", "origin/master"]).trim();
    const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ projects: [{
      id: "demo", repoPath, githubRepo: "owner/demo",
      checkCommand: `test ! -e ordinary-uncommitted.txt && test \"$(git rev-parse HEAD)\" = ${revision}`,
    }] }));
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("deadloop enabled");
  });

  it("runs an explicit npm verification command without requiring a lockfile", async () => {
    expect(await explicitNpmCommandWithoutLockfileObservation()).toContain("deadloop enabled");
  });

  it("enables after an aggregate command installs dependencies in the verification worktree", async () => {
    expect((await dependencySetupObservation()).enabled).toBe(true);
  });

  it("reports retained verification setup after dependency installation", async () => {
    expect((await dependencySetupObservation()).retentionReported).toBe(true);
  });

  it("retains verification setup after dependency installation", async () => {
    expect((await dependencySetupObservation()).cleanup).toBe("retained");
  });

  it.skipIf(process.env.DEADLOOP_NESTED_ENABLEMENT_CHECK === "1")(
    "runs an explicit aggregate command that includes its dependency setup",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-real-enablement-"));
      sandboxes.push(root);
      const repoPath = path.join(root, "primary");
      execFileSync("git", ["clone", "--quiet", "--no-hardlinks", process.cwd(), repoPath]);
      const baseRevision = git(repoPath, ["rev-parse", "HEAD"]).trim();
      const aggregateCommand = JSON.parse(readFileSync(path.join(repoPath, "deadloop.json"), "utf8")).checkCommand;
      const command = `npm ci --ignore-scripts --no-audit --no-fund && ${aggregateCommand}`;
      const previousNestedCheck = process.env.DEADLOOP_NESTED_ENABLEMENT_CHECK;
      const previousMaxForks = process.env.VITEST_MAX_FORKS;
      const previousMaxThreads = process.env.VITEST_MAX_THREADS;
      process.env.DEADLOOP_NESTED_ENABLEMENT_CHECK = "1";
      // Keep the nested full suite from starting a second process fleet alongside the outer suite in constrained CI runners.
      process.env.VITEST_MAX_FORKS = "1";
      process.env.VITEST_MAX_THREADS = "1";
      try {
        const result = await runEnablementVerification({
          stateDir: path.join(root, "state"),
          primaryRepoPath: repoPath,
          repository: "yasuhito/deadloop",
          resolution: {
            status: "resolved",
            contract: {
              repository: "yasuhito/deadloop",
              command,
              source: { kind: "repo_policy", location: "deadloop.json" },
              baseRevision,
            },
          },
        });
        expect(result.outcome, readFileSync(result.logPath, "utf8")).toBe("passed");
      } finally {
        if (previousNestedCheck === undefined) delete process.env.DEADLOOP_NESTED_ENABLEMENT_CHECK;
        else process.env.DEADLOOP_NESTED_ENABLEMENT_CHECK = previousNestedCheck;
        if (previousMaxForks === undefined) delete process.env.VITEST_MAX_FORKS;
        else process.env.VITEST_MAX_FORKS = previousMaxForks;
        if (previousMaxThreads === undefined) delete process.env.VITEST_MAX_THREADS;
        else process.env.VITEST_MAX_THREADS = previousMaxThreads;
      }
    },
    10 * 60_000,
  );

  it("records timed-out required verification as timed out", async () => {
    expect((await timedOutVerificationObservation()).record.outcome).toBe("timed_out");
  });

  it("records no exit code when required verification times out", async () => {
    expect((await timedOutVerificationObservation()).record.exitCode).toBeNull();
  });

  it("records a typed termination reason when required verification times out", async () => {
    expect((await timedOutVerificationObservation()).record.terminationReason).toBe("timeout");
  });

  it("records when required verification times out", async () => {
    expect((await timedOutVerificationObservation()).record.timedOut).toBe(true);
  });

  it("records the timeout applied to required verification", async () => {
    expect((await timedOutVerificationObservation()).record.timeoutMs).toBe(25);
  });

  it("records interrupted required verification as interrupted", async () => {
    expect((await interruptedVerificationObservation()).outcome).toBe("interrupted");
  });

  it("records no exit code when required verification is interrupted", async () => {
    expect((await interruptedVerificationObservation()).exitCode).toBeNull();
  });

  it("records a typed termination reason when required verification is interrupted", async () => {
    expect((await interruptedVerificationObservation()).terminationReason).toBe("interrupted");
  });

  it("records disable of the public enable command as interrupted", async () => {
    expect((await interruptedEnablementCommandObservation("disable")).outcome).toBe("interrupted");
  });

  it("records session shutdown of the public enable command as interrupted", async () => {
    expect((await interruptedEnablementCommandObservation("shutdown")).outcome).toBe("interrupted");
  });

  it("reports interrupted required verification", async () => {
    expect((await interruptedEnablementCommandObservation("disable")).message).toContain(
      "required verification was interrupted",
    );
  });

  it("does not report a null exit code for interrupted required verification", async () => {
    expect((await interruptedEnablementCommandObservation("disable")).message).not.toContain("exit null");
  });

  it("waits for isolated artifacts to be restored during enable-command shutdown", async () => {
    expect((await interruptedEnablementCommandObservation("shutdown")).restoredArtifact).toBe("restored\n");
  });

  it("writes timeout-specific evidence to the durable verification log", async () => {
    expect((await timedOutVerificationObservation()).log).toContain("required verification timed out after 25ms");
  });

  it("does not use Herdr workspaces or agents for enablement verification", async () => {
    const { root, repoPath } = fixtureRepository();
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.execCommands.some(([command, noun]) => command === "herdr" && ["workspace", "agent"].includes(noun))).toBe(false);
  });

  it("retains disabled state when baseline verification fails", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.projects[0].checkCommand = "exit 23";
    writeFileSync(configPath, JSON.stringify(config));
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"))).toBe(false);
  });

  it("shows the durable log location when baseline verification fails", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.projects[0].checkCommand = "echo baseline-broke >&2; exit 23";
    writeFileSync(configPath, JSON.stringify(config));
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const logPath = /log: (.+)$/.exec(extension.messages.at(-1) || "")?.[1] || "";
    expect(readFileSync(logPath, "utf8")).toContain("baseline-broke");
  });

  it("shows the durable log path when failed verification retains a dirty worktree", async () => {
    expect((await dirtyFailureObservation()).messageIncludesLogPath).toBe(true);
  });

  it("records failed verification output when its worktree is dirty", async () => {
    expect((await dirtyFailureObservation()).logIncludesDirtyFailure).toBe(true);
  });

  it("journals cleanup after a verifier exception", async () => {
    expect((await verifierExceptionObservation()).journal).toBe("cleaned");
  });

  it("records failure after a verifier exception", async () => {
    expect((await verifierExceptionObservation()).record).toBe("failed");
  });

  it("records no exit code after a verifier exception", async () => {
    expect((await verifierExceptionObservation()).exitCode).toBeNull();
  });

  it("records a typed termination reason after a verifier exception", async () => {
    expect((await verifierExceptionObservation()).terminationReason).toBe("runner_failure");
  });

  it("logs a verifier exception", async () => {
    expect((await verifierExceptionObservation()).log).toContain("required verification runner failed");
  });

  it("removes the clean worktree after a verifier exception", async () => {
    expect((await verifierExceptionObservation()).worktreeExists).toBe(false);
  });

  it("reports the log path after a verifier exception", async () => {
    const observation = await verifierExceptionObservation();
    expect(observation.message).toContain(observation.logPath);
  });

  it("removes a clean owned temporary Git worktree after verification", async () => {
    const { root, repoPath } = fixtureRepository();
    let worktreePath = "";
    const extension = await loadExtension(root, {
      beforeEnablementWorktreeCreate: async (journalPath) => {
        worktreePath = JSON.parse(readFileSync(journalPath, "utf8")).worktreePath;
      },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(existsSync(worktreePath)).toBe(false);
  });

  it("retains a temporary Git worktree that verification leaves dirty", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.projects[0].checkCommand = "touch created-by-check";
    writeFileSync(configPath, JSON.stringify(config));
    let worktreePath = "";
    const extension = await loadExtension(root, {
      beforeEnablementWorktreeCreate: async (journalPath) => {
        worktreePath = JSON.parse(readFileSync(journalPath, "utf8")).worktreePath;
      },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(existsSync(path.join(worktreePath, "created-by-check"))).toBe(true);
  });

  it("retains a temporary Git worktree containing an ignored artifact", async () => {
    const { root, repoPath } = fixtureRepository();
    writeFileSync(path.join(repoPath, ".gitignore"), "ignored-by-check\n");
    git(repoPath, ["add", ".gitignore"]);
    git(repoPath, ["commit", "--quiet", "-m", "ignore verification artifact"]);
    git(repoPath, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    writeConfig(root, repoPath);
    const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.projects[0].checkCommand = "touch ignored-by-check";
    writeFileSync(configPath, JSON.stringify(config));
    let worktreePath = "";
    const extension = await loadExtension(root, {
      beforeEnablementWorktreeCreate: async (journalPath) => {
        worktreePath = JSON.parse(readFileSync(journalPath, "utf8")).worktreePath;
      },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(existsSync(path.join(worktreePath, "ignored-by-check"))).toBe(true);
  });

  it("persists a passed record before saving enablement", async () => {
    const { root, repoPath } = fixtureRepository();
    let attemptDir = "";
    const extension = await loadExtension(root, {
      beforeEnablementWorktreeCreate: async (journalPath) => {
        attemptDir = path.dirname(journalPath);
      },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(JSON.parse(readFileSync(path.join(attemptDir, "record.json"), "utf8")).outcome).toBe("passed");
  });

  it.each([
    ["temporary worktree path", (observation: Awaited<ReturnType<typeof retainedVerificationDoctorObservation>>) => observation.journal.worktreePath],
    ["target revision", (observation: Awaited<ReturnType<typeof retainedVerificationDoctorObservation>>) => observation.journal.targetRevision],
    ["journal path", (observation: Awaited<ReturnType<typeof retainedVerificationDoctorObservation>>) => observation.journalPath],
    ["record path", (observation: Awaited<ReturnType<typeof retainedVerificationDoctorObservation>>) => observation.journal.recordPath],
    ["log path", (observation: Awaited<ReturnType<typeof retainedVerificationDoctorObservation>>) => observation.journal.logPath],
    ["confirmation command Git prefix", () => "git -C"],
    ["confirmation command status arguments", () => "status --short --untracked-files=all --ignored"],
  ] as const)("shows retained verification %s in doctor", async (_name, expectedValue) => {
    const observation = await retainedVerificationDoctorObservation();

    expect(observation.report).toContain(expectedValue(observation));
  });

  it("shows a general project-check restoration quarantine in doctor", async () => {
    const observation = await retainedGeneralProjectCheckDoctorObservation();

    expect(observation.report).toContain(observation.quarantinePath);
  });

  it("links a general project-check restoration failure to its attempt in doctor", async () => {
    expect((await retainedGeneralProjectCheckDoctorObservation()).report).toContain("attempt-project-check");
  });

  it.each(["missing", "corrupt"] as const)("shows %s attempt records in an independent unresolved doctor section", async (attemptRecord) => {
    const observation = await unresolvedProjectCheckDoctorObservation(attemptRecord);

    expect({
      hasSection: observation.report.includes("Unresolved retained project-check artifacts"),
      hasQuarantine: observation.report.includes(observation.quarantinePath),
    }).toEqual({ hasSection: true, hasQuarantine: true });
  });

  it("registers the explicit launch-failed attempt abandonment command", async () => {
    const { root } = fixtureRepository();
    const extension = await loadExtension(root);

    expect(extension.commands.has("deadloop-abandon-attempt")).toBe(true);
  });

  it("offers launch-failed recovery using normalized project labels", async () => {
    const { extension, repoPath } = await launchFailedRecoveryScenario();

    await invoke(extension.commands.get("deadloop-doctor")!, repoPath);

    expect(extension.messages.at(-1)).toContain("/deadloop-abandon-attempt attempt-211");
  });

  it("requeues through the real recovery script using normalized project labels", async () => {
    const { extension, repoPath, targetState } = await launchFailedRecoveryScenario();

    await extension.commands.get("deadloop-abandon-attempt")!("attempt-211", {
      cwd: repoPath,
      mode: "interactive",
      ui: { notify: () => undefined, setStatus: () => undefined },
    });

    expect(readFileSync(targetState, "utf8")).toBe("requeued");
  });

  it("records abandonment through the real recovery script", async () => {
    const { extension, repoPath, runDir } = await launchFailedRecoveryScenario();

    await extension.commands.get("deadloop-abandon-attempt")!("attempt-211", {
      cwd: repoPath,
      mode: "interactive",
      ui: { notify: () => undefined, setStatus: () => undefined },
    });

    expect(JSON.parse(readFileSync(path.join(runDir, "attempt.json"), "utf8")).phase).toBe("abandoned");
  });

  it.each([
    ["DEADLOOP", "DEADLOOP=off"],
    ["DEADLOOP_AUTOMATIONS", "DEADLOOP_AUTOMATIONS=off"],
  ] as const)("does not retain enablement when %s suppresses scheduler startup", async (variable, reason) => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    process.env[variable] = "off";
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const state = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8"));
    expect({ enabled: state.projects[0].enabled, message: extension.messages.at(-1) }).toEqual({
      enabled: false,
      message: expect.stringContaining(reason),
    });
  });

  it("preserves an existing enablement and scheduler owner when a repeated enable is suppressed", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    const lockPath = path.join(root, ".pi", "agent", "deadloop", schedulerLockName({ githubRepositoryId: "R_demo" }));
    const originalState = JSON.parse(readFileSync(statePath, "utf8"));
    const originalOwner = readFileSync(lockPath, "utf8");
    process.env.DEADLOOP_AUTOMATIONS = "off";

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const retainedState = JSON.parse(readFileSync(statePath, "utf8"));
    expect({ enabled: retainedState.projects[0].enabled, enabledAt: retainedState.projects[0].enabledAt, owner: readFileSync(lockPath, "utf8") }).toEqual({
      enabled: true,
      enabledAt: originalState.projects[0].enabledAt,
      owner: originalOwner,
    });
  });

  it.each(["deadloop-status", "deadloop-doctor"])("does not recommend enablement outside Git for %s", async (command) => {
    const { root } = fixtureRepository();
    const extension = await loadExtension(root);

    await invoke(extension.commands.get(command)!, root);

    const report = extension.messages.at(-1) || "";
    expect(report.includes("unavailable for the current location") && !report.includes("  /deadloop-enable")).toBe(true);
  });

  it.each(["deadloop-status", "deadloop-doctor"])("preserves invalid configuration diagnostics and recommends enablement for %s", async (command) => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    writeFileSync(path.join(root, ".pi", "agent", "deadloop", "projects.json"), "{");
    const extension = await loadExtension(root);

    await invoke(extension.commands.get(command)!, repoPath);

    const report = extension.messages.at(-1) || "";
    expect(report.includes("warning: projects.json") && report.includes("  /deadloop-enable")).toBe(true);
  });

  it.each(["deadloop-status", "deadloop-doctor"])("keeps enabled identity separate from invalid configuration for %s", async (command) => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    writeFileSync(path.join(root, ".pi", "agent", "deadloop", "projects.json"), "{");

    await invoke(extension.commands.get(command)!, repoPath);

    const report = extension.messages.at(-1) || "";
    expect(report.includes("warning: projects.json") && !report.includes("  /deadloop-enable")).toBe(true);
  });

  it("reports a configured base branch change after enablement instead of scheduling it", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    git(repoPath, ["update-ref", "refs/remotes/origin/topic", "HEAD"]);
    const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.projects[0].baseBranch = "origin/topic";
    writeFileSync(configPath, JSON.stringify(config));

    await invoke(extension.commands.get("deadloop-status")!, repoPath);

    expect(extension.messages.at(-1)).toContain("configured base branch changed since enablement");
  });

  it.each(["deadloop-status", "deadloop-doctor"])("reports remote identity drift as disabled in %s", async (command) => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    git(repoPath, ["remote", "set-url", "origin", "https://github.com/other/repo.git"]);

    await invoke(extension.commands.get(command)!, repoPath);

    expect(extension.messages.at(-1)).toContain("/deadloop-enable");
  });

  it.each(["deadloop-status", "deadloop-doctor"])("recommends enablement for a disabled repository in %s", async (command) => {
    const { root, repoPath } = fixtureRepository();
    const extension = await loadExtension(root);

    await invoke(extension.commands.get(command)!, repoPath);

    expect(extension.messages.at(-1)).toContain("/deadloop-enable");
  });

  it("does not schedule a configured project until dedicated enablement exists", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { enabled: false });

    await loadExtension(root);

    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"))).toBe(false);
  });

  it("uses overrides from a configured project whose obsolete enabled field is false", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { enabled: false });
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const lockPath = path.join(root, ".pi", "agent", "deadloop", schedulerLockName({ githubRepositoryId: "R_demo" }));
    expect(JSON.parse(readFileSync(lockPath, "utf8")).projectId).toBe("demo");
  });

  it("requires an explicit verification command when deadloop.json and projects.json are absent", async () => {
    const { root, repoPath } = fixtureRepository();
    rmSync(path.join(repoPath, "deadloop.json"));
    git(repoPath, ["add", "deadloop.json"]);
    git(repoPath, ["commit", "--quiet", "-m", "remove repository policy"]);
    git(repoPath, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("required verification blocked: no_source");
  });

  it("acknowledges an explicit post-enable change from false to true", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await vi.advanceTimersByTimeAsync(3_000);
    writeConfig(root, repoPath, { autoMerge: false });
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    writeConfig(root, repoPath, { autoMerge: true });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("autoMerge is on");
  });

  it("keeps an in-flight guarded operation authorized after repeated enable", async () => {
    const { root, repoPath } = fixtureRepository();
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    const stateDir = path.join(root, ".pi", "agent", "deadloop");
    const enabledAt = JSON.parse(readFileSync(path.join(stateDir, "enabled-projects.json"), "utf8")).projects[0].enabledAt;
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    let authorized = false;

    withEnabledProjectLock({ repoPath, githubRepo: "owner/demo", stateDir, enabledAt }, () => { authorized = true; });

    expect(authorized).toBe(true);
  });

  it.each([
    ["deadloop-enable", "malformed"],
    ["deadloop-enable", "unreadable"],
    ["deadloop-disable", "malformed"],
    ["deadloop-disable", "unreadable"],
  ] as const)("fails closed when %s reads %s disable generation state", async (command, stateKind) => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const generationPath = path.join(root, ".pi", "agent", "deadloop", "disable-generation.json");
    if (stateKind === "malformed") writeFileSync(generationPath, "{");
    else mkdirSync(generationPath);
    const extension = await loadExtension(root);

    await invoke(extension.commands.get(command)!, repoPath);

    const message = extension.messages.at(-1) || "";
    expect(message.includes("disable generation state is invalid") && message.includes("move the file aside")).toBe(true);
  });

  it("disabling one repository does not revoke another repository's enablement", async () => {
    const { root, repoPath } = fixtureRepository();
    const otherRepoPath = path.join(root, "other-primary");
    mkdirSync(otherRepoPath);
    git(otherRepoPath, ["init", "--quiet"]);
    git(otherRepoPath, ["config", "user.email", "test@example.com"]);
    git(otherRepoPath, ["config", "user.name", "Test"]);
    writeFileSync(path.join(otherRepoPath, "README.md"), "other fixture\n");
    writeFileSync(path.join(otherRepoPath, "deadloop.json"), `${JSON.stringify({ checkCommand: "true" })}\n`);
    git(otherRepoPath, ["add", "README.md", "deadloop.json"]);
    git(otherRepoPath, ["commit", "--quiet", "-m", "initial"]);
    git(otherRepoPath, ["remote", "add", "origin", "https://github.com/owner/demo.git"]);
    git(otherRepoPath, ["update-ref", "refs/remotes/origin/master", "master"]);
    let releasePreflight!: () => void;
    let preflightStarted!: () => void;
    const started = new Promise<void>((resolve) => { preflightStarted = resolve; });
    const stalled = new Promise<void>((resolve) => { releasePreflight = resolve; });
    let firstRepoCheck = true;
    const extension = await loadExtension(root, {
      beforeGithubRepoCheck: async () => {
        if (!firstRepoCheck) return;
        firstRepoCheck = false;
        preflightStarted();
        await stalled;
      },
    });

    const enablingOther = invoke(extension.commands.get("deadloop-enable")!, otherRepoPath);
    await started;
    await invoke(extension.commands.get("deadloop-disable")!, repoPath);
    releasePreflight();
    await enablingOther;

    expect(extension.messages.at(-1)).toContain("deadloop enabled for owner/demo");
  });

  it("does not let an enable resume after disable completes during checkout detection", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    let releaseDetection!: () => void;
    let detectionStarted!: () => void;
    const started = new Promise<void>((resolve) => { detectionStarted = resolve; });
    const stalled = new Promise<void>((resolve) => { releaseDetection = resolve; });
    let firstDetection = true;
    const extension = await loadExtension(root, {
      beforePrimaryCheckout: async () => {
        if (!firstDetection) return;
        firstDetection = false;
        detectionStarted();
        await stalled;
      },
    });

    const enabling = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await started;
    await invoke(extension.commands.get("deadloop-disable")!, repoPath);
    releaseDetection();
    await enabling;

    expect(extension.messages.at(-1)).toBe("deadloop was not enabled: enablement was revoked while checkout detection was running");
  });

  it("does not let disable miss an enable attempt published before its locked mutation", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    let releaseEnableCheckout!: () => void;
    let enableCheckoutStarted!: () => void;
    let releaseDisableLock!: () => void;
    let disableReachedLock!: () => void;
    const enableCheckout = new Promise<void>((resolve) => { enableCheckoutStarted = resolve; });
    const holdEnableCheckout = new Promise<void>((resolve) => { releaseEnableCheckout = resolve; });
    const disableLock = new Promise<void>((resolve) => { disableReachedLock = resolve; });
    const holdDisableLock = new Promise<void>((resolve) => { releaseDisableLock = resolve; });
    let firstDetection = true;
    const extension = await loadExtension(root, {
      beforePrimaryCheckout: async () => {
        if (!firstDetection) return;
        firstDetection = false;
        enableCheckoutStarted();
        await holdEnableCheckout;
      },
      beforeDisableLock: async () => {
        disableReachedLock();
        await holdDisableLock;
      },
    });

    const enabling = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await enableCheckout;
    const disabling = invoke(extension.commands.get("deadloop-disable")!, repoPath);
    await disableLock;
    releaseEnableCheckout();
    await enabling;
    const enableMessage = extension.messages.at(-1);
    releaseDisableLock();
    await disabling;

    const state = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8"));
    expect({ enabledProjects: state.projects.length, enableMessage }).toEqual({
      enabledProjects: 0,
      enableMessage: "deadloop was not enabled: enablement was revoked while checkout detection was running",
    });
  });

  it("records disable promptly while an enable preflight is stalled", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    let releasePreflight!: () => void;
    let preflightStarted!: () => void;
    const started = new Promise<void>((resolve) => { preflightStarted = resolve; });
    const stalled = new Promise<void>((resolve) => { releasePreflight = resolve; });
    let firstRepoCheck = true;
    const extension = await loadExtension(root, {
      beforeGithubRepoCheck: async () => {
        if (!firstRepoCheck) return;
        firstRepoCheck = false;
        preflightStarted();
        await stalled;
      },
    });

    const enabling = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await started;
    await invoke(extension.commands.get("deadloop-disable")!, repoPath);
    const disabledState = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8"));
    releasePreflight();
    await enabling;

    expect({ disabled: disabledState.projects.length === 0, finalMessage: extension.messages.at(-1) }).toEqual({
      disabled: true,
      finalMessage: "deadloop was not enabled: enablement was revoked while required verification was running",
    });
  });

  it("publishes disable intent before waiting for the guarded-operation lock", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    let releaseDisable!: () => void;
    let disableIntentPublished!: () => void;
    const published = new Promise<void>((resolve) => { disableIntentPublished = resolve; });
    const stalled = new Promise<void>((resolve) => { releaseDisable = resolve; });
    const extension = await loadExtension(root, {
      beforeDisableLock: async () => {
        disableIntentPublished();
        await stalled;
      },
    });
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    const stateDir = path.join(root, ".pi", "agent", "deadloop");
    const enabledAt = JSON.parse(readFileSync(path.join(stateDir, "enabled-projects.json"), "utf8")).projects[0].enabledAt;

    const disabling = invoke(extension.commands.get("deadloop-disable")!, repoPath);
    await published;
    let authorized = true;
    try {
      withEnabledProjectLock({ repoPath, githubRepo: "owner/demo", stateDir, enabledAt }, () => undefined);
    } catch {
      authorized = false;
    }
    const stillPersistedEnabled = JSON.parse(readFileSync(path.join(stateDir, "enabled-projects.json"), "utf8")).projects[0].enabled;
    releaseDisable();
    await disabling;

    expect({ authorized, stillPersistedEnabled }).toEqual({ authorized: false, stillPersistedEnabled: true });
  });

  it("waits for an authorized label creation to settle before disable returns", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    let releaseCreate!: () => void;
    let labelCreateStarted!: () => void;
    const started = new Promise<void>((resolve) => { labelCreateStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let disableResolved = false;
    const extension = await loadExtension(root, {
      beforeLabelCreate: async (name) => {
        if (name !== "ready-for-agent") return;
        labelCreateStarted();
        await blocked;
      },
    });
    const enabling = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await started;

    const disabling = invoke(extension.commands.get("deadloop-disable")!, repoPath).then(() => { disableResolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const resolvedBeforeCreateSettled = disableResolved;
    releaseCreate();
    await Promise.all([enabling, disabling]);

    expect(resolvedBeforeCreateSettled).toBe(false);
  });

  it("does not create later labels after disable cancels label preparation", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    let releaseLookup!: () => void;
    let secondLookupStarted!: () => void;
    const started = new Promise<void>((resolve) => { secondLookupStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const extension = await loadExtension(root, {
      beforeLabelLookup: async (name) => {
        if (name !== "agent:implement") return;
        secondLookupStarted();
        await blocked;
      },
    });
    const enabling = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await started;

    await invoke(extension.commands.get("deadloop-disable")!, repoPath);
    releaseLookup();
    await enabling;

    expect(extension.ghCommands.filter((args) => args[0] === "label" && args[1] === "create").map((args) => args[2])).toEqual(["ready-for-agent"]);
  });

  it("keeps one enablement status visible when another concurrent enable completes", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    let firstEnableSaved!: () => void;
    let releaseFirstEnable!: () => void;
    const firstSaved = new Promise<void>((resolve) => { firstEnableSaved = resolve; });
    const holdFirst = new Promise<void>((resolve) => { releaseFirstEnable = resolve; });
    let saveCount = 0;
    const extension = await loadExtension(root, {
      afterEnablementSaved: async () => {
        saveCount += 1;
        if (saveCount === 1) {
          firstEnableSaved();
          await holdFirst;
        }
      },
    });
    const activeStatuses = new Map<string, string>();
    const context: CommandContext = {
      cwd: repoPath,
      mode: "tui",
      hasUI: true,
      ui: {
        notify: () => undefined,
        setStatus: (key, value) => {
          if (value === undefined) activeStatuses.delete(key);
          else activeStatuses.set(key, value);
        },
      },
    };
    const firstEnable = extension.commands.get("deadloop-enable")!("", context);
    await firstSaved;
    await extension.commands.get("deadloop-enable")!("", context);

    try {
      expect([...activeStatuses.keys()].filter((key) => key.startsWith("deadloop-enable:")).length).toBe(1);
    } finally {
      releaseFirstEnable();
      await firstEnable;
    }
  });

  it("does not recreate a label added by a concurrent enable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const labels: { name: string }[] = [];
    let releaseFirstCreate!: () => void;
    let firstCreateStarted!: () => void;
    let secondLookupStarted!: () => void;
    const firstCreate = new Promise<void>((resolve) => { firstCreateStarted = resolve; });
    const secondLookup = new Promise<void>((resolve) => { secondLookupStarted = resolve; });
    const holdFirstCreate = new Promise<void>((resolve) => { releaseFirstCreate = resolve; });
    let readyLabelLookups = 0;
    let blockedFirstCreate = false;
    const extension = await loadExtension(root, {
      labels,
      beforeLabelLookup: async (name) => {
        if (name === "ready-for-agent" && ++readyLabelLookups === 2) secondLookupStarted();
      },
      beforeLabelCreate: async (name) => {
        if (name === "ready-for-agent" && !blockedFirstCreate) {
          blockedFirstCreate = true;
          firstCreateStarted();
          await holdFirstCreate;
        }
        if (labels.some((label) => label.name === name)) throw new Error(`label already exists: ${name}`);
        labels.push({ name });
      },
    });
    const firstEnable = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await firstCreate;
    const secondEnable = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await secondLookup;
    releaseFirstCreate();

    await Promise.all([firstEnable, secondEnable]);

    expect(extension.ghCommands.filter((args) => args[0] === "label" && args[1] === "create" && args[2] === "ready-for-agent")).toHaveLength(1);
  });

  it("revokes newly saved enablement when the verification contract changes before scheduler startup", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root, {
      afterEnablementSaved: async () => {
        const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        config.projects[0].checkCommand = "false";
        writeFileSync(configPath, JSON.stringify(config));
      },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const state = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8"));
    expect(state.projects[0].enabled).toBe(false);
  });

  it("does not let a failed enable revoke a later successful concurrent enable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    let releaseFirstEnable!: () => void;
    let firstEnableSaved!: () => void;
    const firstSaved = new Promise<void>((resolve) => { firstEnableSaved = resolve; });
    const holdFirst = new Promise<void>((resolve) => { releaseFirstEnable = resolve; });
    let saveCount = 0;
    const extension = await loadExtension(root, {
      afterEnablementSaved: async () => {
        saveCount += 1;
        if (saveCount === 1) {
          firstEnableSaved();
          await holdFirst;
        }
      },
    });
    const firstEnable = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await firstSaved;
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    writeFileSync(path.join(root, ".pi", "agent", "deadloop", "projects.json"), "{");

    releaseFirstEnable();
    await firstEnable;

    expect(JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8")).projects[0].enabled).not.toBe(false);
  });

  it("does not let an older preflight failure revoke a later successful concurrent enable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    writeFileSync(statePath, JSON.stringify({
      projects: [{ repoPath, githubRepo: "owner/demo", ...enabledSafetyFields, enabledAt: 1 }],
    }));
    let releaseFirstPreflight!: () => void;
    let firstPreflightStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstPreflightStarted = resolve; });
    const holdFirst = new Promise<void>((resolve) => { releaseFirstPreflight = resolve; });
    let repoCheckCount = 0;
    const extension = await loadExtension(root, {
      beforeGithubRepoCheck: async () => {
        repoCheckCount += 1;
        if (repoCheckCount === 1) {
          firstPreflightStarted();
          await holdFirst;
        }
      },
    });

    const firstEnable = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await firstStarted;
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    releaseFirstPreflight();
    await firstEnable;

    expect(JSON.parse(readFileSync(statePath, "utf8")).projects[0].enabled).toBe(true);
  });

  it("infers base branch and worktree root when a configured project omits both", async () => {
    const { root, repoPath } = fixtureRepository({ realPolicyLookup: true });
    writeConfig(root, repoPath);
    git(repoPath, ["checkout", "--quiet", "-b", "invalid-main"]);
    writeFileSync(path.join(repoPath, "deadloop.json"), JSON.stringify({ workerAgent: "invalid" }));
    git(repoPath, ["add", "deadloop.json"]);
    git(repoPath, ["commit", "--quiet", "-m", "invalid main policy"]);
    git(repoPath, ["push", "--quiet", path.join(root, "origin.git"), "HEAD:refs/heads/main"]);
    git(repoPath, ["checkout", "--quiet", "master"]);
    git(repoPath, ["update-ref", "refs/remotes/origin/master", "master"]);
    git(repoPath, ["branch", "--set-upstream-to=origin/master", "master"]);
    const extension = await loadExtension(root, { upstream: "origin/master" });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("deadloop enabled");
  });

  it("normalizes a non-origin tracking branch to the verified GitHub default branch", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root, { upstream: "upstream/master", defaultBranch: "master" });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const state = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8"));
    expect(state.projects[0].baseBranch).toBe("origin/master");
  });

  it("forces a preexisting true auto-merge setting off on first enable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("autoMerge is off");
  });

  it("reports the gated auto-merge setting off on first enable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await invoke(extension.commands.get("deadloop-status")!, repoPath);

    expect(extension.messages.at(-1)).toContain("autoMerge: off");
  });

  it("discovers a user configuration created after enablement", async () => {
    const { root, repoPath } = fixtureRepository();
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await vi.advanceTimersByTimeAsync(3_000);

    writeConfig(root, repoPath, { autoMerge: true });
    await invoke(extension.commands.get("deadloop-status")!, repoPath);

    expect(extension.messages.at(-1)).toContain("autoMerge: on");
  });

  it("keeps auto-merge off through the first actual scheduler tick", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.projects[0].automations = [{
      name: "first tick",
      schedule: "*/1 * * * *",
      precheckFile: "issue-coordinator.precheck.sh",
      promptFile: "issue-coordinator.md",
    }];
    writeFileSync(configPath, JSON.stringify(config));
    let effectiveAutoMerge = "";
    const extension = await loadExtension(root, {
      runAutomationScript: async (args) => {
        effectiveAutoMerge = /DEADLOOP_AUTO_MERGE='([^']+)'/.exec(args[1] || "")?.[1] || "";
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    vi.useFakeTimers();

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await vi.advanceTimersByTimeAsync(3_000);

    const enabled = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8")).projects[0];
    expect({ effectiveAutoMerge, firstStartPending: enabled.firstStartPending }).toEqual({
      effectiveAutoMerge: "0",
      firstStartPending: false,
    });
  });

  it("keeps auto-merge gated when configuration turns on during enablement preflight", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: false });
    let reportPreflightBlocked!: () => void;
    let releasePreflight!: () => void;
    const preflightBlocked = new Promise<void>((resolve) => { reportPreflightBlocked = resolve; });
    const preflightRelease = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const extension = await loadExtension(root, {
      beforeLabelLookup: async () => {
        reportPreflightBlocked();
        await preflightRelease;
      },
    });

    const enabling = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await preflightBlocked;
    writeConfig(root, repoPath, { autoMerge: true });
    releasePreflight();
    await enabling;

    const enabled = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8")).projects[0];
    expect({
      firstEnableAutoMerge: enabled.firstEnableAutoMerge,
      autoMergeAcknowledged: enabled.autoMergeAcknowledged,
      message: extension.messages.at(-1),
    }).toEqual({
      firstEnableAutoMerge: true,
      autoMergeAcknowledged: false,
      message: "deadloop enabled for owner/demo; scheduler owner: this session. autoMerge is off.",
    });
  });

  it("preserves a post-enable true auto-merge confirmation across disable and re-enable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await vi.advanceTimersByTimeAsync(3_000);
    writeConfig(root, repoPath, { autoMerge: false });
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    writeConfig(root, repoPath, { autoMerge: true });
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await invoke(extension.commands.get("deadloop-disable")!, repoPath);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("autoMerge is on");
  });

  it("enables a no-upstream checkout from a verified non-main GitHub default branch", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root, { noUpstream: true, defaultBranch: "master" });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const state = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8"));
    expect(state.projects[0].baseBranch).toBe("origin/master");
  });

  it("rejects a different configured origin push repository", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root, {
      pushRemote: "https://github.com/other/target.git",
      canonicalRepos: { "owner/demo": "owner/demo", "other/target": "other/target" },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("all origin fetch and push URLs must resolve to exactly the same GitHub repository");
  });

  it("rejects origin aliases with the same name when their immutable repository IDs differ", async () => {
    const { root, repoPath } = fixtureRepository();
    const extension = await loadExtension(root, {
      pushRemote: "https://github.com/old/demo.git",
      canonicalRepos: { "owner/demo": "owner/demo", "old/demo": "owner/demo" },
      repositoryIds: { "owner/demo": "R_demo", "old/demo": "R_reused" },
    });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("all origin fetch and push URLs must resolve to exactly the same GitHub repository");
  });

  it("disables an existing enablement when repeated preflight loses write permission", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const options = { viewerPermission: "WRITE" };
    const extension = await loadExtension(root, options);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    options.viewerPermission = "READ";

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8")).projects[0].enabled).toBe(false);
  });

  it("disables an existing enablement when a removed standard label cannot be recreated", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const options: { labels: { name: string }[]; failLabel?: boolean } = {
      labels: ["ready-for-agent", "agent:implement", "agent:in-progress", "agent:review", "agent:reviewing", "agent:blocked", "ready-for-human", "needs-info", "needs-triage"].map((name) => ({ name })),
    };
    const extension = await loadExtension(root, options);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    options.labels = options.labels.filter((label) => label.name !== "needs-triage");
    options.failLabel = true;

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8")).projects[0].enabled).toBe(false);
  });

  it("does not create a required label beyond the old 1,000-label limit", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const labels = Array.from({ length: 1_001 }, (_, index) => ({ name: `label-${index}` }));
    labels.push({ name: "needs-triage" });
    const extension = await loadExtension(root, { labels });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.ghCommands.some((args) => args[0] === "label" && args[1] === "create" && args[2] === "needs-triage")).toBe(false);
  });

  it("does not record enablement when a configured repository at the checkout path has a mismatched GitHub identity", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { githubRepo: "other/demo" });
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"))).toBe(false);
  });

  it("revokes existing permission when configuration changes to a mismatched GitHub identity", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    writeConfig(root, repoPath, { githubRepo: "other/demo" });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    const state = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8"));
    expect(state.projects[0].enabled).toBe(false);
  });

  it("does not record enablement when label preparation fails", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root, { failLabel: true });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"))).toBe(false);
  });

  it("rejects enable from a linked worktree", async () => {
    const { root, repoPath } = fixtureRepository();
    const linkedPath = path.join(root, "linked");
    git(repoPath, ["worktree", "add", "--quiet", "-b", "linked-enable", linkedPath]);
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, linkedPath);

    expect(extension.messages.at(-1)).toContain("linked worktrees cannot be enabled");
  });

  it("points linked-worktree rejection to a primary checkout with an external Git directory", async () => {
    const { root, repoPath } = fixtureRepository({ separateGitDir: true });
    const linkedPath = path.join(root, "linked");
    git(repoPath, ["worktree", "add", "--quiet", "-b", "linked-separate-git-dir", linkedPath]);
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, linkedPath);

    expect(extension.messages.at(-1)).toContain(`use the primary checkout: ${repoPath}`);
  });

  it("enables a primary checkout with an external separate Git directory", async () => {
    const { root, repoPath } = fixtureRepository({ separateGitDir: true });
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("deadloop enabled for owner/demo");
  });

  it("removes primary enablement when disable runs from a linked worktree", async () => {
    const { root, repoPath } = fixtureRepository();
    const linkedPath = path.join(root, "linked");
    git(repoPath, ["worktree", "add", "--quiet", "-b", "linked", linkedPath]);
    writeConfig(root, repoPath);
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    writeFileSync(statePath, JSON.stringify({ projects: [{ repoPath, githubRepo: "owner/demo", ...enabledSafetyFields, enabledAt: 1 }] }));
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-disable")!, linkedPath);

    expect(JSON.parse(readFileSync(statePath, "utf8")).projects[0].enabled).toBe(false);
  });

  it("keeps enablement state unchanged when status is reported", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    writeFileSync(statePath, JSON.stringify({ projects: [{ repoPath, githubRepo: "owner/demo", ...enabledSafetyFields, enabledAt: 1, firstEnableAutoMerge: true, lastObservedAutoMerge: true }] }));
    const extension = await loadExtension(root);
    const before = readFileSync(statePath, "utf8");

    await invoke(extension.commands.get("deadloop-status")!, repoPath);

    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("keeps enablement state unchanged when doctor is reported", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    writeFileSync(statePath, JSON.stringify({ projects: [{ repoPath, githubRepo: "owner/demo", ...enabledSafetyFields, enabledAt: 1, firstEnableAutoMerge: true, lastObservedAutoMerge: true }] }));
    const extension = await loadExtension(root);
    const before = readFileSync(statePath, "utf8");

    await invoke(extension.commands.get("deadloop-doctor")!, repoPath);

    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it.each(["deadloop-status", "deadloop-doctor"])("does not update refs or FETCH_HEAD for %s", async (command) => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    writeFileSync(statePath, JSON.stringify({ projects: [{ repoPath, githubRepo: "owner/demo", ...enabledSafetyFields, enabledAt: 1 }] }));
    const extension = await loadExtension(root);
    const before = gitReportMutationSnapshot(repoPath);

    await invoke(extension.commands.get(command)!, repoPath);

    expect(gitReportMutationSnapshot(repoPath)).toBe(before);
  });

  it("keeps one scheduler owner across old and new aliases of one GitHub repository", async () => {
    const { root, repoPath } = fixtureRepository();
    git(repoPath, ["remote", "set-url", "origin", "https://github.com/old/demo.git"]);
    const secondRepoPath = path.join(root, "second-primary");
    execFileSync("git", ["clone", "--quiet", path.join(root, "origin.git"), secondRepoPath]);
    git(secondRepoPath, ["remote", "set-url", "origin", "https://github.com/new/demo.git"]);
    const firstExtension = await loadExtension(root, {
      fetchRemote: "https://github.com/old/demo.git",
      pushRemote: "https://github.com/old/demo.git",
      canonicalRepos: { "old/demo": "old/demo" },
    });
    await invoke(firstExtension.commands.get("deadloop-enable")!, repoPath);
    const secondExtension = await loadExtension(root, {
      fetchRemote: "https://github.com/new/demo.git",
      pushRemote: "https://github.com/new/demo.git",
      canonicalRepos: { "new/demo": "new/demo" },
    });

    await invoke(secondExtension.commands.get("deadloop-enable")!, secondRepoPath);

    const stateDir = path.join(root, ".pi", "agent", "deadloop");
    const schedulerLocks = readdirSync(stateDir).filter((name) => name.startsWith("scheduler."));
    expect({ locks: schedulerLocks.length, message: secondExtension.messages.at(-1) }).toEqual({
      locks: 1,
      message: expect.stringContaining(`repository is already served by Automation host pid ${process.pid}`),
    });
  });

  it("fails fast when another Automation host owns the repository lock", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const firstExtension = await loadExtension(root);
    await invoke(firstExtension.commands.get("deadloop-enable")!, repoPath);
    const secondExtension = await loadExtension(root);

    await invoke(secondExtension.commands.get("deadloop-enable")!, repoPath);

    expect(secondExtension.messages.at(-1)).toContain(`repository is already served by Automation host pid ${process.pid}`);
  });

  it("does not retry repository lock acquisition after a second Automation host is rejected", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    vi.useFakeTimers();
    const firstExtension = await loadExtension(root);
    await invoke(firstExtension.commands.get("deadloop-enable")!, repoPath);
    const secondExtension = await loadExtension(root);
    await invoke(secondExtension.commands.get("deadloop-enable")!, repoPath);
    const lockPath = path.join(root, ".pi", "agent", "deadloop", schedulerLockName({ githubRepositoryId: "R_demo" }));
    await firstExtension.events.get("session_shutdown")!({}, { cwd: repoPath, mode: "interactive", ui: { notify: () => undefined, setStatus: () => undefined } });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(existsSync(lockPath)).toBe(false);
  });

  it("stops scheduler liveness when an origin push URL targets another repository", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath, { isIdle: () => false });
    git(repoPath, ["remote", "set-url", "--add", "--push", "origin", "https://github.com/other/repo.git"]);

    await vi.advanceTimersByTimeAsync(3_000);

    const lockName = schedulerLockName({ githubRepositoryId: "R_demo" });
    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", lockName))).toBe(false);
  });

  it("stops scheduler liveness when an origin push URL is unparseable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath, { isIdle: () => false });
    git(repoPath, ["remote", "set-url", "--add", "--push", "origin", "not-a-github-url"]);

    await vi.advanceTimersByTimeAsync(3_000);

    const lockName = schedulerLockName({ githubRepositoryId: "R_demo" });
    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", lockName))).toBe(false);
  });

  it("releases the scheduler lock after another session disables a busy owner", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath, { isIdle: () => false });
    writeFileSync(path.join(root, "bin", "gh"), "#!/bin/sh\nsleep 60\n");
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.projects[0].enabled = false;
    writeFileSync(statePath, JSON.stringify(state));

    await vi.advanceTimersByTimeAsync(30_000);

    const lockName = schedulerLockName({ githubRepositoryId: "R_demo" });
    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", lockName))).toBe(false);
  });

  it("releases the scheduler lock after another session disables and re-enables with a newer generation", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath, { isIdle: () => false });
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.projects[0].enabled = false;
    writeFileSync(statePath, JSON.stringify(state));
    state.projects[0].enabled = true;
    state.projects[0].enabledAt += 1;
    writeFileSync(statePath, JSON.stringify(state));

    await vi.advanceTimersByTimeAsync(30_000);

    const lockName = schedulerLockName({ githubRepositoryId: "R_demo" });
    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", lockName))).toBe(false);
  });

  it.each([
    ["completes disable while the scheduler tick remains blocked", (result: { disableResolvedBeforeRelease: boolean }) => result.disableResolvedBeforeRelease, true],
    ["releases the scheduler lock while the tick remains blocked", (result: { lockExistsBeforeRelease: boolean }) => result.lockExistsBeforeRelease, false],
    ["reports disable success after releasing the lock", (result: { successReportedBeforeRelease: boolean }) => result.successReportedBeforeRelease, true],
    ["keeps the scheduler lock released after the disable response", (result: { lockExistsAfterResponse: boolean }) => result.lockExistsAfterResponse, false],
    ["retains the disable success response after blocked work finishes", (result: { successReportedAfterRelease: boolean }) => result.successReportedAfterRelease, true],
    ["does not let the old run clear a newer owner's lock", (result: { newerOwnerRetained: boolean }) => result.newerOwnerRetained, true],
  ])("%s", async (_name, observation, expected) => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.projects[0].automations = [{
      name: "blocked",
      schedule: "*/1 * * * *",
      precheckFile: "issue-coordinator.precheck.sh",
      promptFile: "issue-coordinator.md",
    }];
    writeFileSync(configPath, JSON.stringify(config));
    let releasePrecheck!: () => void;
    let precheckStarted!: () => void;
    const started = new Promise<void>((resolve) => { precheckStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releasePrecheck = resolve; });
    const extension = await loadExtension(root, {
      runAutomationScript: async () => {
        precheckStarted();
        await blocked;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    const tick = vi.advanceTimersByTimeAsync(3_000);
    await started;
    const lockPath = path.join(root, ".pi", "agent", "deadloop", schedulerLockName({ githubRepositoryId: "R_demo" }));
    const enablementLockPath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json.lock");
    const messageCount = extension.messages.length;
    let disableResolved = false;

    const disabling = invoke(extension.commands.get("deadloop-disable")!, repoPath).then(() => { disableResolved = true; });
    await vi.waitFor(() => {
      const enablementState = JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8"));
      if (enablementState.projects.some((project: { enabled?: boolean }) => project.enabled !== false) || existsSync(enablementLockPath)) {
        throw new Error("disable state update is still locked");
      }
    });
    const disableResolvedBeforeRelease = disableResolved;
    const lockExistsBeforeRelease = existsSync(lockPath);
    const successReportedBeforeRelease = extension.messages.length > messageCount;
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "new-owner" }));
    releasePrecheck();
    await Promise.all([tick, disabling]);
    const newerOwnerRetained = existsSync(lockPath);
    rmSync(lockPath, { force: true });

    expect(observation({
      disableResolvedBeforeRelease,
      lockExistsBeforeRelease,
      successReportedBeforeRelease,
      lockExistsAfterResponse: lockExistsBeforeRelease,
      successReportedAfterRelease: extension.messages.length > messageCount,
      newerOwnerRetained,
    })).toBe(expected);
  });

  it("waits for a blocked scheduler tick and lock release during session shutdown", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const configPath = path.join(root, ".pi", "agent", "deadloop", "projects.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.projects[0].automations = [{
      name: "blocked",
      schedule: "*/1 * * * *",
      precheckFile: "issue-coordinator.precheck.sh",
      promptFile: "issue-coordinator.md",
    }];
    writeFileSync(configPath, JSON.stringify(config));
    let releasePrecheck!: () => void;
    let precheckStarted!: () => void;
    const started = new Promise<void>((resolve) => { precheckStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releasePrecheck = resolve; });
    const extension = await loadExtension(root, {
      runAutomationScript: async () => {
        precheckStarted();
        await blocked;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    const tick = vi.advanceTimersByTimeAsync(3_000);
    await started;
    const lockPath = path.join(root, ".pi", "agent", "deadloop", schedulerLockName({ githubRepositoryId: "R_demo" }));
    let shutdownResolved = false;

    const shutdown = extension.events.get("session_shutdown")!(undefined, { cwd: repoPath, mode: "interactive", ui: { notify: () => undefined, setStatus: () => undefined } }).then(() => { shutdownResolved = true; });
    await Promise.resolve();
    const beforeRelease = { shutdownResolved, lockExists: existsSync(lockPath) };
    releasePrecheck();
    await Promise.all([tick, shutdown]);

    expect({ beforeRelease, lockExistsAfterShutdown: existsSync(lockPath) }).toEqual({
      beforeRelease: { shutdownResolved: false, lockExists: true },
      lockExistsAfterShutdown: false,
    });
  });

  it("releases the scheduler lock after disable even when project configuration is invalid", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath, { isIdle: () => false });
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.projects[0].enabled = false;
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(path.join(root, ".pi", "agent", "deadloop", "projects.json"), "{");

    await vi.advanceTimersByTimeAsync(30_000);

    const lockName = schedulerLockName({ githubRepositoryId: "R_demo" });
    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", lockName))).toBe(false);
  });

  it("keeps the state file readable during concurrent enable and disable commands", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const stateDir = path.join(root, ".pi", "agent", "deadloop");
    mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, "enabled-projects.json");
    writeFileSync(statePath, JSON.stringify({ projects: [{ repoPath, githubRepo: "owner/demo", ...enabledSafetyFields, enabledAt: 1 }] }));
    let releasePreflight!: () => void;
    let preflightStarted!: () => void;
    const preflight = new Promise<void>((resolve) => { preflightStarted = resolve; });
    const holdPreflight = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const extension = await loadExtension(root, { beforeGithubRepoCheck: async () => {
      preflightStarted();
      await holdPreflight;
    } });
    const readyPath = path.join(root, "observer-ready");
    const stopPath = path.join(root, "observer-stop");
    const reportPath = path.join(root, "observer-report.json");
    const observerPath = path.join(root, "observe-state.cjs");
    writeFileSync(observerPath, `const fs = require("node:fs");
const [statePath, readyPath, stopPath, reportPath] = process.argv.slice(2);
let reads = 0;
const errors = [];
fs.writeFileSync(readyPath, "ready");
while (!fs.existsSync(stopPath)) {
  try { JSON.parse(fs.readFileSync(statePath, "utf8")); reads += 1; }
  catch (error) { errors.push(error.code || error.name); }
}
fs.writeFileSync(reportPath, JSON.stringify({ reads, errors }));
`);
    const observer = spawn(process.execPath, [observerPath, statePath, readyPath, stopPath, reportPath], { stdio: "ignore" });
    const observerExit = new Promise<void>((resolve, reject) => {
      observer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`observer exited with ${code}`)));
      observer.once("error", reject);
    });
    await waitForFile(readyPath);
    const enabling = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await preflight;
    const disabling = invoke(extension.commands.get("deadloop-disable")!, repoPath);
    releasePreflight();
    await Promise.all([enabling, disabling]);
    writeFileSync(stopPath, "stop");
    await observerExit;
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect({ readAtLeastOnce: report.reads > 0, errors: report.errors }).toEqual({ readAtLeastOnce: true, errors: [] });
  });

  it("keeps a later concurrent disable from being undone by an earlier enable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    let releasePreflight!: () => void;
    let preflightStarted!: () => void;
    const preflight = new Promise<void>((resolve) => { preflightStarted = resolve; });
    const holdPreflight = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const extension = await loadExtension(root, { beforeGithubRepoCheck: async () => {
      preflightStarted();
      await holdPreflight;
    } });
    const enabling = invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await preflight;

    const disabling = invoke(extension.commands.get("deadloop-disable")!, repoPath);
    releasePreflight();
    await Promise.all([enabling, disabling]);

    expect(JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8")).projects.every((project: { enabled: boolean }) => project.enabled === false)).toBe(true);
  });

  it("stops an enabled primary checkout when disabled", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    await invoke(extension.commands.get("deadloop-disable")!, repoPath);

    expect(JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8")).projects[0].enabled).toBe(false);
  });

  it("does not start the scheduler after the enabled origin identity drifts", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    const context = { cwd: repoPath, mode: "interactive", ui: { notify: () => undefined, setStatus: () => undefined } };
    await extension.events.get("session_shutdown")!({}, context);
    git(repoPath, ["remote", "set-url", "origin", "https://github.com/other/repo.git"]);

    await extension.events.get("session_start")!({}, context);

    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", schedulerLockName({ githubRepositoryId: "R_demo" })))).toBe(false);
  });

  it("does not start the parent scheduler from a nested independent repository", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    const context = { cwd: repoPath, mode: "interactive", ui: { notify: () => undefined, setStatus: () => undefined } };
    await extension.events.get("session_shutdown")!({}, context);
    const nested = path.join(repoPath, "nested-repository");
    mkdirSync(nested);
    git(nested, ["init", "--quiet"]);

    await extension.events.get("session_start")!({}, { ...context, cwd: nested });

    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", schedulerLockName({ githubRepositoryId: "R_demo" })))).toBe(false);
  });

  it("does not start the parent scheduler from a nested linked worktree", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    const context = { cwd: repoPath, mode: "interactive", ui: { notify: () => undefined, setStatus: () => undefined } };
    await extension.events.get("session_shutdown")!({}, context);
    const nested = path.join(repoPath, "nested-worktree");
    git(repoPath, ["worktree", "add", "--quiet", "-b", "nested-worktree-test", nested]);

    await extension.events.get("session_start")!({}, { ...context, cwd: nested });

    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", schedulerLockName({ githubRepositoryId: "R_demo" })))).toBe(false);
  });
});
