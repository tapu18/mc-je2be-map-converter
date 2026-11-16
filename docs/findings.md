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

## Java版の保存形式（26.3、DataVersion 5023）

| 事実 | 根拠 |
| --- | --- |
| チャンクは `dimensions/minecraft/<ディメンション>/region/`、エンティティは同じく `entities/` にある。チャンクは zlib 圧縮 | `packages/bridge/src/java-dump.servers.test.ts` |
| ブロックのパレットは型の混ざったリストで、状態のないブロックは文字列、状態のあるブロックは `{id, properties}`。文字列の要素はキーが空文字の compound `{"": "minecraft:stone"}` で包んで保存される | 同上、`packages/core/src/java/world.ts` |
| スコアは `data/minecraft/scoreboard.dat`、storage は `data/<名前空間>/command_storage.dat`（どちらも gzip の NBT） | 同上 |
| エンティティのタグは集合として保存され、付けた順にはならない | 同上 |
| 状態がすべて既定値のブロックは、状態なしの文字列としてパレットに保存される。たとえば既定の向き（`facing=north`、`conditional=false`）のコマンドブロックは `"minecraft:command_block"` だけになる。既定値はデータ生成の `blocks.json` で補う | `packages/bridge/src/extract.servers.test.ts`、配布マップで36個 |
| ブロックステートの値は Java が文字列、BE が数値・真偽値・文字列。両エディションのダンプを比べるときは型を合わせる必要がある | 同上、`bridge.servers.test.ts` |

## 地形変換器（Chunker 1.21.0、Java 26.3 → BE 1.26.60 形式）

| 事実 | 根拠 |
| --- | --- |
| コマンドブロックの種類・向き・条件付き・常時実行・レッドストーン必要・名前付きは運ばれ、BE でそのまま動く。コマンド文字列は変換されない | `poc/terrain-converter/chunker.servers.test.ts` |
| 現行構文の `execute`（`if block`、`positioned`）を含むコマンドブロックは、変換後の BE で動く | 同上 |
| エンティティは1体も運ばれない（防具立て、豚、marker、表示用エンティティ、interaction）。Java→Java 変換でも消え、旧来の `entities/` に置いても同じ | 同上、#6 のコメント |
| スコアボードと command storage は運ばれない | 同上 |
| CLI は `java -jar chunker-cli-1.21.0.jar -i <入力> -f BEDROCK_R26_60 -o <出力>`。小さなワールドで約1.6秒 | 同上 |

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

## コマンドの意味の違い

| 事実 | 根拠 |
| --- | --- |
| `scoreboard players operation ... /=` は、Java が負の無限大方向に切り捨て（7 / -2 = -4）、BE が 0 方向（-3） | `scenarios/scores/arithmetic.json` |
| `%=` は、Java が割る数と同じ符号（7 % -2 = -1、-7 % 2 = 1）、BE が割られる数と同じ符号（1、-1） | 同上 |
| `scoreboard players add` で int があふれると、Java は折り返し（7 + 2147483647 = -2147483642）、BE は加算が失敗して値が変わらない | 同上 |

## ブロック・座標

| 事実 | 根拠 |
| --- | --- |
| BE の階段は `weirdo_direction`（0〜3）、`upside_down_bit`、`minecraft:corner` を持つ | `bridge.servers.test.ts` |
| BE の比較器は `minecraft:cardinal_direction` と `direction` の両方を持ち、`cardinal_direction=south` のとき南側（+Z）から入力を受ける | `poc/launcher` |
| `execute in` でネザーへ移ると x・z が 1/8 になる（y はそのまま）。BE と Java で同じ | `poc/launcher/dimension.servers.test.ts` |
| 整数座標の x・z は中心（+0.5）に寄り、`.0` を付けると寄らない。`summon`、`execute positioned`、`~` での加算、`tp` のどれでも BE と Java で一致する（以前「JE では 7.0」と書いていたのは実測前の誤り） | `poc/coordinates/` |
| セレクタの `x=,y=,z=` は中心に寄らない（BE・Java とも） | 同上 |
| ブロック座標に小数を直接書くと、Java は構文エラー、BE は切り捨てて実行する。`~` 経由ならどちらも切り捨て | 同上 |
| 自前で生成した `.mcstructure` のコマンドブロック（インパルス・チェーン・リピート、常時実行、条件付き）は `structure load` で動く | `poc/launcher`、`poc/mcstructure-version/version.servers.test.ts` |
| BDS 1.26.63.1 が新規作成・保存するブロックの `version` は `18168865`（`0x01153c21`）、コマンドブロックの `Version` は3種類とも `55`。製品バージョンから計算した値とは異なる。この値で生成した構造物では、新しい `execute positioned`・`if block`・`if/unless score` が実行され、条件付きチェーンにも成否が伝搬する | `poc/mcstructure-version/` の実サーバーテスト、`results.json`、BDS保存データ `native.mcstructure`（#9） |

