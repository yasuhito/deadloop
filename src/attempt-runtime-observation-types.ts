/**
 * attempt-runtime-observation の実行時モジュールは CJS (`module.exports`) のままでなければ
 * ならないため、他ファイルから参照される型だけをこの型専用モジュールに分離している。
 */

type JsonObject = Record<string, any>;

export type AttemptRuntimeRunner = {
  listWorkspaces(): JsonObject[];
  listAgents(): JsonObject[];
  listWorktrees(projectRepo: string): JsonObject[];
};

/** The runtime a liveness question needs: an attempt is alive through its agent, not its workspace. */
export type AttemptAgentRunner = Pick<AttemptRuntimeRunner, "listAgents">;
