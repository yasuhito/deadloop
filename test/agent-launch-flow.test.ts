import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const { launchAgentFlow, prepareAgentLaunchFlow, recordAgentLaunchGithubClaimed } = require("../src/agent-launch-flow.ts");
const { assertPreparedWorkerContractCurrent, assertWorkerLaunchBaseCurrent, issueWorkerLaunchPlan } = require("../extensions/deadloop/automations/issue-coordinator-driver.ts");
const { transitionPersistedAttempt } = require("../src/attempt-lifecycle-runtime.cjs");

function input(root: string, role: "worker" | "reviewer" = "worker") {
  const number = role === "worker" ? 1 : 44;
  return {
    worktree: role === "worker"
      ? { mode: "create" as const, branch: "agent/issue-1", baseBranch: "origin/main" }
      : { mode: "open" as const, branch: "feature/review", remote: "origin" },
    repoPath: "/repo",
    automationDir: "/automation",
    stateDir: root,
    workspaceLabel: role === "worker" ? "Worker Issue 1" : "Reviewer PR 44",
    agent: "pi",
    model: "",
    level: "medium",
    uuid: `launch-${role}`,
    promptFilePrefix: `${role}-prompt`,
    project: "demo",
    repository: "owner/repo",
    role,
    target: { kind: role === "worker" ? "issue" as const : "pull-request" as const, number },
    inputRevision: { head: "a".repeat(40) },
    requiredVerification: {
      repository: "owner/repo",
      command: "npm test",
      source: { kind: "repo_policy" as const, location: "deadloop.json" },
      baseRevision: "a".repeat(40),
    },
    ...(role === "reviewer" ? { requestEventId: "request-22" } : {}),
    ...(role === "worker" ? {
      agentRequest: { role: "worker" as const, label: "agent:implement", eventId: "request-1" },
    } : {}),
    intendedWorktreePath: role === "worker" ? "/wt/worker" : "/wt/review",
    resolveWorktreeHead: role === "worker",
    renderPrompt: ({ promiseFile, worktreeHead }: { promiseFile: string; worktreeHead?: string }) =>
      `promise=${promiseFile};head=${worktreeHead || "review"}`,
  };
}

