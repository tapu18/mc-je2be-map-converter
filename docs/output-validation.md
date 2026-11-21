# 生成物の検証範囲（#68）

変換器が出すワールドを、検証ブリッジが設定を補わずに起動して確かめる。
通常の調査用ワールドの補助設定と、製品の出力に必要な設定を区別する。

## 設定と補助の区分

| 対象 | 区分・扱い |
| --- | --- |
| 生成した初期化パックとその有効化参照 | 変換器の出力。Javaの偽プレイヤーのスコアを初回に再注入する |
| Beta APIs、cheatsEnabled、commandsEnabled、commandblocksenabled | 変換器の出力。現在の生成パックは固定のbeta APIに依存し、移植したCBの実行も必要。既存の他の実験設定は保持して必要なものを足す |
| bridge-packと観測リクエスト | テスト用の観測補助。配布する製品ワールドには入れない。スコアの不足を補わない |
| 検証用structureパック | 調査用にCBを配置するための補助。変換後のCBを再作成するためには使わない |
| tickingarea | サーバーにプレイヤーがいない状態でCB等を観測するための補助。利用者のプレイヤー周辺の読み込みや製品に常時読み込まれる範囲を保証するものではない |
| BDSのオフライン・空きポート・ログ設定 | テスト環境の設定。製品ワールドの仕様ではない |
| BDSのallow-cheats | 通常の調査ではtrue。preserveでは出力のcheatsEnabledを読むため、不足をtrueに補わない |
| ワールドの取り込み、利用者による起動操作・移動、保存再読込 | 実クライアントで確認する項目。サーバーテストで代用しない |

`BedrockServer.start({ world, worldSettings: "preserve" })` はlevel.datの実験・コマンド許可を変更しない。
観測パックの追加は行う。`tickingArea: false` では読み込み範囲も追加しない。
変換を通すシナリオはpreserveを使い、CBの観測用tickingareaを使ったことは範囲の制約として残す。

## 自動スモークテスト

`packages/bridge/src/output-world.servers.test.ts` は自作scores-chainワールドを実際に変換して確認する。

- 読み込み範囲も設定も補わずに初期化パックが動き、keptのスコアが42になる。
- BDSのtickingarea一覧で観測用の領域がないことを確認する。
- スコアを99へ変更して保存再起動しても99のままで、初期化パックは再注入しない。
- 初期化パックの有効化参照を欠いたワールドではスコアが復元されない。観測パックが代わりに復元してしまわない。
- Beta APIsの設定を欠いたワールドでは起動準備が失敗し、BDSログに依存APIの実験が無効と出る。

初期測定では、従来の生成物にはBeta APIsがなく、設定を補わずに起動すると初期化パックも観測パックも
依存APIエラーで読み込まれなかった（2026-11-17）。これを変換器の出力設定で修正した。
この検証はスコアの初期化と保持の確認であり、地形・エンティティ・全コマンドの対応を保証しない。

出力スモーク1本と、4シナリオのJava/BE計8本を3回連続成功した
（141.26 / 141.00 / 153.47秒、2026-11-17）。

## 必須観測と差分

変換を通す受け入れシナリオには `requiredObservations` を宣言する。
正規化後のパスを使い、`scores.t`、`blocks`、`entities` のように指定する。配下の差分・比較不能も必須に含む。
必須のパスが両版のどちらかにない場合は不足とし、比較不能な必須項目も失敗にする。
調査用シナリオは宣言を省略でき、比較不能を調査の記録として扱える。

結果には必須項目の一致数・既知差分・不一致・比較不能・不足を表示する。
knownDiffsで説明した差分は許容できても、completeMatchはfalseとする。
完全一致は必須項目が存在し全て一致し、他の差分・比較不能もない場合だけ。
成功条件に反する差分をknownDiffsで隠さず、機能未達として記録する。

## 実クライアントでの受け入れ記録

取り込める.mcworldは変換CLI（#77）で作る。

```sh
npm run convert:world -- <Javaワールド> --out <出力.mcworld>   # ディレクトリ名を渡すとBEワールドのディレクトリを出す
```

- 入力ワールドは一時領域へコピーしてから変換し、原本は変更しない。既存の出力・レポートは上書きせずエラーにする
- 必要な資材（JRE・Chunker・版別文法・blocks.json・固定Geyser対応表と表示）がなければエラーにする。`setup:servers`・`setup:mappings`・`setup:grammars` を実行する
- .mcworld はワールド直下（level.dat・db・behavior_packs・world_behavior_packs.json 等）をアーカイブの直下に置く。Python 3 が必要
- Geyser の出典・MIT表示（`LICENSE.geyser.txt`・`NOTICE.geyser.txt`）をワールド直下と初期化パックに同梱する
- レポート（既定は `<出力>.report.json`）は常に `status: "partial"`、`clientVerification: "not-performed"`、`clearConfirmed: false` で、未対応・省略したコマンドの件数と未実装の範囲（`limitations`）を載せる

