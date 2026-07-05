import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  devDependencies: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
};

describe("package manifest files", () => {
  it("defines a local lint command", () => {
    expect(packageJson.scripts.lint).toBe(
      "biome check package.json biome.json test/ci-workflow.test.ts test/package-manifest.test.ts tsconfig.json --files-ignore-unknown=true && biome lint src extensions/pi-looper/index.ts extensions/pi-looper/automations/launch-agent.ts test/*.ts --files-ignore-unknown=true",
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
    expect(packageJson.files).toContain("extensions/pi-looper/projects.example.json");
  });

  it("does not include package-local project config", () => {
    expect(packageJson.files).not.toContain("extensions/pi-looper/projects.json");
  });
});
