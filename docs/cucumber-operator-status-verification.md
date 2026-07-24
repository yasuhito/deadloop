# Operator status Cucumber migration verification

This record tracks the Cucumber migration for Issue #127. The existing Vitest tests remain only where they retain local diagnostic value.

## Classification mapping

| Classification IDs | Migration destination |
|---|---|
| T050 | Acceptance scenario `Issue の停止コメントに復旧手順を表示する` |
| T051 | Acceptance scenario `Issue の停止コメントに安全な再投入方法を表示する` |
| T052 | Reclassified to focused Vitest coverage in `test/blocked-report-format.test.ts`; this is a static prompt-file contract |
| T053 | Reclassified to focused Vitest coverage in `test/blocked-report-format.test.ts`; this is a static prompt-file contract |
| T054 | `現行の状態表示コマンドを登録する` |
| T380 | `実装待ちの Issue がない場合はそのことを表示する` |
| Issue #127 target display | `対象の Issue を表示する` |
| T381 | `レビュー対象の pull request を表示する` |
| T382 | `片付け候補の作業場所を表示する` |
| T383 | `稼働中の作業場所を表示する` |
| T384 | `コード更新の警告を表示する` |
| T385 | `自動化の直近の判断を表示する` |
| T386 | `設定元を表示する` |
| Issue #127 stop reason | `Issue の停止コメントに理由を表示する`; `pull request の停止コメントに理由を表示する` |

## Acceptance boundary

Each status scenario names the Issue, pull request, workspace, warning, automation decision, or configuration state that its result depends on, then renders the report in When. The stopped-Issue scenarios state that Issue #11 looks like a PRD, design, or parent issue and run the issue coordinator driver with `driver-blocked-prd.json`. The stopped-pull-request scenarios state that pull request #23 is a draft awaiting review and run the PR reviewer driver with `draft-pr.json`.

The deterministic draft gate does not read `pr-reviewer.prompt.md`. Its acceptance scenarios therefore cover the draft-PR comment output, not T052 or T053. Those two classifications retain focused Vitest coverage that reads the prompt file directly and guards its recovery heading and safe requeue command.

## Intentional failures

On 2026-07-23, each expected external result was temporarily changed to an impossible value and `npm run test:acceptance` was run. Every mutation exited with status 1 and named the affected scenario and Then source location. The mutations and detected guarantees were:

- T380: `eligible: none` was changed to `eligible: #999`.
- Issue #127 target display: Issue `#13` was changed to `#999`.
- T381: review target PR `#21` was changed to `#999`.
- T382: cleanup workspace `workspace-20` was changed to `workspace-999`.
- T383: the active branch was changed to a nonexistent branch.
- T384: the expected code-update warning was changed to `missing warning`.
- T385: the selected Issue in the driver summary was changed from `#12` to `#999`.
- T386: the expected repository-policy source was changed from `origin/main` to `origin/missing`.
- T050: the Issue recovery heading was changed to `## Missing recovery steps`.
- T051: the Issue requeue command target was changed from `#11` to `#999`.
- Draft-PR output: the recovery heading was changed to `## Missing recovery steps`, and the recovery command repository was changed from `owner/repo` to `other/repo` in separate runs. T052 and T053 are not assigned to these scenarios because the draft gate does not read the prompt.
- T054: the expected registered command was changed from `deadloop-status` to `missing-status`.
- Issue #127 stop reasons: the known planning-Issue reason and known draft-pull-request reason were each changed to a missing reason; each corresponding scenario failed independently.

Each assertion was restored before the next mutation. The restored acceptance suite then passed with 16 scenarios and 65 steps.

## Full verification

On 2026-07-23, `npm run check` completed successfully after the restored migration: the acceptance rules passed, all 43 Vitest files (484 tests) passed, all 16 Cucumber scenarios (65 steps) passed, lint and type checking passed, shell syntax checks passed, and `npm pack --dry-run` produced `deadloop-0.1.0.tgz`.
