import { describe, expect, it } from "vitest";

import { decideCodeIdentity, observeGitCodeIdentity } from "../src/code-identity";

describe("Automation host code identity", () => {
  it("continues when the loaded and deployed identities match", () => {
    expect(decideCodeIdentity({ loadedIdentity: "a".repeat(40), deployedIdentity: "a".repeat(40) }).action).toBe("continue");
  });

  it("stops when the deployed identity differs from the loaded identity", () => {
    expect(decideCodeIdentity({ loadedIdentity: "a".repeat(40), deployedIdentity: "b".repeat(40) }).action).toBe("stop");
  });

  it("explains that reload restores a stopped host", () => {
    expect(decideCodeIdentity({ loadedIdentity: "a".repeat(40), deployedIdentity: "b".repeat(40) }).recovery).toContain("/reload");
  });

  it("does not inspect uncommitted changes when observing the deployed identity", () => {
    const commands: string[][] = [];
    observeGitCodeIdentity("/package", {
      realpath: (value) => value,
      runGit: (args) => {
        commands.push(args);
        return "a".repeat(40);
      },
    });

    expect(commands).toEqual([["-C", "/package", "rev-parse", "HEAD^{commit}"]]);
  });

  it("keeps the decision independent of the identity observation source", () => {
    const decideFrom = (observeDeployedIdentity: () => string) => decideCodeIdentity({
      loadedIdentity: "a".repeat(40),
      deployedIdentity: observeDeployedIdentity(),
    });

    expect(decideFrom(() => "b".repeat(40))).toEqual(decideFrom(() => "b".repeat(40)));
  });
});
