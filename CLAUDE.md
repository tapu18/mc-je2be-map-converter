# mc-je2be-map-converter

Java版（JE）の配布ワールドを統合版（BE）で遊べる形に変換するコンバータ。地形は既存の変換器に任せ、コマンドブロック・データパック・Java専用エンティティの移植を担う。

- 設計の正本: `docs/design.md`（`docs/design-notes.md` は初期の検討メモ。食い違えば design.md を優先）
- 実測で判明した事実: `docs/findings.md`
- 作業の管理: GitHub の Issue・マイルストーン・PR（https://github.com/tapu18/mc-je2be-map-converter）。手順は `docs/workflow.md`
- 開発は複数のAIエージェントが並行して進める。人は `needs-approval` の判断、段階の関門での承認、実クライアントでのプレイ確認を担う

## 構成

| パス | 内容 |
| --- | --- |
| `packages/core` | Minecraft非依存の中核（NBT、今後パーサ・中間表現・ランタイム中核）。ゲーム内でも動かすため Node / DOM のAPIを使わない |
| `packages/bridge` | 検証ブリッジ（Node専用）。Java版サーバー（RCON）とBDS（検証パック経由）を起動・操作する。`JavaServer.dump()` で保存データからブロック・スコア・storage・エンティティを取り出す |
| `packages/bridge-pack` | BDSに入れる検証用ビヘイビアーパック。`scriptevent je2be:req <JSON>` を受け、`JE2BE_RES <JSON>` をコンソールに出す |
| `poc/` | PoC（実機での検証）。各ディレクトリにパック、テスト、実測結果（`results.json`） |
| `tools/` | 開発用スクリプト。`servers.json` に検証用サーバーの固定バージョン |
| `scripts/` | コーパス調査用のPythonスクリプト（`sample-map/` を読む） |
| `servers/` | 取得したサーバー一式（git管理外） |
| `sample-map/` | 調査用の配布マップ19本（git管理外、権利上リポジトリやCIに載せない） |

## コマンド

```sh
npm install
npm run setup:servers   # JRE 25、Java版サーバー、BDSを servers/ に取得（EULA同意済みとして扱う。ユーザー承認済み）
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
