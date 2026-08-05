import { describe, expect, it } from "vitest";

import {
  formatRequiredVerification,
  resolveRequiredVerification,
  type RequiredVerificationResolution,
} from "../src/required-verification";

const revision = "a".repeat(40);
const local = (command: string, location = "/state/projects.json#demo") => ({
  kind: "local" as const,
  location,
  command,
});
const shared = (command: string, location = "deadloop.json") => ({
  kind: "repo_policy" as const,
  location,
  command,
});
const resolve = (input: Partial<Parameters<typeof resolveRequiredVerification>[0]> = {}) =>
  resolveRequiredVerification({
    repository: "owner/repo",
    baseRevision: revision,
    localSources: [],
    sharedSources: [],
    ...input,
  });

function resolved(result: RequiredVerificationResolution) {
  if (result.status !== "resolved") throw new Error(`expected resolved, got ${result.reason}`);
  return result.contract;
}

describe("required verification resolution", () => {
  it("prefers an explicit local command over shared policy", () => {
    expect(resolved(resolve({ localSources: [local("npm run local")], sharedSources: [shared("npm run shared")] })).command)
      .toBe("npm run local");
  });

  it("discloses a differing shared command as an override", () => {
    expect(resolved(resolve({ localSources: [local("npm run local")], sharedSources: [shared("npm run shared")] })).override)
      .toEqual({ source: { kind: "repo_policy", location: "deadloop.json" }, command: "npm run shared" });
  });

  it("blocks differing commands at the same priority", () => {
    expect(resolve({ localSources: [local("npm test", "/a"), local("npm run check", "/b")] }))
      .toMatchObject({ status: "blocked", reason: "source_conflict" });
  });

  it("blocks when no explicit source exists", () => {
    expect(resolve()).toMatchObject({ status: "blocked", reason: "no_source" });
  });

  it("blocks an explicitly empty command", () => {
    expect(resolve({ sharedSources: [shared("  ")] })).toMatchObject({ status: "blocked", reason: "zero_targets" });
  });

  it("accepts any non-empty explicit command without guessing its meaning", () => {
    expect(resolved(resolve({ sharedSources: [shared("true")] })).command).toBe("true");
  });

  it("binds the effective command to provenance and the trusted base revision", () => {
    expect(resolved(resolve({ sharedSources: [shared("npm run check")] }))).toEqual({
      repository: "owner/repo",
      command: "npm run check",
      source: { kind: "repo_policy", location: "deadloop.json" },
      baseRevision: revision,
    });
  });

  it("formats resolved provenance identically for every operator surface", () => {
    const result = resolve({ sharedSources: [shared("npm run check")] });
    expect(formatRequiredVerification(result)).toBe(
      `requiredVerification: resolved; command=npm run check; source=repo_policy:deadloop.json; baseRevision=${revision}; override=none`,
    );
  });
});
