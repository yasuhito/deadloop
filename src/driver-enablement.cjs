const {
  MAX_GUARDED_OPERATION_MS,
  MAX_ORIGIN_IDENTITIES,
  assertEnabled,
  withEnabledProjectLock,
} = require("./enabled-operation.cjs");

// Authorization runs two bounded Git commands and at most one bounded GitHub
// lookup per distinct supported origin identity. A guarded launch can then run
// up to seven sequential 20-second driver commands (the GitHub mutation plus
// worktree, agent cleanup, tab, and start commands). Include one extra guarded
// timeout as scheduling margin so disable always outwaits a slow live launch.
const DRIVER_COMMAND_TIMEOUT_MS = 20_000;
const MAX_DRIVER_LAUNCH_COMMANDS = 7;
const MAX_DRIVER_REVALIDATION_MS = 25_000;
const MAX_GUARDED_LAUNCH_DURATION_MS =
  (2 + MAX_ORIGIN_IDENTITIES + 1) * MAX_GUARDED_OPERATION_MS
  + MAX_DRIVER_REVALIDATION_MS
  + MAX_DRIVER_LAUNCH_COMMANDS * DRIVER_COMMAND_TIMEOUT_MS;
const DISABLE_LOCK_DELAY_MS = 25;
const DISABLE_LOCK_ATTEMPTS = Math.ceil(MAX_GUARDED_LAUNCH_DURATION_MS / DISABLE_LOCK_DELAY_MS) + 1;

function assertDriverEnabled(project) {
  return assertEnabled(project);
}

function withEnabledDriverLock(project, operation, options) {
  return withEnabledProjectLock(project, operation, options);
}

function withEnabledDriverLaunch(project, mutateWorkflowState, launchAgent, options = {}) {
  return withEnabledProjectLock(project, () => {
    options.revalidate?.();
    mutateWorkflowState();
    return launchAgent();
  }, options);
}

module.exports = {
  DISABLE_LOCK_ATTEMPTS,
  DISABLE_LOCK_DELAY_MS,
  MAX_DRIVER_REVALIDATION_MS,
  MAX_GUARDED_LAUNCH_DURATION_MS,
  assertDriverEnabled,
  withEnabledDriverLaunch,
  withEnabledDriverLock,
};
