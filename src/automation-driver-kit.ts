const fs = require("node:fs") as typeof import("node:fs");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { createHerdrRunner } = require("./herdr-runner.ts");

import type { RunnerAdapter } from "./runner";

export type JsonObject = Record<string, any>;

export type DriverResult = {
  action: "skip" | "done" | "needs_llm" | "error";
  summary: string;
  [key: string]: any;
};

export type CommandRunner = {
  runText(args: string[], options?: { input?: string; check?: boolean }): string;
  runJson(args: string[], options?: { input?: string }): any;
};

const COMMAND_TIMEOUT_MS = 20_000;

function driverResult(action: DriverResult["action"], summary: string, extra: JsonObject = {}): DriverResult {
  return { action, summary, ...extra };
}

function createCommandRunner(config: { timeoutMs?: number } = {}): CommandRunner {
  const timeoutMs = config.timeoutMs ?? COMMAND_TIMEOUT_MS;

  function runText(args: string[], options: { input?: string; check?: boolean } = {}): string {
    const completed = spawnSync(args[0], args.slice(1), {
      input: options.input,
      encoding: "utf8",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    if ((completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      throw new Error(`command timed out after ${timeoutMs}ms: ${args.join(" ")}`);
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
  createCommandRunner,
  createHerdrRunnerFromCommandRunner,
  driverResult,
  loadFixture,
  oneLine,
  parseBool,
  parseFixtureArg,
  shellQuote,
};
