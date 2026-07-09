import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  name: string;
  description: string;
  devDependencies: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
};

describe("package manifest files", () => {
  it("uses the deadloop package name", () => {
    expect(packageJson.name).toBe("deadloop");
  });

  it("describes the public product name", () => {
    expect(packageJson.description).toContain("deadloop");
  });

  it("defines a local lint command", () => {
    expect(packageJson.scripts.lint).toBe(
      "biome check package.json biome.json deadloop.json test/ci-workflow.test.ts test/package-manifest.test.ts tsconfig.json --files-ignore-unknown=true && biome lint src extensions/deadloop/index.ts extensions/deadloop/automations/*.ts test/*.ts --files-ignore-unknown=true",
    );
  });

  it("defines a no-emit typecheck command", () => {
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
  });

  it("uses Biome for lightweight static and formatting checks", () => {
    expect(packageJson.devDependencies["@biomejs/biome"]).toBeDefined();
  });

  it("uses TypeScript for type checking", () => {
    expect(packageJson.devDependencies.typescript).toBeDefined();
  });

  it("includes public setup documentation", () => {
    expect(packageJson.files).toContain("docs/*.md");
  });

  it("includes the example project config", () => {
    expect(packageJson.files).toContain("extensions/deadloop/projects.example.json");
  });

  it("does not include package-local project config", () => {
    expect(packageJson.files).not.toContain("extensions/deadloop/projects.json");
  });
});
