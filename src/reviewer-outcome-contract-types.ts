/**
 * reviewer-outcome-contract の実行時モジュールは CJS (`module.exports`) のままでなければ
 * ならないため、他ファイルから参照される型だけをこの型専用モジュールに分離している。
 */

/** How the review agent disposed of the required findings raised before this review. */
export type PriorRequiredFindingDisposition =
  /** No required finding existed before this review. */
  | "none"
  /** Every prior required finding is resolved on the reviewed head. */
  | "all_resolved"
  /** At least one prior required finding is still unresolved. */
  | "persisted"
  /** A previously resolved required finding came back. */
  | "regressed"
  /** Unresolved prior required findings stand next to new ones. */
  | "mixed";
