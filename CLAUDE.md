# mc-je2be-map-converter

Java版（JE）の配布ワールドを統合版（BE）で遊べる形に変換するコンバータ。地形は既存の変換器に任せ、コマンドブロック・データパック・Java専用エンティティの移植を担う。

- 設計の正本: `docs/design.md`（`docs/design-notes.md` は初期の検討メモ。食い違えば design.md を優先）
- 実測で判明した事実: `docs/findings.md`
- 正解データのシナリオの書き方: `docs/scenarios.md`
- PoC の書き方と共通の小道具: `docs/poc.md`
- 配布マップのコマンドの型の頻度と、M1 の検証用マップに入れる型: `docs/corpus-patterns.md`
- 作業の管理: GitHub の Issue・マイルストーン・PR（https://github.com/tapu18/mc-je2be-map-converter）。手順は `docs/workflow.md`
- 開発は複数のAIエージェントが並行して進める。人は `needs-approval` の判断、段階の関門での承認、実クライアントでのプレイ確認を担う

## 構成

| パス | 内容 |
| --- | --- |
| `packages/core` | Minecraft非依存の中核（NBT、今後パーサ・中間表現・ランタイム中核）。ゲーム内でも動かすため Node / DOM のAPIを使わない |
| `packages/bridge` | 検証ブリッジ（Node専用）。Java版サーバー（RCON）とBDS（検証パック経由）を起動・操作する。`JavaServer.dump()` で保存データからブロック・スコア・storage・エンティティを取り出す |
| `packages/bridge-pack` | BDSに入れる検証用ビヘイビアーパック。`scriptevent je2be:req <JSON>` を受け、`JE2BE_RES <JSON>` をコンソールに出す |
| `scenarios/` | 正解データのシナリオと、Java で記録した結果（`docs/scenarios.md`）。機能は先にシナリオを書いてから作る |
| `poc/` | PoC（実機での検証）。各ディレクトリにパック、テスト、実測結果（`results.json`） |
| `tools/` | 開発用スクリプト。`servers.json` に検証用サーバーの固定バージョン |
| `scripts/` | コーパス調査用のPythonスクリプト（`sample-map/` を読む） |
| `servers/` | 取得したサーバー一式（git管理外） |
| `sample-map/` | 調査用の配布マップ19本（git管理外、権利上リポジトリやCIに載せない） |

## コマンド

```sh
npm install
npm run setup:servers   # JRE 25、Java版サーバー、BDS、Chunker（地形変換器）を servers/ に取得（EULA同意済みとして扱う。ユーザー承認済み）
npm run check           # 型チェック＋Nodeだけのテスト。変更のたびに通す
npm run test:servers    # 実サーバーを起動するテスト（*.servers.test.ts）。数十秒かかる
```

TypeScriptはNodeで直接実行する（型除去）。そのため enum、namespace、コンストラクタ引数でのプロパティ宣言は使わない（`erasableSyntaxOnly`）。相対importは `.ts` 拡張子付きで書く。

## 作業ルール

- **`docs/workflow.md` の手順に従う。** Issue に `claim:` コメントを書いて着手し、worktree とブランチを分け、PR で CI を通してからマージする。区切りごとに Issue へ進捗をコメントし、途中で止まっても別のエージェントが再開できる状態にする。
- **実測した事実は `docs/findings.md` に根拠付きで残す。**
- **Script APIの仕様は記憶で書かない。** `node_modules/@minecraft/server/index.d.ts`（固定バージョン）と、BDSでの実測を根拠にする。ベータAPIは使ってよいが、利用はホスト層に閉じ込める。
- **Java側の正解は実サーバーで取る。** 期待値を手で書いたテストより、Java版サーバーで記録した結果との突き合わせを優先する。
- **未確認の仮定は実測して記録する。** `docs/design.md` の「未確認」やPoCチェックリストは、結果と根拠（テストやログ）で更新する。
- **設計を変えたいときは、根拠を添えて提案し、承認後に `docs/design.md` を更新する。**
- **区切りごとにコミットして push する。** 1コミット1目的。`npm run check` が通る状態でコミットする。
- 出力先BEは最新版に追従する。BDSと `@minecraft/*` のバージョンを上げるときは `tools/servers.json` と各 `package.json` を同時に更新し、`npm run test:servers` を通す。
- メモリは7GB程度。Java版サーバーは `-Xmx1G` で起動し、BDSと同時に動かすのは必要なときだけにする。

## 主張の確度

文書・Issue・PR・コメントに書く主張には、確度を区別して書く。M0 で、実測していない記憶（「JE では `positioned 7 8 9` が 7.0 のまま」）が `design.md` と `findings.md` に残り、後で誤りとわかった（#10）。

| 確度 | 意味 | 書き方 |
| --- | --- | --- |
| 実測 | サーバーで確かめ、根拠のテストやデータがある | 根拠（テスト名、`results.json`、コミット）を併記する |
| 推定 | 実測から推論したが、直接は確かめていない | 「推定」と書き、前提を添える（例：「RCON がtickの合間に処理されるとすれば」） |
| 未確認 | 記憶、ドキュメント、ソースを読んだだけ | 「未確認」と書き、確かめる Issue を添える |

- `docs/findings.md` には「実測」だけを載せる。推定と未確認は Issue に書く。
- ソースを読んでわかったこと（外部ツールの実装など）は「未確認」として扱う。#6 では、ソースから予想した問題（Chunker が `Version` を書かない）が実測では起きなかった。
- 実験が結論を区別できる配置になっているかを確かめてから結論を書く。#18 では、置いた順と座標順が同じ配置だったため「BE は座標順」と誤りかけた。

## 手順の落とし穴

M0 で実際に起きた失敗。どれも手順書に書いただけで仕組みにはしていないため、読み落とすと再発する。将来は `tools/` のスクリプトにまとめる候補（未着手）。

| 落とし穴 | 起きたこと | 守り方 | スクリプト化の候補 |
| --- | --- | --- | --- |
| 積み上げた PR の base ブランチを先に消す | 上に積んでいた #17 が自動でクローズされた | 下の PR を `--delete-branch` なしでマージ → 上の PR の base を main に → 下のブランチを削除（`docs/workflow.md` 3節） | `tools/merge-pr.sh` |
| push 直後に CI を待つ | CI が未登録で `gh pr checks --watch` がすぐ終わり、#28 を CI 前にマージした | `tools/wait-pr-ci.sh <PR番号>` で待つ | `tools/merge-pr.sh` に組み込む |
| 新しい worktree でパックをビルドしていない | BDS の起動待ちでタイムアウトした（ブリッジは今はエラーで知らせる） | worktree を作ったら `npm ci && npm run setup:servers && npm run build:pack` | `tools/new-worktree.sh <Issue番号>` |
| RCON の応答を信じる | 長い応答が黙って切れ、記録が欠けた（#18 で修正） | Java の RCON の癖（`docs/findings.md`）を踏まえる。1コマンド 1,446 バイトまで | 修正済み（`packages/bridge/src/rcon.ts`） |
| `pkill -f` で自分を止める | パターンがシェル自身のコマンドラインに一致し、シェルごと終了した | プロセスの停止はスクリプトファイルに書いて実行するか、PID を指定する | — |
| 実行ごとに揺れる結果を固定する | #18 のテストが3回に1回失敗した | 新しい実機テストは3回流してから PR を出す。揺れる性質は期待値にしない | — |
