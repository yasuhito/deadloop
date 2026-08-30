/**
 * The stop codes a person can act on.
 *
 * Deadloop publishes one code per stop, and every code names exactly one operation. A stop that
 * could end in two different operations is split before it is published: the code decides the next
 * action, and the stop comment carries the cause as prose. Diagnostic-only and internal decision
 * vocabularies (monitor directives, journal release evidence, doctor findings) are not stop codes;
 * they decide deadloop's own next move or record evidence, and never ask a person to choose.
 */
type StopCode = "add_request" | "free_storage" | "fix_environment" | "fix_verification_policy" | "wait";

const STOP_CODE_ACTIONS: Record<StopCode, string> = {
  add_request: "Inspect the retained attempt evidence, then add a new Agent request for the work you still want.",
  free_storage: "Free up storage on the machine running deadloop, then add a new Agent request once storage is available.",
  fix_environment: "Repair the local environment problem the stop comment names (checkout, worktree, workspace, or branch conflict), then add a new Agent request.",
  fix_verification_policy: "Resolve the required-verification policy or trusted base, run /deadloop-enable, then requeue with the command /deadloop-doctor prints.",
  wait: "Take no action; deadloop resumes this work automatically.",
};

function isStopCode(value: unknown): value is StopCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STOP_CODE_ACTIONS, value);
}

function stopCodeAction(code: StopCode): string {
  return STOP_CODE_ACTIONS[code];
}

/** The codes an agent may name in a blocked completion report: every one maps to one human action. */
const WORKER_STOP_CODES: StopCode[] = ["add_request", "free_storage", "fix_environment", "fix_verification_policy"];

module.exports = { STOP_CODE_ACTIONS, WORKER_STOP_CODES, isStopCode, stopCodeAction };
