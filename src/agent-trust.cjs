// @ts-check
//
// Claude workspace trust — the shared trust judgment used by both the doctor
// diagnostics (src/doctor.ts) and the launcher (launch-agent.ts). Reading
// ~/.claude.json and deciding whether a workspace is trusted is a deterministic
// check, so it lives here as one function rather than being duplicated.
//
// Authored as CommonJS + JSDoc for the same reason as agent-profiles.cjs: the
// launcher runs under bare `node`. See docs/adr/0004-agent-launcher.md.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** @typedef {{ hasTrustDialogAccepted?: boolean } | null | undefined} ClaudeProjectTrust */
/** @typedef {{ ok: true, projects: Record<string, ClaudeProjectTrust> } | { ok: false }} ClaudeConfigResult */
/** @typedef {"trusted" | "untrusted" | "unknown"} WorkspaceTrust */

/**
 * Read ~/.claude.json into the trust config shape the doctor and launcher share.
 * Returns `{ ok: false }` when the file is missing or unparseable so callers can
 * treat trust as indeterminate rather than confirmed-unmet.
 * @param {string} [homeDir]
 * @returns {ClaudeConfigResult}
 */
function readClaudeConfig(homeDir) {
  const configPath = path.join(homeDir || os.homedir(), ".claude.json");
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(raw);
    const projects = parsed && typeof parsed.projects === "object" && parsed.projects ? parsed.projects : {};
    return { ok: true, projects };
  } catch {
    return { ok: false };
  }
}

/**
 * Judge whether a claude workspace is trusted.
 * - `trusted`: the trust dialog was accepted for this path.
 * - `untrusted`: the config is readable and confirms the path is not trusted.
 * - `unknown`: the config could not be read, so the state is indeterminate.
 * @param {ClaudeConfigResult | undefined} claudeConfig
 * @param {string} repoPath
 * @returns {WorkspaceTrust}
 */
function evaluateWorkspaceTrust(claudeConfig, repoPath) {
  if (!claudeConfig || claudeConfig.ok === false) return "unknown";
  const trust = claudeConfig.projects ? claudeConfig.projects[repoPath] : undefined;
  return trust && trust.hasTrustDialogAccepted === true ? "trusted" : "untrusted";
}

module.exports = { readClaudeConfig, evaluateWorkspaceTrust };
