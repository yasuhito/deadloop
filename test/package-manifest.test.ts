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
      "biome check package.json biome.json --files-ignore-unknown=true && biome lint src extensions/pi-looper/index.ts test/*.ts",
    );
  });

  it("uses Biome for lightweight static and formatting checks", () => {
    expect(packageJson.devDependencies["@biomejs/biome"]).toBeDefined();
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
