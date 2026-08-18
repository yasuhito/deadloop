import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * One temporary deadloop state directory for this test process.
 *
 * A driver takes its target's dispatch lock before deciding anything, and that lock is a file under
 * the state directory. Without a directory of its own, a fixture run writes either into the work
 * tree or into the operator's live deadloop state, and two runs of the same fixture contend on one
 * lock as if they were competing hosts.
 */
let stateDir = "";

export function fixtureStateDir(): string {
  if (!stateDir) {
    stateDir = mkdtempSync(path.join(tmpdir(), "deadloop-acceptance-state-"));
    process.on("exit", () => rmSync(stateDir, { recursive: true, force: true }));
  }
  return stateDir;
}
