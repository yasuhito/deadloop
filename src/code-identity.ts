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

const RELOAD_RECOVERY = "Run /reload in this session to load the deployed deadloop code.";

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
