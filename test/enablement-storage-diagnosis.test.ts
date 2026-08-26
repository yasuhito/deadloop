import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { observedStorageExhaustionCode } = require("../src/storage-exhaustion.cjs");
const {
  clearEnablementStorageExhaustion,
  enablementStorageExhaustionPath,
  formatEnablementFailureMessage,
  readEnablementStorageExhaustion,
  recordEnablementStorageExhaustion,
} = require("../src/enablement-storage-diagnosis.cjs");

const stateDirs: string[] = [];

function stateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deadloop-enablement-diagnosis-"));
  stateDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function enospcError() {
  const error: NodeJS.ErrnoException = new Error("ENOSPC: no space left on device, write");
  error.code = "ENOSPC";
  return error;
}

describe("the observed storage-exhaustion judgment", () => {
  it("names ENOSPC when the host error carries that code", () => {
    expect(observedStorageExhaustionCode(enospcError())).toBe("ENOSPC");
  });

  it("names EDQUOT when the host error carries that code", () => {
    expect(observedStorageExhaustionCode({ code: "EDQUOT" })).toBe("EDQUOT");
  });

  it("does not classify a message that merely mentions ENOSPC", () => {
    expect(observedStorageExhaustionCode(new Error("git failed: ENOSPC: no space left on device"))).toBeNull();
  });

  it("does not classify unrelated filesystem codes", () => {
    expect(observedStorageExhaustionCode({ code: "EACCES" })).toBeNull();
  });
});

describe("local enablement storage-exhaustion evidence", () => {
  it("records evidence that reads back unchanged", () => {
    const dir = stateDir();
    recordEnablementStorageExhaustion(dir, { code: "ENOSPC", detail: "write failed", repoPath: "/repos/demo", githubRepo: "owner/demo", observedAt: 5 });
    expect(readEnablementStorageExhaustion(dir)).toMatchObject({ code: "ENOSPC", detail: "write failed", githubRepo: "owner/demo", observedAt: 5 });
  });

  it("reads nothing when no evidence was recorded", () => {
    expect(readEnablementStorageExhaustion(stateDir())).toBeNull();
  });

  it("ignores malformed evidence files", () => {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(enablementStorageExhaustionPath(dir), JSON.stringify({ code: "EACCES" }));
    expect(readEnablementStorageExhaustion(dir)).toBeNull();
  });

  it("clears recorded evidence", () => {
    const dir = stateDir();
    recordEnablementStorageExhaustion(dir, { code: "EDQUOT", detail: "", observedAt: 7 });
    clearEnablementStorageExhaustion(dir);
    expect(readEnablementStorageExhaustion(dir)).toBeNull();
  });

  it("reports recording failure instead of pointing at missing evidence", () => {
    const dir = stateDir();
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "not a directory\n");
    expect(recordEnablementStorageExhaustion(path.join(blocker, "sub"), { code: "ENOSPC", detail: "" }).ok).toBe(false);
  });
});

describe("the enablement failure result message", () => {
  it("reports a storage-exhaustion stop for an observed ENOSPC and records evidence", () => {
    const dir = stateDir();
    const message = formatEnablementFailureMessage(enospcError(), { stateDir: dir, repoPath: "/repos/demo", githubRepo: "owner/demo" });
    expect(message).toContain("enablement stopped because a deterministic host operation ran out of local storage (ENOSPC)");
  });

  it("keeps a generic failure unclassified when only stderr text mentions ENOSPC", () => {
    const message = formatEnablementFailureMessage(new Error("git fetch failed: ENOSPC: no space left on device"), { stateDir: stateDir() });
    expect(message.startsWith("deadloop was not enabled: git fetch failed")).toBe(true);
  });

  it("writes no evidence for an unclassified failure", () => {
    const dir = stateDir();
    formatEnablementFailureMessage(new Error("git fetch failed: EDQUOT exceeded"), { stateDir: dir });
    expect(readEnablementStorageExhaustion(dir)).toBeNull();
  });

  it("points the storage stop at the retained evidence file", () => {
    const dir = stateDir();
    const message = formatEnablementFailureMessage({ code: "EDQUOT", message: "quota exceeded" }, { stateDir: dir });
    expect(message).toContain(`Local evidence: ${enablementStorageExhaustionPath(dir)}`);
  });
});
