import { spawnSync } from "node:child_process";
import path from "node:path";

import { fixtureStateDir } from "./fixture-state-dir";

export type PrReviewerDriverResult = {
  driverAction?: string;
  comment?: string;
  githubEffects?: Array<{
    operation?: string;
    reviewer?: string;
    body?: string;
    move?: { add?: string | string[]; remove?: string | string[] };
  }>;
  prompt?: string;
  testAdapterEffects?: { herdrStarts?: unknown[] };
};

export function runPrReviewerDriverFixture(
  fixturePath: string,
  extraEnv: Record<string, string> = {},
): PrReviewerDriverResult {
  const result = spawnSync("node", ["extensions/deadloop/automations/pr-reviewer-driver.cts", "--fixture", fixturePath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEADLOOP_PROJECT_ID: "demo",
      DEADLOOP_STATE_DIR: fixtureStateDir(),
      DEADLOOP_REPO_PATH: "/repo",
      DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_REVIEWER_AGENT: "pi",
      DEADLOOP_REVIEWER_MODEL: "",
      DEADLOOP_AUTO_MERGE: "0",
      DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS: "deadloop-bot",
      DEADLOOP_NOW: "2026-07-08T00:00:00Z",
      ...extraEnv,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout) as PrReviewerDriverResult;
}
