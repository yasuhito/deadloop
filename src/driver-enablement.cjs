const fs = require("node:fs");
const path = require("node:path");

function assertDriverEnabled(project) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(project.stateDir, "enabled-projects.json"), "utf8"));
    const enabled = state.projects.find((candidate) =>
      candidate && candidate.repoPath === path.resolve(project.repoPath) && candidate.githubRepo === project.githubRepo && candidate.enabled !== false,
    );
    if (enabled) return;
  } catch {}
  throw new Error("deadloop is disabled for this repository");
}

module.exports = { assertDriverEnabled };
