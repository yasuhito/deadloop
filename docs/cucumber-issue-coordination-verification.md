# Issue coordination acceptance verification

Issue #118 moves the user-visible outcomes for a selected Issue into the Japanese executable acceptance specification. The coordinator transitions are unchanged; planning guidance and the worker launch reason omit unnecessary internal implementation details.

## Classification correspondence and equivalence

The executable feature is the sole canonical acceptance specification. The migrated classification IDs correspond to these scenarios:

| Classification ID | Replaced guarantee | Acceptance scenario |
| --- | --- | --- |
| T211 | Missing contracts stop deterministically without an LLM handoff, implementation, or monitoring | [`実装契約が不足している場合は言語モデルへ判断を引き渡さない`](../acceptance/features/issue-coordination.feature.md#シナリオ-実装契約が不足している場合は言語モデルへ判断を引き渡さない), [`実装契約が不足している場合は作業を開始しない`](../acceptance/features/issue-coordination.feature.md#シナリオ-実装契約が不足している場合は作業を開始しない), [`実装契約が不足している場合は完了監視を開始しない`](../acceptance/features/issue-coordination.feature.md#シナリオ-実装契約が不足している場合は完了監視を開始しない) |
| T212 | Missing-contract guidance names the required sections | [`実装契約が不足している場合は必要な項目を案内する`](../acceptance/features/issue-coordination.feature.md#シナリオ-実装契約が不足している場合は必要な項目を案内する) |
| T213 | Planning Issues receive user-facing recovery guidance without internal operations, implementation, or monitoring | [`計画用の-issue-には復旧手順を案内する`](../acceptance/features/issue-coordination.feature.md#シナリオ-計画用の-issue-には復旧手順を案内する), [`計画用の-issue-の停止コメントに内部運用情報を含めない`](../acceptance/features/issue-coordination.feature.md#シナリオ-計画用の-issue-の停止コメントに内部運用情報を含めない), [`計画用の-issue-は作業を開始しない`](../acceptance/features/issue-coordination.feature.md#シナリオ-計画用の-issue-は作業を開始しない), [`計画用の-issue-は完了監視を開始しない`](../acceptance/features/issue-coordination.feature.md#シナリオ-計画用の-issue-は完了監視を開始しない) |
| T214 | A design-document reference alone does not classify an implementable Issue as planning work | [`設計文書への参照だけを持つ-issue-は完了監視へ進む`](../acceptance/features/issue-coordination.feature.md#シナリオ-設計文書への参照だけを持つ-issue-は完了監視へ進む) |
| T215 | An implementable Issue receives hygienic work instructions, starts work, and proceeds to completion monitoring | [`実装可能な-issue-の作業指示に内部実装名を含めない`](../acceptance/features/issue-coordination.feature.md#シナリオ-実装可能な-issue-の作業指示に内部実装名を含めない), [`実装可能な-issue-は作業を開始する`](../acceptance/features/issue-coordination.feature.md#シナリオ-実装可能な-issue-は作業を開始する), [`実装可能な-issue-は完了監視へ進む`](../acceptance/features/issue-coordination.feature.md#シナリオ-実装可能な-issue-は完了監視へ進む) |

Each scenario runs the deterministic Issue coordinator with the same fixture used by the replaced Vitest case. Each Then contains one direct assertion against one observable outcome, such as deterministic completion without an LLM handoff, absence of a work launch, absence of monitoring, one part of the guidance, work launch, or completion monitoring. Separate scenarios verify that stopped paths start neither work nor monitoring, while implementable work receives no stop comment; the requeue and planning-split instructions are also observed independently. The planning stop comment now contains only the split and requeue guidance, and the fixture adapter exposes the instructions delivered to the simulated worker so their information hygiene is observable. Scenario text uses product terms rather than fixture names, function names, or internal result identifiers.

Before deleting T211–T215, the new Cucumber scenarios and all 22 tests in `test/issue-coordinator-driver.test.ts` passed against the same product code on 2026-07-24. The five Vitest cases were then removed because their public guarantees were completely replaced and the Cucumber failures identify the scenario and source-mapped assertion directly.

## Intentional failure check

On 2026-07-25, every shared Then used by the migrated T211–T215 observations was changed separately, never committed, and checked with `npm run test:acceptance`. Each run exited with status 1 at the listed source-mapped assertion and showed the intentional expected/actual difference. The original assertion was restored after every run.

| Observation | Step location | Temporary difference | Failing scenarios |
| --- | --- | --- | --- |
| Deterministic stop without LLM | `issue-coordination.steps.ts:64` | expected action `done` → `intentional-failure` | contract-missing LLM-handoff scenario |
| No work launch | `issue-coordination.steps.ts:68` | expected `launch` `undefined` → `intentional-failure` | contract-missing and planning no-work scenarios |
| Required-section guidance | `issue-coordination.steps.ts:72` | required-section pattern → `intentional-failure` | missing-contract section-guidance scenario |
| Requeue guidance | `issue-coordination.steps.ts:76` | requeue pattern → `intentional-failure` | missing-contract requeue scenario |
| Planning split guidance | `issue-coordination.steps.ts:80` | split pattern → `intentional-failure` | planning split scenario |
| Recovery guidance | `issue-coordination.steps.ts:84` | recovery heading → `intentional-failure` | planning recovery scenario |
| Stop-comment hygiene | `issue-coordination.steps.ts:88` | `doesNotMatch` → `match` for forbidden internal details | planning comment hygiene scenario |
| Work launch | `issue-coordination.steps.ts:95` | expected simulated launch `true` → `false` | implementable work-launch scenario |
| Work-instruction hygiene | `issue-coordination.steps.ts:99` | `doesNotMatch` → `match` for internal names | worker-instruction hygiene scenario |
| Completion monitoring | `issue-coordination.steps.ts:103` | expected kind `issue` → `intentional-failure` | design-reference and implementable monitoring scenarios |
| No completion monitoring | `issue-coordination.steps.ts:107` | expected handoff `undefined` → `intentional-failure` | contract-missing and planning no-monitor scenarios |
| No stop comment | `issue-coordination.steps.ts:111` | expected comment `undefined` → `intentional-failure` | implementable no-stop-comment scenario |

After restoring all expectations, `npm run test:acceptance` passed all 89 scenarios and 465 steps.

## Vitest retained by scope

The following nearby classifications remain in Vitest because they retain lower-level diagnostic value or belong to a later acceptance boundary:

- T216–T217 and T219 diagnose deterministic agent naming, prompt wiring, and promise-path placement.
- T222–T224 diagnose environment wiring and renderer selection.
- T225–T229 cover the pure internal planning function.
- T235–T242 cover prompt rendering, escaping, validation commands, and static wiring.
- T218 and T220–T221 belong to the worker completion and monitoring contract in Issue #119.
- T230–T234 belong to the detailed human-facing recovery display migration rather than the selected-Issue transition in Issue #118.

T209 (no selected candidate) and T210 (cleanup-only execution) are outside Issue #118's selected-Issue premise and remain for a separate migration boundary. No classification-table deletion candidate applies to this change.
