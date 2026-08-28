import { describe, expect, it } from "vitest";

import { decideCodeIdentity, decideCodeReload, observeGitCodeIdentity } from "../src/code-identity";

describe("Automation host code identity", () => {
  it("continues when the loaded and deployed identities match", () => {
    expect(decideCodeIdentity({ loadedIdentity: "a".repeat(40), deployedIdentity: "a".repeat(40) }).action).toBe("continue");
  });

  it("stops when the deployed identity differs from the loaded identity", () => {
    expect(decideCodeIdentity({ loadedIdentity: "a".repeat(40), deployedIdentity: "b".repeat(40) }).action).toBe("stop");
  });

  it("explains that a code reload restores a stopped host", () => {
    expect(decideCodeIdentity({ loadedIdentity: "a".repeat(40), deployedIdentity: "b".repeat(40) }).recovery).toContain("/deadloop-reload");
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

describe("Automation host code reload", () => {
  const changed = decideCodeIdentity({ loadedIdentity: "a".repeat(40), deployedIdentity: "b".repeat(40) });
  const idle = { sessionIdle: true, pendingMessages: false };

  it("continues when the loaded and deployed identities match", () => {
    const identity = decideCodeIdentity({ loadedIdentity: "a".repeat(40), deployedIdentity: "a".repeat(40) });

    expect(decideCodeReload({ identity, requestedFor: null, ...idle }).action).toBe("continue");
  });

  it("requests a reload when the deployed identity differs and the session is idle", () => {
    expect(decideCodeReload({ identity: changed, requestedFor: null, ...idle }).action).toBe("request_reload");
  });

  it("names the deployed identity the reload is requested for", () => {
    const decision = decideCodeReload({ identity: changed, requestedFor: null, ...idle });

    expect(decision.action === "request_reload" && decision.deployedIdentity).toBe("b".repeat(40));
  });

  it("waits without requesting while the session is busy", () => {
    expect(decideCodeReload({ identity: changed, requestedFor: null, sessionIdle: false, pendingMessages: false }).action).toBe("wait");
  });

  it("waits without requesting while messages are pending", () => {
    expect(decideCodeReload({ identity: changed, requestedFor: null, sessionIdle: true, pendingMessages: true }).action).toBe("wait");
  });

  it("stops instead of requesting again for the same deployed identity", () => {
    expect(decideCodeReload({ identity: changed, requestedFor: "b".repeat(40), ...idle }).action).toBe("stop");
  });

  it("requests again when a newer deployed identity appears", () => {
    expect(decideCodeReload({ identity: changed, requestedFor: "c".repeat(40), ...idle }).action).toBe("request_reload");
  });

  it("stops when the deployed identity is unknown", () => {
    const identity = decideCodeIdentity({ loadedIdentity: "a".repeat(40), deployedIdentity: null });

    expect(decideCodeReload({ identity, requestedFor: null, ...idle }).action).toBe("stop");
  });

  it("tells the operator to reload by hand when a requested reload did not take", () => {
    const decision = decideCodeReload({ identity: changed, requestedFor: "b".repeat(40), ...idle });

    expect(decision.action === "stop" && decision.status).toContain("/deadloop-reload");
  });
});
