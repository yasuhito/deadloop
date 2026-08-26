// @ts-check
//
// Agent launch profiles — the single source of truth for how each agent kind
// (pi / claude / omp) is launched. `src/core.ts` derives the workerAgent enum from
// AGENT_KINDS, and `extensions/deadloop/automations/launch-agent.cts` builds the
// launch argv from AGENT_PROFILES. See docs/adr/0004-agent-launcher.md.
//
// Authored as CommonJS + JSDoc (not an ESM `.ts`) so the launcher can be run by
// bare `node` with no build step: node's type stripping only removes type
// annotations, it does not rewrite module syntax, so an ESM `.ts` cannot be
// loaded under this `type: commonjs` package. This is the JS + JSDoc launcher
// fallback the ADR sanctions. core.ts / doctor.ts / tests still import it with
// full types via the JSDoc typedefs below.

/** @typedef {"pi" | "claude" | "omp"} AgentKind */
/** @typedef {"file-ref" | "file-contents"} PromptMode */

/**
 * @typedef {Object} AgentProfile
 * @property {string} command                                  Launched CLI binary.
 * @property {{ flag: string, source: "name" | "uuid" }} [identity]  Session identity flag and where its value comes from; omitted for a CLI that has none.
 * @property {string} levelFlag                                Launch-policy level flag name (level tokens map through unchanged).
 * @property {string} modelFlag                                Operator model flag name; always emitted because the resolved role model is required.
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
    // deadloop launches only operator-configured repositories in unattended
    // worktrees. Approve project resources for this run so Pi cannot pause on
    // its interactive project-trust dialog.
    permissionArgs: ["--approve"],
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
  omp: {
    command: "omp",
    // omp has no session identity flag: Herdr names the agent through
    // `agent start <NAME>`, so nothing here needs to repeat it.
    levelFlag: "--thinking",
    modelFlag: "--model",
    // Unattended worktrees cannot answer approval prompts.
    permissionArgs: ["--auto-approve"],
    prompt: "file-ref",
    preconditions: [],
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
 * @property {string} [name]            Herdr agent name, used as the pi session identity; unused by a CLI with no identity flag.
 * @property {string} level              Launch-policy level token (low / medium / high).
 * @property {string} model             Resolved operator model for this launch's role; required and never empty.
 * @property {string} [uuid]             Session uuid, used as the claude session identity.
 * @property {string} promptFile         Prompt file path, referenced as `@<promptFile>` for file-ref agents.
 * @property {string} promptText         Prompt file contents, passed as a positional arg for file-contents agents.
 */

/**
 * Build the agent CLI argv — the part after `herdr agent start <name> ... --`.
 * @param {LaunchContext} ctx
 * @returns {string[]}
 */
function buildNativeArgv(ctx) {
  if (!isAgentKind(ctx.agent)) throw new Error(`unknown agent: ${String(ctx.agent)}`);
  const profile = AGENT_PROFILES[ctx.agent];

  const identity = profile.identity;
  const nativeArgv = [];
  if (identity) {
    const identityValue = identity.source === "uuid" ? ctx.uuid : ctx.name;
    if (!identityValue) {
      throw new Error(`agent ${ctx.agent} requires ${identity.source} for ${identity.flag}`);
    }
    nativeArgv.push(identity.flag, identityValue);
  }
  if (!ctx.model || !String(ctx.model).trim()) {
    throw new Error(`agent ${ctx.agent} requires a non-empty resolved model`);
  }
  nativeArgv.push(profile.levelFlag, ctx.level);
  nativeArgv.push(profile.modelFlag, ctx.model);
  nativeArgv.push(...profile.permissionArgs);
  nativeArgv.push(profile.prompt === "file-contents" ? ctx.promptText : `@${ctx.promptFile}`);
  return nativeArgv;
}

/**
 * Build argv after Herdr's `--` separator. Herdr selects the executable
 * through `agent start --kind`, so this intentionally excludes profile.command.
 * Non-Herdr callers may still use buildAgentArgv below.
 * @param {LaunchContext} ctx
 * @returns {string[]}
 */
function buildNativeAgentArgv(ctx) {
  return buildNativeArgv(ctx);
}

/**
 * Build a standalone agent argv including its executable.
 * @param {LaunchContext} ctx
 * @returns {string[]}
 */
function buildAgentArgv(ctx) {
  if (!isAgentKind(ctx.agent)) throw new Error(`unknown agent: ${String(ctx.agent)}`);
  return [AGENT_PROFILES[ctx.agent].command, ...buildNativeAgentArgv(ctx)];
}

module.exports = { AGENT_PROFILES, AGENT_KINDS, isAgentKind, buildAgentArgv, buildNativeAgentArgv };
