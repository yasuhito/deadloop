#!/usr/bin/env node
// Validate a worker promise JSON file. CommonJS-shaped so it can run directly
// with `node extract-worker-promise.ts`.

const fs = require("node:fs") as typeof import("node:fs");

type PromiseValidation = Record<string, any>;

const VALID_PROMISE_STATUSES = new Set(["complete", "blocked"]);

function invalidPromise(filePath: string, error: string): PromiseValidation {
  return { status: "invalid", file: filePath, error };
}

function validatePromise(filePath: string): PromiseValidation {
  if (!fs.existsSync(filePath)) return { status: "none", file: filePath };

  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return invalidPromise(filePath, "invalid_json");
    return invalidPromise(filePath, `read_error: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalidPromise(filePath, "not_object");
  const promise = payload as PromiseValidation;
  const status = promise.status;
  if (!VALID_PROMISE_STATUSES.has(status)) return invalidPromise(filePath, "invalid_status");
  if (typeof promise.reason !== "string") return invalidPromise(filePath, "invalid_reason");
  if (typeof promise.summary !== "string") return invalidPromise(filePath, "invalid_summary");

  return { status, file: filePath, promise };
}

function requiredPromiseArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePromiseArgs(argv: string[]): PromiseValidation {
  const parsed: PromiseValidation = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--file") {
      parsed.file = requiredPromiseArg(argv, index, token);
      index += 1;
      continue;
    }
    if (token.startsWith("--file=")) {
      parsed.file = token.slice("--file=".length);
      continue;
    }
    throw new Error(`unknown flag: ${token}`);
  }
  return parsed;
}

function promiseHelp(): string {
  return "Usage: extract-worker-promise.ts --file FILE";
}

function main(argv: string[] = process.argv.slice(2)): number {
  const args = parsePromiseArgs(argv);
  if (args.help) {
    process.stdout.write(`${promiseHelp()}\n`);
    return 0;
  }
  if (!args.file) throw new Error("--file is required");
  const result = validatePromise(args.file);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return VALID_PROMISE_STATUSES.has(result.status) ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`extract-worker-promise.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

module.exports = { validatePromise };