自動検査は `packages/bridge/src/convert-cli.servers.test.ts`。自作の検証ワールドをCLIで変換し、原本が変わらないこと、上書きを拒否すること、アーカイブの構成、
展開したワールドを設定補助・tickingareaなしでBDSで開きスコア42が復元されることを確かめる。
`JE2BE_ACCEPTANCE_ARTIFACTS=<ディレクトリ>` を付けて実行すると、そのとき作った `fixture.mcworld` とレポートを残す。下表の実クライアント確認にはこれを使う。

### 確認用ファイルの作り方（エージェントが行う）

```sh
JE2BE_ACCEPTANCE_ARTIFACTS=$HOME/je2be-acceptance-$(date +%Y%m%d-%H%M%S) \
  npx vitest run --config vitest.servers.config.ts packages/bridge/src/convert-cli.servers.test.ts
```

20秒ほどで、指定したディレクトリに `fixture.mcworld` と `fixture.report.json` ができる。既にあるファイルは上書きしないので、毎回新しいディレクトリを指定する。
中身はスーパーフラットのワールドに、スコア `t` の偽プレイヤー `kept`＝42と、未対応コマンド（`data get storage`）のコマンドブロック1つ。操作するギミックは入っていない。
`sha256sum` で成果物のハッシュを、`git rev-parse --short HEAD` で対象コミットを控える。
WSL では Windows のエクスプローラーから `\\wsl$\<ディストリビューション名>\home\<ユーザー>\...` で開ける。

### 人にお願いする操作

1. `fixture.mcworld` をダブルクリックして統合版へ取り込む
2. 取り込んだワールドを開く。実験的機能（Beta APIs）の警告は想定どおり
3. チャットで `/scoreboard objectives setdisplay sidebar t` を入力し、画面右に `kept 42` と出るかを見る
4. `/scoreboard players set kept t 99` を入力する
5. 一時停止メニューから「保存して終了」し、同じワールドを開き直して、右の表示が99のままかを見る（42に戻れば失敗）
6. ワールドの設定の「ビヘイビアーパック」に `je2be init` だけがあるかを見る

結果と併せて、統合版のバージョン（タイトル画面の右下）と機器を聞く。
Windows の統合版では、コンテンツログが `%APPDATA%\Minecraft Bedrock\logs\ContentLog*.txt`、ワールドが `%APPDATA%\Minecraft Bedrock\Users\<ID>\games\com.mojang\minecraftWorlds\` にあり、WSL から `/mnt/c/...` で読める（2026-11-21 に確認）。
ログやワールドは読むだけにし、調べるときはコピーを使う。

### 記録

以下の確認は #46 で行う。サーバー検証だけでM1や製品の完了とはしない。

2026-11-21 の確認：対象コミット `46f6b82`、成果物 `fixture.mcworld`（SHA-256 `bd80e04bf0935a0a92a88022d9018faac5b28590c1619856843451f540a12b94`）、Windows の統合版 1.26.65.1（level.dat の `lastOpenedWithVersion`）。

| 項目 | 状態 | 根拠・結果 |
| --- | --- | --- |
| 自作マップの.mcworldを実クライアントへ取り込む | 成功（2026-11-21） | ダブルクリックで取り込めた（所有者の操作） |
| 初回に偽プレイヤーのスコアが復元される | 成功（2026-11-21） | サイドバーに `kept 42`（所有者の確認）。コンテンツログに `[je2be] initialized 1 scores` が初回の1回だけ出た |
| ギミックが利用者の起動操作で動く | 未実施 | 確認用ファイルに操作するギミックがない。#46 の検証用マップでの確認待ち |
| 値を変えて保存し、ワールドを閉じて再読込する | 成功（2026-11-21） | 99に変えて開き直しても99（所有者の確認）。統合版が保存したワールドのコピーをBDSで開いても `kept`＝99 |
| ブリッジのパックやtickingareaに依存しない | 成功（2026-11-21） | 配布物と統合版が保存したワールドの `world_behavior_packs.json` は `je2be init` だけ。tickingareaなしでプレイヤー周辺で上記が成立 |

ワールドに入った直後に「At least one of your resource or behavior packs failed to load」と出たが、変換の不具合ではなかった。
初期化パックを除いたワールド、実験設定も除いたワールド、統合版で新規に作った何も変えないワールドでも同じ表示が出た（所有者の確認）。コンテンツログにエラーはなかった。
この統合版の環境に由来すると推定する（グローバルリソースなどは未確認）。

人の確認は「未実施／成功／失敗」を区別し、実施日・対象コミット・クライアント版・操作・結果・ログや画像を添える。
失敗と手修正は評価記録へ残す（#69）。実クライアントの通し確認がない状態でclearConfirmedをtrueにしない。
