import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normalizeProject } from "../src/core";
import { resolveActiveProject } from "../src/status";

const fixture = JSON.parse(readFileSync("test/fixtures/status/report-case.json", "utf8"));
const projects = fixture.projects.map(normalizeProject);


describe("deadloop status report", () => {
  it("resolves the active project only from the exact repository top-level", () => {
    expect(resolveActiveProject("/home/yasuhito/Work/deadloop", projects)?.id).toBe("deadloop");
  });

  it("does not select a parent project from a nested repository root", () => {
    expect(resolveActiveProject("/home/yasuhito/Work/deadloop/vendor/nested", projects)).toBeNull();
  });

});
