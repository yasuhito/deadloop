import { describe, expect, it } from "vitest";

const { createCommandRunner, driverResult, oneLine, parseBool, parseFixtureArg, shellQuote } = require("../src/automation-driver-kit.ts");

describe("automation driver kit", () => {
  it("builds driver result payloads", () => {
    expect(driverResult("done", "ok", { driverAction: "tested" })).toEqual({ action: "done", summary: "ok", driverAction: "tested" });
  });

  it("runs commands as text", () => {
    const runner = createCommandRunner();

    expect(runner.runText(["node", "-e", "process.stdout.write('ok')"])).toBe("ok");
  });

  it("times out a hung launch command", () => {
    const runner = createCommandRunner({ timeoutMs: 50 });

    expect(() => runner.runText(["node", "-e", "setInterval(() => {}, 1000)"])).toThrow("timed out");
  });

  it("normalizes multiline text", () => {
    expect(oneLine("a\n b\t c")).toBe("a b c");
  });

  it("quotes shell arguments", () => {
    expect(shellQuote("a b'c")).toBe(`'a b'"'"'c'`);
  });

  it("parses boolean environment values", () => {
    expect(parseBool("true")).toBe(true);
  });

  it("parses fixture arguments", () => {
    expect(parseFixtureArg(["--fixture", "case.json"])).toEqual({ fixture: "case.json" });
  });
});
