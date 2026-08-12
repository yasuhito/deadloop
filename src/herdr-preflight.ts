import { execFileSync, spawnSync } from "node:child_process";

import {
  type Herdr075CompatibilityObservation,
  compatibilityDiagnosticData,
  formatCompatibilityDiagnostic,
  parseHerdr075Compatibility,
} from "./herdr-075-compat";

export type HerdrPreflightOps = {
  run(command: string, args: string[]): string;
};

export type HerdrProbeResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  errorMessage: string;
};

export type HerdrReachabilityOps = {
  probe(command: string, args: string[]): HerdrProbeResult;
};

// Failures the runtime reports when its server is not answering. Anything else is a failure this
// host must not read as an unreachable runtime.
const UNREACHABLE_SERVER =
  /connection refused|cannot connect|failed to connect|unreachable|timed? out|no such file|no such socket|socket.*not found/;

function spawnProbe(command: string, args: string[]): HerdrProbeResult {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    errorMessage: String(result.error?.message || ""),
  };
}

/**
 * Whether a compatible local client sees no reachable runtime server. The caller may then expose
 * the stopped work on GitHub; it opens no candidate, launch, completion, push, ready, or merge path.
 */
export function herdrServerIsUnreachableWithCompatibleClient(
  ops: HerdrReachabilityOps = { probe: spawnProbe },
): boolean {
  const client = ops.probe("herdr", ["--version"]);
  if (client.status !== 0 || client.errorMessage) return false;
  try {
    parseHerdr075Compatibility(client.stdout, "version: 0.7.5\ncompatible: yes\n");
  } catch { return false; }
  const server = ops.probe("herdr", ["status", "server"]);
  if (server.status === 0 && !server.errorMessage) return false;
  return UNREACHABLE_SERVER.test(`${server.errorMessage}\n${server.stderr}\n${server.stdout}`.toLowerCase());
}

export function runHerdrCompatibilityPreflight(
  ops: HerdrPreflightOps = {
    run: (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 10_000 }),
  },
): { clientVersion: string; serverVersion: string } {
  let clientText = "";
  let serverText = "";
  try {
    clientText = ops.run("herdr", ["--version"]);
    serverText = ops.run("herdr", ["status", "server"]);
    return parseHerdr075Compatibility(clientText, serverText);
  } catch (error) {
    let observation: Herdr075CompatibilityObservation;
    try {
      const client = /^herdr (\S+)$/.exec(clientText.trim())?.[1];
      const server = /^version: (\S+)$/m.exec(serverText)?.[1];
      observation = client && server
        ? { clientVersion: client, serverVersion: server }
        : { probeFailure: error instanceof Error ? error.message : String(error) };
    } catch {
      observation = { probeFailure: "unknown compatibility probe failure" };
    }
    throw new Error(formatCompatibilityDiagnostic(compatibilityDiagnosticData(observation)), { cause: error });
  }
}
