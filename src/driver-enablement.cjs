const { assertEnabled, withEnabledProjectLock } = require("./enabled-operation.cjs");

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

module.exports = { assertDriverEnabled, withEnabledDriverLaunch, withEnabledDriverLock };
