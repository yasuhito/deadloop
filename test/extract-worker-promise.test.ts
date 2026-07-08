import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const helperPath = "extensions/pi-looper/automations/extract-worker-promise.ts";

function runHelper(filePath: string, style: "separate" | "equals" = "separate") {
  const args = style === "equals" ? [helperPath, `--file=${filePath}`] : [helperPath, "--file", filePath];
  const result = spawnSync("node", args, { cwd: process.cwd(), encoding: "utf8" });
  const output = JSON.parse(result.stdout);
  return { code: result.status, status: output.status };
}

function withTempFile(content: string, callback: (filePath: string) => void) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-looper-promise-"));
  try {
    const filePath = path.join(tempRoot, "promise.json");
    writeFileSync(filePath, content);
    callback(filePath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("extract worker promise helper", () => {
  it("accepts complete promise files", () => {
    withTempFile('{"status":"complete","reason":"","summary":"実装した。検証した。残作業なし。"}', (filePath) => {
      expect(runHelper(filePath)).toEqual({ code: 0, status: "complete" });
    });
  });

  it("accepts blocked promise files", () => {
    withTempFile('{"status":"blocked","reason":"仕様不足","summary":"確認した。仕様が足りない。判断待ち。"}', (filePath) => {
      expect(runHelper(filePath)).toEqual({ code: 0, status: "blocked" });
    });
  });

  it("accepts argparse-style equals file arguments", () => {
    withTempFile('{"status":"complete","reason":"","summary":"実装した。検証した。残作業なし。"}', (filePath) => {
      expect(runHelper(filePath, "equals")).toEqual({ code: 0, status: "complete" });
    });
  });

  it("reports none for missing promise files", () => {
    const filePath = path.join(tmpdir(), `pi-looper-missing-${Date.now()}.json`);

    expect(runHelper(filePath)).toEqual({ code: 1, status: "none" });
  });

  it("reports invalid for malformed JSON", () => {
    withTempFile("{", (filePath) => {
      expect(runHelper(filePath)).toEqual({ code: 1, status: "invalid" });
    });
  });

  it("reports invalid when status is missing", () => {
    withTempFile('{"reason":"","summary":"実装した。検証した。残作業なし。"}', (filePath) => {
      expect(runHelper(filePath)).toEqual({ code: 1, status: "invalid" });
    });
  });
});
