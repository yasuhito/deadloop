import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  files: string[];
  pi?: { skills?: string[] };
};
const skillText = readFileSync("skills/pi-looper/SKILL.md", "utf8");

describe("skills CLI compatibility package", () => {
  it("declares bundled Pi skills in the package manifest", () => {
    expect(packageJson.pi?.skills).toContain("./skills");
  });

  it("includes skills in the npm package file list", () => {
    expect(packageJson.files).toContain("skills/**/*.md");
  });

  it("provides Agent Skills frontmatter", () => {
    expect(skillText).toMatch(/^---\nname: pi-looper\ndescription: .+\n---/);
  });

  it("makes the Pi package activation step explicit", () => {
    expect(skillText).toContain("pi install git:github.com/yasuhito/pi-looper");
  });
});
