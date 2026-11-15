# 実測で判明した事実

設計や実装の前提になる、実機で確かめた事実。根拠となるテストやデータを併記する。追記は表の末尾に行う。記憶や推測で書かず、確かめたものだけを載せる。

対象バージョン：BDS 1.26.63.1、Java版 26.3、`@minecraft/server` 2.12.0-beta（別記がない限り）。

## 環境・サーバー

| 事実 | 根拠 |
| --- | --- |
| Java 26.3 サーバーは JRE 25 が必要 | Mojang のバージョンマニフェスト（`javaVersion.majorVersion`） |
| Java 26.3 はプレイヤーがいないと原点付近のチャンクも読み込まない。`forceload` が必要 | `packages/bridge/src/java.ts` |
| Java 26.3 の RCON は、1回の受信で届いた複数のパケットのうち先頭しか処理しない（続けて送ると取りこぼし、接続を切ることがある）。コマンドは1つずつ送る | `packages/bridge/src/rcon.ts`、`bridge.servers.test.ts` |
| Java 26.3 の RCON は、1,446 バイトを超えるコマンドを受け取ると接続を切る。長い応答は 4,096 文字ごとのパケットに分けて返し、終わりの印はない | 同上 |
| Java 26.3 の RCON は、未定義の種類のパケットを受け取ると接続を切る。空のコマンドには応答しない | 同上 |
| BDS の平坦ワールドは `level.dat` の `Generator=2` で作れる（y=-64 岩盤、-63〜-62 土、-61 草） | `bridge.servers.test.ts` |
| BDS のベータAPIは `level.dat` の `experiments.gametest=1` で有効になる | 検証パックの起動 |
| BDS の `level.dat` は自前のNBT実装で読み書きでき、書き戻すとバイト単位で一致する | 2026-11-15 の確認 |

## Script API

| 事実 | 根拠 |
| --- | --- |
| `runCommand` は構文エラーで例外を投げ、実行時の失敗では `successCount: 0` を返す（理由の文字列は取れない） | `bridge.servers.test.ts` |
| `ScoreboardObjective.getScore` は、一度もスコアを持ったことのない名前で例外を投げる | `poc/launcher` |
| 起動口の挙動（成否の伝搬、実行順、ハンドラ内の制限、実行コンテキストの復元）は `design.md` 7章のとおり | `poc/launcher/launcher.servers.test.ts` |
| カスタムコマンドのハンドラ内でも動的プロパティは読み書きできる（ワールドの変更だけが禁止） | 同上 |
| ネザーのIDは BE が `nether`、Java が `the_nether`。BE で `execute in the_nether` は構文エラーになり、カスタムコマンドもBEコマンドも動かない | `poc/launcher/dimension.servers.test.ts` |
| `execute in nether` を挟むと発生元は `Server` になり、ハンドラからディメンションはわからない。別ディメンションのチャンクが読み込まれていなくてもハンドラは動く | 同上 |
| 動的プロパティの文字列1件は UTF-8 で 32,767 バイトまで（文字数ではなくバイト数）。ワールドとエンティティで同じ。超えると `ArgumentOutOfBoundsError` | `poc/dynamic-properties/` |
| 動的プロパティの合計は、ワールド・エンティティとも 32MB まで書いて上限に当たらなかった | 同上 |
| 動的プロパティは再起動後も、エンティティのチャンクを読み込み直した後も残る（約8MBで確認） | 同上 |
| tick内の実行順は BE が「コマンドブロック → `tick.json` → `runInterval` → `system.run` → `scriptevent`」、Java が「`tick` 関数 → コマンドブロック」（推定）。詳細は `design.md` 7章 | `poc/tick-order/` |
| `system.run` の実行順は積んだ順ではない。スクリプトの処理中（`runInterval` 内）に積んだものが、コマンドブロックの処理中に積んだものより先に動く | 同上 |
| リピートコマンドブロックは、同じチャンク内では BE・Java とも置いた順（保存された順）に動く。座標順ではない。再起動後も同じ | `poc/tick-order/cb-order.servers.test.ts` |
| チャンク間の実行順は、Java はセッション中一定だが再起動ごとに変わり得る。BE はおおむねチャンク順だが tick によって入れ替わる（38tick中1〜2回） | 同上 |

## ブロック・座標

| 事実 | 根拠 |
| --- | --- |
| BE の階段は `weirdo_direction`（0〜3）、`upside_down_bit`、`minecraft:corner` を持つ | `bridge.servers.test.ts` |
| BE の比較器は `minecraft:cardinal_direction` と `direction` の両方を持ち、`cardinal_direction=south` のとき南側（+Z）から入力を受ける | `poc/launcher` |
| `execute in` でネザーへ移ると x・z が 1/8 になる（y はそのまま）。BE と Java で同じ | `poc/launcher/dimension.servers.test.ts` |
| 整数座標の x・z は中心（+0.5）に寄り、`.0` を付けると寄らない。`summon`、`execute positioned`、`~` での加算、`tp` のどれでも BE と Java で一致する（以前「JE では 7.0」と書いていたのは実測前の誤り） | `poc/coordinates/` |
| セレクタの `x=,y=,z=` は中心に寄らない（BE・Java とも） | 同上 |
| ブロック座標に小数を直接書くと、Java は構文エラー、BE は切り捨てて実行する。`~` 経由ならどちらも切り捨て | 同上 |
| 自前で生成した `.mcstructure` のコマンドブロック（インパルス・チェーン、常時実行、条件付き）は `structure load` で動く。ブロックの version とコマンドブロックの Version は仮の値（#9） | `poc/launcher` |
