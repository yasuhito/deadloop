import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };

describe("package manifest files", () => {
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
