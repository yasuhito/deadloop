import { describe, expect, it } from "vitest";

const { STOP_CODE_ACTIONS, WORKER_STOP_CODES, isStopCode, stopCodeAction } = require("../src/stop-codes.cts");

describe("stop codes", () => {
  it("maps add_request to adding a new Agent request", () => {
    expect(stopCodeAction("add_request")).toContain("add a new Agent request");
  });

  it("maps free_storage to freeing storage before re-requesting", () => {
    expect(stopCodeAction("free_storage")).toContain("Free up storage");
  });

  it("maps fix_environment to repairing the named environment problem", () => {
    expect(stopCodeAction("fix_environment")).toContain("Repair the local environment");
  });

  it("maps fix_verification_policy to resolving the policy and re-enabling", () => {
    expect(stopCodeAction("fix_verification_policy")).toContain("/deadloop-enable");
  });

  it("maps wait to no action", () => {
    expect(stopCodeAction("wait")).toContain("Take no action");
  });

  it("gives an agent every stop code except the automatic wait", () => {
    expect(WORKER_STOP_CODES).toEqual(["add_request", "free_storage", "fix_environment", "fix_verification_policy"]);
  });

  it("rejects values outside the taxonomy", () => {
    expect(isStopCode("worker_blocked")).toBe(false);
  });

  it("declares exactly the five codes in its action table", () => {
    expect(Object.keys(STOP_CODE_ACTIONS)).toEqual(["add_request", "free_storage", "fix_environment", "fix_verification_policy", "wait"]);
  });
});
