// Close the still-open workspace of an attempt whose settlement is already proven — its journal
// released the attempt or its monitored pull request closed (#395). The ownership judgment mirrors
// complete-attempt-workspace.cts: only a workspace this journal exactly owns is closed, never on
// faith. Every evaluated attempt writes a bounded receipt beside the journal; the host patrol uses
// that receipt to attempt the closure exactly once, and doctor presents the retry command after a
// failed attempt.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const { createHerdrRunnerFromCommandRunner } = require("./automation-driver-kit.cts");
const { readAttemptRecord, releasesAttemptOwnership } = require("./attempt-lifecycle-runtime.cjs");
const { assertWorktreeBelongsToProject, canonicalAttemptLocation } = require("./attempt-project-confinement.cjs");

type CommandRunner = import("./automation-driver-kit-types").CommandRunner;

type ClosureArgs = {
  attemptRecord: string;
  projectId: string;
  projectRepo: string;
  githubRepo: string;
  stateDir: string;
  enabledAt?: string | number;
};

type SettledWorkspaceClosure = { closed: true } | { closed: false; detail: string };

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeCall<T>(operation: () => T): { ok: true; value: T } | { ok: false; detail: string } {
  try { return { ok: true as const, value: operation() }; }
  catch (error) { return { ok: false as const, detail: detailOf(error) }; }
}

/** The bounded evidence record of one closure attempt; also the patrol's exactly-once marker. */
function readSettledWorkspaceCleanupReceipt(runDir: string): Record<string, unknown> | null {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(runDir, "settled-workspace-cleanup.json"), "utf8"));
    return receipt && typeof receipt === "object" && !Array.isArray(receipt) && receipt.schemaVersion === 1
      ? receipt as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function recordReceipt(runDir: string, record: { attemptId: string; phase: string }, outcome: "closed" | "failed", detail: string): void {
  try {
    fs.writeFileSync(
      path.join(runDir, "settled-workspace-cleanup.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        attemptId: record.attemptId,
        phase: record.phase,
        outcome,
        ...(detail ? { detail } : {}),
        at: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {}
}

/**
 * Closes the settled attempt's workspace after the same ownership proof the completion chain uses:
 * exactly one listed workspace bound to the journal's ID and worktree path, no newer live attempt
 * claiming it, and a worktree still registered by the configured checkout. A failed attempt keeps
 * its reason in the receipt; nothing here rewrites the journal phase or touches GitHub.
 */
function closeSettledAttemptWorkspace(
  args: ClosureArgs,
  commandRunner: CommandRunner,
): SettledWorkspaceClosure {
  const { runDir, runsRoot } = canonicalAttemptLocation(args);
  const record: any = readAttemptRecord(runDir);
  if (!record.workspaceId || ["workspace_closed", "abandoned"].includes(record.phase)) return { closed: true };
  const fail = (detail: string): SettledWorkspaceClosure => {
    recordReceipt(runDir, record, "failed", detail);
    return { closed: false, detail };
  };
  const runner = createHerdrRunnerFromCommandRunner(commandRunner);

  const listed = safeCall(() => runner.listWorkspaces());
  if ("detail" in listed) return fail(listed.detail);
  const matches = listed.value.filter((workspace) => workspace.workspaceId === record.workspaceId);
  if (matches.length === 0) {
    recordReceipt(runDir, record, "closed", "workspace was already closed");
    return { closed: true };
  }
  if (matches.length > 1 || !matches[0].worktreePath
    || path.resolve(matches[0].worktreePath) !== path.resolve(record.worktreePath)) {
    return fail("workspace ownership is ambiguous");
  }

  for (const entry of fs.readdirSync(runsRoot)) {
    if (path.join(runsRoot, entry) === runDir) continue;
    let candidate;
    try { candidate = readAttemptRecord(path.join(runsRoot, entry)); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Attempt record is missing:")) continue;
      return fail("another attempt journal is malformed");
    }
    if (candidate.project !== record.project || candidate.repository !== record.repository) continue;
    const candidateOwnsWorkspace = !["prepared", "github_claimed"].includes(candidate.phase);
    if (candidateOwnsWorkspace && !releasesAttemptOwnership(candidate.phase) && candidate.attemptId !== record.attemptId
      && (Boolean(record.workspaceId) && candidate.workspaceId === record.workspaceId
        || path.resolve(candidate.worktreePath) === path.resolve(record.worktreePath))) {
      return fail("another live attempt claims the workspace");
    }
  }

  try { assertWorktreeBelongsToProject(commandRunner, record, args); }
  catch (error) { return fail(detailOf(error)); }

  const closed = safeCall(() => runner.closeWorkspace(record.workspaceId));
  if ("detail" in closed) return fail(closed.detail);
  const after = safeCall(() => runner.listWorkspaces());
  if ("detail" in after) return fail(after.detail);
  if (after.value.some((workspace) => workspace.workspaceId === record.workspaceId)) {
    return fail("workspace remained open after the close");
  }
  recordReceipt(runDir, record, "closed", "");
  return { closed: true };
}

module.exports = { closeSettledAttemptWorkspace, readSettledWorkspaceCleanupReceipt, recordSettledWorkspaceCleanupReceipt: recordReceipt };
