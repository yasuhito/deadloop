# 機能: 着手可能な Issue だけを選ぶ

Issue coordinator は、公開ラベルと依存関係を確認して、Worker が安全に開始できる
Issue だけを作業対象にする。

これにより、準備不足、進行中、または未完了の作業に重複して着手しない。

## シナリオ: 準備済みの Issue を作業対象に選ぶ

* 前提 選定可能な Issue が `ready-for-agent` と `agent:implement` のラベルを持つ
* もし Issue coordinator が作業対象を選ぶ
* ならば その Issue は作業対象に選ばれる

## シナリオ: 作業中の Issue を作業対象に選ばない

* 前提 作業中の Issue が `agent:in-progress` ラベルを持つ
* もし Issue coordinator が作業対象を選ぶ
* ならば 作業中の Issue は作業対象に選ばれない

## シナリオアウトライン: 未完了の本文依存を持つ Issue を作業対象に選ばない

* 前提 選定可能な Issue が本文の"<位置>"で未完了の依存を示す
* もし Issue coordinator が作業対象を選ぶ
* ならば 未完了の依存を持つ Issue は作業対象に選ばれない

### 例:

  | 位置 |
  | 依存欄 |
  | 末尾 |

## シナリオ: 完了した本文依存を持つ Issue を作業対象に選ぶ

* 前提 選定可能な Issue が本文で完了した依存を示す
* もし Issue coordinator が作業対象を選ぶ
* ならば 完了した依存を持つ Issue は作業対象に選ばれる

## シナリオ: GitHub 上の未完了の依存を持つ Issue を作業対象に選ばない

* 前提 選定可能な Issue が GitHub 上で未完了の依存を持つ
* もし Issue coordinator が作業対象を選ぶ
* ならば GitHub 上の未完了の依存を持つ Issue は作業対象に選ばれない