## ID 対応表（Geyser 固定版）

| 事実 | 根拠 |
| --- | --- |
| Geyser mappings `e9271c0`（BE 1.26.60 向け）の対応を使い、BDS 1.26.63.1 上で石・レンガ、丸太3軸、乾いたスラブ3種、乾いた直線階段4方向×上下の計16状態を `setblock` で配置でき、表が明示する型・状態を読み戻せた。JE との挙動等価性、水没レイヤー、全状態の互換性はこの測定の対象外 | `packages/bridge/src/mappings.servers.test.ts` の `places and reads back ...`。2026-11-15、3回連続成功（#56） |
| 同表の `minecraft:stone` の状態指定は空だが、BDS 1.26.63.1 で `setblock ... minecraft:stone []` として配置して Script API で読むと `stone_type: "stone"` が補われる。表の明示状態と、サーバーで補われる既定状態を区別する必要がある | 同テストの stone の読み戻し検査、3回連続成功 |

## 性能

| 事実 | 根拠 |
| --- | --- |
| 1チャンクの常時実行リピート100個でスコア加算を行う最小処理は、BEコマンド直接実行・カスタムコマンド→キュー・scriptevent→キューの全経路で毎tick100更新となり、平均tick間隔は約50msを維持した。Core i5-11400 / WSL2で各100tick×2回測定。全スレッド合計のBDS CPU時間/tickは、基準1.54〜1.65ms、直接2.25〜2.33ms、custom 5.58〜5.92ms、scriptevent 5.00〜5.69ms。CPU時間はメインスレッドのMSPTではなく、完成したランタイムやスマホの評価でもない | `poc/repeat-performance/performance.servers.test.ts`、`results.json`、`samples.jsonl`（#5） |
| 500個を2チャンクに密集させると全経路とも200更新/tick、8チャンクに分散すると500更新/tickになった。どちらも平均tick間隔は約50msのため、tick間隔だけでは処理量の低下を見抜けない。密集時の更新制限の原因・閾値は未確認 | 同上 |
| runIntervalでキューを反映する最小処理では、custom経由は起動と同tick、scriptevent経由は1tick後に加算された。キュー処理件数の合計と各IDのスコア差分の合計は一致した | 同上 |

## コマンドの文法（Java 26.3）

