/**
 * human-handoff の実行時モジュールは CJS (`module.exports`) のままにするため、
 * 他ファイルから参照される型だけをこの型専用モジュールに分離している。
 */

/** The configured workflow labels whose presence keeps an agent request waiting on a pull request. */
export type HumanHandoffLabels = {
  reviewLabel: string;
  implementLabel: string;
  updateBranchLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
};

/** What GitHub shows about one pull request, as far as a handoff cares. */
export type HumanHandoffObservation = {
  isDraft: boolean;
  labels: readonly string[];
};
