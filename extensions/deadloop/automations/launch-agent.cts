#!/usr/bin/env node
//
// launch-agent — the single command the coordinator uses to start an agent
// (Worker / reviewer). It builds the launch argv from the profile table
// (src/agent-profiles.cjs), fail-fast checks the agent's preconditions (claude
// workspace trust, via the shared judgment in src/agent-trust.cjs), then runs
// `herdr agent start ... -- <argv...>` WITHOUT a shell (execFileSync) so that
// prompt text containing quotes, `$`, or backticks reaches the agent as one
// intact argument. herdr's result JSON is written to stdout unchanged.
//
// Run directly with `node launch-agent.cts` — node strips the type annotations,
// so there is no build step. See docs/adr/0004-agent-launcher.md.
//
// Usage:
//   node launch-agent.cts --agent <pi|claude|omp> --name <name> --cwd <path>
//     --pane <rootPaneId> --level <low|medium|high> --model <model> --prompt-file <path>
//     [--uuid <uuid>] [--repo-path <path>]

const fs = require("node:fs") as typeof import("node:fs");
const { execFileSync } = require("node:child_process") as typeof import("node:child_process");

const { buildNativeAgentArgv, isAgentKind, AGENT_KINDS, AGENT_PROFILES } = require("../../../src/agent-profiles.cjs");
const { readClaudeConfig, evaluateWorkspaceTrust } = require("../../../src/agent-trust.cjs");
const { createHerdrRunner } = require("../../../src/herdr-runner.cts");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");

const FLAG_KEYS = ["agent", "name", "cwd", "model", "level", "uuid", "prompt-file", "pane", "repo-path"] as const;

function parseArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (!FLAG_KEYS.includes(key as (typeof FLAG_KEYS)[number])) {
      throw new Error(`unknown flag: ${token}`);
    }
    values[key] = argv[i + 1] ?? "";
    i += 1;
  }
  return values;
}

function fail(payload: Record<string, unknown>): never {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(1);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function main(
  argv: string[] = process.argv.slice(2),
  options: {
    runner?: { startAgent: (input: { name: string; kind: string; rootPaneId: string; nativeAgentArgv: string[] }) => string };
    herdrPreflight?: () => unknown;
    readClaudeConfig?: () => unknown;
    writeOutput?: boolean;
  } = {},
): string {
  try {
    if (options.herdrPreflight) options.herdrPreflight();
    else if (!options.runner) runHerdrPreflight();
  } catch (error) {
    fail({ error: "herdr_unsupported", message: error instanceof Error ? error.message : String(error) });
  }

  let args: Record<string, string>;
  try {
    args = parseArgs(argv);
  } catch (error) {
    fail({ error: "bad_arguments", message: error instanceof Error ? error.message : String(error) });
  }

  const agent = args.agent || "";
  if (!isAgentKind(agent)) {
    fail({ error: "unknown_agent", agent, supported: AGENT_KINDS });
  }
  const profile = AGENT_PROFILES[agent];

  const cwd = args.cwd || "";
  const promptFile = args["prompt-file"] || "";
  if (!cwd) fail({ error: "missing_cwd" });
  if (!promptFile) fail({ error: "missing_prompt_file" });
  const rootPaneId = args.pane || "";
  if (!rootPaneId) fail({ error: "missing_root_pane" });
  // The role's resolved model is required: an empty model would silently fall back to the
  // agent CLI default, which is exactly what deadloop never does.
  if (!String(args.model || "").trim()) fail({ error: "missing_model", resolution: "configure workerModel and reviewerModel for this project" });

  let promptText: string;
  try {
    promptText = fs.readFileSync(promptFile, "utf8");
  } catch (error) {
    fail({ error: "prompt_file_unreadable", promptFile, message: error instanceof Error ? error.message : String(error) });
  }

  // Preconditions: fail-fast only when a precondition is confirmed unmet.
  // Indeterminate checks warn and continue (ADR 0004: an uncertain trust check
  // that blocks is worse than letting a known-bypassable dialog through).
  // Trust is judged against the operator-trusted repo root (matching the doctor
  // diagnostic), not the per-launch worktree cwd, falling back to cwd.
  if (profile.preconditions.includes("workspaceTrust")) {
    const trustPath = args["repo-path"] || cwd;
    const trust = evaluateWorkspaceTrust((options.readClaudeConfig ?? readClaudeConfig)(), trustPath);
    if (trust === "untrusted") {
      fail({
        error: "workspace_trust_unaccepted",
        repoPath: trustPath,
        resolution: `cd ${shellQuote(trustPath)} && claude`,
      });
    }
    if (trust === "unknown") {
      process.stderr.write(
        `launch-agent: warning: cannot determine claude workspace trust for ${trustPath}; launching anyway\n`,
      );
    }
  }

  let agentArgv: string[];
  try {
    agentArgv = buildNativeAgentArgv({
      agent,
      name: args.name || "",
      level: args.level || "",
      model: args.model || "",
      uuid: args.uuid || "",
      promptFile,
      promptText,
    });
  } catch (error) {
    fail({ error: "invalid_launch", message: error instanceof Error ? error.message : String(error) });
  }

  const runner =
    options.runner ??
    createHerdrRunner({
      runText: (command: string, commandArgs: string[], timeoutMs?: number) =>
        execFileSync(command, commandArgs, { encoding: "utf8", ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) }),
    });

  try {
    const stdout = runner.startAgent({
      name: args.name || "",
      kind: agent,
      rootPaneId,
      nativeAgentArgv: agentArgv,
    });
    if (options.writeOutput !== false) process.stdout.write(stdout);
    return stdout;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    fail({ error: "herdr_start_failed", message: err.message || String(error) });
  }
}

if (require.main === module) main();

module.exports = { main };
