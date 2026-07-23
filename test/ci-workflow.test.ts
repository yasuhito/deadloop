import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
const checkScript = packageJson.scripts.check;

describe("GitHub Actions CI workflow", () => {
  it("runs on pull requests", () => {
    expect(workflow).toMatch(/pull_request:/);
  });

  it("runs on pushes to main", () => {
    expect(workflow).toMatch(/push:[\s\S]*branches:[\s\S]*- main/);
  });

  it("runs the complete project check", () => {
    expect(workflow).toContain("npm run check");
  });

  it("does not bypass the complete project check with a unit-only command", () => {
    expect(workflow).not.toContain("run: npm run test:unit");
  });

  it("runs npm test through the complete check", () => {
    expect(checkScript).toContain("npm test");
  });

  it("runs lint checks through the complete check", () => {
    expect(checkScript).toContain("npm run lint");
  });

  it("runs TypeScript type checks through the complete check", () => {
    expect(checkScript).toContain("npm run typecheck");
  });

  it("runs shell syntax checks through the complete check", () => {
    expect(checkScript).toContain("bash -n extensions/deadloop/automations/*.sh");
  });

  it("does not require Python automation compile checks", () => {
    expect(workflow).not.toContain("python3 -m py_compile extensions/deadloop/automations/*.py");
  });

  it("runs npm pack dry run through the complete check", () => {
    expect(checkScript).toContain("npm pack --dry-run");
  });
});
