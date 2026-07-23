const fs = require("node:fs");
const path = require("node:path");

const { acquireLockSync, releaseOwned } = require("./enablement-lock.cjs");

function normalizeAutomationState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { automations: {} };
  if (!value.automations || typeof value.automations !== "object" || Array.isArray(value.automations)) {
    return { ...value, automations: {} };
  }
  return value;
}

function loadAutomationState(statePath) {
  try {
    return normalizeAutomationState(JSON.parse(fs.readFileSync(statePath, "utf8")));
  } catch {
    return { automations: {} };
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function saveAutomationState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  const lock = acquireLockSync(lockPath, {
    attempts: 1200,
    delayMs: 25,
    busyMessage: "automation state is busy",
  });
  try {
    const current = loadAutomationState(statePath);
    const merged = {
      ...current,
      ...state,
      automations: {
        ...current.automations,
        ...normalizeAutomationState(state).automations,
      },
    };
    writeJsonFile(statePath, merged);
    return merged;
  } finally {
    releaseOwned(lockPath, lock.token);
  }
}

module.exports = { loadAutomationState, saveAutomationState };
