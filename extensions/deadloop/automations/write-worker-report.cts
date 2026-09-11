#!/usr/bin/env node
//
// write-worker-report — the agent-run CLI around the deterministic writer for the Issue Worker's
// canonical V1 completion report (src/worker-report-writer.cts).
//
// The Worker prompt no longer asks the model to transcribe the report identity or `git rev-parse
// HEAD`; the model hands the semantic payload to this writer, which injects the fixed fields and
// atomically writes the attempt record's own promise file.
//
// Usage:
//   node write-worker-report.cts --attempt-record <runDir>/attempt.json --payload <file>
//   node write-worker-report.cts --attempt-record <runDir>/attempt.json <<'JSON'
//   {"status":"complete","summary":"...","evidence":{"validations":["command and result"]}}
//   JSON

const fs = require("node:fs") as typeof import("node:fs");
const { writeWorkerReport, WorkerReportRefusal } = require("../../../src/worker-report-writer.cts");

type WorkerReportRefusalShape = Error & { code: string; fields: string[] };

function parseWriterArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    const match = /^--(attempt-record|payload)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error(`unknown flag: ${token}`);
    const value = match[2] !== undefined ? match[2] : argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${match[1]} requires a value`);
    parsed[match[1]] = value;
    if (match[2] === undefined) index += 1;
  }
  return parsed;
}

function writerHelp(): string {
  return "Usage: write-worker-report.cts --attempt-record <runDir>/attempt.json [--payload FILE] (payload defaults to stdin)";
}

function readPayload(args: Record<string, string | boolean>): string {
  const payloadFile = args.payload;
  if (typeof payloadFile === "string") return fs.readFileSync(payloadFile, "utf8");
  if (process.stdin.isTTY) throw new Error("a payload is required: pass --payload FILE or pipe it on stdin");
  return fs.readFileSync(0, "utf8");
}

function refusalPayload(error: WorkerReportRefusalShape): Record<string, unknown> {
  return {
    status: "refused",
    error: error.code,
    message: error.message,
    ...(error.fields.length ? { fields: error.fields } : {}),
  };
}

function requiredAttemptRecordArg(args: Record<string, string>): string {
  const value = args["attempt-record"];
  if (!value) throw new Error("--attempt-record is required");
  return value;
}

function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseWriterArgs(argv);
  if (args.help) {
    process.stdout.write(`${writerHelp()}\n`);
    return 0;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(readPayload(args));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new WorkerReportRefusal("invalid_payload_json", `payload is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  const result = writeWorkerReport({ attemptRecordFile: requiredAttemptRecordArg(args as Record<string, string>), payload });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof WorkerReportRefusal) {
      process.stdout.write(`${JSON.stringify(refusalPayload(error))}\n`);
      process.exitCode = 1;
    } else {
      console.error(`write-worker-report.cts: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
  }
}
