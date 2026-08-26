import fs from "node:fs";
import path from "node:path";

const CODE_SNAPSHOT_DIRECTORY = "code-snapshots";

export type CodeSnapshotGeneration = {
  codeIdentity: string;
  bytes: number;
};

/** Read-only observation of the code snapshot generations kept under the Automation host state dir. */
export type CodeSnapshotInventory = {
  root: string;
  generations: CodeSnapshotGeneration[];
};

function generationBytes(root: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    // Snapshots hard-link dependencies behind a node_modules symlink; a symlink adds no bytes of its own
    // and must never be followed, because following one would count another generation's files twice.
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) total += generationBytes(entryPath);
    else if (entry.isFile()) total += fs.lstatSync(entryPath).size;
  }
  return total;
}

/**
 * Lists every published code snapshot generation with its size on disk. Staged snapshots (dot-prefixed
 * temporary directories) are not yet published and are skipped. This only reads; removing a snapshot
 * needs cross-session knowledge no single session has, so doctor reports and a person decides.
 */
export function collectCodeSnapshotInventory(stateDir: string): CodeSnapshotInventory | null {
  const root = path.join(stateDir, CODE_SNAPSHOT_DIRECTORY);
  if (fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) return null;
  const generations = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{40}$/i.test(entry.name))
    .map((entry) => ({ codeIdentity: entry.name.toLowerCase(), bytes: generationBytes(path.join(root, entry.name)) }))
    .sort((left, right) => left.codeIdentity.localeCompare(right.codeIdentity));
  return { root, generations };
}
