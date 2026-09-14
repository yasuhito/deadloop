#!/usr/bin/env node
// Agent-run CLI for the deterministic explorer completion-report writer.

const fs = require("node:fs") as typeof import("node:fs");
const { ExplorerReportRefusal, writeExplorerReport } = require("../../../src/explorer-report-writer.cts");

type Refusal = Error & { code: string; fields: string[] };

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") { parsed.help = true; continue; }
    const match = /^--(attempt-record|payload)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error(`unknown flag: ${token}`);
    const value = match[2] === undefined ? argv[index + 1] : match[2];
    if (!value || value.startsWith("--")) throw new Error(`--${match[1]} requires a value`);
    parsed[match[1]] = value;
    if (match[2] === undefined) index += 1;
  }
  return parsed;
}

function help(): string {
  return "Usage: write-explorer-report.cts --attempt-record <runDir>/attempt.json [--payload FILE] (payload defaults to stdin)";
}

function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(`${help()}\n`); return 0; }
  const attemptRecordFile = args["attempt-record"];
  if (typeof attemptRecordFile !== "string") throw new Error("--attempt-record is required");
  const text = typeof args.payload === "string" ? fs.readFileSync(args.payload, "utf8") : fs.readFileSync(0, "utf8");
  let payload: unknown;
  try { payload = JSON.parse(text); } catch (error) {
    throw new ExplorerReportRefusal("invalid_payload_json", `payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = writeExplorerReport({ attemptRecordFile, payload });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) {
    if (error instanceof ExplorerReportRefusal) {
      const refusal = error as Refusal;
      process.stdout.write(`${JSON.stringify({ status: "refused", error: refusal.code, message: refusal.message, ...(refusal.fields.length ? { fields: refusal.fields } : {}) })}\n`);
      process.exitCode = 1;
    } else {
      console.error(`write-explorer-report.cts: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
  }
}
