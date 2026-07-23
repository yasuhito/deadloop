const { assertEnabled, withEnabledProjectLock } = require("./enabled-operation.cjs");

// A guarded launch can run up to seven sequential 20-second driver commands
// (the GitHub mutation plus worktree, agent cleanup, tab, and start commands).
// Disable must outwait that bounded critical section so it can always record
// revocation after a slow but live launch finishes.
const DISABLE_LOCK_ATTEMPTS = 12_000;
const DISABLE_LOCK_DELAY_MS = 25;

function assertDriverEnabled(project) {
  return assertEnabled(project);
}

function withEnabledDriverLock(project, operation, options) {
  return withEnabledProjectLock(project, operation, options);
}

function withEnabledDriverLaunch(project, mutateWorkflowState, launchAgent, options) {
  return withEnabledProjectLock(project, () => {
    mutateWorkflowState();
    return launchAgent();
  }, options);
}

module.exports = {
  DISABLE_LOCK_ATTEMPTS,
  DISABLE_LOCK_DELAY_MS,
  assertDriverEnabled,
  withEnabledDriverLaunch,
  withEnabledDriverLock,
};
