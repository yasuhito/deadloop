const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { createHerdrRunner } = require("./herdr-runner.cts");

import type { CommandRunner, DriverResult, JsonObject } from "./automation-driver-kit-types";
import type { RunnerAdapter } from "./runner";

const COMMAND_TIMEOUT_MS = 20_000;
// `gh` はネットワーク越しの GitHub 操作なので、ホストが高負荷でもローカルの決定論的コマンドと
// 同じ 20 秒では打ち切られすぎる (#415)。
const NETWORK_COMMAND_TIMEOUT_MS = 90_000;

/** コマンド種別ごとの既定タイムアウト。`gh` はネットワークを伴うので長め。 */
function defaultCommandTimeoutMs(command: string): number {
  return command === "gh" ? NETWORK_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
}

/** タイムアウト理由に「どのスクリプトの」を残すための、起動スクリプト名。 */
function entryScriptLabel(): string {
  const entry = process.argv[1] || "";
  return entry ? path.basename(entry) : "";
}

function driverResult(action: DriverResult["action"], summary: string, extra: JsonObject = {}): DriverResult {
  return { action, summary, ...extra };
}

function createCommandRunner(config: { timeoutMs?: number; label?: string } = {}): CommandRunner {
  const label = config.label !== undefined ? config.label : entryScriptLabel();

  function timeoutMsFor(command: string): number {
    return config.timeoutMs ?? defaultCommandTimeoutMs(command);
  }

  function runText(args: string[], options: { input?: string; check?: boolean } = {}): string {
    const timeoutMs = timeoutMsFor(args[0]);
    const completed = spawnSync(args[0], args.slice(1), {
      input: options.input,
      encoding: "utf8",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    if ((completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      // 理由には、どのスクリプトの、どのコマンドが、何ミリ秒で打ち切られたかを残す (#389, #415)。
      throw new Error(`${label ? `${label}: ` : ""}command timed out after ${timeoutMs}ms: ${args.join(" ")}`);
    }
    if (completed.error) throw completed.error;
    if (options.check !== false && completed.status !== 0) {
      throw new Error((completed.stderr || completed.stdout || `command failed: ${args.join(" ")}`).trim());
    }
    return completed.stdout || "";
  }

  function runJson(args: string[], options: { input?: string } = {}): any {
    return JSON.parse(runText(args, { input: options.input }));
  }

  return { runText, runJson };
}

function createHerdrRunnerFromCommandRunner(commandRunner: CommandRunner): RunnerAdapter {
  return createHerdrRunner({
    runText: (command: string, args: string[]) => commandRunner.runText([command, ...args]),
    runJson: (command: string, args: string[]) => commandRunner.runJson([command, ...args]),
  });
}

function shellQuote(value: string | number): string {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function oneLine(value: unknown): string {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = oneLine(value);
    if (text) return text;
  }
  return "";
}

/**
 * Distills one operator-readable reason for a failed completion sub-step: the stage script name
 * plus the child result's own failure text. A child script that catches its own exception still
 * exits 0 with a `driverAction: "exception"` tag, so collapsing the result to that tag alone
 * would record the single word "exception" as the whole failure reason (#389).
 */
function stageFailureReason(stage: string, result: unknown): string {
  const child = result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : undefined;
  const detail = firstText(child?.summary, child?.error, child?.reason, child?.driverAction, child?.action);
  const message = oneLine(detail || "unknown failure").slice(0, 200);
  // The child's own timeout reason already names its script (#415), so keep one stage prefix.
  return message.startsWith(`${stage}: `) ? message : `${stage}: ${message}`;
}

function parseBool(value: string | undefined): boolean {
  return String(value || "").toLowerCase() === "1" || String(value || "").toLowerCase() === "true";
}

function loadFixture(file: string | undefined): JsonObject | null {
  if (!file) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("fixture must be a JSON object");
  return data;
}

function parseFixtureArg(argv: string[]): { fixture?: string } {
  const parsed: { fixture?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--fixture") {
      parsed.fixture = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

module.exports = {
  COMMAND_TIMEOUT_MS,
  NETWORK_COMMAND_TIMEOUT_MS,
  createCommandRunner,
  defaultCommandTimeoutMs,
  createHerdrRunnerFromCommandRunner,
  driverResult,
  loadFixture,
  oneLine,
  parseBool,
  parseFixtureArg,
  shellQuote,
  stageFailureReason,
};
