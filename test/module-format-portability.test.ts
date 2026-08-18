import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// 行頭 `export` が一つでもあると Bun ベースのローダーはそのファイルを ESM と判定し、
// CJS の `module` が存在しない状態で評価する。よって `module.exports` へ代入する行に届いた瞬間
// `ReferenceError: module is not defined` で拡張全体のロードが失敗する。両者は同居できない。

const scannedRoots = ["src", "extensions/deadloop"];

function typescriptFiles(relativeRoot: string): string[] {
  return fs.readdirSync(path.join(process.cwd(), relativeRoot), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : typescriptFiles(relativePath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relativePath] : [];
  });
}

describe("module format portability", () => {
  it("keeps every module.exports file free of top-level exports", () => {
    const hybridModules = scannedRoots
      .flatMap(typescriptFiles)
      .filter((relativePath) => {
        const lines = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8").split("\n");
        return lines.some((line) => line.startsWith("module.exports"))
          && lines.some((line) => line.startsWith("export "));
      })
      .sort();

    expect(hybridModules).toEqual([]);
  });
});
