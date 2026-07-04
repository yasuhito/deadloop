import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

describe("GitHub Actions CI workflow", () => {
  it("runs on pull requests", () => {
    expect(workflow).toMatch(/pull_request:/);
  });

  it("runs on pushes to main", () => {
    expect(workflow).toMatch(/push:[\s\S]*branches:[\s\S]*- main/);
  });

  it("runs npm test", () => {
    expect(workflow).toContain("npm test");
  });

  it("runs shell syntax checks", () => {
    expect(workflow).toContain("bash -n extensions/pi-looper/automations/*.sh");
  });

  it("runs Python compile checks", () => {
    expect(workflow).toContain("python3 -m py_compile extensions/pi-looper/automations/*.py");
  });

  it("runs npm pack dry run", () => {
    expect(workflow).toContain("npm pack --dry-run");
  });
});
