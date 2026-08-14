// Agent scratch areas — untracked directories the launched agent CLI creates
// inside the target worktree for its own bookkeeping. They are neither an
// artifact of the target repository nor something the operator manages, so the
// gates that ask "does someone else have unsaved work here" do not count them.
//
// One list, read by every gate and by the project-check quarantine. See
// docs/adr/0024-an-agent-scratch-area-is-not-uncommitted-work.md.

/**
 * Directories the agent CLI writes for itself, relative to the worktree root.
 * `.pi/npm` and `.pi/git` exist because deadloop launches pi with `--approve`,
 * which trusts the project and makes pi install its project packages there.
 */
const AGENT_SCRATCH_AREAS = [".pi/subagents", ".pi/npm", ".pi/git"];

/**
 * The status form every gate shares. `--untracked-files=all` is required: git
 * collapses a fully untracked directory to a single line, which cannot be told
 * apart from a shared project resource stored beside a scratch area.
 */
const UNCOMMITTED_WORK_STATUS_ARGS = ["status", "--porcelain", "--untracked-files=all"];

const SCRATCH_AREA_LINE = new RegExp(
  `^\\?\\? "?(?:${AGENT_SCRATCH_AREAS.map((area) => area.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})/`,
);

/**
 * Untracked only: a tracked path under a scratch area is work the operator
 * chose to manage, which is exactly what the gates exist to protect.
 */
function isAgentScratchAreaStatusLine(line: string): boolean {
  return SCRATCH_AREA_LINE.test(line);
}

/** The `UNCOMMITTED_WORK_STATUS_ARGS` lines that are somebody's unsaved work. */
function uncommittedWorkLines(status: unknown): string[] {
  return String(status || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .filter((line) => !isAgentScratchAreaStatusLine(line));
}

function hasUncommittedWork(status: unknown): boolean {
  return uncommittedWorkLines(status).length > 0;
}

module.exports = {
  AGENT_SCRATCH_AREAS,
  UNCOMMITTED_WORK_STATUS_ARGS,
  hasUncommittedWork,
  uncommittedWorkLines,
};
