export const HERDR_MINIMUM_VERSION = "0.8.0";
export const HERDR_UPDATE_COMMAND = "herdr update --handoff";
export const HERDR_QUIET_AUTOMATIONS_INSTRUCTION = "Quiet active deadloop automations";

type Semver = { major: number; minor: number; patch: number };

export type HerdrVersionObservation =
  | { clientVersion: string; serverVersion: string; probeFailure?: never }
  | { probeFailure: string; clientVersion?: never; serverVersion?: never };

export type HerdrVersionDiagnostic = HerdrVersionObservation & {
  minimumVersion: typeof HERDR_MINIMUM_VERSION;
  updateCommand: typeof HERDR_UPDATE_COMMAND;
  quietAutomationsInstruction: typeof HERDR_QUIET_AUTOMATIONS_INSTRUCTION;
};

export function herdrVersionDiagnosticData(observation: HerdrVersionObservation): HerdrVersionDiagnostic {
  return {
    ...observation,
    minimumVersion: HERDR_MINIMUM_VERSION,
    updateCommand: HERDR_UPDATE_COMMAND,
    quietAutomationsInstruction: HERDR_QUIET_AUTOMATIONS_INSTRUCTION,
  };
}

export function formatHerdrVersionDiagnostic(diagnostic: HerdrVersionDiagnostic): string {
  const detected = "probeFailure" in diagnostic
    ? `Herdr version probe failed: ${diagnostic.probeFailure}`
    : `Detected Herdr client ${diagnostic.clientVersion} and server ${diagnostic.serverVersion}`;
  return `${detected}; minimum required version is ${diagnostic.minimumVersion}. ${diagnostic.quietAutomationsInstruction}, then run \`${diagnostic.updateCommand}\`.`;
}

export class HerdrVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrVersionError";
  }
}

function stableSemver(value: string): Semver | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

function atLeast(left: Semver, right: Semver): boolean {
  if (left.major !== right.major) return left.major > right.major;
  if (left.minor !== right.minor) return left.minor > right.minor;
  return left.patch >= right.patch;
}

function requireSupportedVersion(value: string, source: string): void {
  const parsed = stableSemver(value);
  if (!parsed) throw new HerdrVersionError(`${source} version is not stable Semantic Versioning: ${value || "missing"}`);
  if (!atLeast(parsed, stableSemver(HERDR_MINIMUM_VERSION)!)) {
    throw new HerdrVersionError(`${source} version ${value} is below ${HERDR_MINIMUM_VERSION}`);
  }
}

function uniqueServerVersion(text: string): string | null {
  const matches = text.split(/\r?\n/).filter((line) => /^version: (.+)$/.test(line));
  return matches.length === 1 ? matches[0].slice("version: ".length) : null;
}

export function parseHerdrVersions(clientText: string, serverText: string): { clientVersion: string; serverVersion: string } {
  const client = /^herdr ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(clientText.trim());
  if (!client) throw new HerdrVersionError("Herdr client probe must be exactly 'herdr <semver>'");
  requireSupportedVersion(client[1], "Herdr client");
  const server = uniqueServerVersion(serverText);
  if (!server) throw new HerdrVersionError("Herdr server probe has no unique version");
  requireSupportedVersion(server, "Herdr server");
  return { clientVersion: client[1], serverVersion: server };
}
