# 日本語 Cucumber 移行台帳

この台帳は、[`cucumber-test-classification.md`](cucumber-test-classification.md) で分類した T001〜T399 の最終結果を一意に追跡する。受け入れ仕様の正本は [`acceptance/features/`](../acceptance/features/) であり、ここでは移行記録または Vitest を残す診断価値への参照だけを管理する。

- `移行済み`: 外部観測可能な保証を日本語 Cucumber へ移した。局所診断用の Vitest を併存させる場合も含む。
- `Vitest 継続へ再分類`: 外部から同じ保証を明瞭に表せない、または失敗原因を局所化する価値が勝るため、移行記録で再分類した。
- `同じ保証へ統合`: 別 ID と同じ外部保証を一つのシナリオで追跡する。
- `Vitest 継続`: 当初から単体・低レベル・静的検査として残す分類であり、ID ごとの理由は分類表にある。
- `削除済み`: 移行履歴だけを固定していたテストを、記載した現行契約の代替確認後に削除した。

この表の完全性は `test/cucumber-migration-ledger.test.ts` が検査する。人間による日本語全面移行の明示承認は、コードで代替せず Issue / プルリクエストのレビュー記録で行う。

## 完了ゲートの証拠

- 未定義・曖昧・pending・0件実行は、`npm run check` に含まれる `check:acceptance-rules` と `test:acceptance` が失敗として扱う。
- 実行時間の目安超過は [Issue #172](https://github.com/yasuhito/deadloop/issues/172) で根本原因を追跡する。
- この変更の `npm run check` の結果はコミット前に確認する。CI 成功と人間の明示承認は、変更を GitHub でレビューするときに記録する。

| 分類 ID | 当初分類 | 最終結果 | 移行記録・継続理由・代替確認 |
|---|---|---|---|
| T001 | Cucumber候補 | Vitest 継続へ再分類 | 既存のプルリクエストの作業場所を開くレビュー担当固有の起動引数、プロンプト書込み、戻り値を一度に診断する低レベル統合として `test/agent-launch-flow.test.ts` に残す（[移行記録](cucumber-worker-launch-monitoring-migration.md)） |
| T002 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T003 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T004 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T005 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T006 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T007 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T008 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T009 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T010 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T011 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T012 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T013 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T014 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T015 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T016 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T017 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T018 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T019 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T020 | Cucumber候補 | Vitest 継続へ再分類 | 信頼済み状態を起動前判定へ写す局所診断として `test/agent-trust.test.ts` に残す |
| T021 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T022 | Cucumber候補 | Vitest 継続へ再分類 | 判定不能時の警告と継続を分離して診断するため `test/agent-trust.test.ts` に残す |
| T023 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T024 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T025 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T026 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T027 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T028 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T029 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T030 | Cucumber候補 | 移行済み | [cucumber-automation-driver-results-verification.md](cucumber-automation-driver-results-verification.md) |
| T031 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T032 | Cucumber候補 | 移行済み | [cucumber-automation-driver-results-verification.md](cucumber-automation-driver-results-verification.md) |
| T033 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T034 | Cucumber候補 | 移行済み | [cucumber-automation-driver-results-verification.md](cucumber-automation-driver-results-verification.md) |
| T035 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T036 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T037 | Cucumber候補 | 移行済み | [cucumber-automation-driver-results-verification.md](cucumber-automation-driver-results-verification.md) |
| T038 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T039 | Cucumber候補 | 移行済み | [cucumber-automation-driver-results-verification.md](cucumber-automation-driver-results-verification.md) |
| T040 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T041 | Cucumber候補 | 移行済み | [cucumber-automation-driver-results-verification.md](cucumber-automation-driver-results-verification.md) |
| T042 | Cucumber候補 | 移行済み | [cucumber-automation-driver-results-verification.md](cucumber-automation-driver-results-verification.md) |
| T043 | 削除候補 | 削除済み | T044〜T046 が現行ファイルの解決契約を確認する |
| T044 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T045 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T046 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T047 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T048 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T049 | 削除候補 | 削除済み | T047〜T048 が配布例の現行ファイル名を確認する |
| T050 | Cucumber候補 | 移行済み | [cucumber-operator-status-verification.md](cucumber-operator-status-verification.md) |
| T051 | Cucumber候補 | 移行済み | [cucumber-operator-status-verification.md](cucumber-operator-status-verification.md) |
| T052 | Cucumber候補 | Vitest 継続へ再分類 | 復旧見出しをプロンプトファイルから直接読む静的契約として `test/blocked-report-format.test.ts` に残す（[移行記録](cucumber-operator-status-verification.md)） |
| T053 | Cucumber候補 | Vitest 継続へ再分類 | 安全な再投入コマンドをプロンプトファイルから直接読む静的契約として `test/blocked-report-format.test.ts` に残す（[移行記録](cucumber-operator-status-verification.md)） |
| T054 | Cucumber候補 | 移行済み | [cucumber-operator-status-verification.md](cucumber-operator-status-verification.md) |
| T055 | 削除候補 | 削除済み | T054 が現行コマンドの登録を確認する |
| T056 | 削除候補 | 削除済み | T076〜T078 が現行の DEADLOOP 設定経路を確認する |
| T057 | 削除候補 | 削除済み | T054 と docs/migration-to-deadloop.md が現行名称を確認する |
| T058 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T059 | Cucumber候補 | 移行済み | [cucumber-migration-records.md](cucumber-migration-records.md) |
| T060 | Cucumber候補 | 移行済み | [cucumber-migration-records.md](cucumber-migration-records.md) |
| T061 | Cucumber候補 | 移行済み | [cucumber-migration-records.md](cucumber-migration-records.md) |
| T062 | Cucumber候補 | 移行済み | [cucumber-migration-records.md](cucumber-migration-records.md) |
| T063 | Cucumber候補 | 移行済み | [cucumber-migration-records.md](cucumber-migration-records.md) |
| T064 | Cucumber候補 | 移行済み | [cucumber-migration-records.md](cucumber-migration-records.md) |
| T065 | Cucumber候補 | 移行済み | [cucumber-migration-records.md](cucumber-migration-records.md) |
| T066 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T067 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T068 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T069 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T070 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T071 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T072 | 削除候補 | 削除済み | T066〜T071、T073 が現行 CI 契約を確認する |
| T073 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T074 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T075 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T076 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T077 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T078 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T079 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T080 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T081 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T082 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T083 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T084 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T085 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T086 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T087 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T088 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T089 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T090 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T091 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T092 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T093 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T094 | Cucumber候補 | Vitest 継続へ再分類 | 明示指示文と指示ファイルの優先順位は文字列組み立て内部の契約であり、起動結果へ統合すると原因が不明瞭になるため Vitest に残す（[移行記録](cucumber-migration-record.md)） |
| T095 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T096 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T097 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T098 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T099 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T100 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T101 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T102 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T103 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T104 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T105 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T106 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T107 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T108 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T109 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T110 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T111 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T112 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T113 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T114 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T115 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T116 | Cucumber候補 | Vitest 継続へ再分類 | 実行周期ごとの再読込順序を検査する低レベル統合であり、単一回の利用者操作として表現すると契機が曖昧になるため Vitest に残す（[移行記録](cucumber-migration-record.md)） |
| T117 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T118 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T119 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T120 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T121 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T122 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T123 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T124 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T125 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T126 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T127 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T128 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T129 | Cucumber候補 | Vitest 継続へ再分類 | スケジューラーロック所有者と再読込後 ID の内部不変条件を診断する低レベル統合として Vitest に残す（[移行記録](cucumber-migration-record.md)） |
| T130 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T131 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T132 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T133 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T134 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T135 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T136 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T137 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T138 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T139 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T140 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T141 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T142 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T143 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T144 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T145 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T146 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T147 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T148 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T149 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T150 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T151 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T152 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T153 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T154 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T155 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T156 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T157 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T158 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T159 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T160 | Cucumber候補 | 移行済み | [cucumber-doctor-recovery-verification.md](cucumber-doctor-recovery-verification.md) |
| T161 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T162 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T163 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T164 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T165 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T166 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T167 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T168 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T169 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T170 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T171 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T172 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T173 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T174 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T175 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T176 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T177 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T178 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T179 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T180 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T181 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T182 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T183 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T184 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T185 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T186 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T187 | Cucumber候補 | 移行済み | [分類表内の Issue #112 移行記録](cucumber-test-classification.md) |
| T188 | Cucumber候補 | 移行済み | [分類表内の Issue #112 移行記録](cucumber-test-classification.md) |
| T189 | Cucumber候補 | Vitest 継続へ再分類 | 生成された一時ファイルだけを除外する低レベルの Git status 解釈の失敗位置を絞るため Vitest に残す（[Issue #112 移行記録](cucumber-test-classification.md)） |
| T190 | Cucumber候補 | 移行済み | [分類表内の Issue #112 移行記録](cucumber-test-classification.md) |
| T191 | Cucumber候補 | Vitest 継続へ再分類 | `.pi-subagents` 固有の削除防止を実際のファイル操作で診断するため Vitest に残す（[Issue #112 移行記録](cucumber-test-classification.md)） |
| T192 | Cucumber候補 | Vitest 継続へ再分類 | 追跡済み実行時ファイルによる停止理由の文言を実際の削除処理に近い位置で診断するため Vitest に残す（[Issue #112 移行記録](cucumber-test-classification.md)） |
| T193 | Cucumber候補 | Vitest 継続へ再分類 | 停止時に Herdr 作業領域を削除しない副作用を直接診断するため Vitest に残す（[Issue #112 移行記録](cucumber-test-classification.md)） |
| T194 | Cucumber候補 | Vitest 継続へ再分類 | 一時ファイルだけを消して作業領域を削除する実際の副作用を直接診断するため Vitest に残す（[Issue #112 移行記録](cucumber-test-classification.md)） |
| T195 | Cucumber候補 | Vitest 継続へ再分類 | 作業領域 ID の正規化と欠落時の停止を実行基盤アダプターに近い位置で診断するため Vitest に残す（[Issue #112 移行記録](cucumber-test-classification.md)） |
| T196 | Cucumber候補 | Vitest 継続へ再分類 | `main` 作業領域の停止理由を直接診断するため Vitest に残す（[Issue #112 移行記録](cucumber-test-classification.md)） |
| T197 | Cucumber候補 | 移行済み | [分類表内の Issue #112 移行記録](cucumber-test-classification.md) |
| T198 | Cucumber候補 | Vitest 継続へ再分類 | 片付け後に Issue 調整役を起動する低レベルの事前確認結合を診断するため Vitest に残す（[Issue #112 移行記録](cucumber-test-classification.md)） |
| T199 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T200 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T201 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T202 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T203 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T204 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T205 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T206 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T207 | Cucumber候補 | 同じ保証へ統合 | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T208 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T209 | Cucumber候補 | Vitest 継続へ再分類 | 候補なし入力から Issue 調整役が `skip` を返す決定論的な遷移を局所診断するため `test/issue-coordinator-driver.test.ts` に残す |
| T210 | Cucumber候補 | Vitest 継続へ再分類 | 片付けだけの入力から Issue 調整役が `cleanup_applied` を返す決定論的な遷移を局所診断するため `test/issue-coordinator-driver.test.ts` に残す |
| T211 | Cucumber候補 | 移行済み | [cucumber-issue-coordination-verification.md](cucumber-issue-coordination-verification.md) |
| T212 | Cucumber候補 | 移行済み | [cucumber-issue-coordination-verification.md](cucumber-issue-coordination-verification.md) |
| T213 | Cucumber候補 | 移行済み | [cucumber-issue-coordination-verification.md](cucumber-issue-coordination-verification.md) |
| T214 | Cucumber候補 | 移行済み | [cucumber-issue-coordination-verification.md](cucumber-issue-coordination-verification.md) |
| T215 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T216 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T217 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T218 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T219 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T220 | Cucumber候補 | Vitest 継続へ再分類 | Issue 調整役の Worker プロンプトに `run-project-check.ts` を配線する静的境界を局所診断するため `test/issue-coordinator-driver.test.ts` に残す |
| T221 | Cucumber候補 | Vitest 継続へ再分類 | PR 作成前の検証指示を局所化するプロンプト境界として `test/issue-coordinator-driver.test.ts` に残す |
| T222 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T223 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T224 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T225 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T226 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T227 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T228 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T229 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T230 | Cucumber候補 | 同じ保証へ統合 | `operator-status.feature.md` の Issue 停止コメントに理由を表示する保証へ統合 |
| T231 | Cucumber候補 | 同じ保証へ統合 | `operator-status.feature.md` の Issue 停止コメントに復旧手順を表示する保証へ統合 |
| T232 | Cucumber候補 | Vitest 継続へ再分類 | 停止理由と復旧節の描画順を局所診断するため `test/issue-coordinator-renderers.test.ts` に残す |
| T233 | Cucumber候補 | Vitest 継続へ再分類 | シェル引数の引用処理を局所診断するため `test/issue-coordinator-renderers.test.ts` に残す |
| T234 | Cucumber候補 | 同じ保証へ統合 | `operator-status.feature.md` の Issue 停止コメントに安全な再投入方法を表示する保証へ統合 |
| T235 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T236 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T237 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T238 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T239 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T240 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T241 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T242 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T243 | Cucumber候補 | 移行済み | [cucumber-issue-selection-verification.md](cucumber-issue-selection-verification.md) |
| T244 | Cucumber候補 | 移行済み | [cucumber-issue-selection-verification.md](cucumber-issue-selection-verification.md) |
| T245 | Cucumber候補 | 移行済み | [cucumber-issue-selection-verification.md](cucumber-issue-selection-verification.md) |
| T246 | Cucumber候補 | 移行済み | [cucumber-issue-selection-verification.md](cucumber-issue-selection-verification.md) |
| T247 | Cucumber候補 | 移行済み | [cucumber-issue-selection-verification.md](cucumber-issue-selection-verification.md) |
| T248 | Cucumber候補 | 移行済み | [cucumber-issue-selection-verification.md](cucumber-issue-selection-verification.md) |
| T249 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T250 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T251 | Cucumber候補 | Vitest 継続へ再分類 | シェルを介さない Herdr 引数受渡しを局所診断するため `test/launch-agent-integration.test.ts` に残す |
| T252 | Cucumber候補 | Vitest 継続へ再分類 | メタ文字を含む指示の単一引数受渡しを局所診断するため `test/launch-agent-integration.test.ts` に残す |
| T253 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T254 | Cucumber候補 | Vitest 継続へ再分類 | 信頼状態を取得できない場合のランチャー接続を局所診断するため `test/launch-agent-integration.test.ts` に残す |
| T255 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T256 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T257 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T258 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T259 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T260 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T261 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T262 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T263 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T264 | Cucumber候補 | Vitest 継続へ再分類 | Issue close を禁じる監視プロンプトの静的な安全境界として `test/monitor-prompts.test.ts` に残す |
| T265 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T266 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T267 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T268 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T269 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T270 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T271 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T272 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T273 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T274 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T275 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T276 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T277 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T278 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T279 | Cucumber候補 | Vitest 継続へ再分類 | 基準コミットを含む先頭コミットの純粋な更新判定を局所診断するため `test/pr-branch-update-decision.test.ts` に残す |
| T280 | Cucumber候補 | Vitest 継続へ再分類 | 早送りの純粋な更新判定を局所診断するため `test/pr-branch-update-decision.test.ts` に残す |
| T281 | Cucumber候補 | Vitest 継続へ再分類 | 競合のないマージの純粋な更新判定を局所診断するため `test/pr-branch-update-decision.test.ts` に残す |
| T282 | Cucumber候補 | 移行済み | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T283 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T284 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T285 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T286 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T287 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T288 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T289 | Cucumber候補 | 移行済み | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T290 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T291 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T292 | Cucumber候補 | 同じ保証へ統合 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T293 | Cucumber候補 | 移行済み | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T294 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T295 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T296 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T297 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T298 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T299 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T300 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T301 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T302 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T303 | Cucumber候補 | 移行済み | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T304 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T305 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T306 | Cucumber候補 | 同じ保証へ統合 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T307 | Cucumber候補 | 移行済み | [cucumber-pr-review-transitions-migration.md](cucumber-pr-review-transitions-migration.md) |
| T308 | Cucumber候補 | 移行済み | [cucumber-pr-review-transitions-migration.md](cucumber-pr-review-transitions-migration.md) |
| T309 | Cucumber候補 | 移行済み | [cucumber-pr-review-transitions-migration.md](cucumber-pr-review-transitions-migration.md) |
| T310 | Cucumber候補 | 移行済み | [cucumber-pr-review-transitions-migration.md](cucumber-pr-review-transitions-migration.md) |
| T311 | Cucumber候補 | 移行済み | [cucumber-pr-review-transitions-migration.md](cucumber-pr-review-transitions-migration.md) |
| T312 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T313 | Cucumber候補 | 移行済み | [cucumber-pr-review-transitions-migration.md](cucumber-pr-review-transitions-migration.md) |
| T314 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T315 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-pr-review-transitions-migration.md](cucumber-pr-review-transitions-migration.md) |
| T316 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-pr-review-transitions-migration.md](cucumber-pr-review-transitions-migration.md) |
| T317 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T318 | Cucumber候補 | 移行済み | [cucumber-requeued-pr-review-migration.md](cucumber-requeued-pr-review-migration.md) |
| T319 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T320 | Cucumber候補 | 移行済み | [cucumber-requeued-pr-review-migration.md](cucumber-requeued-pr-review-migration.md) |
| T321 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T322 | Cucumber候補 | 移行済み | [cucumber-requeued-pr-review-migration.md](cucumber-requeued-pr-review-migration.md) |
| T323 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-bounded-pr-recovery-migration.md](cucumber-bounded-pr-recovery-migration.md) |
| T324 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T325 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T326 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T327 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T328 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T329 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T330 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T331 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T332 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T333 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T334 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T335 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T336 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T337 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T338 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T339 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T340 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T341 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T342 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T343 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T344 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T345 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T346 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T347 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T348 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T349 | Cucumber候補 | 移行済み | [cucumber-requeued-pr-review-migration.md](cucumber-requeued-pr-review-migration.md) |
| T350 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T351 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T352 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T353 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T354 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T355 | Cucumber候補 | 移行済み | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T356 | Cucumber候補 | Vitest 継続へ再分類 | [cucumber-migration-record.md](cucumber-migration-record.md) |
| T357 | Cucumber候補 | 移行済み | [分類表内の Issue #113 移行記録](cucumber-test-classification.md) |
| T358 | Cucumber候補 | 移行済み | [分類表内の Issue #113 移行記録](cucumber-test-classification.md) |
| T359 | Cucumber候補 | 移行済み | [分類表内の Issue #113 移行記録](cucumber-test-classification.md) |
| T360 | Cucumber候補 | 移行済み | [分類表内の Issue #113 移行記録](cucumber-test-classification.md) |
| T361 | Cucumber候補 | 移行済み | [分類表内の Issue #113 移行記録](cucumber-test-classification.md) |
| T362 | Cucumber候補 | 移行済み | [分類表内の Issue #113 移行記録](cucumber-test-classification.md) |
| T363 | Cucumber候補 | 移行済み | [分類表内の Issue #113 移行記録](cucumber-test-classification.md) |
| T364 | Cucumber候補 | 移行済み | [分類表内の Issue #113 移行記録](cucumber-test-classification.md) |
| T365 | Cucumber候補 | 移行済み | [分類表内の Issue #113 移行記録](cucumber-test-classification.md) |
| T366 | 削除候補 | 削除済み | T369〜T371 が現行の完了ファイル契約を確認する |
| T367 | 削除候補 | 削除済み | T369〜T371 が現行の完了ファイル契約を確認する |
| T368 | 削除候補 | 削除済み | T369〜T371 が現行の完了ファイル契約を確認する |
| T369 | Cucumber候補 | Vitest 継続へ再分類 | 作業領域外の一意な完了ファイルパスをプロンプトへ描画する局所診断として残す |
| T370 | Cucumber候補 | Vitest 継続へ再分類 | 停止時にも完了ファイルを要求するプロンプト境界の静的診断として残す |
| T371 | Cucumber候補 | 同じ保証へ統合 | `worker-launch-and-monitoring.feature.md` の完了ファイルだけを根拠に監視を終える保証へ統合 |
| T372 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T373 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T374 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T375 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T376 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T377 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T378 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T379 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T380 | Cucumber候補 | 移行済み | [cucumber-operator-status-verification.md](cucumber-operator-status-verification.md) |
| T381 | Cucumber候補 | 移行済み | [cucumber-operator-status-verification.md](cucumber-operator-status-verification.md) |
| T382 | Cucumber候補 | 移行済み | [cucumber-operator-status-verification.md](cucumber-operator-status-verification.md) |
| T383 | Cucumber候補 | 移行済み | [cucumber-operator-status-verification.md](cucumber-operator-status-verification.md) |
| T384 | Cucumber候補 | 移行済み | [cucumber-operator-status-verification.md](cucumber-operator-status-verification.md) |
| T385 | Cucumber候補 | 移行済み | [cucumber-operator-status-verification.md](cucumber-operator-status-verification.md) |
| T386 | Cucumber候補 | 移行済み | [cucumber-operator-status-verification.md](cucumber-operator-status-verification.md) |
| T387 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T388 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T389 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T390 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T391 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T392 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T393 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T394 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T395 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T396 | Cucumber候補 | 移行済み | [cucumber-worker-launch-monitoring-migration.md](cucumber-worker-launch-monitoring-migration.md) |
| T397 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T398 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
| T399 | Vitest継続 | Vitest 継続 | [分類表の診断価値](cucumber-test-classification.md) |
