import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { schedulerLockName } from "../src/project-identity";

type CommandContext = { cwd: string; mode: string; ui: { notify: () => void; setStatus: () => void }; isIdle?: () => boolean; hasPendingMessages?: () => boolean };
type CommandHandler = (_args: string, ctx: CommandContext) => Promise<void>;

const originalHome = process.env.HOME;
const originalStateDir = process.env.PI_CODING_AGENT_DIR;
const originalPath = process.env.PATH;
const sandboxes: string[] = [];

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

function fixtureRepository() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-enablement-"));
  sandboxes.push(root);
  const repoPath = path.join(root, "primary");
  mkdirSync(repoPath);
  git(repoPath, ["init", "--quiet"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repoPath, "README.md"), "fixture\n");
  git(repoPath, ["add", "README.md"]);
  git(repoPath, ["commit", "--quiet", "-m", "initial"]);
  const barePath = path.join(root, "origin.git");
  execFileSync("git", ["clone", "--quiet", "--bare", repoPath, barePath]);
  git(repoPath, ["remote", "add", "origin", "https://github.com/owner/demo.git"]);
  writeFileSync(path.join(root, ".gitconfig"), `[url "file://${barePath}"]\n\tinsteadOf = https://github.com/owner/demo.git\n`);
  const binDir = path.join(root, "bin");
  mkdirSync(binDir);
  const gitPath = path.join(binDir, "git");
  writeFileSync(gitPath, `#!/bin/sh
if [ "$3 $4" = "remote get-url" ]; then
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
  return { root, repoPath };
}

async function loadExtension(
  root: string,
  options: { failLabel?: boolean; labels?: unknown[]; viewerPermission?: string; pushRemote?: string; noUpstream?: boolean; beforeGithubRepoCheck?: () => Promise<void> } = {},
): Promise<{ commands: Map<string, CommandHandler>; ghCommands: string[][]; messages: string[] }> {
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = path.join(root, ".pi", "agent");
  process.env.PATH = `${path.join(root, "bin")}:${originalPath || ""}`;
  vi.resetModules();
  const commands = new Map<string, CommandHandler>();
  const messages: string[] = [];
  const ghCommands: string[][] = [];
  // @ts-expect-error Vitest transforms this runtime extension import.
  const extension = (await import("../extensions/deadloop/index")).default;
  extension({
    exec: async (command: string, args: string[]) => {
      if (command === "git") {
        if (args.includes("get-url")) {
          const remote = args.includes("--push") ? options.pushRemote || "https://github.com/owner/demo.git" : "https://github.com/owner/demo.git";
          return { code: 0, stdout: `${remote}\n`, stderr: "" };
        }
        if (args.includes("--symbolic-full-name")) return options.noUpstream ? { code: 128, stdout: "", stderr: "no upstream" } : { code: 0, stdout: "", stderr: "" };
        if (args.includes("fetch")) return { code: 0, stdout: "", stderr: "" };
        if (args.includes("show")) return { code: 1, stdout: "", stderr: "missing" };
        try {
          return { code: 0, stdout: execFileSync("git", args, { encoding: "utf8" }), stderr: "" };
        } catch (error) {
          return { code: 1, stdout: "", stderr: String(error) };
        }
      }
      if (command === "gh") ghCommands.push(args);
      if (command === "gh" && args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
      if (command === "gh" && args[0] === "repo") {
        await options.beforeGithubRepoCheck?.();
        return { code: 0, stdout: JSON.stringify({ viewerPermission: options.viewerPermission || "WRITE" }), stderr: "" };
      }
      if (command === "gh" && args[0] === "label" && args[1] === "list") return { code: 0, stdout: JSON.stringify(options.labels || []), stderr: "" };
      if (command === "gh" && args[0] === "label" && args[1] === "create") {
        return options.failLabel ? { code: 1, stdout: "", stderr: "label denied" } : { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
    registerCommand: (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler),
    on: () => undefined,
    sendMessage: (message: { content: string }) => messages.push(message.content),
    sendUserMessage: () => undefined,
  });
  return { commands, ghCommands, messages };
}

function writeConfig(root: string, repoPath: string, options: { autoMerge?: boolean; worktreeRoot?: string; githubRepo?: string } = {}): void {
  const stateDir = path.join(root, ".pi", "agent", "deadloop");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify({
    projects: [{
      id: "demo",
      repoPath,
      githubRepo: options.githubRepo || "owner/demo",
      automations: [],
      ...(options.autoMerge === undefined ? {} : { autoMerge: options.autoMerge }),
      ...(options.worktreeRoot === undefined ? {} : { worktreeRoot: options.worktreeRoot }),
    }],
  }));
}

async function invoke(handler: CommandHandler, cwd: string, schedulerState: Pick<CommandContext, "isIdle" | "hasPendingMessages"> = {}): Promise<void> {
  await handler("", { cwd, mode: "interactive", ui: { notify: () => undefined, setStatus: () => undefined }, ...schedulerState });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalStateDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalStateDir;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe("enablement command integration", () => {
  it("records enablement after label preparation succeeds", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("deadloop enabled");
  });

  it("accepts a preexisting true auto-merge setting on a later explicit enable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("autoMerge is on");
  });

  it("forces a preexisting true auto-merge setting off on first enable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("autoMerge is off");
  });

  it("preserves explicit auto-merge confirmation across disable and re-enable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    writeConfig(root, repoPath, { autoMerge: false });
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    writeConfig(root, repoPath, { autoMerge: true });
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);
    await invoke(extension.commands.get("deadloop-disable")!, repoPath);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("autoMerge is on");
  });

  it("enables a primary checkout whose current branch has no upstream", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root, { noUpstream: true });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("deadloop enabled");
  });

  it("rejects a different configured origin push repository", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root, { pushRemote: "https://github.com/other/target.git" });

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("all origin fetch and push URLs must identify exactly the same GitHub repository");
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

  it("does not create a standard label that appears after the first 100 labels", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const labels = Array.from({ length: 100 }, (_, index) => ({ name: `label-${index}` }));
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

  it("rejects disable from a linked worktree without removing primary enablement", async () => {
    const { root, repoPath } = fixtureRepository();
    const linkedPath = path.join(root, "linked");
    git(repoPath, ["worktree", "add", "--quiet", "-b", "linked", linkedPath]);
    writeConfig(root, repoPath);
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    writeFileSync(statePath, JSON.stringify({ projects: [{ repoPath, githubRepo: "owner/demo", enabledAt: 1 }] }));
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-disable")!, linkedPath);

    expect(JSON.parse(readFileSync(statePath, "utf8")).projects).toHaveLength(1);
  });

  it("keeps enablement state unchanged when status is reported", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    writeFileSync(statePath, JSON.stringify({ projects: [{ repoPath, githubRepo: "owner/demo", enabledAt: 1, firstEnableAutoMerge: true, lastObservedAutoMerge: true }] }));
    const extension = await loadExtension(root);
    const before = readFileSync(statePath, "utf8");

    await invoke(extension.commands.get("deadloop-status")!, repoPath);

    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("keeps enablement state unchanged when doctor is reported", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath, { autoMerge: true });
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    writeFileSync(statePath, JSON.stringify({ projects: [{ repoPath, githubRepo: "owner/demo", enabledAt: 1, firstEnableAutoMerge: true, lastObservedAutoMerge: true }] }));
    const extension = await loadExtension(root);
    const before = readFileSync(statePath, "utf8");

    await invoke(extension.commands.get("deadloop-doctor")!, repoPath);

    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it.each(["deadloop-status", "deadloop-doctor"])("does not update refs or FETCH_HEAD for %s", async (command) => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    writeFileSync(statePath, JSON.stringify({ projects: [{ repoPath, githubRepo: "owner/demo", enabledAt: 1 }] }));
    const extension = await loadExtension(root);
    const before = gitReportMutationSnapshot(repoPath);

    await invoke(extension.commands.get(command)!, repoPath);

    expect(gitReportMutationSnapshot(repoPath)).toBe(before);
  });

  it("reports another live lock owner as standby", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const stateDir = path.join(root, ".pi", "agent", "deadloop");
    const lockPath = path.join(stateDir, schedulerLockName({ id: "demo", repoPath, githubRepo: "owner/demo" }));
    writeFileSync(lockPath, JSON.stringify({ pid: 4242, token: "owner" }));
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | string) => {
      if (pid === 4242 && signal === 0) return true;
      return true;
    }) as typeof process.kill);
    const extension = await loadExtension(root);

    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    expect(extension.messages.at(-1)).toContain("another session (pid 4242)");
  });

  it("takes scheduler ownership after the original owner releases its lock", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const stateDir = path.join(root, ".pi", "agent", "deadloop");
    const lockPath = path.join(stateDir, schedulerLockName({ id: "demo", repoPath, githubRepo: "owner/demo" }));
    writeFileSync(lockPath, JSON.stringify({ pid: 4242, token: "owner" }));
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | string) => {
      if (pid === 4242 && signal === 0) return true;
      return true;
    }) as typeof process.kill);
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath, { isIdle: () => false });
    rmSync(lockPath);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
  });

  it("releases the scheduler lock when an additional origin push URL targets another repository", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath, { isIdle: () => false });
    git(repoPath, ["remote", "set-url", "--add", "--push", "origin", "https://github.com/other/repo.git"]);

    await vi.advanceTimersByTimeAsync(3_000);

    const lockName = schedulerLockName({ id: "demo", repoPath, githubRepo: "owner/demo" });
    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", lockName))).toBe(false);
  });

  it("releases the scheduler lock when an additional origin push URL is unparseable", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath, { isIdle: () => false });
    git(repoPath, ["remote", "set-url", "--add", "--push", "origin", "not-a-github-url"]);

    await vi.advanceTimersByTimeAsync(3_000);

    const lockName = schedulerLockName({ id: "demo", repoPath, githubRepo: "owner/demo" });
    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", lockName))).toBe(false);
  });

  it("releases the scheduler lock after another session disables a busy owner", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    vi.useFakeTimers();
    await invoke(extension.commands.get("deadloop-enable")!, repoPath, { isIdle: () => false });
    const statePath = path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.projects[0].enabled = false;
    writeFileSync(statePath, JSON.stringify(state));

    await vi.advanceTimersByTimeAsync(30_000);

    const lockName = schedulerLockName({ id: "demo", repoPath, githubRepo: "owner/demo" });
    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", lockName))).toBe(false);
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

    const lockName = schedulerLockName({ id: "demo", repoPath, githubRepo: "owner/demo" });
    expect(existsSync(path.join(root, ".pi", "agent", "deadloop", lockName))).toBe(false);
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

    expect(JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8")).projects[0].enabled).toBe(false);
  });

  it("stops an enabled primary checkout when disabled", async () => {
    const { root, repoPath } = fixtureRepository();
    writeConfig(root, repoPath);
    const extension = await loadExtension(root);
    await invoke(extension.commands.get("deadloop-enable")!, repoPath);

    await invoke(extension.commands.get("deadloop-disable")!, repoPath);

    expect(JSON.parse(readFileSync(path.join(root, ".pi", "agent", "deadloop", "enabled-projects.json"), "utf8")).projects[0].enabled).toBe(false);
  });
});
