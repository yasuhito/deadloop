import { execFileSync } from "node:child_process";

import {
  type Herdr075CompatibilityObservation,
  compatibilityDiagnosticData,
  formatCompatibilityDiagnostic,
  parseHerdr075Compatibility,
} from "./herdr-075-compat";

export type HerdrPreflightOps = {
  run(command: string, args: string[]): string;
};

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