function operations(_root: string, role: "worker" | "reviewer", calls: string[]) {
  const worktreePath = role === "worker" ? "/wt/worker" : "/wt/review";
  let launchedName = "";
  return {
    mkdirSync: () => {},
    alignCheckout: () => {},
    runner: {
      createWorktree: () => ({ workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1", worktreePath }),
      openWorktree: () => ({ workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1", worktreePath }),
      renameWorkspace: () => (calls.push("rename"), ""),
      startAgent: () => "",
      closeWorkspace: () => "",
      listWorkspaces: () => [],
      listWorktrees: () => role === "reviewer" ? [{ path: worktreePath, branch: "feature/review" }] : [],
      listAgents: () => launchedName ? [{ name: launchedName, paneId: "pane-1", cwd: worktreePath, status: "working" }] : [],
      removeWorktree: () => "",
    },
    runText: (args: string[]) => {
      if (args[0] === "git") return `${"a".repeat(40)}\n`;
      calls.push(args.join(" "));
      const nameIndex = args.indexOf("--name");
      if (nameIndex >= 0) launchedName = args[nameIndex + 1];
      return "started";
    },
    writeFileSync: (file: string, text: string) => require("node:fs").writeFileSync(file, text, "utf8"),
  };
}

describe("0.8.0 エージェント起動フロー", () => {
  it("外部の要求状態を変える前に準備済み試行記録を残す", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const ops = operations(root, "worker", []);
      const prepared = prepareAgentLaunchFlow(input(root), ops);
      expect(JSON.parse(readFileSync(path.join(prepared.runDir, "attempt.json"), "utf8")).phase).toBe("prepared");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reviewer は要求イベント id なしで GitHub 要求消費を記録できない", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const launchInput: any = input(root, "reviewer");
      delete launchInput.requestEventId;
      prepareAgentLaunchFlow(launchInput, operations(root, "reviewer", []));
      expect(() => recordAgentLaunchGithubClaimed(launchInput)).toThrow("request event id");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reviewer の要求消費を要求イベント id に束縛する", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const launchInput = input(root, "reviewer");
      const prepared = prepareAgentLaunchFlow(launchInput, operations(root, "reviewer", []));
      expect(JSON.parse(readFileSync(path.join(prepared.runDir, "attempt.json"), "utf8")).requestEventId).toBe("request-22");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("要求を変える前に Worker の選択済み要求世代を固定する", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const prepared = prepareAgentLaunchFlow(input(root), operations(root, "worker", []));
      expect(JSON.parse(readFileSync(path.join(prepared.runDir, "attempt.json"), "utf8")).agentRequest.eventId).toBe("request-1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("最初の外部副作用より前に Worker の必須検証契約を固定する", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const prepared = prepareAgentLaunchFlow(input(root), operations(root, "worker", []));
      expect(JSON.parse(readFileSync(path.join(prepared.runDir, "attempt.json"), "utf8")).requiredVerification.command).toBe("npm test");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("最初の外部副作用より前に Reviewer の必須検証契約を固定する", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const prepared = prepareAgentLaunchFlow(input(root, "reviewer"), operations(root, "reviewer", []));
      expect(JSON.parse(readFileSync(path.join(prepared.runDir, "attempt.json"), "utf8")).requiredVerification.command).toBe("npm test");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("Reviewer の必須検証契約に選択済み基準 revision を固定する", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const prepared = prepareAgentLaunchFlow(input(root, "reviewer"), operations(root, "reviewer", []));
      expect(JSON.parse(readFileSync(path.join(prepared.runDir, "attempt.json"), "utf8")).requiredVerification.baseRevision).toBe("a".repeat(40));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("起動リポジトリと異なる必須検証契約を拒否する", () => {
    expect(() => issueWorkerLaunchPlan(
      { number: 1, title: "Task" },
      { projectId: "demo", githubRepo: "owner/repo", baseBranch: "origin/main", checkCommand: "npm test", requiredVerification: JSON.stringify({ repository: "other/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: "a".repeat(40) }), fixtureMode: false, worktreeRoot: "/wt", automationDir: "/automation", stateDir: "/state", workerAgent: "pi", workerModel: "", workerInstructions: "" },
      "launch", "a".repeat(40),
    )).toThrow("repository");
  });

  it("選択したベースと異なる必須検証契約を拒否する", () => {
    expect(() => issueWorkerLaunchPlan(
      { number: 1, title: "Task" },
      { projectId: "demo", githubRepo: "owner/repo", baseBranch: "origin/main", checkCommand: "npm test", requiredVerification: JSON.stringify({ repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: "b".repeat(40) }), fixtureMode: false, worktreeRoot: "/wt", automationDir: "/automation", stateDir: "/state", workerAgent: "pi", workerModel: "", workerInstructions: "" },
      "launch", "a".repeat(40),
    )).toThrow("base revision");
  });

  it("選択後にベースが進んだ Worker 起動を拒否する", () => {
    expect(() => assertWorkerLaunchBaseCurrent(
      { repoPath: "/repo", baseBranch: "origin/main" },
      "a".repeat(40),
      () => "b".repeat(40),
    )).toThrow("base commit changed");
  });

  it("リダイレクトされたリモートでは Worker の要求状態を変更しない", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-redirected-remote-"));
    try {
      const repo = path.join(root, "repo"); const remote = path.join(root, "redirected.git");
      execFileSync("git", ["init", "--bare", "--quiet", remote]); execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
      execFileSync("git", ["-C", repo, "config", "user.name", "Test"]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
      writeFileSync(path.join(repo, "deadloop.json"), JSON.stringify({ checkCommand: "npm test" }));
      execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "base"]);
      execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]); execFileSync("git", ["-C", repo, "push", "--quiet", "-u", "origin", "main"]);
      const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const launchInput = { ...input(root), repoPath: repo, inputRevision: { head }, requiredVerification: { repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: head } };
      prepareAgentLaunchFlow(launchInput, operations(root, "worker", []));

      expect(() => assertPreparedWorkerContractCurrent(launchInput, { stateDir: root, repoPath: repo, configPath: "" }, "R_owner_repo")).toThrow("stale_policy");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("準備中にローカル検証方針が変わった Worker 起動を要求状態の変更前に拒否する", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-policy-"));
    try {
      const repo = path.join(root, "repo"); const remote = path.join(root, "remote.git"); const config = path.join(root, "projects.json");
      execFileSync("git", ["init", "--bare", "--quiet", remote]); execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
      execFileSync("git", ["-C", repo, "config", "user.name", "Test"]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
      writeFileSync(path.join(repo, "file.txt"), "base\n"); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "base"]);
      execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]); execFileSync("git", ["-C", repo, "push", "--quiet", "-u", "origin", "main"]);
      const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      writeFileSync(config, JSON.stringify({ projects: [{ id: "demo", githubRepo: "owner/repo", checkCommand: "npm test" }] }));
      const launchInput = { ...input(root), repoPath: repo, inputRevision: { head }, requiredVerification: { repository: "owner/repo", command: "npm test", source: { kind: "local", location: `${config}#project=demo` }, baseRevision: head } };
      prepareAgentLaunchFlow(launchInput, operations(root, "worker", []));
      writeFileSync(config, JSON.stringify({ projects: [{ id: "demo", githubRepo: "owner/repo", checkCommand: "npm run stricter-check" }] }));

      expect(() => assertPreparedWorkerContractCurrent(launchInput, { stateDir: root, repoPath: repo, configPath: config })).toThrow("stale_policy");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("既存作業ツリーを開き直す Worker に設定済みの非 main ベースを記録する", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const plan = issueWorkerLaunchPlan(
        { number: 1, title: "Task" },
        { projectId: "demo", githubRepo: "owner/repo", baseBranch: "origin/release", checkCommand: "npm test", fixtureMode: true, worktreeRoot: "/wt", automationDir: "/automation", stateDir: root, workerAgent: "pi", workerModel: "", workerInstructions: "" },
        "requeue-launch",
        "a".repeat(40),
        { branch: "agent/issue-1", worktreePath: "/wt/agent-issue-1", inputHead: "a".repeat(40), abandonedAt: "now", workspaceId: "old", agentName: "old" },
      );
      const prepared = prepareAgentLaunchFlow(plan.input, operations(root, "worker", []));
      expect(JSON.parse(readFileSync(path.join(prepared.runDir, "attempt.json"), "utf8")).baseBranch).toBe("origin/release");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("attempt.json のない移行前の実行ディレクトリを兄弟試行として無視する", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      require("node:fs").mkdirSync(path.join(root, "runs", "historical"), { recursive: true });
      require("node:fs").writeFileSync(path.join(root, "runs", "historical", "promise.json"), "{}\n");
      const prepared = prepareAgentLaunchFlow(input(root), operations(root, "worker", []));
      expect(JSON.parse(readFileSync(path.join(prepared.runDir, "attempt.json"), "utf8")).phase).toBe("prepared");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("attempt.json が壊れた兄弟試行では安全側に停止する", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      require("node:fs").mkdirSync(path.join(root, "runs", "malformed"), { recursive: true });
      require("node:fs").writeFileSync(path.join(root, "runs", "malformed", "attempt.json"), "not-json\n");
      expect(() => prepareAgentLaunchFlow(input(root), operations(root, "worker", []))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("同じ実行記録の起動失敗を準備済み状態で上書きしない", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const launchInput = input(root);
      const ops = operations(root, "worker", []);
      prepareAgentLaunchFlow(launchInput, ops);
      transitionPersistedAttempt(path.join(root, "runs", launchInput.uuid), "launch_failed", "failed");
      expect(() => prepareAgentLaunchFlow(launchInput, ops)).toThrow(/cannot resume/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("同じ UUID でも不変の起動識別情報が違えば再開しない", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const launchInput = input(root);
      const ops = operations(root, "worker", []);
      prepareAgentLaunchFlow(launchInput, ops);
      expect(() => prepareAgentLaunchFlow({ ...launchInput, repository: "other/repo" }, ops)).toThrow(/identity/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["/custom/worktrees/worker", "/home/test/.herdr/worktrees/demo/agent-issue-1"])(
    "Worker 作業ツリー作成へ設定済みの正確な意図経路 %s を渡す",
    (expectedPath) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const launchInput = { ...input(root), intendedWorktreePath: expectedPath };
      const ops: any = operations(root, "worker", []);
      let intendedPath = "";
      ops.runner.createWorktree = (request: { intendedPath: string }) => {
        intendedPath = request.intendedPath;
        return { workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1", worktreePath: request.intendedPath };
      };
      let launchedName = "";
      ops.runner.listAgents = () => launchedName ? [{ name: launchedName, paneId: "pane-1", cwd: intendedPath, status: "working" }] : [];
      ops.runText = (args: string[]) => {
        if (args[0] === "git") return `${"a".repeat(40)}\n`;
        const index = args.indexOf("--name");
        if (index >= 0) launchedName = args[index + 1];
        return "started";
      };
      prepareAgentLaunchFlow(launchInput, ops);
      recordAgentLaunchGithubClaimed(launchInput);
      launchAgentFlow(launchInput, ops);
      expect(intendedPath).toBe(expectedPath);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("返された作業ツリーが記録済み経路と違えば起動しない", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const launchInput = input(root, "reviewer");
      const ops: any = operations(root, "reviewer", []);
      ops.runner.openWorktree = () => ({ workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1", worktreePath: "/wt/other" });
      prepareAgentLaunchFlow(launchInput, ops);
      recordAgentLaunchGithubClaimed(launchInput);
      expect(() => launchAgentFlow(launchInput, ops)).toThrow(/outside the recorded attempt checkout/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("開始後の担当が返されたルートペインにいなければ agent_started を記録しない", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const launchInput = input(root, "reviewer");
      const ops: any = operations(root, "reviewer", []);
      let observations = 0;
      ops.runner.listAgents = () => ++observations === 1 ? [] : [{ name: require("../src/herdr-agent-name.cjs").deriveHerdrAgentName({ repository: "owner/repo", role: "reviewer", target: 44, launchUuid: "launch-reviewer" }), paneId: "pane-other", cwd: "/wt/review", status: "working" }];
      prepareAgentLaunchFlow(launchInput, ops);
      recordAgentLaunchGithubClaimed(launchInput);
      expect(() => launchAgentFlow(launchInput, ops)).toThrow(/recorded root pane/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("同じ作業ツリーの過去試行と同じ workspace ID を返したら名前変更前に拒否する", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const priorInput = input(root, "reviewer");
      const priorOps = operations(root, "reviewer", []);
      prepareAgentLaunchFlow(priorInput, priorOps);
      recordAgentLaunchGithubClaimed(priorInput);
      launchAgentFlow(priorInput, priorOps);
      const nextInput = { ...priorInput, uuid: "launch-reviewer-next" };
      const calls: string[] = [];
      const nextOps = operations(root, "reviewer", calls);
      prepareAgentLaunchFlow(nextInput, nextOps);
      recordAgentLaunchGithubClaimed(nextInput);
      expect(() => launchAgentFlow(nextInput, nextOps)).toThrow(/workspace ID used by a prior attempt/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("Worker からレビューと修正へ続く選択済み起動で毎回新しい三つの所有 ID を確認する", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    try {
      const identities = [
        ["workspace-worker", "tab-worker", "pane-worker"],
        ["workspace-reviewer", "tab-reviewer", "pane-reviewer"],
        ["workspace-repair", "tab-repair", "pane-repair"],
      ];
      const roles = ["worker", "reviewer", "review-repair"] as const;
      const observed: string[] = [];
      for (let index = 0; index < roles.length; index += 1) {
        const base = input(root, roles[index] === "worker" ? "worker" : "reviewer");
        const launchInput: any = {
          ...base, uuid: `chain-${roles[index]}`, role: roles[index], project: "demo", intendedWorktreePath: "/wt/shared",
          worktree: index === 0 ? { mode: "create", branch: "feature/shared", baseBranch: "origin/main" } : { mode: "open", branch: "feature/shared", remote: "origin" },
          target: index === 0 ? { kind: "issue", number: 1 } : { kind: "pull-request", number: 44 }, resolveWorktreeHead: false,
          ...(roles[index] === "review-repair" ? { requiredVerification: input(root, "worker").requiredVerification } : {}),
        };
        const ops: any = operations(root, roles[index] === "worker" ? "worker" : "reviewer", []);
        ops.runner.createWorktree = () => ({ workspaceId: identities[index][0], tabId: identities[index][1], rootPaneId: identities[index][2], worktreePath: "/wt/shared" });
        ops.runner.openWorktree = ops.runner.createWorktree;
        ops.runner.listWorktrees = () => index === 0 ? [] : [{ path: "/wt/shared", branch: "feature/shared" }];
        let launchedName = "";
        ops.runner.listAgents = () => launchedName ? [{ name: launchedName, paneId: identities[index][2], cwd: "/wt/shared", status: "working" }] : [];
        ops.runText = (args: string[]) => {
          const nameIndex = args.indexOf("--name");
          if (nameIndex >= 0) { launchedName = args[nameIndex + 1]; observed.push(launchedName); }
          return "started";
        };
        prepareAgentLaunchFlow(launchInput, ops); recordAgentLaunchGithubClaimed(launchInput); launchAgentFlow(launchInput, ops);
      }
      expect(identities.flat()).toHaveLength(new Set(identities.flat()).size);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("返されたルートペインへ直接起動し追加タブを作らない", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-"));
    const calls: string[] = [];
    try {
      const launchInput = input(root, "reviewer");
      const ops = operations(root, "reviewer", calls);
      prepareAgentLaunchFlow(launchInput, ops);
      recordAgentLaunchGithubClaimed(launchInput);
      launchAgentFlow(launchInput, ops);
      expect(calls).toEqual([
        "rename",
        expect.stringContaining("--pane pane-1"),
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("opened checkout alignment at launch", () => {
  it("aligns an opened pull-request checkout to the recorded input revision", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-align-"));
    try {
      const launchInput = input(root, "reviewer");
      const ops: any = operations(root, "reviewer", []);
      const aligned: any[] = [];
      ops.alignCheckout = (value: any) => aligned.push(value);
      ops.runner.listWorktrees = () => [{ path: "/wt/review", branch: "feature/review" }];
      prepareAgentLaunchFlow(launchInput, ops);
      recordAgentLaunchGithubClaimed(launchInput);
      launchAgentFlow(launchInput, ops);

      expect(aligned).toEqual([{
        worktreePath: "/wt/review", expectedHead: "a".repeat(40), remote: "origin", branch: "feature/review",
      }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("leaves a resumed issue Worker checkout alone, because its input revision is the base head", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-align-issue-"));
    try {
      const launchInput: any = {
        ...input(root, "worker"),
        worktree: { mode: "open", branch: "agent/issue-1" },
        resolveWorktreeHead: false,
      };
      const ops: any = operations(root, "worker", []);
      const aligned: any[] = [];
      ops.alignCheckout = (value: any) => aligned.push(value);
      ops.runner.listWorktrees = () => [{ path: "/wt/worker", branch: "agent/issue-1" }];
      prepareAgentLaunchFlow(launchInput, ops);
      recordAgentLaunchGithubClaimed(launchInput);
      launchAgentFlow(launchInput, ops);

      expect(aligned).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses to open a pull-request checkout without the configured remote", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-align-remote-"));
    try {
      const launchInput: any = { ...input(root, "reviewer"), worktree: { mode: "open", branch: "feature/review" } };
      const ops: any = operations(root, "reviewer", []);
      ops.runner.listWorktrees = () => [{ path: "/wt/review", branch: "feature/review" }];
      prepareAgentLaunchFlow(launchInput, ops);
      recordAgentLaunchGithubClaimed(launchInput);

      expect(() => launchAgentFlow(launchInput, ops)).toThrow("requires the configured remote");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