| 事実 | 根拠 |
| --- | --- |
| データパックの関数は読み込み時に全行がパースされ、1行でも失敗すると関数ごと読み込まれない。ログに `Failed to load function <ID>` と、次の行にエラー文（`Whilst parsing command on line N: ...`）が出る。これを使い、コマンドを1つずつ関数にして Java に文法を判定させられる | `packages/bridge/src/java-syntax.ts`、`packages/bridge/src/command-parser.servers.test.ts`（3回連続成功、#13） |
| 関数の読み込み時のパースは文法だけでなく、ブロック・パーティクル・attribute などのレジストリ、データパック内の述語・ルートテーブル・タグの参照、コンポーネントや述語の値の形も確かめる（例：`fill ... minecraft:` の空の ID、`attribute ... minecraft:generic.max_health`、その場で書いた述語の形が違うもの） | 同上 |
| 26.3 で読めるもの：パスが空のリソース ID（`storage ns:`）、NBT パスの `.` の直後の `[0]`（`Items.[0]`）、`@e[tag=]`、セレクタの `=` や `,` の前後の空白、SNBT の末尾のカンマ・16進・`_` 区切り・`5ub`・`bool()`・`uuid()`・`\n` などのエスケープ、型の混ざったリスト | 同上 |
| 26.3 で読めないもの：アイテムの `id{NBT}`（1.20.5 より前の書き方）、旧形式の `particle dust 1 0 0 1 ...`、`gamerule` の旧名（`keepInventory`）、`@e[limit=0]`、セレクタの `x=~1`、`^` と `~` の混在、`~~1~` のような区切りのない座標、ブロック座標の小数、引数の間の空白2つ、区切りのない SNBT（`{a:1 b:2}`） | 同上 |
| 配布マップ19本のコマンド（コマンドブロック 3,541、関数の行 111,946。うちマクロ行 3,630 は除く）を 26.3 の文法でパースすると 97.8% が読めた（コマンドブロック 98.4%、関数 97.8%）。DataVersion 別では、1.20.4 のマップ（対象外）が 85.5%（旧形式の `particle` が大半）、1.20.5 以降は 99.0〜100% | `tools/parse-corpus.ts`（集計値のみ。2026-11-16、#13） |
| 重複を除いた 100,182 件を Java 26.3 にも読ませると、Java が読めてパーサが読めないものは 0 件、両方読めないものは 2,186 件、パーサだけが読めたものは 1,399 件。後者はすべてレジストリ・データパック内の参照・値の形の検証によるもので、文法の違いではない（#59） | `tools/parse-corpus.ts --java`（同上） |
| 独自 fixture の predicate・loot_table・item_modifier・ブロックタグを参照する4コマンドは、バニラだけの判定では全て拒否され、定義を含むパックを同時に読み込むと全て受理された。旧 `minecraft:generic.max_health` と `custom_model_data=1` は同じパック構成でも拒否された | `packages/bridge/src/java-validation.servers.test.ts`、2026-11-16（#59） |
| 存在しない predicate の型をパックに定義すると、Java 26.3 は `Failed to load datapacks` として起動を中止した。この場合はコマンドの合否を取れない | 同テストの `reports an unreadable registry context ...` |
| 判定用コピーの関数本文を空にして元の load タグと関数 ID を残した状態で起動し、load 関数と判定対象に書いたスコア目標追加のどちらも実行されず、保存後のスコア目標は空だった。元パックの関数本文は変化しなかった | 同テストの `does not execute ...`。`JavaWorld.scoreboard()` で保存データを確認 |
| 同じ定義をディレクトリと ZIP から判定用コピーにした場合、Java 26.3 は通常の predicate と有効オーバーレイの predicate をどちらも受理し、未提供の predicate をどちらも拒否した。ZIP のバイト列と元関数本文は変化せず、通常・オーバーレイの load 関数に書いたスコア目標追加は実行されなかった（保存後のスコア目標は空） | `packages/bridge/src/validation-context.servers.test.ts`、2026-11-16（#63） |
| Java 26.3 で保存した `Data.DataPacks.Enabled` の順序を新規判定ワールドの有効順へ渡すと、その順序で有効化された。`Disabled` のパックが持つ predicate は判定に混入せず、その参照は拒否された | 同テスト。保存された `level.dat` と RCON の `datapack list enabled`、関数読み込み結果で確認 |

## 変換の通し（Java 26.3 → Chunker 1.21.0 → BDS 1.26.63.1）

| 事実 | 根拠 |
| --- | --- |
| 変換後のワールドに入れたビヘイビアーパックの `world.afterEvents.worldLoad` で `scoreboard.addObjective` と `setScore` を呼ぶと、スコアを書き込める。`BedrockServer.start` が戻った時点（検証パックの準備完了と読み込み範囲の読み込みの後）では書き込みは終わっていた | `scenarios/convert/scores-chain.json`（`packages/bridge/src/scenario/scenarios.servers.test.ts`、3回連続成功、#61） |
| Java の偽プレイヤー名（`#a`、`$b`、`kept` などの英数字の名前）を `setScore` に文字列で渡すと、BE で同じ名前の `FakePlayer` になり、BE のコマンド（`scoreboard players operation #a t += #b t`）から同じ名前で参照できる | 同上 |
| Java で `auto:0b`（レッドストーン必要）にしたインパルスとチェーンは、Chunker で変換した後、BE で隣にレッドストーンブロックを置くと動く。条件付きチェーンの成否、`~` を使う `setblock`、`fill`、`clone` の結果は Java と一致した | `scenarios/convert/redstone-block-ops.json`、`scores-chain.json`（同上） |
