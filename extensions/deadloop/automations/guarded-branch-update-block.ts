#!/usr/bin/env node
// Apply the branch-update failure label transition only while the reviewed PR
// remains on the exact head that the update attempt targeted.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");

type Args = {
  projectRepo: string; githubRepo: string; stateDir: string; enabledAt: number;
  pr: string; expectedHead: string; reviewLabel: string; reviewingLabel: string; blockedLabel: string;
};
type Result = { status: number; stdout: string; stderr: string };
type Ops = {
  run: (args: string[]) => Result;
  withLock?: (project: Pick<Args, "projectRepo" | "githubRepo" | "stateDir" | "enabledAt">, operation: (_enabled: unknown, recheck: () => void) => number) => number;
};

function defaultRun(args: string[]): Result {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: MAX_GUARDED_OPERATION_MS, killSignal: "SIGKILL" });
  return { status: result.status ?? 1, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}
function checked(ops: Ops, args: string[]): string {
  const result = ops.run(args);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${args[0]} failed`).trim());
  return result.stdout;
}
function livePr(args: Args, ops: Ops): Record<string, any> {
  try { return JSON.parse(checked(ops, ["gh", "pr", "view", args.pr, "-R", args.githubRepo, "--json", "state,headRefOid,labels"])); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("PR state response was invalid; branch-update block stopped");
    throw error;
  }
}
function labels(pr: Record<string, any>): Set<string> {
  return new Set(Array.isArray(pr.labels) ? pr.labels.map((label: any) => label?.name).filter((name: unknown): name is string => typeof name === "string") : []);
}
function assertEligible(args: Args, pr: Record<string, any>): void {
  const current = labels(pr);
  if (pr.state !== "OPEN" || String(pr.headRefOid || "").toLowerCase() !== args.expectedHead.toLowerCase()) {
    throw new Error("PR changed; branch-update block stopped");
  }
  if (!current.has(args.reviewLabel)) throw new Error("review target label is missing; branch-update block stopped");
}
function blockBranchUpdate(args: Args, ops: Ops = { run: defaultRun }): number {
  const project = { projectRepo: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const operation = (_enabled: unknown, recheck: () => void) => {
    assertEligible(args, livePr(args, ops));
    recheck();
    const boundary = livePr(args, ops);
    assertEligible(args, boundary);
    const boundaryLabels = labels(boundary);
    checked(ops, ["gh", "pr", "edit", args.pr, "-R", args.githubRepo, "--remove-label", args.reviewingLabel, "--add-label", args.blockedLabel]);
    const after = livePr(args, ops); const current = labels(after);
    const headChanged = String(after.headRefOid || "").toLowerCase() !== args.expectedHead.toLowerCase();
    if (headChanged || !current.has(args.reviewLabel) || current.has(args.reviewingLabel) || !current.has(args.blockedLabel)) {
      const rollback = ["gh", "pr", "edit", args.pr, "-R", args.githubRepo];
      const blockerAdded = !boundaryLabels.has(args.blockedLabel) && current.has(args.blockedLabel);
      if (headChanged && blockerAdded) rollback.push("--remove-label", args.blockedLabel);
      for (const label of [args.reviewLabel, args.reviewingLabel]) {
        if (boundaryLabels.has(label) && !current.has(label)) rollback.push("--add-label", label);
      }
      if (rollback.length > 6) checked(ops, rollback);
      if (headChanged) throw new Error(`PR head changed during branch-update block; prior labels restored and blocker ${blockerAdded ? "removed" : "preserved"}`);
      throw new Error("branch-update blocked-label transition was not persisted exactly; prior labels restored and blocker preserved");
    }
    return 0;
  };
  return ops.withLock ? ops.withLock(project, operation) : withEnabledProjectLock(
    { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt }, operation,
  );
}
function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const field of ["projectRepo", "githubRepo", "stateDir", "pr", "expectedHead", "reviewLabel", "reviewingLabel", "blockedLabel"]) if (!values[field]) throw new Error(`--${field} is required`);
  const enabledAt = Number(values.enabledAt); if (!Number.isFinite(enabledAt)) throw new Error("--enabled-at is required");
  return { ...values, enabledAt } as Args;
}
function main(): void {
  try { process.exitCode = blockBranchUpdate(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(`guarded-branch-update-block.ts: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { blockBranchUpdate, parseArgs };
