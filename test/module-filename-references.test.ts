import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import { describe, expect, it } from "vitest";

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

const documentationFiles = trackedFiles.filter((file) => file.endsWith(".md"));

const staleModuleNames = [
  ...new Set(
    trackedFiles
      .filter((file) => file.endsWith(".cts") || file.endsWith(".cjs"))
      .filter((file) => !trackedFiles.includes(`${file.slice(0, -extname(file).length)}.ts`))
      .map((file) => basename(file, extname(file))),
  ),
];

const findStaleReferences = (file: string): string[] => {
  const text = readFileSync(file, "utf8");
  return staleModuleNames.filter((name) => new RegExp(`(?<![\\w-])${name}\\.ts\\b`).test(text));
};

describe("documentation module filenames", () => {
  it("names no module by an extension it no longer uses", () => {
    const stale = documentationFiles.flatMap((file) => findStaleReferences(file).map((name) => `${file}: ${name}.ts`));
    expect(stale).toEqual([]);
  });
});

describe("packaged module coverage", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };

  const globToRegExp = (pattern: string): RegExp =>
    new RegExp(
      `^${pattern
        .split("**/")
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
        .join("(?:.*/)?")}$`,
    );

  const packagedPatterns = packageJson.files.map(globToRegExp);

  it("packages every CommonJS TypeScript module", () => {
    const unpackaged = trackedFiles
      .filter((file) => file.endsWith(".cts"))
      .filter((file) => !packagedPatterns.some((pattern) => pattern.test(file)));
    expect(unpackaged).toEqual([]);
  });
});
