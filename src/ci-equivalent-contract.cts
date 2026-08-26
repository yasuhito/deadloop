// CI-equivalent verification contract resolution (ADR 0030).
//
// The repository owner supplies the complete CI-equivalent command in trusted-base deadloop.json.
// Without an explicit command, a trusted-base npm lockfile plus a package.json scripts.check entry
// establishes the convention `npm ci && npm run check`; otherwise fallback is unavailable. No other
// ecosystem is inferred. An explicit empty command is a configuration error.

/** Pure resolution over already-inspected trusted-base inputs. */
function resolveCiEquivalentContract(input: {
  repoPolicyCiCommand?: unknown;
  npmLockfilePresent?: boolean;
  npmCheckScriptPresent?: boolean;
}): Record<string, any> {
  if (input.repoPolicyCiCommand !== undefined) {
    if (typeof input.repoPolicyCiCommand !== "string") {
      throw new Error("deadloop.json ciEquivalentCommand must be a string");
    }
    const command = input.repoPolicyCiCommand.trim();
    if (!command) {
      throw new Error("deadloop.json ciEquivalentCommand is empty; an explicit empty CI-equivalent command is a configuration error");
    }
    return {
      status: "resolved",
      command,
      derivation: "explicit_repo_policy",
      policySource: { kind: "repo_policy", location: "deadloop.json#ciEquivalentCommand" },
    };
  }
  if (input.npmLockfilePresent && input.npmCheckScriptPresent) {
    return {
      status: "resolved",
      command: "npm ci && npm run check",
      derivation: "npm_convention",
      policySource: { kind: "npm_convention", location: "package-lock.json+package.json#scripts.check" },
    };
  }
  return { status: "unavailable", reason: "no_contract" };
}

/**
 * Inspect the fixed trusted base revision of one repository and resolve its CI-equivalent
 * contract. `git` access is injected so tests can drive real repositories without shelling logic
 * in this module.
 */
function observeTrustedBaseContract(input: {
  projectRepo: string;
  baseRevision: string;
  runText?: (args: string[]) => string;
}): Record<string, any> {
  const run = input.runText
    || ((args: string[]): string => {
      const { execFileSync } = require("node:child_process");
      return execFileSync("git", ["-C", input.projectRepo, ...args], { encoding: "utf8" });
    });
  let repoPolicyCommand: unknown;
  let policyText: string | undefined;
  try {
    policyText = run(["show", `${input.baseRevision}:deadloop.json`]);
  } catch {
    // A missing trusted-base deadloop.json means no repository policy.
    policyText = undefined;
  }
  if (policyText !== undefined) {
    let policy: unknown;
    try {
      policy = JSON.parse(policyText || "{}");
    } catch {
      return { status: "unavailable", reason: "malformed_repo_policy", baseRevision: input.baseRevision };
    }
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      return { status: "unavailable", reason: "malformed_repo_policy", baseRevision: input.baseRevision };
    }
    if (Object.prototype.hasOwnProperty.call(policy, "ciEquivalentCommand")) {
      repoPolicyCommand = (policy as Record<string, unknown>).ciEquivalentCommand;
    }
  }
  const lockfilePresent = gitObjectExists(run, input.baseRevision, "package-lock.json");
  let checkScriptPresent = false;
  try {
    const manifest = JSON.parse(run(["show", `${input.baseRevision}:package.json`]));
    checkScriptPresent = Boolean(
      manifest && typeof manifest === "object"
      && manifest.scripts && typeof manifest.scripts === "object"
      && typeof manifest.scripts.check === "string"
      && manifest.scripts.check.trim(),
    );
  } catch {}
  return { ...resolveCiEquivalentContract({
    ...(repoPolicyCommand !== undefined ? { repoPolicyCiCommand: repoPolicyCommand } : {}),
    npmLockfilePresent: lockfilePresent,
    npmCheckScriptPresent: checkScriptPresent,
  }), baseRevision: input.baseRevision };
}

function gitObjectExists(run: (args: string[]) => string, revision: string, objectPath: string): boolean {
  try {
    run(["cat-file", "-e", `${revision}:${objectPath}`]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { observeTrustedBaseContract, resolveCiEquivalentContract };
