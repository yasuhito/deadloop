#!/usr/bin/env node
// Validate a worker promise JSON file. CommonJS-shaped so it can run directly
// with `node extract-worker-promise.ts`.

const fs = require("node:fs") as typeof import("node:fs");

type PromiseValidation = Record<string, any>;

const VALID_PROMISE_STATUSES = new Set(["complete", "blocked"]);
const VALID_REVIEW_OUTCOMES = new Set(["approved", "changes_requested", "human_required"]);
const VALID_FINDING_SEVERITIES = new Set(["blocker", "major", "minor"]);

function validFinding(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const finding = value as PromiseValidation;
  if (typeof finding.title !== "string" || !finding.title.trim()) return false;
  if (typeof finding.body !== "string" || !finding.body.trim()) return false;
  if (finding.path !== undefined && (typeof finding.path !== "string" || !finding.path.trim())) return false;
  if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) return false;
  if (finding.severity !== undefined && !VALID_FINDING_SEVERITIES.has(finding.severity)) return false;
  return true;
}

function validRepair(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const repair = value as PromiseValidation;
  return (
    typeof repair.title === "string" &&
    Boolean(repair.title.trim()) &&
    typeof repair.summary === "string" &&
    Boolean(repair.summary.trim()) &&
    Array.isArray(repair.paths) &&
    repair.paths.length > 0 &&
    repair.paths.every((entry: unknown) => typeof entry === "string" && Boolean(entry.trim()))
  );
}

function validCheck(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const check = value as PromiseValidation;
  return typeof check.command === "string" && Boolean(check.command.trim()) && check.result === "passed";
}

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
  if (promise.outcome !== undefined && !VALID_REVIEW_OUTCOMES.has(promise.outcome)) {
    return invalidPromise(filePath, "invalid_outcome");
  }
  if (promise.findings !== undefined && (!Array.isArray(promise.findings) || !promise.findings.every(validFinding))) {
    return invalidPromise(filePath, "invalid_findings");
  }
  if (promise.outcome === "changes_requested" && (!Array.isArray(promise.findings) || promise.findings.length === 0)) {
    return invalidPromise(filePath, "changes_requested_requires_findings");
  }
  if (status === "blocked" && promise.outcome !== undefined) return invalidPromise(filePath, "blocked_has_outcome");
  if (
    promise.reason === "repair_pushed" &&
    (!Array.isArray(promise.repairs) || promise.repairs.length === 0 || !promise.repairs.every(validRepair))
  ) {
    return invalidPromise(filePath, "repair_pushed_requires_repairs");
  }
  if (
    promise.reason === "repair_pushed" &&
    (!Array.isArray(promise.checks) || promise.checks.length === 0 || !promise.checks.every(validCheck))
  ) {
    return invalidPromise(filePath, "repair_pushed_requires_passed_checks");
  }

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
