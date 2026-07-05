// @ts-check
//
// Agent launch profiles — the single source of truth for how each agent kind
// (pi / claude) is launched. `src/core.ts` derives the workerAgent enum from
// AGENT_KINDS, and `extensions/pi-looper/automations/launch-agent.ts` builds the
// launch argv from AGENT_PROFILES. See docs/adr/0004-agent-launcher.md.
//
// Authored as CommonJS + JSDoc (not an ESM `.ts`) so the launcher can be run by
// bare `node` with no build step: node's type stripping only removes type
// annotations, it does not rewrite module syntax, so an ESM `.ts` cannot be
// loaded under this `type: commonjs` package. This is the JS + JSDoc launcher
// fallback the ADR sanctions. core.ts / doctor.ts / tests still import it with
// full types via the JSDoc typedefs below.

/** @typedef {"pi" | "claude"} AgentKind */
/** @typedef {"file-ref" | "file-contents"} PromptMode */

/**
 * @typedef {Object} AgentProfile
 * @property {string} command                                  Launched CLI binary.
 * @property {{ flag: string, source: "name" | "uuid" }} identity  Session identity flag and where its value comes from.
 * @property {string} levelFlag                                Launch-policy level flag name (level tokens map through unchanged).
 * @property {string} modelFlag                                Operator model flag name (omitted when the model is empty).
 * @property {string[]} permissionArgs                         Extra permission flags, in order.
 * @property {PromptMode} prompt                               How the prompt reaches the CLI: `@file` reference or file contents as a positional arg.
 * @property {string[]} preconditions                          Preconditions the launcher fail-fast checks before starting.
 */

/** @type {Record<AgentKind, AgentProfile>} */
const AGENT_PROFILES = {
  pi: {
    command: "pi",
    identity: { flag: "--name", source: "name" },
    levelFlag: "--thinking",
    modelFlag: "--model",
    permissionArgs: [],
    prompt: "file-ref",
    preconditions: [],
  },
  claude: {
    command: "claude",
    identity: { flag: "--session-id", source: "uuid" },
    levelFlag: "--effort",
    modelFlag: "--model",
    permissionArgs: ["--permission-mode", "bypassPermissions"],
    prompt: "file-contents",
    preconditions: ["workspaceTrust"],
  },
};

/** @type {AgentKind[]} */
const AGENT_KINDS = /** @type {AgentKind[]} */ (Object.keys(AGENT_PROFILES));

/**
 * @param {unknown} value
 * @returns {value is AgentKind}
 */
function isAgentKind(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AGENT_PROFILES, value);
}

/**
 * @typedef {Object} LaunchContext
 * @property {AgentKind} agent
 * @property {string} name                Herdr agent name, used as the pi session identity.
 * @property {string} level              Launch-policy level token (low / medium / high).
 * @property {string} [model]            Operator model; the model flag is omitted when this is empty.
 * @property {string} [uuid]             Session uuid, used as the claude session identity.
 * @property {string} promptFile         Prompt file path, referenced as `@<promptFile>` for file-ref agents.
 * @property {string} promptText         Prompt file contents, passed as a positional arg for file-contents agents.
 */

/**
 * Build the agent CLI argv — the part after `herdr agent start <name> ... --`.
 * @param {LaunchContext} ctx
 * @returns {string[]}
 */
function buildAgentArgv(ctx) {
  if (!isAgentKind(ctx.agent)) throw new Error(`unknown agent: ${String(ctx.agent)}`);
  const profile = AGENT_PROFILES[ctx.agent];

  const identityValue = profile.identity.source === "uuid" ? ctx.uuid : ctx.name;
  if (!identityValue) {
    const missing = profile.identity.source === "uuid" ? "uuid" : "name";
    throw new Error(`agent ${ctx.agent} requires ${missing} for ${profile.identity.flag}`);
  }

  const argv = [profile.command, profile.identity.flag, identityValue, profile.levelFlag, ctx.level];
  if (ctx.model) argv.push(profile.modelFlag, ctx.model);
  argv.push(...profile.permissionArgs);
  argv.push(profile.prompt === "file-contents" ? ctx.promptText : `@${ctx.promptFile}`);
  return argv;
}

module.exports = { AGENT_PROFILES, AGENT_KINDS, isAgentKind, buildAgentArgv };
