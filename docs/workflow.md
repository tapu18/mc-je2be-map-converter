# 開発の進め方（複数エージェント向け）

複数のAIエージェントが並行して開発し、人は判断と実機確認を担う。作業の正本は GitHub の Issue と PR で、リポジトリ内の文書は設計（`design.md`）と実測した事実（`findings.md`）を持つ。

定期巡回で Codex / Claude Code を起動する管理プログラムは [agent-runner.md](agent-runner.md) を参照。`npm run agents -- --dry-run` で候補を確認できる。

## 役割

所有者（人）・PM（AI）・worker（AI）の3つ。責任、してよいこと・しないこと、受け渡しの形は [roles.md](roles.md) に定める。この文書の手順は、主に worker が Issue を完了させるためのもの。

## 管理の単位

- **マイルストーン**：段階（M0〜M5、`design.md` 7章）
- **Issue**：1つのPRで完了できる作業。完了条件は機械的に確かめられる形で書く
- **ラベル**

| ラベル | 意味 |
| --- | --- |
| `status:ready` | 着手可能。担当なし |
| `status:in-progress` | 作業中。担当は Issue の `claim:` コメントで示す |
| `status:in-review` | PR を提出済み。CI やレビュー待ち。マージされると Issue は閉じる |
| `status:paused` | 中断。再開手順が Issue のコメントにある |
| `status:blocked` | 他の Issue か人の判断を待っている |
| `needs-approval` | 所有者の判断待ち（判断の Issue）。判断が出るまでその Issue には着手しない |
| `owner-task` | 所有者にしかできない作業（プレイ確認、作者への依頼など） |
| `owner-inbox` | 判断の受付（ピン留めの Issue、1件だけ。[roles.md](roles.md#判断の受付)） |
| `type:*` / `area:*` | 種類と分野 |

## 作業の流れ

### 1. 着手する

1. `gh issue list --label status:ready --milestone "<現在の段階>"` から選ぶ。`needs-approval` が付いたものや、依存（Issueの「依存」欄）が終わっていないものは選ばない。
2. ラベルを `status:in-progress` に付け替え、`claim: <エージェント名>（ブランチ <ブランチ名>）` とコメントする。
3. コメントを読み直し、自分より前に別の `claim:` があれば手を引く（先に書いた方が担当）。
4. エージェント名は作業ごとに一意にする（例：`claude-poc-tick`）。全員が同じGitHubアカウントを使うため、assignee では区別できない。

### 2. 作業する

- **worktree を分ける。** 同じディレクトリで複数のエージェントが作業しない。
  ```sh
  tools/new-worktree.sh <Issue番号>
  cd ../je2be-<Issue番号>
  ```
- ブランチ名は `<Issue番号>-<短い説明>`（例：`3-poc-tick-order`）。
- 1コミット1目的。`npm run check` が通る状態でコミットする。
- こまめに push する。途中で止まっても、別のエージェントがブランチから再開できるようにするため。
- 区切りごとに、Issue に進捗コメント（何をしたか、何を確かめたか、次の一手）を書く。
- 実測した事実は `docs/findings.md` に根拠（テスト名、コミット）付きで追記する。設計に関わるものは `docs/design.md` にも反映する。
- 作業中に見つけた別の作業は、新しい Issue にする。今の PR に混ぜない。

### 3. PRを出してマージする

1. `gh pr create` で PR を出す。本文に `Closes #<番号>` を書く（テンプレートあり）。
2. CI の `check` と、実機テストの選択・結果を集約する `servers / result` が通るのを待つ。待つときは `tools/wait-pr-ci.sh <PR番号>` を使う（push 直後に実行が未登録のことがあるため、#28）。失敗したら直す。
3. マージの条件：
   - CI が通っている
   - Issue の完了条件を満たしている
   - 必要な人の判断が該当する Issue に記録されている
4. **条件を満たせば、エージェントが自分でマージしてよい**（2026-11-15 に所有者が許可）。作業中に判断が必要になった場合は、下記の手順で判断を待つ。
   - マージの方式は通常のマージコミット（`gh pr merge <番号> --merge`）。スカッシュは積み上げた PR で衝突を起こすため使わない。
   - マージ待ちの PR に依存する作業は、その PR のブランチから派生させ、PR の base をそのブランチにする（積み上げ）。
   - `tools/merge-pr.sh <PR番号>` は main 宛て PR の CI を待ち、マージ後に直接の後続 PR を main に切り替えてから元ブランチを削除する。途中で失敗した場合は状態を確認し、以下を手動で続ける。
   - 積み上げた PR をマージする手順：
     1. 下の PR を `--delete-branch` を付けずにマージする（**base のブランチを先に消すと、上に積んだ PR が自動でクローズされる**）
     2. 上の PR の base を main に切り替える（`gh pr edit <番号> --base main`）。base が main 以外のままマージすると `Closes #番号` で Issue が閉じない
     3. 下の PR のブランチを削除する（`git push origin --delete <ブランチ>`）
     4. 上の PR の CI が通っていることを `tools/wait-pr-ci.sh` で確かめてマージする（base を変えたり main を取り込んだりした後は、CI をもう一度待つ）
5. マージ後、worktree を片付ける（`git worktree remove`）。

### 4. 中断する

管理プログラムが起動した worker は、途中で終了するとき `status:paused` を付けず、claim も変更しない。進捗と再開手順を Issue に書き、可能な変更を push する。管理プログラムは次の巡回で同じ worktree から再実行し、起動回数を数える。依存や人の判断待ちは別途 `status:blocked` または `needs-approval` にする。

管理プログラムを使わない場合：

1. 作業中のブランチを push する。
2. Issue に再開手順をコメントする（どこまで済んだか、次に何をするか、気をつけること）。
3. ラベルを `status:paused` にする。`claim:` は取り消したと明記する。

## CI の時間予算と実行範囲

時間はワークフロー開始から完了までの目標。GitHub が開始前に待たせる時間は別に見る。実機ジョブは 20 分で打ち切る。

| トリガー | 予算 | 実行範囲 |
| --- | --- | --- |
| PR | 15 分 | `npm run check` と変更に対応する実機テスト |
| main への push、手動実行 | 20 分 | `npm run check` と隔離中を除く全実機テスト |
| 夜間（毎日 03:23 JST） | 25 分 | main と同じ範囲に加え、隔離中のテストを専用ジョブで実行 |

main への push CI は新しい push により実行中の古い実行を取り消すため、連続マージの途中のコミットには完了した検証結果が残らない場合がある。取消を維持する理由は #223 に記録する。管理プログラムは最新の完了済み push CI を確認するが、実行中の最新コミットが検証済みであることまでは保証しない。

PR の実機テストはマージ結果と base SHA の差分から `tools/server-test-plan.ts` が選ぶ。

- `scenarios/` のシナリオまたは正解 JSON の変更では、変更された ID の現存するシナリオを両エディションで検証する。BE 未実行の指定はそのまま扱う。
- テストがある `poc/<名前>/` の変更では、グループをまたいで同じディレクトリの実機テストを選ぶ。
- `docs/` とルートの Markdown だけなら実機テストを省略する。
- `packages/`、`tools/`、ワークフローなどの共有・未分類のパスや、差分を取得できなかった場合は、隔離中を除く全実機テストを選ぶ。PoC 間の共有データやコードを導入する場合は、この全件選択に入るパスへ置く。

実機ファイルのグループは `tools/server-test-groups.ts` が割り当てる。正解データのシナリオは ID 順に最大 12 件ずつ独立したランナーに分ける。各ジョブ内では同じサーバーディレクトリを使うため直列に実行し、各シナリオは従来どおり新しいワールドで起動する。

### 起動方式と 10 倍時の見積もり

一つのサーバー起動にまとめて座標範囲を片付ける方式は、起動時間を省ける。現在の形式ではスコアボード、storage、関数タグ、予約済み関数などがワールド全体に残るため、座標範囲の片付けだけでは前後の結果を独立にできない。変換シナリオは変換途中の Java 保存データと独立した BE ワールドも必要とする。サーバーを共有する方式には実行できる操作の制約とリセット検証が必要になるため、今回は独立したワールドを維持してジョブを並列化する。

[2026-11-21 の main の CI](https://github.com/tapu18/mc-je2be-map-converter/actions/runs/44900032141) で、シナリオ全 15 本は約 206 秒、変換を含むシナリオの連続した完了の間隔は約 19〜22 秒だった。実機ジョブの準備はテスト開始まで 40 秒以内で、bridge は約 826 秒、そのうち版別文法は約 310 秒だった。版別文法は独立ジョブに分ける。

推定では、同程度の負荷で 150 本になっても 13 ジョブ（12 件 × 12 ジョブと 6 件 × 1 ジョブ）に収まる。残りの実機 5 ジョブを含めて 18 並列枠が使える場合、1 件 25 秒とジョブ当たり準備 60 秒を見込んだシナリオは最大 6 分。最長は bridge の残り約 516 秒と準備 60 秒で約 10 分、計画の 1 分を足して全件選択でも約 11 分を見込む。通常の再試行に約 4 分の余裕があり、3 トリガーとも時間予算内となる推定。ランナー枠やキャッシュの状況、各シナリオの負荷が変わったら、CI の実測から分割数と予算を見直す。

### 揺れる実機テスト

- CI では失敗したテストケースを Vitest が 1 回再試行する。再試行後も失敗すればジョブは失敗する。再試行で通った場合はログに警告を出す。再試行したケースのファイル、テスト名、回数、最終結果をジョブの `server-logs-*` 成果物に `test-retries.jsonl` として保存する。起動準備、ファイル読み込み、フックなどケース外の失敗はジョブのログで調べる。
- 同じケースの失敗と成功が確認できたら、実行 URL とログの根拠、再現手順を Issue に記録して調べる。調査中に隔離する場合は `tools/server-test-quarantine.json` の `files` にファイルパス、または `scenarios` にシナリオ ID をキーとして登録し、値を追跡 Issue 番号にする。隔離分は夜間の `quarantine-*` ジョブに入り、失敗は通常ジョブの判定から分かれる。通常の実行で安定することを確かめたら登録を外す。

### 定期実行の確認と手動代替

日次の CI と週次の Version canary の実行履歴を確認し、予定の実行が見当たらなければ次を main で実行する。隔離の登録がない場合、隔離ジョブは生成されない。手動実行は人が確認して起動する運用であり、自動再試行ではない。

```sh
gh workflow run ci.yml --ref main -f include_quarantine=true
gh workflow run version-canary.yml --ref main
gh run list --workflow ci.yml --limit 10
gh run list --workflow version-canary.yml --limit 10
```

実行の完了と結果を Actions で確認する。CI の `servers / result` は隔離ジョブの失敗を含まないため、`quarantine-*` のログも個別に確認する。canary は下記の artifact を確認し、必要な版上げは別 Issue で追跡する。

## 衝突を避けるために

- `docs/findings.md` や `docs/design.md` の同じ節を、複数のPRが同時に編集しないようにする。追記は節の末尾に行う。衝突したら、main を取り込んで解消してから push する。
- 実サーバーを使うテストは、worktree ごとの `servers/` を使う。同時に起動するとポートが衝突する（#2 で解消予定）。
- `tools/servers.json`（サーバーのバージョン）を上げる PR は、ほかの作業と分ける。

## 人へのエスカレーション

人の判断がチャットなど GitHub の外で示された場合は、受け取ったエージェントが該当する Issue にコメントとして記録する（日付と判断の内容）。ほかのエージェントはその記録を承認として扱う。

次の場合は作業を止め、判断の Issue に `needs-approval` を付ける。判断が出るまでその Issue には着手しない。

- 設計（`docs/design.md`）の方針を変える必要がある
- 外部への影響がある（新しいリポジトリやサービスの作成、公開、費用の発生）
- ライセンスや配布マップの権利に関わる判断

判断の Issue は、テンプレート「判断」（`.github/ISSUE_TEMPLATE/decision.yml`）の節（問い・選択肢・推奨）で書き、所有者がその Issue だけで選べるようにする。書き方は [roles.md の判断の Issue の書き方](roles.md#判断の-issue-の書き方)。所有者には[判断の受付](roles.md#判断の受付)の一覧で届く。調査・比較・PoC がまだ必要なら、着手可能な子 Issue に分ける。子の本文先頭に `親（判断）: #番号`、親の本文に `Depends on: #子` を書く。子の提案は `docs/proposals/<名前>.md` に「未承認の提案」と明記して置く。承認後に親の作業で `docs/design.md` を更新する。

判断が出たら、まず親の Issue にその内容を記録し（形は [roles.md の受け渡し](roles.md#受け渡し)）、`needs-approval` を外してから、必要な実装の Issue に進む。判断の受付で受けた答えなら、元のコメントに「記録しました → #番号」と返信し、`npm run decisions -- --update` で一覧を更新する。

## サーバー・API の版上げ

`Version canary` は毎週月曜に公式 BDS Linux 配布 API、Mojang の Java 安定版マニフェスト、npm の `@minecraft/*` beta、Chunker の最新リリースを照合する。Actions の `workflow_dispatch` でも起動できる。使い捨て checkout で候補版に差し替え、型・Node テスト、実サーバー、Java 正解データの再記録、互換性台帳の再生成を順に試す。main の固定版は更新しない。候補は BDS と同じ安定版系列の beta API を選び、npm の beta タグも記録する。配布元が期待した形式を返さない場合は失敗として扱う。

Actions の `version-canary` artifact の `versions.json` に固定版・候補版・npm の beta タグ、`outcomes.txt` に各段階の結果がある。`api-*.log` は API と型、`setup.log` と `mappings.log` は配布物と ID 対応、`servers.log` は文法・保存形式・実サーバーの失敗を調べる入口。`record.log` と `scenarios.diff` は Java の再記録結果、`ledger/compatibility-diff.json` は ID と文法の台帳差分を示す。失敗箇所はログから個別に判断し、差分を自動的に正解とはしない。配布マップは CI に持ち込まず、台帳の頻度は未計数となる。検出に失敗した場合は Actions の検出ステップのログを見る。

版を正式に上げる際は別の作業ブランチで次を行う。

1. artifact の候補と公式配布元を確認し、`tools/servers.json` の URL・ハッシュ・Java DataVersion と `packages/*/package.json` の `@minecraft/*` を更新する。BE は BDS と API を同時に上げ、必要なら各パックの manifest の API 版も合わせる。`npm install` で lockfile を更新する。
2. `npm ci && npm run setup:servers && npm run setup:mappings && npm run build:pack && npm run check && npm run test:servers` を実行する。新しい版に必要な JRE や対応表があれば、出典・版を確認して更新する。
3. `npm run scenarios:record` で Java の正解を再記録し、差分の意味を実機で確認する。`docs/compatibility-ledger.md` の手順で台帳を再生成し、差分と根拠を確認して反映する。配布マップを使う場合は同文書の非公開入力の扱いに従う。
4. API、ID、文法、保存形式の失敗をそれぞれ調査して修正し、実測と根拠を記録する。CI と関連する実機テストが通ることを確認して PR にする。
