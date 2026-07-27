# Automation driver result acceptance verification

This note records the Cucumber migration for the observable automation-driver outcomes in Issue #120. The existing deterministic runner remains unchanged; only its public prompt-delivery behavior moved from Vitest to the executable acceptance specification.

## Classification correspondence and equivalence

The executable feature is the sole canonical acceptance specification. Each classification ID links directly to its scenario there:

- [T030](../acceptance/features/automation-driver-results.feature.md#シナリオ-処理不要と判断された場合はプロンプトを送信しない)
- [T032](../acceptance/features/automation-driver-results.feature.md#シナリオ-処理完了と報告された場合はプロンプトを送信しない)
- [T034](../acceptance/features/automation-driver-results.feature.md#シナリオ-判断が必要な場合は判断用プロンプトだけを送信する)
- [T037](../acceptance/features/automation-driver-results.feature.md#シナリオ-自動化の応答が不正な場合はプロンプトを送信しない)
- [T039](../acceptance/features/automation-driver-results.feature.md#シナリオ-自動化が失敗した場合はプロンプトを送信しない)
- [T041](../acceptance/features/automation-driver-results.feature.md#シナリオ-自動化が停止を報告した場合はプロンプトを送信しない)
- [T042](../acceptance/features/automation-driver-results.feature.md#シナリオ-決定論的な判断を設定していない場合は通常のプロンプトを送信する)

Each scenario creates the same scheduled, precheck-passing automation state and trigger as its replaced Vitest case. Its one Then assertion observes the delivered prompt list, so it detects the same user-visible behavior without coupling the specification to runner state fields or result enum names. The seven corresponding Vitest cases were removed after the acceptance scenarios passed; the remaining Vitest cases continue to cover internal state recording and recovery behavior.

## Intentional failure checks

During the PR #152 repair, the assertions in `acceptance/steps/automation-driver-results.steps.ts` were temporarily changed and `npm run test:acceptance` was run after each bounded mutation. Every run exited with status 1, identified the linked feature source and source-mapped Then callback, and printed the following assertion diff:

| Classification ID | Failing source | Temporary expected value | Reported actual / expected diff |
| --- | --- | --- | --- |
| T030 | [feature:6](../acceptance/features/automation-driver-results.feature.md#シナリオ-処理不要と判断された場合はプロンプトを送信しない), [step:87](../acceptance/steps/automation-driver-results.steps.ts#L87) | `["intentional failure"]` | `[]` / `["intentional failure"]` |
| T032 | [feature:12](../acceptance/features/automation-driver-results.feature.md#シナリオ-処理完了と報告された場合はプロンプトを送信しない), [step:87](../acceptance/steps/automation-driver-results.steps.ts#L87) | `["intentional failure"]` | `[]` / `["intentional failure"]` |
| T034 | [feature:18](../acceptance/features/automation-driver-results.feature.md#シナリオ-判断が必要な場合は判断用プロンプトだけを送信する), [step:91](../acceptance/steps/automation-driver-results.steps.ts#L91) | `["intentional failure"]` | `["decision prompt"]` / `["intentional failure"]` |
| T037 | [feature:24](../acceptance/features/automation-driver-results.feature.md#シナリオ-自動化の応答が不正な場合はプロンプトを送信しない), [step:87](../acceptance/steps/automation-driver-results.steps.ts#L87) | `["intentional failure"]` | `[]` / `["intentional failure"]` |
| T039 | [feature:30](../acceptance/features/automation-driver-results.feature.md#シナリオ-自動化が失敗した場合はプロンプトを送信しない), [step:87](../acceptance/steps/automation-driver-results.steps.ts#L87) | `["intentional failure"]` | `[]` / `["intentional failure"]` |
| T041 | [feature:36](../acceptance/features/automation-driver-results.feature.md#シナリオ-自動化が停止を報告した場合はプロンプトを送信しない), [step:87](../acceptance/steps/automation-driver-results.steps.ts#L87) | `["intentional failure"]` | `[]` / `["intentional failure"]` |
| T042 | [feature:42](../acceptance/features/automation-driver-results.feature.md#シナリオ-決定論的な判断を設定していない場合は通常のプロンプトを送信する), [step:95](../acceptance/steps/automation-driver-results.steps.ts#L95) | `["intentional failure"]` | `["normal prompt"]` / `["intentional failure"]` |

The no-prompt cases shared one bounded mutation of their common Then assertion; Cucumber reported all five scenarios as separate failures. T034 and T042 were mutated and run separately. Every temporary change was restored before the clean verification run.
