export type RequiredVerificationSourceKind = "local" | "repo_policy";

export type RequiredVerificationSource = {
  kind: RequiredVerificationSourceKind;
  location: string;
  command: string;
};

export type RequiredVerificationSourceIdentity = Omit<RequiredVerificationSource, "command">;

export type RequiredVerificationContract = {
  repository: string;
  command: string;
  source: RequiredVerificationSourceIdentity;
  baseRevision: string;
  override?: {
    source: RequiredVerificationSourceIdentity;
    command: string;
  };
};

export type RequiredVerificationBlockReason = "source_conflict" | "no_source" | "zero_targets" | "missing_base_revision";

export type RequiredVerificationResolution =
  | { status: "resolved"; contract: RequiredVerificationContract }
  | {
      status: "blocked";
      reason: RequiredVerificationBlockReason;
      repository: string;
      baseRevision: string;
      sources: RequiredVerificationSource[];
    };

export type RequiredVerificationResolutionInput = {
  repository: string;
  baseRevision: string;
  localSources: RequiredVerificationSource[];
  sharedSources: RequiredVerificationSource[];
};

function identity(source: RequiredVerificationSource): RequiredVerificationSourceIdentity {
  return { kind: source.kind, location: source.location };
}

function blocked(
  input: RequiredVerificationResolutionInput,
  reason: RequiredVerificationBlockReason,
): RequiredVerificationResolution {
  return {
    status: "blocked",
    reason,
    repository: input.repository,
    baseRevision: input.baseRevision,
    sources: [...input.localSources, ...input.sharedSources],
  };
}

function hasDifferentCommands(sources: RequiredVerificationSource[]): boolean {
  return new Set(sources.map((source) => source.command)).size > 1;
}

export function resolveRequiredVerification(
  input: RequiredVerificationResolutionInput,
): RequiredVerificationResolution {
  if (hasDifferentCommands(input.localSources) || hasDifferentCommands(input.sharedSources)) {
    return blocked(input, "source_conflict");
  }

  const selected = input.localSources[0] || input.sharedSources[0];
  if (!selected) return blocked(input, "no_source");
  if (!selected.command.trim()) return blocked(input, "zero_targets");
  if (input.sharedSources.length && (!input.baseRevision.trim() || input.baseRevision === "unknown")) {
    return blocked(input, "missing_base_revision");
  }

  const replaced = input.localSources.length ? input.sharedSources[0] : undefined;
  return {
    status: "resolved",
    contract: {
      repository: input.repository,
      command: selected.command,
      source: identity(selected),
      baseRevision: input.baseRevision,
      ...(replaced && replaced.command !== selected.command
        ? { override: { source: identity(replaced), command: replaced.command } }
        : {}),
    },
  };
}

function quotedCommand(value: string): string {
  return JSON.stringify(value);
}

export function formatRequiredVerification(resolution: RequiredVerificationResolution): string {
  if (resolution.status === "blocked") {
    const sources = resolution.sources.length
      ? resolution.sources
        .map((source) => `${source.kind}:${source.location}=${quotedCommand(source.command)}`)
        .join(",")
      : "none";
    return `requiredVerification: blocked; reason=${resolution.reason}; baseRevision=${resolution.baseRevision}; sources=${sources}`;
  }

  const { contract } = resolution;
  const override = contract.override
    ? `${contract.override.source.kind}:${contract.override.source.location}=${quotedCommand(contract.override.command)}`
    : "none";
  return `requiredVerification: resolved; command=${quotedCommand(contract.command)}; source=${contract.source.kind}:${contract.source.location}; baseRevision=${contract.baseRevision}; override=${override}`;
}
