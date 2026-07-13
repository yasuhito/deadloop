import { describe, expect, it } from "vitest";

import { AGENT_KINDS, buildAgentArgv, isAgentKind } from "../src/agent-profiles.cjs";

describe("agent launch profiles", () => {
  it("derives the supported agent kinds from the profile table", () => {
    expect(AGENT_KINDS).toEqual(["pi", "claude"]);
  });

  it("recognizes a profiled agent kind", () => {
    expect(isAgentKind("claude")).toBe(true);
  });

  it("rejects an unprofiled agent kind", () => {
    expect(isAgentKind("codex")).toBe(false);
  });

  it("builds the pi argv with a file-reference prompt", () => {
    expect(
      buildAgentArgv({
        agent: "pi",
        name: "demo-issue-1-worker",
        level: "medium",
        promptFile: "/wt/.deadloop/prompt.md",
        promptText: "unused",
      }),
    ).toEqual([
      "pi",
      "--name",
      "demo-issue-1-worker",
      "--thinking",
      "medium",
      "--approve",
      "@/wt/.deadloop/prompt.md",
    ]);
  });

  it("approves project trust for unattended pi agents", () => {
    expect(
      buildAgentArgv({ agent: "pi", name: "w", level: "low", promptFile: "/p", promptText: "" }),
    ).toContain("--approve");
  });

  it("builds the claude argv with a positional prompt payload", () => {
    expect(
      buildAgentArgv({
        agent: "claude",
        name: "demo-issue-1-worker",
        level: "high",
        uuid: "11111111-1111-1111-1111-111111111111",
        promptFile: "/wt/.deadloop/prompt.md",
        promptText: "実装してください",
      }),
    ).toEqual([
      "claude",
      "--session-id",
      "11111111-1111-1111-1111-111111111111",
      "--effort",
      "high",
      "--permission-mode",
      "bypassPermissions",
      "実装してください",
    ]);
  });

  it("omits the model flag when the model is empty", () => {
    expect(
      buildAgentArgv({ agent: "pi", name: "w", level: "low", model: "", promptFile: "/p", promptText: "" }),
    ).not.toContain("--model");
  });

  it("includes the pi model flag when a model is set", () => {
    expect(
      buildAgentArgv({
        agent: "pi",
        name: "w",
        level: "low",
        model: "anthropic/claude-opus-4-8",
        promptFile: "/p",
        promptText: "",
      }),
    ).toContain("anthropic/claude-opus-4-8");
  });

  it("maps the pi level onto the --thinking flag", () => {
    expect(buildAgentArgv({ agent: "pi", name: "w", level: "low", promptFile: "/p", promptText: "" })).toContain(
      "--thinking",
    );
  });

  it("maps the claude level onto the --effort flag", () => {
    expect(
      buildAgentArgv({ agent: "claude", name: "w", level: "low", uuid: "u", promptFile: "/p", promptText: "x" }),
    ).toContain("--effort");
  });

  it("threads the uuid into the claude session id", () => {
    expect(
      buildAgentArgv({ agent: "claude", name: "w", level: "low", uuid: "abc-uuid", promptFile: "/p", promptText: "x" }),
    ).toContain("abc-uuid");
  });

  it("throws when the agent kind is unknown", () => {
    expect(() =>
      buildAgentArgv({
        // @ts-expect-error deliberately unknown agent kind
        agent: "codex",
        name: "w",
        level: "low",
        promptFile: "/p",
        promptText: "",
      }),
    ).toThrow(/unknown agent/);
  });

  it("throws when the claude session uuid is missing", () => {
    expect(() =>
      buildAgentArgv({ agent: "claude", name: "w", level: "low", promptFile: "/p", promptText: "x" }),
    ).toThrow(/uuid/);
  });
});
