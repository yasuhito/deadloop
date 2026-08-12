import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

export type RequiredVerificationSourceKind = "local" | "repo_policy" | "default";

export type VerificationCandidate = {
  category: "aggregate" | "individual" | "ci_run";
  command: string;
  workingDirectory: string;
  source: {
    kind: "package_manifest" | "github_actions";
    location: string;
  };
  executionContext?: {
    shell?: unknown;
    workflowEnv?: unknown;
    jobEnv?: unknown;
    stepEnv?: unknown;
    matrix?: unknown;
    runsOn?: unknown;
    container?: unknown;
    services?: unknown;
    setupSteps?: Array<{ uses: unknown; with?: unknown }>;
  };
};

export type VerificationCandidateDiscovery =
  | { status: "found"; candidates: VerificationCandidate[]; inspectedSources: string[] }
  | { status: "none"; inspectedSources: string[] }
  | {
      status: "error";
      reason: "manifest_parse_error" | "workflow_parse_error" | "filesystem_error";
      source: string;
      message: string;
      inspectedSources: string[];
    };

export type VerificationCandidateDiscoveryInput = {
  repositoryRoot: string;
};

export type RequiredVerificationSource = {
  kind: RequiredVerificationSourceKind;
  location: string;
  command: string;
};

export const DEFAULT_REQUIRED_VERIFICATION_COMMAND = "npm run check";
export const DEFAULT_REQUIRED_VERIFICATION_SOURCE: RequiredVerificationSource = {
  kind: "default",
  location: "deadloop",
  command: DEFAULT_REQUIRED_VERIFICATION_COMMAND,
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

export type RequiredVerificationBlockReason = "source_conflict" | "zero_targets" | "missing_base_revision";

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
  sources: RequiredVerificationSource[] = [...input.localSources, ...input.sharedSources],
): RequiredVerificationResolution {
  return {
    status: "blocked",
    reason,
    repository: input.repository,
    baseRevision: input.baseRevision,
    sources,
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

  const selected = input.localSources[0] || input.sharedSources[0] || DEFAULT_REQUIRED_VERIFICATION_SOURCE;
  if (!selected.command.trim()) return blocked(input, "zero_targets");
  if (!input.baseRevision.trim() || input.baseRevision === "unknown") {
    const sources = selected.kind === "default"
      ? [DEFAULT_REQUIRED_VERIFICATION_SOURCE]
      : [...input.localSources, ...input.sharedSources];
    return blocked(input, "missing_base_revision", sources);
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

const AGGREGATE_PACKAGE_SCRIPTS = new Set(["check", "verify", "validate", "ci"]);
const INDIVIDUAL_PACKAGE_SCRIPT = /^(?:test|lint|typecheck|type-check)(?::|$)/;

function discoveryError(
  reason: "manifest_parse_error" | "workflow_parse_error" | "filesystem_error",
  source: string,
  error: unknown,
  inspectedSources: string[],
): VerificationCandidateDiscovery {
  return {
    status: "error",
    reason,
    source,
    message: error instanceof Error ? error.message : String(error),
    inspectedSources,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalExecutionContext(context: NonNullable<VerificationCandidate["executionContext"]>) {
  return Object.values(context).some((value) => value !== undefined) ? { executionContext: context } : {};
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function workflowCandidates(text: string, location: string): VerificationCandidate[] {
  const workflow = parseYaml(text, { uniqueKeys: true });
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new Error("workflow has no jobs mapping");
  const workflowDefaults = isRecord(workflow.defaults) && isRecord(workflow.defaults.run) ? workflow.defaults.run : {};
  const candidates: VerificationCandidate[] = [];

  for (const [jobId, rawJob] of Object.entries(workflow.jobs)) {
    if (!isRecord(rawJob)) throw new Error(`jobs.${jobId} must be a mapping`);
    if (rawJob.steps === undefined) continue;
    if (!Array.isArray(rawJob.steps)) throw new Error(`jobs.${jobId}.steps must be a sequence`);
    const steps = rawJob.steps;
    const jobDefaults = isRecord(rawJob.defaults) && isRecord(rawJob.defaults.run) ? rawJob.defaults.run : {};

    steps.forEach((rawStep, stepIndex) => {
      if (!isRecord(rawStep)) throw new Error(`jobs.${jobId}.steps[${stepIndex}] must be a mapping`);
      if (rawStep.run === undefined) return;
      if (typeof rawStep.run !== "string" || !rawStep.run.trim()) {
        throw new Error(`jobs.${jobId}.steps[${stepIndex}].run must be a non-empty string`);
      }
      const workingDirectory = optionalString(
        rawStep["working-directory"] ?? jobDefaults["working-directory"] ?? workflowDefaults["working-directory"],
        `jobs.${jobId}.steps[${stepIndex}].working-directory`,
      ) || ".";
      const shell = rawStep.shell ?? jobDefaults.shell ?? workflowDefaults.shell;
      const strategy = isRecord(rawJob.strategy) ? rawJob.strategy : {};
      const setupSteps = steps.slice(0, stepIndex).flatMap((priorStep) => {
        if (!isRecord(priorStep) || priorStep.uses === undefined) return [];
        return [{ uses: priorStep.uses, ...(priorStep.with !== undefined ? { with: priorStep.with } : {}) }];
      });
      const executionContext: NonNullable<VerificationCandidate["executionContext"]> = {
        ...(shell !== undefined ? { shell } : {}),
        ...(workflow.env !== undefined ? { workflowEnv: workflow.env } : {}),
        ...(rawJob.env !== undefined ? { jobEnv: rawJob.env } : {}),
        ...(rawStep.env !== undefined ? { stepEnv: rawStep.env } : {}),
        ...(strategy.matrix !== undefined ? { matrix: strategy.matrix } : {}),
        ...(rawJob["runs-on"] !== undefined ? { runsOn: rawJob["runs-on"] } : {}),
        ...(rawJob.container !== undefined ? { container: rawJob.container } : {}),
        ...(rawJob.services !== undefined ? { services: rawJob.services } : {}),
        ...(setupSteps.length ? { setupSteps } : {}),
      };
      candidates.push({
        category: "ci_run",
        command: rawStep.run,
        workingDirectory,
        source: { kind: "github_actions", location: `${location}#jobs.${jobId}.steps[${stepIndex}].run` },
        ...optionalExecutionContext(executionContext),
      });
    });
  }
  return candidates;
}

export function discoverVerificationCandidates(
  input: VerificationCandidateDiscoveryInput,
): VerificationCandidateDiscovery {
  const candidates: VerificationCandidate[] = [];
  const inspectedSources: string[] = [];
  const manifestLocation = "package.json";
  const manifestPath = path.join(input.repositoryRoot, manifestLocation);
  try {
    const text = fs.readFileSync(manifestPath, "utf8");
    inspectedSources.push(manifestLocation);
    let manifest: unknown;
    try { manifest = JSON.parse(text); }
    catch (error) { return discoveryError("manifest_parse_error", manifestLocation, error, inspectedSources); }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return discoveryError("manifest_parse_error", manifestLocation, "manifest root must be an object", inspectedSources);
    }
    const scripts = (manifest as { scripts?: unknown }).scripts;
    if (scripts !== undefined && (!scripts || typeof scripts !== "object" || Array.isArray(scripts))) {
      return discoveryError("manifest_parse_error", manifestLocation, "scripts must be an object", inspectedSources);
    }
    for (const [name, value] of Object.entries((scripts || {}) as Record<string, unknown>)) {
      const category = AGGREGATE_PACKAGE_SCRIPTS.has(name)
        ? "aggregate"
        : INDIVIDUAL_PACKAGE_SCRIPT.test(name) ? "individual" : null;
      if (!category || typeof value !== "string" || !value.trim()) continue;
      candidates.push({
        category,
        command: `npm run ${name}`,
        workingDirectory: ".",
        source: { kind: "package_manifest", location: `package.json#scripts.${name}` },
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return discoveryError("filesystem_error", manifestLocation, error, inspectedSources);
    }
  }

  const workflowsDirectory = path.join(input.repositoryRoot, ".github", "workflows");
  let workflowNames: string[] = [];
  try {
    workflowNames = fs.readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/i.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return discoveryError("filesystem_error", ".github/workflows", error, inspectedSources);
    }
  }
  for (const name of workflowNames) {
    const location = path.posix.join(".github/workflows", name);
    inspectedSources.push(location);
    let text: string;
    try {
      text = fs.readFileSync(path.join(workflowsDirectory, name), "utf8");
    } catch (error) {
      return discoveryError("filesystem_error", location, error, inspectedSources);
    }
    try {
      candidates.push(...workflowCandidates(text, location));
    } catch (error) {
      return discoveryError("workflow_parse_error", location, error, inspectedSources);
    }
  }

  return candidates.length ? { status: "found", candidates, inspectedSources } : { status: "none", inspectedSources };
}

export function formatVerificationCandidates(discovery: VerificationCandidateDiscovery): string[] {
  if (discovery.status === "error") {
    return [`verificationCandidates: error; reason=${discovery.reason}; source=${discovery.source}; message=${JSON.stringify(discovery.message)}`];
  }
  if (discovery.status === "none") {
    return [`verificationCandidates: none; inspected=${discovery.inspectedSources.join(",") || "none"}`];
  }
  return [
    `verificationCandidates: found; count=${discovery.candidates.length}`,
    ...discovery.candidates.map((candidate) => {
      const context = candidate.executionContext === undefined
        ? "none"
        : JSON.stringify(candidate.executionContext);
      return `- candidate: category=${candidate.category}; command=${JSON.stringify(candidate.command)}; workingDirectory=${JSON.stringify(candidate.workingDirectory)}; source=${candidate.source.kind}:${candidate.source.location}; executionContext=${context}`;
    }),
  ];
}
