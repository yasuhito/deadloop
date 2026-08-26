import { describe, expect, it } from "vitest";

const { resolveCiEquivalentContract } = require("../src/ci-equivalent-contract.cts");

describe("CI-equivalent contract resolution", () => {
  it("prefers the explicit trusted-base repository command", () => {
    expect(resolveCiEquivalentContract({
      repoPolicyCiCommand: "make ci",
      npmLockfilePresent: true,
      npmCheckScriptPresent: true,
    })).toMatchObject({ status: "resolved", command: "make ci", derivation: "explicit_repo_policy" });
  });

  it("resolves the npm convention from a lockfile plus scripts.check without explicit configuration", () => {
    expect(resolveCiEquivalentContract({ npmLockfilePresent: true, npmCheckScriptPresent: true }))
      .toMatchObject({ status: "resolved", command: "npm ci && npm run check", derivation: "npm_convention" });
  });

  it("leaves fallback unavailable for a non-npm repository instead of guessing a command", () => {
    expect(resolveCiEquivalentContract({})).toEqual({ status: "unavailable", reason: "no_contract" });
  });

  it("does not infer verification from a lockfile alone", () => {
    expect(resolveCiEquivalentContract({ npmLockfilePresent: true })).toEqual({ status: "unavailable", reason: "no_contract" });
  });

  it("treats an explicit empty repository command as a configuration error", () => {
    expect(() => resolveCiEquivalentContract({ repoPolicyCiCommand: "   " })).toThrow(/configuration error/);
  });
});

describe("trusted-base contract observation", () => {
  function repoWithFiles(files: Record<string, string>): (args: string[]) => string {
    return (args) => {
      if (args[0] === "cat-file") throw new Error("not found");
      const objectPath = args[1].split(":")[1];
      if (!files[objectPath]) throw new Error(`fatal: path '${objectPath}' does not exist`);
      return files[objectPath];
    };
  }

  it("resolves the explicit command from the trusted base deadloop.json", () => {
    const runText = repoWithFiles({
      "deadloop.json": JSON.stringify({ ciEquivalentCommand: "bundle exec rake ci" }),
      "package.json": JSON.stringify({ name: "x" }),
    });
    expect(require("../src/ci-equivalent-contract.cts").observeTrustedBaseContract({
      projectRepo: "/repo",
      baseRevision: "base",
      runText,
    })).toMatchObject({ status: "resolved", command: "bundle exec rake ci" });
  });

  it("reports malformed trusted-base policy as unavailable rather than guessing", () => {
    const runText = repoWithFiles({ "deadloop.json": "{ not json" });
    expect(require("../src/ci-equivalent-contract.cts").observeTrustedBaseContract({
      projectRepo: "/repo",
      baseRevision: "base",
      runText,
    })).toMatchObject({ status: "unavailable", reason: "malformed_repo_policy" });
  });
});
