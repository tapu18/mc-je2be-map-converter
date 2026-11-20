# 常時実行リピートのチャンク当たりの更新数（#31）

## 再現

```sh
npm ci
npm run setup:servers
npm run build:pack
npx vitest run --config vitest.servers.config.ts poc/repeat-density/density.servers.test.ts
```

テストは `servers/results.repeat-density.json` に観測値を書く。[results.json](results.json) は2026-11-20に両テストが成功した実行の記録。

## 測り方

- BDS 1.26.63.1 と Java 26.3 の新規平坦ワールドを使う。プレイヤーは接続せず、両版で同じ4×4チャンクを常時読み込み、同じ座標に無条件・常時実行のリピートを配置する。各ブロックが専用のスコアに 1 を加算する。
- 10 tick のウォームアップ後の40 tickを測る。BDS は同じ `system.runInterval` フェーズでスコアを読み、連続したスナップショットの差をチャンク別・ブロック別に集計する。Java は `tick freeze` 中にスコアを初期化し、`tick step 40` の完了をゲーム時刻で確かめ、保存したスコアを読み出す。
- 平面の200個は形と各ブロックのIDを保ったまま x 座標だけ8ずらし、1チャンクから100個ずつの2チャンクへ分ける。配置順の比較では上下2層に同じ座標とコマンドを使い、層を置く順だけを反転する。逆順の配置を保存して再起動後に再測定する。#18 では1個ずつ置いて相対順を調べた。今回は層単位の配置順を変えて更新数を測る。[#18 の実行順テスト](../tick-order/cb-order.servers.test.ts)
- 100個の直下にチェスト100個、または下向きホッパー100個と搬出先のチェスト100個を置く。BDS は測定中に全ホッパーの在庫が減ったことを確認する。Java は座標 (0, -51, 0) のホッパーの在庫で確認する。
- BDS の設定実験では、常時読み込み範囲と1チャンク200個の配置を固定する。ゲームルールは1項目ずつ変えて読み戻す。サーバー設定は変更ごとに再起動する。永続 ticking area の最大サイズは、既存の16チャンクを保ったまま、17チャンクの新規エリアが追加できるかを対照にする。

根拠データの `updatesByChunk` は各チャンクの毎tickの加算数、`perBlock` は座標に割り当てたID順の40 tickの加算数。Java の `updatesPerTick` は40 tickで割った平均。

## 実測結果

| 配置 | BDS の更新/tick（チャンク別） | Java の更新/tick（合計） |
| --- | ---: | ---: |
| 1チャンクに99個 | 99 | 99 |
| 1チャンクに100個 | 100 | 100 |
| 1チャンクに101個 | 100 | 101 |
| 1チャンクに200個（1層・2層） | 100 | 200 |
| 2チャンクに150 + 50個 | 100 + 50 | 200 |
| 2チャンクに100 + 100個 | 100 + 100 | 200 |
| 4チャンクに50個ずつ | 50 + 50 + 50 + 50 | 200 |
| 1チャンクに200個（2層を逆順に配置、再起動の前後） | 100 | 200 |
| 1チャンクに100個とチェスト100個 | 100 | 100 |
| 1チャンクに100個と稼働中のホッパー100個、搬出先チェスト100個 | 100 | 100 |

BDS では、1チャンクに101個置くと40 tickで合計4,000更新になり、各ブロックが1回以上更新した。200個を置くと各ブロックは40 tick中20回更新した。Java では同じ全配置で、各ブロックが40 tickで40回更新した。ホッパーの試行では、根拠データを取った試行ではBDSの全100個が各5個を払い出し、Javaの観測点では在庫が62個から57個に減った。

| BDS の変更（1チャンクに200個） | 更新/tick |
| --- | ---: |
| `maxCommandChainLength` を1、100000 | 100 |
| `functionCommandLimit` を1、10000 | 100 |
| `randomTickSpeed` を0、100 | 100 |
| `tick-distance` を4から12に変更 | 100 |
| `persistent-ticking-area-max-chunks` を100から16に変更 | 100 |
| `commandBlocksEnabled` を false、true | 0、100 |

`tick-distance` の測定範囲は、プレイヤーがいない常時読み込みエリア。永続 ticking area のサイズ設定は BDS 1.26.63.1 同梱の `server.properties` に記載がある。[BDS の server.properties](https://learn.microsoft.com/minecraft/creator/documents/bedrockserver/server-properties)、[GameRule の一覧](https://learn.microsoft.com/minecraft/creator/scriptapi/minecraft/server/gamerule?view=minecraft-bedrock-stable)
