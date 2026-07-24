# Operator status Cucumber migration verification

This record tracks the Cucumber migration for Issue #127. The existing Vitest tests remain only where they retain local diagnostic value.

## Classification mapping

| Classification IDs | Acceptance scenario(s) |
|---|---|
| T050 | `Issue の停止コメントに復旧手順を表示する` |
| T051 | `Issue の停止コメントに安全な再投入方法を表示する` |
| T052 | `pull request の停止コメントに復旧手順を表示する` |
| T053 | `pull request の停止コメントに安全な再投入方法を表示する` |
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

The status scenarios establish input data in Given and render the report in When. The stopped-Issue scenarios run the issue coordinator driver with `driver-blocked-prd.json`, while the stopped-pull-request scenarios run the PR reviewer driver with `draft-pr.json`; their When step observes the comments returned by those deterministic acceptance adapters rather than reading a prompt or pre-rendering a comment in Given.

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
- T050 and T052: the shared expected recovery heading was changed to `## Missing recovery steps`; both the Issue and pull-request scenarios failed, demonstrating the same heading guarantee at each output boundary.
- T051: the Issue requeue command target was changed from `#11` to `#999`.
- T053: the pull-request recovery command repository was changed from `owner/repo` to `other/repo`.
- T054: the expected registered command was changed from `deadloop-status` to `missing-status`.
- Issue #127 stop reasons: the known planning-Issue reason and known draft-pull-request reason were each changed to a missing reason; each corresponding scenario failed independently.

Each assertion was restored before the next mutation. The restored acceptance suite then passed with 16 scenarios and 65 steps.

## Full verification

On 2026-07-23, `npm run check` completed successfully after the restored migration: the acceptance rules passed, all 43 Vitest files (484 tests) passed, all 16 Cucumber scenarios (65 steps) passed, lint and type checking passed, shell syntax checks passed, and `npm pack --dry-run` produced `deadloop-0.1.0.tgz`.
