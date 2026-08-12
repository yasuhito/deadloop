import { describe, expect, it } from "vitest";

import { herdrServerIsUnreachableWithCompatibleClient } from "../src/herdr-preflight";

const COMPATIBLE_CLIENT = { status: 0, stdout: "herdr 0.7.5\n", stderr: "", errorMessage: "" };

function probes(client: Record<string, unknown>, server: Record<string, unknown>) {
  return {
    probe: (_command: string, args: string[]) => (args[0] === "--version" ? client : server) as never,
  };
}

describe("Herdr runtime reachability", () => {
  it("reports an unreachable server behind a compatible client", () => {
    expect(herdrServerIsUnreachableWithCompatibleClient(
      probes(COMPATIBLE_CLIENT, { status: 1, stdout: "", stderr: "connection refused\n", errorMessage: "" }),
    )).toBe(true);
  });

  it("reports a running server as reachable", () => {
    expect(herdrServerIsUnreachableWithCompatibleClient(
      probes(COMPATIBLE_CLIENT, { status: 0, stdout: "version: 0.8.0\ncompatible: yes\n", stderr: "", errorMessage: "" }),
    )).toBe(false);
  });

  it("reports a spawn failure of the server probe as unreachable", () => {
    expect(herdrServerIsUnreachableWithCompatibleClient(
      probes(COMPATIBLE_CLIENT, { status: null, stdout: "", stderr: "", errorMessage: "connect ENOENT no such socket" }),
    )).toBe(true);
  });

  it("does not read an unrecognized server failure as unreachable", () => {
    expect(herdrServerIsUnreachableWithCompatibleClient(
      probes(COMPATIBLE_CLIENT, { status: 1, stdout: "", stderr: "permission denied\n", errorMessage: "" }),
    )).toBe(false);
  });

  it("does not classify the runtime when the client itself cannot run", () => {
    expect(herdrServerIsUnreachableWithCompatibleClient(
      probes({ status: 127, stdout: "", stderr: "herdr: not found\n", errorMessage: "" },
        { status: 1, stdout: "", stderr: "connection refused\n", errorMessage: "" }),
    )).toBe(false);
  });

  it("does not classify the runtime when the client is too old", () => {
    expect(herdrServerIsUnreachableWithCompatibleClient(
      probes({ status: 0, stdout: "herdr 0.7.4\n", stderr: "", errorMessage: "" },
        { status: 1, stdout: "", stderr: "connection refused\n", errorMessage: "" }),
    )).toBe(false);
  });
});
