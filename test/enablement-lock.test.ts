import { describe, expect, it } from "vitest";

const { processStartIdentity } = require("../src/enablement-lock.cjs");

function unavailableProc(): never {
  throw new Error("/proc unavailable");
}

describe("portable enablement lock identity", () => {
  it("uses ps start time when procfs is unavailable on Unix", () => {
    const identity = processStartIdentity(42, {
      platform: "darwin",
      readFileSync: unavailableProc,
      spawnSync: () => ({ status: 0, stdout: "Mon Mar  2 10:20:30 2026\n" }),
    });

    expect(identity).toBe("darwin:Mon Mar  2 10:20:30 2026");
  });

  it("uses PowerShell start ticks when procfs is unavailable on Windows", () => {
    const identity = processStartIdentity(42, {
      platform: "win32",
      readFileSync: unavailableProc,
      spawnSync: () => ({ status: 0, stdout: "639080148300000000\r\n" }),
    });

    expect(identity).toBe("win32:639080148300000000");
  });
});
