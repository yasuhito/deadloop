import { execFileSync } from "node:child_process";
import {
  type HerdrVersionObservation,
  formatHerdrVersionDiagnostic,
  herdrVersionDiagnosticData,
  parseHerdrVersions,
} from "./herdr-version";

export type HerdrPreflightOps = { run(command: string, args: string[]): string };

export function runHerdrPreflight(
  ops: HerdrPreflightOps = {
    run: (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 10_000 }),
  },
): { clientVersion: string; serverVersion: string } {
  let clientText = "";
  let serverText = "";
  try {
    clientText = ops.run("herdr", ["--version"]);
    serverText = ops.run("herdr", ["status", "server"]);
    return parseHerdrVersions(clientText, serverText);
  } catch (error) {
    const client = /^herdr (\S+)$/.exec(clientText.trim())?.[1];
    const server = /^version: (\S+)$/m.exec(serverText)?.[1];
    const observation: HerdrVersionObservation = client && server
      ? { clientVersion: client, serverVersion: server }
      : { probeFailure: error instanceof Error ? error.message : String(error) };
    throw new Error(formatHerdrVersionDiagnostic(herdrVersionDiagnosticData(observation)), { cause: error });
  }
}
