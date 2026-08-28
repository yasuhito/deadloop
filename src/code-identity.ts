export type CodeIdentityInput = {
  loadedIdentity: string | null;
  deployedIdentity: string | null;
};

export type CodeIdentityDecision = CodeIdentityInput & {
  action: "continue" | "stop";
  reason?: string;
  recovery?: string;
};

export type GitCodeIdentityDependencies = {
  realpath: (value: string) => string;
  runGit: (args: string[]) => string;
};

const RELOAD_RECOVERY = "Run /deadloop-reload in this session to load the deployed deadloop code.";

export function decideCodeIdentity(input: CodeIdentityInput): CodeIdentityDecision {
  if (input.loadedIdentity && input.deployedIdentity && input.loadedIdentity === input.deployedIdentity) {
    return { ...input, action: "continue" };
  }
  const reason = !input.loadedIdentity
    ? "the loaded deadloop code identity could not be determined"
    : !input.deployedIdentity
      ? "the deployed deadloop code identity could not be determined"
      : "the loaded deadloop code identity differs from the deployed code identity";
  return { ...input, action: "stop", reason, recovery: RELOAD_RECOVERY };
}

export function observeGitCodeIdentity(
  checkoutPath: string,
  dependencies: GitCodeIdentityDependencies,
): string {
  const checkout = dependencies.realpath(checkoutPath);
  const identity = dependencies.runGit(["-C", checkout, "rev-parse", "HEAD^{commit}"]).trim();
  if (!/^[0-9a-f]{40}$/i.test(identity)) throw new Error("deadloop checkout commit could not be resolved");
  return identity.toLowerCase();
}

export type CodeReloadInput = {
  identity: CodeIdentityDecision;
  /** The deployed identity a reload was already requested for in this extension instance, if any. */
  requestedFor: string | null;
  sessionIdle: boolean;
  pendingMessages: boolean;
};

export type CodeReloadDecision =
  | { action: "continue" }
  | { action: "request_reload"; deployedIdentity: string; status: string }
  | { action: "wait"; status: string }
  | { action: "stop"; status: string };

function shortIdentity(identity: string | null): string {
  return identity ? identity.slice(0, 7) : "unknown";
}

/**
 * Decides whether the Automation host reloads itself to take in deployed code (ADR 0035). A reload
 * is requested once per deployed identity, only while the session is idle; a request that did not
 * take stops the host with a manual recovery step, exactly as ADR 0016 stopped it.
 */
export function decideCodeReload(input: CodeReloadInput): CodeReloadDecision {
  const { identity } = input;
  if (identity.action === "continue") return { action: "continue" };
  const deployed = identity.deployedIdentity;
  const loaded = identity.loadedIdentity;
  if (!deployed || !loaded) return { action: "stop", status: `stopped: ${identity.reason}. ${identity.recovery}` };
  if (input.requestedFor === deployed) {
    return {
      action: "stop",
      status: `stopped: a code reload was requested for ${shortIdentity(deployed)} but ${shortIdentity(loaded)} is still loaded. ${RELOAD_RECOVERY}`,
    };
  }
  if (!input.sessionIdle || input.pendingMessages) {
    return { action: "wait", status: `stopped: ${identity.reason}; waiting for an idle session to reload` };
  }
  return {
    action: "request_reload",
    deployedIdentity: deployed,
    status: `reloading: deployed deadloop code ${shortIdentity(deployed)} differs from loaded ${shortIdentity(loaded)}; requested /deadloop-reload`,
  };
}
