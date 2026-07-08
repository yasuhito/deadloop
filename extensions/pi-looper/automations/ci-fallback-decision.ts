#!/usr/bin/env node
// Decide whether failed GitHub checks may use local CI fallback. CommonJS-shaped
// so it can run directly with `node ci-fallback-decision.ts`.

const fs = require("node:fs") as typeof import("node:fs");

type CiRecord = Record<string, any>;

const PENDING_CHECK_STATES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING", "REQUESTED"]);
const FAILURE_CONCLUSIONS = new Set(["FAILURE", "FAILED", "ACTION_REQUIRED", "STARTUP_FAILURE", "TIMED_OUT", "CANCELLED"]);
const SUCCESS_CONCLUSIONS = new Set(["SUCCESS", "SUCCESSFUL", "NEUTRAL", "SKIPPED"]);
const INFRASTRUCTURE_TEXT_RE = /\b(spending limit|quota|minutes? exceeded|included minutes|actions disabled|github actions (?:is )?disabled|github actions.{0,80}billing|billing.{0,80}github actions|billing.{0,80}disabled|workflow (?:was )?disabled|payment required|no account minutes|cannot run workflows?|disabled by (?:repository|organization))\b/i;
const FAILED_STEP_CONCLUSIONS = new Set(["FAILURE", "FAILED", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const IMMEDIATE_INFRA_CONCLUSIONS = new Set(["FAILURE", "FAILED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const LOG_UNAVAILABLE_RE = /\b(no logs?|log not found|failed to get logs?|could not fetch logs?)\b/i;

function parseCiBool(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  return String(value || "").trim().toLowerCase() === "1" || ["true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parseCiTime(value: unknown): Date | null {
  if (!value) return null;
  const text = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2}T/.test(text) && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? `${text}Z` : text;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function durationSeconds(item: CiRecord): number | null {
  const started = parseCiTime(item.startedAt || item.started_at);
  const completed = parseCiTime(item.completedAt || item.completed_at);
  if (!started || !completed) return null;
  return (completed.getTime() - started.getTime()) / 1000;
}

function loadCiJson(file: string | undefined): unknown {
  return JSON.parse(file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8"));
}

function loadOptionalCiJson(file: string | undefined): unknown {
  return file ? loadCiJson(file) : null;
}

function pullRequestFrom(data: unknown): CiRecord {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as CiRecord;
    for (const key of ["pullRequest", "pull_request", "pr"]) if (record[key] && typeof record[key] === "object") return record[key];
    return record;
  }
  if (Array.isArray(data) && data.length && data[0] && typeof data[0] === "object") return data[0];
  return {};
}

function iterCiJobs(data: unknown): CiRecord[] {
  const jobs: CiRecord[] = [];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as CiRecord;
    if (Array.isArray(record.jobs)) jobs.push(...record.jobs.filter((job: unknown) => job && typeof job === "object"));
    const runs = record.runs || record.workflowRuns || record.workflow_runs;
    if (Array.isArray(runs)) for (const run of runs) jobs.push(...iterCiJobs(run));
  } else if (Array.isArray(data)) {
    for (const item of data) jobs.push(...iterCiJobs(item));
  }
  return jobs;
}

function statusRollup(pr: CiRecord): CiRecord[] {
  const checks = pr.statusCheckRollup || pr.status_check_rollup || [];
  return Array.isArray(checks) ? checks.filter((check: unknown) => check && typeof check === "object") : [];
}

function normalizedConclusion(item: CiRecord): string {
  return String(item.conclusion || item.state || "").toUpperCase();
}

function normalizedStatus(item: CiRecord): string {
  return String(item.status || item.state || "").toUpperCase();
}

function isCiFailure(item: CiRecord): boolean {
  return FAILURE_CONCLUSIONS.has(normalizedConclusion(item));
}

function isCiSuccess(item: CiRecord): boolean {
  return SUCCESS_CONCLUSIONS.has(normalizedConclusion(item)) || normalizedStatus(item) === "SUCCESS";
}

function hasPendingCi(items: CiRecord[]): boolean {
  return items.some((item) => PENDING_CHECK_STATES.has(normalizedStatus(item)));
}

function recursiveCiStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((child) => recursiveCiStrings(child));
  if (value && typeof value === "object") return Object.values(value).flatMap((child) => recursiveCiStrings(child));
  return [];
}

function jobSteps(job: CiRecord): CiRecord[] {
  const steps = job.steps || [];
  return Array.isArray(steps) ? steps.filter((step: unknown) => step && typeof step === "object") : [];
}

function failedSteps(job: CiRecord): CiRecord[] {
  return jobSteps(job).filter((step) => FAILED_STEP_CONCLUSIONS.has(String(step.conclusion || step.status || "").toUpperCase()));
}

function checkSummary(item: CiRecord): string {
  const name = item.name || item.workflowName || item.displayTitle || "unnamed";
  const duration = durationSeconds(item);
  return duration === null ? `${name}: duration unknown` : `${name}: ${duration.toFixed(0)}s`;
}

function decideCiFallback(data: unknown, jobsData: unknown, logText: string, enabled: boolean, mode: string, maxImmediateSeconds: number): CiRecord {
  const pr = pullRequestFrom(data);
  const combinedJobsSource = jobsData ?? data;
  const checks = statusRollup(pr);
  const jobs = iterCiJobs(combinedJobsSource);
  const evidence: string[] = [];

  const textBlob = [...recursiveCiStrings(pr), ...recursiveCiStrings(combinedJobsSource), logText].join("\n");
  const explicitInfra = INFRASTRUCTURE_TEXT_RE.test(textBlob);
  if (explicitInfra) evidence.push("GitHub Actions の課金・quota・Actions 停止系の文言を検出しました。");

  const observableItems = [...checks, ...jobs];
  const failedJobs = jobs.filter(isCiFailure);
  const failedChecks = checks.filter(isCiFailure);
  const failedItems = failedJobs.length ? failedJobs : failedChecks;

  if (!enabled) {
    return { enabled: false, mode, classification: "disabled", fallbackAllowed: false, reason: "ci_fallback_disabled", evidence };
  }
  if (mode !== "billing-only") {
    return {
      enabled: true,
      mode,
      classification: "unsupported_mode",
      fallbackAllowed: false,
      reason: "unsupported_mode",
      evidence: [...evidence, "現在サポートする mode は billing-only だけです。"],
    };
  }
  if (!observableItems.length) {
    return {
      enabled: true,
      mode,
      classification: "unknown_ci_failure",
      fallbackAllowed: false,
      reason: "no_check_data",
      evidence: [...evidence, "GitHub checks / job 情報がありません。"],
    };
  }
  if (hasPendingCi(observableItems)) {
    return {
      enabled: true,
      mode,
      classification: "pending",
      fallbackAllowed: false,
      reason: "checks_pending",
      evidence: [...evidence, "進行中の check があるため fallback 判定をしません。"],
    };
  }
  if (!failedItems.length) {
    return {
      enabled: true,
      mode,
      classification: "no_failure",
      fallbackAllowed: false,
      reason: "no_failed_checks",
      evidence: [...evidence, "失敗した check / job がありません。"],
    };
  }

  const successfulItems = observableItems.filter(isCiSuccess);
  const jobFailedSteps = failedJobs.flatMap(failedSteps);
  if (jobFailedSteps.length) {
    return {
      enabled: true,
      mode,
      classification: "ordinary_ci_failure",
      fallbackAllowed: false,
      reason: "failed_job_step",
      evidence: [
        ...evidence,
        "失敗 step があるため、コード実行後の通常 CI failure と扱います。",
        ...jobFailedSteps.slice(0, 5).map((step) => `failed step: ${step.name || step.number || "unnamed"}`),
      ],
    };
  }

  const durations = failedItems.map(durationSeconds);
  const allDurationsKnown = durations.every((duration) => duration !== null);
  const allImmediate = allDurationsKnown && durations.every((duration) => duration !== null && duration <= maxImmediateSeconds);
  const allObservableFailed = successfulItems.length === 0 && observableItems.every(isCiFailure);
  const allImmediateConclusionsMatch = failedItems.every((item) => IMMEDIATE_INFRA_CONCLUSIONS.has(normalizedConclusion(item)));
  const allFailedJobsHaveNoSteps = failedJobs.length > 0 && failedJobs.every((job) => jobSteps(job).length === 0);
  const noLogAvailable = !logText.trim() || LOG_UNAVAILABLE_RE.test(logText);

  if (explicitInfra) {
    return {
      enabled: true,
      mode,
      classification: "ci_infrastructure_failure",
      fallbackAllowed: true,
      reason: "explicit_infrastructure_text",
      evidence,
    };
  }

  if (allObservableFailed && allImmediate && allImmediateConclusionsMatch && allFailedJobsHaveNoSteps && noLogAvailable) {
    return {
      enabled: true,
      mode,
      classification: "ci_infrastructure_failure",
      fallbackAllowed: true,
      reason: "all_jobs_failed_immediately_without_steps_or_logs",
      evidence: [
        ...evidence,
        `すべての失敗 check / job が ${maxImmediateSeconds} 秒以内に終了し、job steps と log がありません。`,
        ...failedItems.slice(0, 8).map(checkSummary),
      ],
    };
  }

  let reason = "mixed_or_slow_failures";
  let detail = "成功した check と失敗した check が混在、または失敗までの時間が通常実行相当です。";
  if (!allDurationsKnown) {
    reason = "insufficient_duration_data";
    detail = "失敗までの時間を確認できないため、billing-only fallback は許可しません。";
  }
  return {
    enabled: true,
    mode,
    classification: successfulItems.length || !allImmediate ? "ordinary_ci_failure" : "unknown_ci_failure",
    fallbackAllowed: false,
    reason,
    evidence: [...evidence, detail, ...failedItems.slice(0, 8).map(checkSummary)],
  };
}

function requiredCiValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseCiArgs(argv: string[]): CiRecord {
  const parsed: CiRecord = { logFile: [], enabled: "false", mode: "billing-only", maxImmediateSeconds: "5.0" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (["--input", "--jobs", "--enabled", "--mode", "--max-immediate-seconds"].includes(token)) {
      const key = token.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
      parsed[key] = requiredCiValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token.startsWith("--input=")) {
      parsed.input = token.slice("--input=".length);
      continue;
    }
    if (token.startsWith("--jobs=")) {
      parsed.jobs = token.slice("--jobs=".length);
      continue;
    }
    if (token.startsWith("--enabled=")) {
      parsed.enabled = token.slice("--enabled=".length);
      continue;
    }
    if (token.startsWith("--mode=")) {
      parsed.mode = token.slice("--mode=".length);
      continue;
    }
    if (token.startsWith("--max-immediate-seconds=")) {
      parsed.maxImmediateSeconds = token.slice("--max-immediate-seconds=".length);
      continue;
    }
    if (token === "--log-file") {
      parsed.logFile.push(requiredCiValue(argv, index, token));
      index += 1;
      continue;
    }
    if (token.startsWith("--log-file=")) {
      parsed.logFile.push(token.slice("--log-file=".length));
      continue;
    }
    throw new Error(`unknown flag: ${token}`);
  }
  return parsed;
}

function ciFallbackHelp(): string {
  return "Usage: ci-fallback-decision.ts [--input FILE] [--jobs FILE] [--log-file FILE...] [--enabled BOOL] [--mode billing-only]";
}

function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseCiArgs(argv);
  if (args.help) {
    process.stdout.write(`${ciFallbackHelp()}\n`);
    return 0;
  }
  const maxImmediateSeconds = Number(args.maxImmediateSeconds);
  if (!Number.isFinite(maxImmediateSeconds)) throw new Error("--max-immediate-seconds must be a number");
  const data = loadCiJson(args.input);
  const jobsData = loadOptionalCiJson(args.jobs);
  const logParts = (args.logFile || []).map((file: string) => fs.readFileSync(file, { encoding: "utf8", flag: "r" }));
  const inputLog = data && typeof data === "object" && !Array.isArray(data) ? (data as CiRecord).logText : "";
  if (inputLog) logParts.push(String(inputLog));
  const decision = decideCiFallback(data, jobsData, logParts.join("\n"), parseCiBool(args.enabled), args.mode, maxImmediateSeconds);
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ci-fallback-decision.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

module.exports = { decideCiFallback };
