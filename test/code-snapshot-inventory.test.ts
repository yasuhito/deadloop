import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { collectCodeSnapshotInventory } from "../src/code-snapshot-inventory";

const tempRoots: string[] = [];

function stateDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-code-snapshot-inventory-"));
  tempRoots.push(root);
  return root;
}

function generation(root: string, codeIdentity: string, files: Record<string, number>): void {
  const generationDir = path.join(root, "code-snapshots", codeIdentity, "package");
  mkdirSync(generationDir, { recursive: true });
  for (const [name, size] of Object.entries(files)) {
    writeFileSync(path.join(generationDir, name), Buffer.alloc(size));
  }
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("collect code snapshot inventory", () => {
  it("reports each published generation with its own byte size", () => {
    const root = stateDir();
    generation(root, "a".repeat(40), { "index.ts": 10 });
    generation(root, "B".repeat(40), { "index.ts": 300 });

    expect(collectCodeSnapshotInventory(root)).toEqual({
      root: path.join(root, "code-snapshots"),
      generations: [
        { codeIdentity: "a".repeat(40), bytes: 10 },
        { codeIdentity: "b".repeat(40), bytes: 300 },
      ],
    });
  });

  it("skips staged snapshot directories that have not been published yet", () => {
    const root = stateDir();
    generation(root, "a".repeat(40), { "index.ts": 10 });
    const snapshots = path.join(root, "code-snapshots");
    mkdirSync(path.join(snapshots, `.staged.${process.pid}.tmp`, "package"), { recursive: true });

    expect(collectCodeSnapshotInventory(root)?.generations).toHaveLength(1);
  });

  it("does not count dependency files behind a snapshot's node_modules symlink", () => {
    const root = stateDir();
    generation(root, "a".repeat(40), { "index.ts": 10 });
    symlinkSync(path.join(root, "dependency-snapshots", "shared", "node_modules"), path.join(root, "code-snapshots", "a".repeat(40), "package", "node_modules"));

    expect(collectCodeSnapshotInventory(root)?.generations[0].bytes).toBe(10);
  });

  it("finds nothing when no snapshot was ever created", () => {
    expect(collectCodeSnapshotInventory(stateDir())).toBeNull();
  });

  it("never removes a snapshot while collecting the inventory", () => {
    const root = stateDir();
    generation(root, "a".repeat(40), { "index.ts": 10 });
    const before = readdirSync(path.join(root, "code-snapshots"));

    collectCodeSnapshotInventory(root);

    expect(readdirSync(path.join(root, "code-snapshots"))).toEqual(before);
  });
});
