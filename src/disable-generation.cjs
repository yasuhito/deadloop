const fs = require("node:fs");
const path = require("node:path");
const { acquireLockSync, releaseOwned } = require("./enablement-lock.cjs");

function generationPath(stateDir) {
  return path.join(stateDir, "disable-generation.json");
}

function loadDisableGenerations(stateDir) {
  const file = generationPath(stateDir);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const generation = value?.generation;
    const generations = value?.generations ?? {};
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || !Number.isSafeInteger(generation)
      || generation < 0
      || !generations
      || typeof generations !== "object"
      || Array.isArray(generations)
      || Object.values(generations).some((entry) => typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)
    ) throw new Error("schema is invalid");
    return { generation, generations };
  } catch (error) {
    if (error?.code === "ENOENT") return { generation: 0, generations: {} };
    throw new Error(`disable generation state is invalid at ${file}: ${error?.message || error}. Inspect and move the file aside, then retry the command to recover.`);
  }
}

function disableGenerationForRepo(state, repoPath) {
  return state.generations[path.resolve(repoPath)] ?? state.generation;
}

function currentDisableGeneration(stateDir, repoPath) {
  return disableGenerationForRepo(loadDisableGenerations(stateDir), repoPath);
}

function advanceDisableGeneration(stateDir, repoPath, writeJsonFile) {
  const file = generationPath(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = acquireLockSync(`${file}.lock`, {
    busyMessage: "disable generation state is busy",
  });
  try {
    const state = loadDisableGenerations(stateDir);
    const resolvedRepoPath = path.resolve(repoPath);
    const generation = disableGenerationForRepo(state, resolvedRepoPath) + 1;
    writeJsonFile(file, {
      generation: state.generation,
      generations: { ...state.generations, [resolvedRepoPath]: generation },
    });
    return generation;
  } finally {
    releaseOwned(lock.lockPath, lock.token);
  }
}

module.exports = {
  advanceDisableGeneration,
  currentDisableGeneration,
  disableGenerationForRepo,
  loadDisableGenerations,
};
