export const HERDR_075_MINIMUM_VERSION = "0.7.5";

type Semver = { major: number; minor: number; patch: number };

export class Herdr075CompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Herdr075CompatibilityError";
  }
}

function parseStableSemver(value: string): Semver | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function atLeast(left: Semver, right: Semver): boolean {
  if (left.major !== right.major) return left.major > right.major;
  if (left.minor !== right.minor) return left.minor > right.minor;
  return left.patch >= right.patch;
}

function requireStableVersion(value: string, source: string): Semver {
  const parsed = parseStableSemver(value);
  if (!parsed)
    throw new Herdr075CompatibilityError(`${source} version is not stable Semantic Versioning: ${value || "missing"}`);
  if (!atLeast(parsed, parseStableSemver(HERDR_075_MINIMUM_VERSION)!)) {
    throw new Herdr075CompatibilityError(`${source} version ${value} is below ${HERDR_075_MINIMUM_VERSION}`);
  }
  return parsed;
}

function serverField(text: string, name: string): string | null {
  const lines = text.split(/\r?\n/);
  const matches = lines.filter((line) => new RegExp(`^${name}: (.+)$`).test(line));
  if (matches.length !== 1) return null;
  return matches[0].slice(name.length + 2);
}

export function parseHerdr075Compatibility(
  clientText: string,
  serverText: string,
): { clientVersion: string; serverVersion: string } {
  const client =
    /^herdr ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(
      clientText.trim(),
    );
  if (!client) throw new Herdr075CompatibilityError("Herdr client probe must be exactly 'herdr <semver>'");
  requireStableVersion(client[1], "Herdr client");

  if (/\bprotocol_mismatch\b/.test(serverText)) {
    throw new Herdr075CompatibilityError("Herdr server reports protocol_mismatch");
  }
  const serverVersion = serverField(serverText, "version");
  const compatible = serverField(serverText, "compatible");
  if (!serverVersion) throw new Herdr075CompatibilityError("Herdr server probe has no version");
  if (compatible !== "yes") throw new Herdr075CompatibilityError("Herdr server is not compatible");
  requireStableVersion(serverVersion, "Herdr server");
  return { clientVersion: client[1], serverVersion };
}
