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
| tick内の実行順は BE が「コマンドブロック → `tick.json` → `runInterval` → `system.run` → `scriptevent`」。Java 26.3 は `tick step` で進めた4 tick で「`tick` 関数 → リピートコマンドブロック」だった | `poc/tick-order/`、[#96 の Java 実測データ](../scenarios/datapack/load-tick.java.json) |
| `system.run` の実行順は積んだ順ではない。スクリプトの処理中（`runInterval` 内）に積んだものが、コマンドブロックの処理中に積んだものより先に動く | 同上 |
| リピートコマンドブロックは、同じチャンク内では BE・Java とも置いた順（保存された順）に動く。座標順ではない。再起動後も同じ | `poc/tick-order/cb-order.servers.test.ts` |
| チャンク間の実行順は、Java はセッション中一定だが再起動ごとに変わり得る。BE はおおむねチャンク順だが tick によって入れ替わる（38tick中1〜2回） | 同上 |

## コマンドの意味の違い

| 事実 | 根拠 |
| --- | --- |
| Java 26.3 の関数タグで `return 7`・`return 4` を順に呼ぶと結果は 11。`execute if function` では先頭の非ゼロ return で後続関数を実行しない | `packages/bridge/src/scenario/runtime-function-condition.servers.test.ts` |
| Java 26.3 の `execute if function` は、明示的な `return -1` では成立し、`return 0`・`return fail`・通常終了では成立しない。`unless` はその逆 | `packages/bridge/src/scenario/runtime-function-condition.servers.test.ts` |
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

BDS 1.26.66.1 でも `poc/mcstructure-version/version.servers.test.ts` が成功し、同じブロック `version` とコマンドブロック `Version`、生成構造物でのコマンド実行を確認した（#227、`poc/mcstructure-version/results.json`）。

## ID 対応表（Geyser 固定版）

| 事実 | 根拠 |
| --- | --- |
| Geyser mappings `e9271c0`（BE 1.26.60 向け）の対応を使い、BDS 1.26.63.1 上で石・レンガ、丸太3軸、乾いたスラブ3種、乾いた直線階段4方向×上下の計16状態を `setblock` で配置でき、表が明示する型・状態を読み戻せた。JE との挙動等価性、水没レイヤー、全状態の互換性はこの測定の対象外 | `packages/bridge/src/mappings.servers.test.ts` の `places and reads back ...`。2026-11-15、3回連続成功（#56） |
| 同表の `minecraft:stone` の状態指定は空だが、BDS 1.26.63.1 で `setblock ... minecraft:stone []` として配置して Script API で読むと `stone_type: "stone"` が補われる。表の明示状態と、サーバーで補われる既定状態を区別する必要がある | 同テストの stone の読み戻し検査、3回連続成功 |

## 性能

| 事実 | 根拠 |
| --- | --- |
| 1チャンクの常時実行リピート100個でスコア加算を行う最小処理は、BEコマンド直接実行・カスタムコマンド→キュー・scriptevent→キューの全経路で毎tick100更新となり、平均tick間隔は約50msを維持した。Core i5-11400 / WSL2で各100tick×2回測定。全スレッド合計のBDS CPU時間/tickは、基準1.54〜1.65ms、直接2.25〜2.33ms、custom 5.58〜5.92ms、scriptevent 5.00〜5.69ms。CPU時間はメインスレッドのMSPTではなく、完成したランタイムやスマホの評価でもない | `poc/repeat-performance/performance.servers.test.ts`、`results.json`、`samples.jsonl`（#5） |
| 500個を2チャンクに密集させると全経路とも200更新/tick、8チャンクに分散すると500更新/tickになった。どちらも平均tick間隔は約50msのため、tick間隔だけでは処理量の低下を見抜けない。閾値の切り分けは下記の #31 | 同上 |
| runIntervalでキューを反映する最小処理では、custom経由は起動と同tick、scriptevent経由は1tick後に加算された。キュー処理件数の合計と各IDのスコア差分の合計は一致した | 同上 |
| BDS 1.26.63.1 では1チャンクに常時実行リピートを99/100/101/200個置くと、それぞれ毎tick 99/100/100/100更新。150+50個ではチャンクごとに100+50更新、平面の200個を8ブロックずらして100+100個に分けると100+100更新。Java 26.3 は同じどの配置でも40 tickで各ブロックが40回更新した | [#31 実機テスト](../poc/repeat-density/density.servers.test.ts)、[根拠データ](../poc/repeat-density/results.json) |
| BDS の1チャンク200個では各ブロックが40 tickで20回更新した。上下2層を置く順を反転しても、逆順の配置を保存・再起動しても、各ブロック20回・合計100更新/tickだった。100個の直下にチェスト100個、または稼働中のホッパー100個と搬出先のチェスト100個を置いても、毎tick100更新だった | [配置と測定方法](../poc/repeat-density/README.md)、[根拠データ](../poc/repeat-density/results.json)（#31、#18 の相対順テストを参照） |
| BDS の1チャンク200個は `maxCommandChainLength`（1・100000）、`functionCommandLimit`（1・10000）、`randomTickSpeed`（0・100）を変えても毎tick100更新だった。プレイヤーなしの常時読み込みエリアでは `tick-distance`（4→12）と `persistent-ticking-area-max-chunks`（100→16）の変更後も毎tick100更新。 `commandBlocksEnabled` を false にすると0更新、true で100更新に戻った | [設定別の結果](../poc/repeat-density/README.md#実測結果)、[根拠データ](../poc/repeat-density/results.json)（#31） |

## コマンドの文法（Java 26.3）

- 管理コマンド `ban` の `game_profile` は `@s`、`@e`、`@n` をプレイヤー限定違反として拒否し、それぞれに `type=player` を付けると受理する。`@a`、`@p`、`@r` も受理する。偽の execute 条件下で解析し実行しない対照付きの実測（`packages/bridge/src/admin-syntax.servers.test.ts`、#243）。管理コマンドは関数文脈では使用できないため、`checkJavaSyntax` の拒否だけではセレクター違反を特定できない。

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
| 安定リリース1.20.5 / 1.20.6 / 1.21.4 は `tellraw @a {text:'x'}` と `{text:"x",bold:1b}` を拒否し、1.21.5 / 1.21.11 / 26.3 は受理した。引用符付きキーの JSON `{"text":"x"}` は全6版で受理された。JSON のスラッシュのエスケープを含む文字列は前者3版で受理、後者3版で拒否された。1.21.5 の配布物の `version.json` は DataVersion 4325・データパック形式71だった | `packages/bridge/src/versioned-grammar.servers.test.ts`、各版の配布物と生成文法。6版×14ケースの比較を3回連続成功（2026-11-16、#58） |
| `gamerule keepInventory true` は1.20.5 / 1.20.6 / 1.21.4 / 1.21.5で受理、1.21.11 / 26.3で拒否。`keep_inventory` は逆だった。また `setworldspawn 0 64 0 ~15` は前者4版でのみ受理、`setworldspawn 0 64 0 90 0` は後者2版でのみ受理。中間リリースの追加測定は後掲の #70 の節を参照 | 同テスト。記載した6版でのみ確認 |
| 旧5版と26.3の全6版で、`team modify t color blue` と `reset` は受理され、`bold` は色として拒否された。版別文法のパーサも同じ結果になった | 同テスト |
| 同じ定義をディレクトリと ZIP から判定用コピーにした場合、Java 26.3 は通常の predicate と有効オーバーレイの predicate をどちらも受理し、未提供の predicate をどちらも拒否した。ZIP のバイト列と元関数本文は変化せず、通常・オーバーレイの load 関数に書いたスコア目標追加は実行されなかった（保存後のスコア目標は空） | `packages/bridge/src/validation-context.servers.test.ts`、2026-11-16（#63） |
| Java 26.3 で保存した `Data.DataPacks.Enabled` の順序を新規判定ワールドの有効順へ渡すと、その順序で有効化された。`Disabled` のパックが持つ predicate は判定に混入せず、その参照は拒否された | 同テスト。保存された `level.dat` と RCON の `datapack list enabled`、関数読み込み結果で確認 |
| 同じ predicate ID に対し、低優先パックへ存在しない型、高優先パックへ正しい型を置くと、保存した順序を渡した検証ワールドは正常に起動し、その ID の参照を受理した | 同テスト。パック名の辞書順では `first` → `second` だが、有効順を `second` → `first` にして優先順を識別 |

## 変換の通し（Java 26.3 → Chunker 1.21.0 → BDS 1.26.63.1）

| 事実 | 根拠 |
| --- | --- |
| 変換後のワールドに入れたビヘイビアーパックの `world.afterEvents.worldLoad` で `scoreboard.addObjective` と `setScore` を呼ぶと、スコアを書き込める。`BedrockServer.start` が戻った時点（検証パックの準備完了と読み込み範囲の読み込みの後）では書き込みは終わっていた | `scenarios/convert/scores-chain.json`（`packages/bridge/src/scenario/scenarios.servers.test.ts`、3回連続成功、#61） |
| Java の偽プレイヤー名（`#a`、`$b`、`kept` などの英数字の名前）を `setScore` に文字列で渡すと、BE で同じ名前の `FakePlayer` になり、BE のコマンド（`scoreboard players operation #a t += #b t`）から同じ名前で参照できる | 同上 |
| Java で `auto:0b`（レッドストーン必要）にしたインパルスとチェーンは、Chunker で変換した後、BE で隣にレッドストーンブロックを置くと動く。条件付きチェーンの成否、`~` を使う `setblock`、`fill`、`clone` の結果は Java と一致した | `scenarios/convert/redstone-block-ops.json`、`scores-chain.json`（同上） |

## コマンドの書き換え（Java 26.3 → BDS 1.26.63.1）

| 事実 | 根拠 |
| --- | --- |
| BE は引用符なしの偽プレイヤー名 `#a` を `scoreboard players set` では読むが、`execute if score` では構文エラーにする。`$b` はどちらでも構文エラー。`"#a"`・`"$b"` と引用符で囲めばどちらでも読める | `packages/bridge/src/rewrite.servers.test.ts` の `needs quotes for fake player names ...`（#62） |
| BE の `execute if block` に状態の一部だけを書くと、書いた状態だけを比べる（書かなければ ID だけを比べる） | 同上 |
| Java 26.3 の `scoreboard objectives setdisplay` の表示場所は `below_name`。`belowName` は文法として拒否される | 同テストの `uses inputs that Java 26.3 accepts` |
| 書き換えた BE のコマンド（セレクタの `r`・`rm`・`c`・`l`・`lm`・`m`・`rx`・`ry`、状態つきのブロック、rawtext の `tellraw`・`titleraw`、`execute in nether` など、同テストの一覧）は BDS が構文として受理する。見た目（rawtext の書式）の一致は未確認 | 同テストの `produces commands that BDS accepts` |
| 変換を通したワールドで、`distance=..9` → `r=9`、`distance=9..16` → `rm=9,r=16`、`sort=nearest,limit=2` → `c=2`、`sort=furthest,limit=1` → `c=-1`、`@n` → `@e[c=1]`、`dx/dy/dz` の範囲は、コマンドブロックから Java と同じ防具立てを選んだ（距離は境界から1ブロック以上離した配置で確かめた） | `scenarios/convert/selectors.json`（3回連続成功、#62） |
| 状態つきの `setblock`・`execute if block`（一致・不一致）、`fill ... replace minecraft:air`、偽プレイヤー名 `#a`・`$b` の比較と演算は、書き換えた後の BE で Java と同じ結果になった | `scenarios/convert/block-predicates.json`（同上） |

### 単一コマンドの追加検証（#72）

| 事実 | 根拠 |
| --- | --- |
| Java 26.3 の `entity_type` を BDS の `@e[type=…]` と照合した。`zombified_piglin` → `zombie_pigman`、`evoker` → `evocation_illager` などの別名が受理された。`marker` と木材別のボート ID は拒否された | `packages/bridge/src/rewrite.servers.test.ts` の `checks vanilla entity and effect IDs against BDS` |
| Java 26.3 の40効果のうち35種は同名で、`hero_of_the_village` は `village_hero` でブタに付与できた。残る `dolphins_grace`、`glowing`、`luck`、`unluck` は同名では拒否された。BDS の `effect <対象> clear <効果>` は指定した効果だけを消した | 同テスト。個別解除後の再解除は対象0件、全解除は対象1件 |
| BDS は `playsound random.orb` と `particle minecraft:basic_flame_particle` の変換出力を構文として受理した。音声・粒子を描画するクライアントでの確認は未実施 | 同ファイルの `produces commands that BDS accepts` |
| BDS は `clone ... filtered <mode> <block>` と `tp ... facing <target>` を受理した。`tp ... facing entity <target> feet` は拒否され、同じ高さに置いた対象への `facing <target>` のピッチは0度だった | 同テストの変換出力。ピッチは BDS のエンティティの回転値を読み戻した |
| BDS は `gamemode spectator @a`、`time query time`、`time add`、`weather rain 100`、`difficulty normal` を受理した。`weather rain 100` の直後に保存したワールドには、経過した19 tick を引いた `rainTime=81` が記録された | 同テストの変換出力と BDS の `level.dat` の読み戻し |
| Java 1.20.5 が保存したコマンドブロックの旧 `time set noon`、`gamerule keepInventory`、`belowName`、JSON のスラッシュエスケープ、ボートのセレクタを、DataVersion 3837 の文法で読み、出力を BDS が受理した | 同ファイルの `rewrites command blocks saved by Java 1.20.5 with that world's grammar` |

### ゲームルールの設定と照会（#318）

| 事実 | 根拠 |
| --- | --- |
| Java の `gamerule` の固定文法では、1.21.10 は旧名、26.3 は名前空間付きと省略形の両方を受理する。対応表の真偽値・整数の型は、両版の `commands.json` の引数型に一致した | `packages/bridge/src/game-rule.servers.test.ts` の `matches the Java 1.21.10 and 26.3 names and value types` |
| BDS 1.26.66.1 は対応する真偽値・整数を、Java の旧名と 26.3 の名前空間付き ID から変換して設定できた。各設定の直後に `gamerule <名前>` で照会し、設定値を確認した | 同ファイルの `sets and reads back each supported boolean and integer from both Java name forms` |
| BDS 1.26.66.1 の `randomTickSpeed` は 0〜4096、`spawnRadius` は 0〜128。上限値を設定して読み返した。下限の直前と上限の直後は成功件数 0 だった | 同ファイルの `reports missing rules, mismatched rules and values outside the Bedrock range` |
| BDS 1.26.66.1 は `gamerule playerWaypoints off\|everyone` で設定でき、`gamerule` 一覧で読み返せる。値を省いた `gamerule playerWaypoints` は構文エラーになった | 同ファイルの `translates the locator toggle and reports the unavailable named query` |

BDS 1.26.66.1 で `gamerule playerWaypoints` の設定を含む関数を読み込むと、パックの `min_engine_version` が 1.21.0 の場合は構文エラー、変換器の出力と同じ 1.26.60 の場合は受理された。監査用パックを 1.26.60 に揃えた後、対象 288 形・330 候補はすべて読み込みエラーなしだった。旧版の監査で拒否された `time query time` も受理された。根拠は `packages/bridge/src/shape-bedrock-audit.servers.test.ts` と下記の #112 の再生成コマンド。

### 音と粒子のコマンド（#90）

| 事実 | 根拠 |
| --- | --- |
| BDS 1.26.63.1 は固定 Geyser 表の `playsound_mapping` 由来の全 1,615 種類（JE 1,917 行）と、バニラ名前空間の `bedrock_id` 由来の全 81 種類（JE 92 行）を受理した。どの ID も成功件数 1 で、拒否された対応先 ID はなかった | `packages/bridge/src/sound-particles.servers.test.ts` の `checks every distinct mapped ID …`。入力一覧は `npm run setup:mappings` の生成した `mappings.json` の `sounds`・`particles` の値を重複排除したもの。音は同じ座標の試験用プレイヤーを対象とした |
| 架空の `je2be.nonexistent.sound`、`minecraft:je2be_nonexistent_particle` と、対応表から除いた `geyseropt:ash` も成功件数 1 だった。カテゴリを付けた JE 形式の音と、拡散・速度・個数・`force` を付けた JE 形式の粒子は構文エラーだった | 同テストの対照入力。コマンド応答で確認できるのは書式とサーバーでの成功件数まで |
| `playsound` の実行位置を対象から水平に 24 ブロック離すと、位置省略では成功件数 1、実行位置を `~ ~ ~` で渡すと 0 だった。明示位置で距離 24 のとき、音量 1・最小音量 0 では 0、音量を 2 または最小音量を 0.5 にすると 1 だった。同じ位置ではピッチ 0 と 2 のどちらも 1 だった | 同ファイルの `checks the distance, volume, pitch and minimum volume …` |
| 変換シナリオで出力した `playsound random.orb @p 2.5 -59 1.5 1.5 0.7 0.25` と `particle minecraft:basic_flame_particle 6.5 -58.5 0.5` は試験用プレイヤーを置いた変換済みワールドで成功件数 1。ソースのカテゴリ、未対応 ID、色・拡散・速度・個数・表示範囲・表示対象は変換レポートに出た | 同ファイルの `checks converted scenario commands …` |
| ボタン版の `sound-particles.mcworld` では、Java と BDS の両方でボタンを押すとダイヤモンド・エメラルドブロックが置かれた | `packages/bridge/src/playtest.servers.test.ts` の `convert/sound-particles`。音・粒子の実クライアント確認は `docs/output-validation.md` の #46 記録欄で追跡 |

## 安定リリースの版別文法の拡充（#70）

| 事実 | 根拠 |
| --- | --- |
| 1.20.5 / 1.20.6、1.21〜1.21.11の全12安定版、26.1 / 26.2 / 26.3の全17版で、テキスト・gamerule・色・回転引数の14ケースについて、当該版の実サーバーとパーサの受理結果が一致した | `packages/bridge/src/versioned-grammar.servers.test.ts`。各版のDataVersion・パック形式は `docs/command-versions.md` |
| `setworldspawn 0 64 0 ~15` を拒否し、`setworldspawn 0 64 0 90 0` を受理する最初の対象安定版は1.21.9。1.21.8までは逆だった | 同テスト、1.21.8 / 1.21.9を含む実サーバー比較 |
| `gamerule keepInventory true` を拒否し、`gamerule keep_inventory true` を受理する最初の対象安定版は1.21.11。1.21.10までは逆だった | 同テスト |
| 同じパック形式を共有する41（1.20.5 / .6）、48（1.21 / .1）、57（1.21.2 / .3）、81（1.21.7 / .8）、88（1.21.9 / .10）の各組で、生成文法のSHA-256が一致した | `npm run setup:grammars` が生成した各版の `grammar.json` の `commandsSha256` |
| 19本115,487行の同じローカルコーパスで、文法なしが26,903から18,924へ減った。追加対象のDataVersion 3953は5,474行すべて、4903は2,505行すべてを判定でき、パース成功はそれぞれ5,470行と2,500行だった | `tools/parse-corpus.ts`、2026-11-16。詳細・未判定の内訳は `docs/command-versions.md`。構文の集計であり、BEでの実行成功率ではない |

## ブリッジの設定補助を使わない生成物検証（#68）

| 事実 | 根拠 |
| --- | --- |
| 従来の変換出力を実験設定を補わずBDSで開くと、生成した初期化パックが「Beta APIs experiment is not enabled」として読み込まれなかった。同じ固定beta依存の観測パックも読み込まれず、準備待ちがタイムアウトした | `packages/bridge/src/output-world.servers.test.ts` の初期測定（2026-11-17、修正前のconvertWorld）。BDS 1.26.63.1の依存エラーログ |
| 変換器がBeta APIs・コマンド許可をlevel.datへ出した後は、ブリッジの設定補助とtickingareaなしで初期化パックが動き、keptのスコアは42になった。99に変更して保存再起動すると99を保持し、再注入は起きなかった | 同テスト。BDSのtickingarea一覧・スコア観測・初期化ログを確認 |
| 初期化パックの有効化参照を除くと観測パックだけではスコアを復元しなかった。Beta APIsの設定を0にした入力は依存エラーとなり、ブリッジは設定を修復しなかった | 同テストの欠落ケース。出力スモークと4変換シナリオ計9テストを3回連続成功（2026-11-17） |

## コーパス追加調査（#15、保存データの静的計数）

- 2026-11-20、19 ZIP（18ワールド＋単体データパック）を読み取り走査。非空関数10,155個中、現行書き換え器が全行を出力できるものは318個（3.13%）。ゲーム内の成功率ではない。空関数125個は除外した。
- 配置済みコンパレーター19個中、CBに6面で隣接するもの16個（隣接ペア22）、背面入力位置にCBがあるもの15個。JEのfacingは入力側を指すことを `corpus-survey.servers.test.ts` で確認（入力側/逆向きの出力15/0）。直接の設置/複製コマンドの書込先が実行元CB自身に重なる行は1行。実行時条件は未評価。
- パースできた範囲では、NBTのマージ値の末端キー `start_interpolation` が55,830回、`transformation[]` が55,366回。進捗616、predicate 195、loot_table 514ファイル、モデル890、フォント76、シェーダー3ファイルを計数した。定義の存在数であり、有効化・描画・発火の計数ではない。
- 根拠: `scripts/survey_corpus.py` と `tools/survey-corpus.ts`。全匿名集計は [corpus-survey.json](corpus-survey.json)、除外数・未判定・再実行方法は [corpus-survey.md](corpus-survey.md)。集計ロジックは合成ZIP/NBT・匿名化テスト（`npm run check`）、既存の抽出/書き換えは実Java/BDSテストで検証した。私有マップは公開・CI投入していない。

## ランタイムの遅延書き込みと tick の依存（#67）

| 事実 | 根拠 |
| --- | --- |
| キューに積んだ直後のハンドラで確定済みのブロックは空気、防具立ての検索結果は0体。保留中の石と防具立てをオーバーレイで読むと、同じチェーン内の条件と選択数は Java・ネイティブ BE と一致した。反映後に石と防具立て1体も確認した。セレクタで使った条件は種類と距離 | [実機テスト](../poc/runtime-queue/runtime-queue.servers.test.ts)、[実測データ](../poc/runtime-queue/results.json) |
| 対象ありの `tag` では両版のネイティブ経路と BE のキュー経路で比較器が点灯し、条件付きブロックが動いた。対象なしの場合、ネイティブ経路ではどちらも起きず、キュー経路ではどちらも起きた。委譲の成功数0を確認した時点は、成功を返したハンドラより後で、同じ BDS tick 内だった | 同上 |
| 同じチェーンでネイティブがスコア1を書き、ランタイムが2を予約したところ、ネイティブは古い1を読んだ。その後のネイティブの加算で11になり、キュー反映が2で上書きした。Java・ネイティブ BE の同じ並びでは読み取り値2、加算後12 | 同上 |
| 両経路を共に0で初期化した起動テストを3回実施。関数からコマンドブロックの最初の書き込み1を読んだのは Java で3回目、BE で2回目。最初のコマンドブロックが読んだ関数の値は Java で2、BE で1。両方が毎tick動く区間では、どちらも反対側の直前の書き込みを読んだ | [起動時の観測条件と時系列](../poc/runtime-queue/README.md#起動時の観測)、[実測データ](../poc/runtime-queue/results.json) |

## 変換した .mcworld の実クライアントでの確認（#46、2026-11-21）

| 事実 | 根拠 |
| --- | --- |
| Windows の統合版 1.26.65.1 で、CLIの出力 `fixture.mcworld` を取り込めた。初回の読み込みで初期化パックが1回だけ動き、`kept`＝42が復元された | 対象コミット `46f6b82`、成果物の SHA-256 `bd80e04b…`。所有者の画面確認と、統合版のコンテンツログ `[je2be] initialized 1 scores`。記録は `docs/output-validation.md` |
| 99へ変更して保存し開き直すと99のままで、初期化は再び動かなかった | 所有者の画面確認。統合版が保存したワールドのコピーを BDS 1.26.63.1 で開いても `kept`＝99 |
| 入った直後の「At least one of your resource or behavior packs failed to load」は、同じ統合版で新規に作った何も変えないワールドでも出た。変換出力から初期化パック・実験設定を除いても出た | 所有者の画面確認（4種類のワールドで比較）。コンテンツログにエラーはなかった |

## ボタンの押下の再現と、変換後のボタン（#86）

| 事実 | 根拠 |
| --- | --- |
| 押されていない石のボタンを、インパルス（`auto:0`）のコマンドブロックの面に `setblock` で置いても、コマンドブロックは動かなかった。押された状態（JE は `powered=true`、BE は `button_pressed_bit=true`）で置き直すと、両版とも隣のコマンドブロックが動いた | 2026-11-21、Java 26.3 と BDS 1.26.63.1 での一時的な計測（`setblock 10 -60 10 diamond_block` の有無を観測）。同じ置き方で `packages/bridge/src/playtest.servers.test.ts` の4本が、Java で元のシナリオの正解データと一致する（押されていないボタンの設置で動いていれば一致しない） |
| Chunker 1.21.0 は、コマンドブロックの面に付けた石のボタン（壁付け・北向き）を、同じ向きの BE のボタンに変換した | `playtest.servers.test.ts` で押す前のボタンを両版で観測し、Geyser の対応表で比べて一致（3回連続成功、2026-11-21） |
| Windows の統合版で、変換した検証用マップ4本（F1〜F4 をボタン操作にしたもの）のボタンを人が押すと、どれも BDS のテストと同じ結果になった | 2026-11-21、所有者の画面確認とコマンドの一覧（`/scoreboard players list *`、`/tag ... list`）。成果物の SHA-256 と手順は `docs/output-validation.md` |
| 統合版のサイドバーに、`#` で始まる名前（`#a` など）のスコアは出なかった。同じ目的変数の `kept`・`$b` は出た | 同上。値は `/scoreboard players list *` で出た |

## 変換前に配置したエンティティの復元（#89）

Java 26.3 → Chunker 1.21.0 → BDS 1.26.63.1。Java の保存データを正解として記録した
[`convert/placed-entities`](../scenarios/convert/placed-entities.json) と
[`placed-entities.servers.test.ts`](../packages/bridge/src/placed-entities.servers.test.ts) の結果。

| 項目 | 実測結果 |
| --- | --- |
| 種類・位置・向き・名前・タグ | 防具立て、村人（BE では `villager_v2`）、豚のブロック座標・名前・タグ・個体数が Java と一致。防具立ては [8.5, -60, 8.5]、yaw 90°。BDS はプレイヤーなし、ブリッジの常設読み込み領域なしで初期化を完了した |
| UUID スコアと再読み込み | 防具立ての 7、村人の -4 は BE の各個体のスコアボード ID に付いた。再起動後も値と3体の BE ID は同じだった。Java 専用 `marker` とそのスコアはレポートに出た |
| 防具立て | 頭の鉄のヘルメットは `replaceitem` で装備できた。 `effect @s invisibility infinite 0 true` は再起動後も残った。BDS が保存した NBT には効果の `Duration: -1`、`CustomNameVisible: 0`、`PoseIndex: 0` があった。Java の名前の常時表示、頭の姿勢、`Small`・`ShowArms` はレポートに出た |
| 村人の職業・服装・取引 | `minecraft:become_farmer` の後と再起動後に BE の `family=farmer` で選択できた。Java の砂漠服に対し BE の `mark_variant` は 0。BDS のスクリプトで列挙したコンポーネントに取引テーブルはなく、保存値は `TradeTier: 0`、`TradeExperience: 0`、農民の既定テーブルとその取引だった。Java のレベル2とエメラルドからダイヤモンドへの取引はレポートに出た |
| 動作・耐性 | BDS の村人には歩行ナビゲーションがあり、`damage … 1` で体力が減った。Java の `NoAI`・`Invulnerable`・`Silent` はレポートに出た。BDS が保存した村人と豚では `Persistent: 1` を確認した |

保存 NBT は、出力アーカイブを展開して BDS で開き、初期化終了後に
`structure save je2be:probe89 7 -60 7 14 -57 10 true disk false` と
`structure save je2be:probe89pig 47 -60 47 49 -57 49 true disk false` を実行して取得した。
[構造物の WAL 読み出しヘルパー](../poc/mcstructure-version/leveldb-log.ts) と
`readNbt(..., "bedrock")` で `structure.entities` を読んだ。

## M2 のデータパックシナリオ（#96）

Java 26.3 で `reload` 後に操作し、スコアと command storage をワールドの保存データから記録した。

| 項目 | 実測結果 | 根拠 |
| --- | --- | --- |
| 関数の戻り値とタグ | `return run function` で内側の戻り値 7 と成功値 1 が得られた。`return fail` の結果値と成功値はともに 0。各 return より後の行は実行されなかった。スコア条件を満たして呼んだ関数タグは記載順に実行された | [calls.java.json](../scenarios/datapack/calls.java.json) |
| 複数の実行者 | 距離の異なる marker 3体で、`execute as` から呼んだ関数が `sort=nearest` で 1, 2, 3、`sort=furthest` で 3, 2, 1 の順に実行された | [calls.java.json](../scenarios/datapack/calls.java.json) |
| `@e` の既定順（#232） | 同じチャンク内で召喚コマンドの X 座標を 13, 9, 11 と指定した marker 3体で、`execute as @e[type=marker,tag=worker]` は召喚順の 1, 2, 3 で関数を実行した。保存とサーバー再起動を挟んだシナリオでも同じ順だった | [execute-order.java.json](../scenarios/datapack/execute-order.java.json)、[execute-order-reload.java.json](../scenarios/datapack/execute-order-reload.java.json) |
| スコアの演算 | `operation` の全9演算子を記録した。負数を含む除算では −7 / 2 と 7 / −2 がともに −4、剰余はそれぞれ 1 と −1。最大の int に `+= 1` すると −2147483648 になった | [score-operations.java.json](../scenarios/datapack/score-operations.java.json) |
| storage とマクロ | `merge` は入れ子の既存キーを残し、指定したキーを更新・追加した。スコアを storage に保存し、2組の引数でマクロを呼ぶと、それぞれの名前に対応するスコア −7 と 12 が付いた | [storage-macro.java.json](../scenarios/datapack/storage-macro.java.json) |
| 予約実行 | `append` の2件は予約から 2、4 tick 後に動いた。`replace` を使った関数は古い予約の 2 tick 後には動かず、5 tick 後に1回動いた。`clear` で取り消した 3、6 tick 後の2件は、7 tick 後まで記録されなかった | [schedule.java.json](../scenarios/datapack/schedule.java.json) |
| load と tick | tick を止めて `reload` を済ませた時点の記録は空。最初の `tick step` で load が先に1回動いた。続く4組は各組で tick 関数 → 反復コマンドブロックの順に動き、各組の両方が同じ tick 番号 1〜4 を記録した | [load-tick.java.json](../scenarios/datapack/load-tick.java.json) |

## 実機 CI の計時（#108）

2026-11-21 の [main の CI 実行 44900032141](https://github.com/tapu18/mc-je2be-map-converter/actions/runs/44900032141) では、Vitest の計時で正解シナリオ 15 本に約 206 秒、bridge グループに約 826 秒かかった。そのうち `versioned-grammar.servers.test.ts` は約 310 秒だった。変換シナリオの連続した BE 照合の完了間隔は約 19〜22 秒だった。ジョブ開始から実機テストのステップ開始までの時間は各グループで 40 秒以内だった。

## schedule の保存・再起動（#123）

Java 26.3 の [schedule-restart](../scenarios/datapack/schedule-restart.json) では、100 tick 後の関数を予約して 30 tick 進め、保存・停止して同じワールドを再起動した。再起動直後とさらに 50 tick 後は未実行、100 tick 後には実行済みだった（[記録](../scenarios/datapack/schedule-restart.java.json)）。予約時と関数の実行時のゲーム内時刻の差は 100 tick だった。したがって、この実験では停止前に進めた 30 tick を含め、予定は予約時からのゲーム内 tick を維持していた。再起動直後の残り時間は 50 tick より長く 100 tick 以下だった。起動中にも tick が進むため、再起動直後の正確な残り tick 数や長期停止中の実時間の影響はこの実験では測っていない。

#101 の Java 26.3 RCON 確認では、`tick freeze` 中に同じ関数を同じ期限に 2 回 `append` しても実行は 1 回だった。同じ ID の関数とタグは両方実行され、`schedule clear #probe:a` は構文エラーだった。1 tick 後に予約済みの関数をモード省略で 2 tick 後に予約し直すと、1 tick 後の実行は消えた。同じ tick の先頭の関数から `schedule clear` すると、その tick で後に登録した対象の実行も消えた。`0t` は実行時に拒否され、`0.0249999999s` と `2147483648t` はそれぞれ 1、2,147,483,647 tick として予約された。ゲーム内時刻 10 のときに 2 tick 後を予約し、`execute store result` で取得した値は 12 だった。Node 側の回帰確認は [schedule.data.test.ts](../packages/runtime-host/src/schedule.data.test.ts) にある。

## execute の追加修飾句（#134）

Java 26.3 の [execute-extra](../scenarios/datapack/execute-extra.json) で観測した（[正解データ](../scenarios/datapack/execute-extra.java.json)）。負座標の `align xyz` は [-2, -60, 8]、`align xz` は [-2, -59.3, 8] になった。防具立てへの `facing entity` は feet と eyes で pitch が異なり、`rotated as` は対象の [90, 30]、`positioned as` は対象の位置を得た。

石・水・葉を積んだ列で `positioned over` の高さは world_surface と motion_blocking が 73、motion_blocking_no_leaves が 72、ocean_floor が 73 だった。この配置に限る観測である。`if blocks` は一致した2ブロックで all・masked とも結果 2、空気を含む範囲では masked が対応先の非空気を無視した。不一致、読み込み外チャンク、ディメンションの条件も同シナリオに記録した。

#233 の Java 26.3 RCON 確認では、空気同士の1ブロックを比較した `execute if blocks 16 70 16 16 70 16 17 70 16 masked` は成功して結果 0 を返し、`store success` で 1 を記録した。`unless blocks` は失敗し、`store result` の後にこの条件と `run` を続けると後続コマンドは実行されずスコアも作られなかった。`if loaded` は同じチャンクの Y=500 と Y=-100 の両方で成功した。未ロードの座標を使った `positioned over` と `unless blocks` は `That position is not loaded` を返し、終端の `if blocks` が同じエラーを返したときは `store result` で 0 が記録された。

終端の `if blocks` を marker 2 体で分岐させ、手前の marker の上だけに比較先と同じブロックを置いた。同じ保持者への `store result score` は `sort=nearest` で最終値 0、`sort=furthest` で最終値 1 になった。Node の照合と回帰確認は [runtime-context-ir.data.test.ts](../packages/bridge/src/runtime-context-ir.data.test.ts) にある。

### スコア保持者とゼロ除算（#140）

| 実測 | 根拠 |
| --- | --- |
| Java 26.3 と BDS 1.26.63.1 で、`#hidden`、英字40・41・256文字、UUID形式の36文字を文字列の保持者として設定すると、記録した値は一致した。これは名前の最大長や、実在するエンティティとの対応を示さない | `scenarios/scores/runtime-boundaries.json` と Java 正解データ |
| ゼロ除数による `/=` の後、被除数 7 は両版で変わらなかった | 同上。成否はこのシナリオでは比較していない |
| 同じゼロ除算をコマンドブロックから実行すると、条件付き後続は Java では動かず BE では動いた | `scenarios/scores/zero-division-success.json` と Java 正解データ |
| 固定 UUID を持つ防具立てに対し、その UUID 文字列でスコアを設定すると Java では実体に 7 が付いた。BE で防具立てと同じ文字列の保持者を作っても実体にはスコアが付かなかった | `scenarios/scores/uuid-holder.json` と Java 正解データ |

### ランタイム用パーサ・文法・対応表の読み込み（#141）

Java 26.3 の commands.json と Geyser 対応表、既存パーサを組み込んだ PoC は BDS 1.26.63.1 で3回とも初回コマンドをパースできた。起動要求からパースまで 602 / 783 / 613 ms、スクリプト内の JSON.parse は 159 / 193 / 178 ms、パックの圧縮前合計は 12,624,623 bytes。測定範囲・環境と限界は [PoC](../poc/runtime-load/README.md)、記録は [results.json](../poc/runtime-load/results.json)。

### コマンドブロックとマクロ（#155）

Java 26.3 の [実サーバーテスト](../packages/bridge/src/macro-command-block.servers.test.ts)では、コマンドブロックに `$` で始まる行を保存できたが、その行はスコアを変更しなかった。同じテストでは、コマンドブロックからインライン compound と storage の両方式でマクロ関数を呼ぶと、展開した命令がスコアを変更した。これはこのテストの入力に限った観測で、他のコマンドや版すべての挙動を保証するものではない。

### マクロの具体値による型紙試探（#155、暫定）

#### 複数の穴の組合せ（#282）

同じ入力と Java 26.3 文法を用い、既存の11候補による試探に加えて、異なる名前が2個以上ある **123行**について2名前を選び、それぞれ `0`、`x`、`@s`、`0 0 0`、`{}`、`run say x` の全組合せにした。他の名前には `0`、`x`、`@s` のいずれかを共通に入れ、同名の穴は常に同じ値とした。再現手順は下記と同じ（現在のスクリプトはこの追加試探を含む）。

試作パーサーで新たに **10行**に異なる成功形を発見し、全体は固定 0、不定 **27**、未判定 **3,603**（成功例なし 7、成功例はあるが固定を証明できない 3,596）となった。追加試探で初めて成功した行は0。節の種類・名前・型・ジャンプだけを比較する。値の内部構造や Java の受理を保証せず、3名前以上の独立した全組合せ、任意の文字列、元版の文法は未検証。不定はこのパーサー上で見つけた反例に限り、未判定は固定を意味しない。下の #238 の数値は追加試探前の記録である。

#### 空白と形の集計（#238）

2026-11-25 に同じ非公開コーパスを下記の手順で集計した。3,630 行、4,089 穴のうち、空白を含む値への変更で節の列が変わる例を確認できたのは **25 穴、12 行**。これは発見できた下限であり、残りが変化しないことは示さない。同名の穴は同時に置換し、該当する出現箇所を数えるため、個々の穴の独立した影響を示す数ではない。

形の分類は固定 0 行、不定 17 行、未判定 3,613 行。不定は成功した代入例に異なる節の列がある行。固定は唯一の末尾 message 引数に固定の非空白接頭辞を持つ `say` の証明条件に該当した行に限る。未判定は試探が全て不成功 7 行、成功例はあるが異なる節の列も固定の証明もない 3,606 行。固定率は求められていない。未判定の続きは #282 で追う。

空白の試探は空白なしの基準値9種類を全穴に入れ、1つの名前だけ `0 0 0` または `run say x` に変え、両方のパースが成功したとき節の種類・名前・型・ジャンプを比較する。形の試探は11候補を全穴の基準値とし、1名前だけ11候補に変える。いずれも有限例であり、節の内部構造、任意の値、複数の異なる名前の組合せ、元の版の文法、Java サーバーの受理を保証しない。試作パーサーによる集計で、実行時の頻度でもない。

```sh
python3 -I scripts/dump_commands.py /home/tapukoko/code/mc-je2be-map-converter/sample-map > /tmp/issue238-commands.jsonl
node tools/probe-macro-corpus.ts /tmp/issue238-commands.jsonl servers/reports-26.3/reports/commands.json
```

抽出ファイルには本文が含まれるため公開しない。`npm run setup:servers` で Java 26.3 の文法を準備する。

非公開コーパスの抽出結果を `tools/probe-macro-corpus.ts` で集計した。2026-11-23 時点のコーパスはマクロ 3,630 行・穴 4,089 個で、行頭の命令名に穴があるのは 1 行だった。Java 26.3 の文法で各行の全穴に同一の候補値を代入したところ、3,615 行で少なくとも一例がパースされ、15 行はどの候補でもパースできなかった。型の内訳は同スクリプトで再現できる。これは固定率ではない。異なる値や複数穴の組合せを網羅しておらず、元のワールドの版とも限らない。

同スクリプトで11候補を基準値とし、同名の穴は同じ値に保って1つの名前だけ別候補に変える試探では、17行に異なる節の列を発見した。固定形と判定する条件を `say` の唯一の末尾 `message` 引数に固定の非空白接頭辞がある行に限定すると該当は0行、残り3,613行は未判定だった。0行は固定可能な行が存在しない証明ではない。判定は本パーサの節の列に限り、Java の受理や変換結果を保証しない。

最初に成功した候補での穴の対応先は、entity 2,106、NBT path 797、NBT tag 271、team 129、vec3 99、component 94、function 81、slot source 78、score holder 54、string 47、integer 44、resource location 44、item stack 23、block state 3 個などだった。これは代入例による型であり、別の値で型が変わらないことを示さない。全穴に `0 0 0` を入れた場合は 327 行がパースされたが、空白によって引数の数が変わる穴の数を示すものではない。

同じスクリプトで11種類の値を各行の全穴に同一に代入し、成功したパースの節（種類・名前・型・ジャンプ）の列を比較すると、2行で異なる列が得られた。残る3,628行は未判定であり、固定率は求められていない。穴ごとに異なる値の組合せや、節の内部で変わる構造は比較していない。これは Java サーバーではなく試作パーサーによる結果である。

再現手順（配布マップや抽出データを公開しない）:

```sh
python3 -I scripts/dump_commands.py /home/tapukoko/code/mc-je2be-map-converter/sample-map > /tmp/issue155-commands.jsonl
node tools/probe-macro-corpus.ts /tmp/issue155-commands.jsonl servers/reports-26.3/reports/commands.json
```

同環境で Java 26.3 の `commands.json` は 583,592 bytes、`servers/mappings/mappings.json` は 10,357,025 bytes（`wc -c`）。`commands.json` を `gzip -n -c` で圧縮すると 19,663 bytes（2026-11-25、#240）。これはデータのサイズであり、実際に同梱が必要な範囲や起動時メモリの測定ではない。

### コマンド形の候補（#112）

Java 26.3 で `node tools/shape-java-audit.ts /tmp/shape-java-audit-112.json` を実行し、1,424 形の 1,520 候補を関数の読み込みで判定した。Java が 1,448 候補を受理し、パーサとの不一致は 72、パーサが到達した終端形の不一致は 0 だった。書き換えの結果は unsupported 1,298、unchanged 86、rewritten 136。Java の関数では使用できないコマンドや存在しない参照を含むため、この不一致数をパーサの欠陥数とは扱えない。BDS の全候補の構文判定は行っていない。

BDS 1.26.63.1 の使い捨てワールドで、Java が受理した候補のうち書き換え結果が rewritten または unchanged の 222 件を `BedrockServer.exec` で直接実行したところ、いずれも例外を返さなかった。一方、対照の `time set bogus` も例外なし・successCount 0 だった。同じ実験で不正な effect 引数、不正なブロック ID、不正なコマンド名は構文エラーを返した。したがって直接実行で例外がないことも、全引数の構文受理の証拠にはできない。

### Java 1.20.4 ワールドの更新（#145）

合成した 1.20.4 ワールドを Java 26.3 で開いた実サーバーテストでは、コマンドブロックの `Command` と関数ファイルの文字列が保存され、チェスト内アイテムの `CustomModelData` は `minecraft:custom_model_data` に移った。防具立ての `CustomName` の内容も残った。対象はテスト内の各1例である。根拠は `packages/bridge/src/upgrade-1204.servers.test.ts`（3回成功）、再現方法と文法・コーパスの調査は `docs/research-1204.md`。

### Java 1.20.4 と 1.20.5 のアイテムコマンド（#308）

両版でチェストに独自 NBT を持つ石を `item replace` で入れ、1.20.4 の `Items[{Slot:0b}].tag.foo` と
1.20.5 の `Items[{Slot:0b}].components."minecraft:custom_data".foo` が同じ byte 値 `1b` を返した。
1.20.5 の `custom_data~{foo:1b}` は別のキーも持つその石に一致した。テキスト表示エンティティの NBT を
`data get entity` で読むと、両版の `show_item` の JSON にカスタムキー `foo` が残った。
根拠は `packages/bridge/src/versioned-grammar-item-components.servers.test.ts`。

### Actions の定期実行（#222）

2026-11-23 UTC の Actions API では schedule の実行履歴が 0 件で、CI と Version canary の workflow はともに active、Actions は enabled だった。隔離登録が空の状態で `include_quarantine=true` を指定した [手動 CI](https://github.com/tapu18/mc-je2be-map-converter/actions/runs/45154796628) は成功し、隔離ジョブは生成されなかった。

同日の [手動 Version canary](https://github.com/tapu18/mc-je2be-map-converter/actions/runs/45154550420) は検出、API、セットアップ、実機、Java 再記録、台帳生成がすべて成功し、`scenarios.diff` は空だった。artifact の候補は Java 26.3、BDS 1.26.66.1、Chunker 1.21.0 で、固定 BDS 1.26.63.1 との差を検出した。版上げの追跡は #227。
### storage の NBT パス代入（#99）

Java 26.3 では、同じ値を storage に再代入すると変更なしとなる。また `missing.list[0].x` への代入は対象なしで失敗するが、途中の `missing.list` は空リストとして生成される。同じテストで `insert -1` はリスト末尾に追加され、storage の compound merge は入れ子のキーを保持して再帰的に更新し、同値なら変更なしとなること、欠けたパスへの append と merge がそれぞれリストと compound を作り、文字列 `abcdef` の範囲 `1 -1` が `bcde` になることも確認した。根拠は `packages/bridge/src/nbt-mutation.servers.test.ts`（各3回成功）。
## Java 版別シナリオの記録（#216）

実測。`scenarios/datapack/` と `scenarios/scores/` の21シナリオを、各版の実サーバーで新規ワールドから実行し、`*.java.<版>.json` の正規化済み state を 26.3 の `*.java.json` と比較した。コマンドブロックは明示的に有効化した。

| Java 版 | 26.3 との差があるシナリオ | 差分 |
| --- | --- | --- |
| 1.20.6、1.21.4 | `datapack/entity-nbt` | storage へのコピーは `HandItems` / `ArmorItems` のリスト（出力の `hand` / `armor`）で、26.3 は `equipment.mainhand`。同じ CustomName 入力について、前者は `"Probe"` を含む文字列、後者は `{"text":"Probe"}` を含む文字列。表示名が同じかはこの記録では測っていない（#219）。 |
| 1.20.6、1.21.4 | `datapack/execute-extra` | `#all_mismatch`、`#masked_diff`、`#unloaded_if`、`#wrong_dimension` が 0 で存在し、26.3 の記録には存在しない。発生箇所の切り分けは #220。 |
| 1.21.11、26.2 | 差なし | 21シナリオの state が 26.3 と一致。 |

上記以外のシナリオには差がなかった。各版の具体的な値は対応する正解 JSON を参照。NBT の数値型は正規化時に一部省かれる（`docs/scenarios.md`）。
### コマンド形の参照先と実験設定（#166）

Java 26.3 の関数読み込みで、`minecart_improvements` を有効にすると `max_minecart_speed` の監査候補 6 件は受理された。また `test` の参照先を同梱の `minecraft:always_pass`、`time` の timeline を `minecraft:day` に変えた 13 件は受理された。関数を実行せずに測定した。再現手順と個々の候補は `docs/command-shape-audit.md` の #166 の表を参照。
### BDS の関数読み込みによる構文検査（#165）

BDS 1.26.63.1 の使い捨てワールドで、合成コマンドを 1 行ずつ別のビヘイビアーパック関数に置き、関数を呼び出さずに起動ログを調べた（`tools/shape-bedrock-audit.ts`、`shape-bedrock-audit.servers.test.ts`）。`time set noon` は読み込みエラーなし、`time set bogus`、不正な effect、存在しないコマンド名はそれぞれ関数名と行番号を含む読み込みエラーになった。読み込み後に副作用のある対照の scoreboard objective を新規作成でき、対照の関数が読み込み時に実行されていないことも確認した。直接実行と異なり、この対照では引数の不正を区別できた。関数内で使えるコマンドや参照の制約、実行時の成否・意味の一致、すべての不正引数は未検証であり、エラーなしを一般的な完全受理の証明とはしない。

Java 26.3 の #112 監査結果を入力とすると、1,424 形・1,520 候補のうち Java 受理かつ rewritten / unchanged の 180 形・222 候補を検査し、221 件は読み込みエラーなし、1 件はエラーだった。`time query time` は Java 受理・unchanged だが BDS 関数読み込みでは `time` 引数が構文エラーだった。残る 1,244 形・1,298 候補は Java 不受理または unsupported のため BDS 未検査。形ごとの候補数・未検査数と各候補の結果は `node tools/shape-java-audit.ts /tmp/java.json && node tools/shape-bedrock-audit.ts /tmp/java.json /tmp/bedrock.json` で再生成できる。合成入力のみを使用する。

ローカルで実サーバーテストを 3 回実行した所要時間は 14.23、14.19、13.88 秒（Java の監査生成を含む）。CI では bridge 実サーバージョブに対照と全対象候補の読み込みを追加し、既知の `time query time` の不一致を明示して他の読み込みエラーを回帰として検出する。後続の #318 では、監査パックのエンジン版を変換器に揃えると、この不一致が解消した。読み込みエラーの有無と Java の受理を比較するもので、候補生成の網羅性や実行結果を保証しない。

### 中核を束ねた BDS パックの起動（#217）

BDS 1.26.63.1 で `packages/runtime-host/src/bundle.servers.test.ts` を実行し、製品用バンドルから中核の scoreboard 命令を仮ホストで3回実行した。各回の結果とスコアは 42。`main.js` は非圧縮 6,168 bytes、テンプレート準備後の起動要求から結果ログまで 1,085 / 1,022 / 1,082 ms。生成データ・manifest はサイズに含まず、起動時間にはワールド読み込みを含む。

### エンティティ名と装備の版別観測（#219）

`scenarios/datapack/entity-nbt-equivalence` を Java 1.20.6、1.21.4、1.21.11、26.2、26.3 で実行した。防具立てに主手の石、副手の土、足の鉄のブーツを装備し、旧版には JSON テキスト文字列 `"Probe"`、26.3 には文字列 `Probe` を名前として与えた。各版で `name=Probe` セレクターが一致した。`data get` の成功と entity から storage にコピーした値は各版の `*.java*.json` に記録した。

1.20.6 と 1.21.4 は `HandItems` と `ArmorItems` の取得が成功し、主手・副手は順に hand の 0・1、足は armor の 0 に入り、空スロットは空 compound だった。1.21.11、26.2、26.3 はそれらの取得が失敗し、`equipment` と `equipment.mainhand` / `offhand` / `feet` の取得が成功し、対応する装備が入った。名前のコピーは旧版が `"Probe"` を含む文字列、26.3 が `Probe` だった。

この例の装備と単純な名前は対応する値へ正規化できるが、実行中の `data get` や storage コピーは版の違いを観測できるため、実体を 26.3 形式へ正規化するだけでは旧版の観測を保持できない。複雑な名前や装備の全組合せの可逆性はこの実験の対象外。ソース版の表現を扱う後続作業は #247。

### execute のゼロスコアと保存形式（#220）

`packages/bridge/src/execute-zero.servers.test.ts` は `execute-extra` の4条件をそれぞれ初期値 -1 のスコアへ `execute store result` し、応答、保存前後の `scoreboard players get`、保存 NBT とダンプ、再起動後の取得を測る。結果は `scenarios/datapack/execute-zero-observations.java*.json`。Java 1.20.6、1.21.4、1.21.11、26.2、26.3 のすべてで4コマンドの応答は `Test failed`、取得値は保存前・保存後・再起動後とも 0 だった。

1.20.6 と 1.21.4 の保存 NBT は各エントリに `Score: 0` を含み、ダンプも 0 を返した。1.21.11、26.2、26.3 の保存 NBT は各エントリが存在するが `Score` を含まず、修正前のダンプはそのエントリを返さなかった。この4例の差は、保存データで `Score` を省略したエントリを 0 として読み取る正規化で吸収でき、execute の版別実行挙動はこの観測に限れば不要。#249 の修正後、26.3 の同テストはダンプでも 0 を返した。また `packages/bridge/src/convert-cli.servers.test.ts` は 26.3 の保存ワールドにあるゼロと 42 を CLI で変換し、BDS の出力ワールドでそれぞれ 0 と 42 を確認した（各テストを3回実行）。

### PR の浅い checkout と base SHA（#225）

[CI run 45150800820](https://github.com/tapu18/mc-je2be-map-converter/actions/runs/45150800820/job/137611563490) は merge commit `743a585` を深さ 2 で取得した。checkout のログ上のマージ先は `f493ddf`、イベントの base SHA は `b700b79` で異なり、後者を使う diff は `bad object` となった。`tools/server-test-plan.test.ts` の使い捨て Git リポジトリでも、浅い checkout の範囲外の base は diff に失敗し、SHA を明示的に取得すると文書差分と PoC 差分を選択できた。取得できない場合は全実機テストを選択する。

### 保存された command storage（#201）

Java 26.3 で複数の名前空間に compound、long 最大値と long 配列を保存したワールドについて、変換器の型付き初期データを復号して `JavaServer.dump()` と比較した結果は一致した。根拠は [実サーバーテスト](../packages/bridge/src/initial-storage.servers.test.ts)。

### スコアを使うセレクタと条件（#261）

Java 26.3 の `scenarios/datapack/score-selector-conditions` を3回記録し、同一の `score-selector-conditions.java.json` を得た。4体の marker のうち値 1・3・5 の3体にスコアを設定すると、`..3` は2体、`5..`・`2..4`・完全一致 3 は各1体、2目的の条件も1体に一致した。未設定の1体は全域指定にも一致しなかった。3体への `remove 2` は -1・1・3、最小値からの `remove 1` は 2147483647 になった。チーム条件と `unless` の結果も同じ記録にある。プレイヤーは接続していないため、`@a` と `gamemode` の観測は空集合に限る。

#262 で Java 26.3 の同シナリオを再実行し、Node のフェイクホストでも全観測値が正解データと一致した。Java の追加 RCON 検証では、`scores={__proto__=-2147483648}` で選んだ2体に `scoreboard players remove … __proto__ 1` を実行すると、各スコアは 2147483647、`execute store result` が保存した合計は -2 になった。`unless score` は存在する objective の未設定スコアでは成立し、存在しない objective ではエラーになった。根拠は [正解データ](../scenarios/datapack/score-selector-conditions.java.json) と [Node の照合テスト](../packages/bridge/src/runtime-context-ir.data.test.ts)。

### CI schedule の実行履歴（#241）

2026-11-24 の調査時点で `gh run list --workflow ci.yml --event schedule --limit 100` に表示された実行は [run 45323204840](https://github.com/tapu18/mc-je2be-map-converter/actions/runs/45323204840) のみだった。UTC 11月24日 03:59:11 に作成・開始され、04:10:38 に成功した。`check` と `servers / result` も成功した。CI の cron は `23 18 * * *` で、直前の予定は 11月23日 18:23 UTC。予定との対応は履歴から直接確認できない。11月22日 18:23 UTC の予定に対応すると特定できる実行は見つからなかった。

### Script API ホスト接続（#234）

`packages/runtime-host/src/host.servers.test.ts`（BDS 1.26.66.1）では、現行 `executeCommand` の objective 追加、`scoreboard players set alice test 42`、保持者と objective の削除を Script API へ投影し、3回連続で値と結果を確認した。同テストで既存 objective との衝突による投影失敗と以降の実行停止、ブロックの読み書き・未ロード・範囲外・不正 ID、候補とエンティティ取得、ネイティブ命令、動的プロパティを確認した。削除済みの文字列保持者を `getScore` で読むと例外となったため、削除は参加者一覧で検証した。候補の完全性は検証しておらず、ホストは常に不完全と返す。

### 関数からのネイティブ委譲（#309）

`packages/runtime-host/src/host.servers.test.ts` は BDS 1.26.66.1 の独立したワールド 3 回で、関数内の `execute as … at @s` を経由した `setblock` が試験プレイヤーからの相対位置に石を配置することを確認した。委譲直前の BE スコアは `setblock` で 41、続く `score` 成分付き `tellraw @s` で 42 だった。後者は試験プレイヤー 1 人への成功件数を観測した。クライアントの描画結果は観測していない。

同テストでは、`-0.0000001` を位置と向きに含むコンテキストでも生成パックからの委譲が成功した。BDS 1.26.66.1 の別のコンソール試行では、`execute positioned -1e-7 -59 0 run say precision` が構文エラーになった。

### worldborder の時間指定（#199）

`packages/bridge/src/worldborder-normalize.servers.test.ts` で Java 1.21.10 の `7` と 1.21.11 の `7s` を比較した。固定した境界から `add`、`set`、`warning time` を個別に実行すると、応答に示される時間はどちらも 7 秒だった（3回実行）。進行中の境界の操作全般は未検証。

#302 で同テストに極端な `warning time` を追加した。Java 1.21.10 の `2147483647` では応答に 2147483647 秒、1.21.11 の `2147483647s` では 107374182.35 秒が表示された。

### time set の固定時刻名（#199）

`packages/bridge/src/time-marker-normalize.servers.test.ts` は Java 1.21.11 と 26.1 で tick を止め、`time set day/noon/night/midnight` 後の保存値を調べた。旧版の `level.dat` の `DayTime` と新版の `world_clocks.dat` の overworld `total_ticks` を 24000 で割った余りは、両版とも順に 1000・6000・13000・18000 だった（3回実行、既定データパック）。

### 確定世代の再起動（#303）

`packages/runtime-host/src/persistence.servers.test.ts` は BDS 1.26.66.1 で、通常のランタイム起動後にセッションのコマンドでスコアと storage を変更し、tick 境界で確定して正常停止したワールドを再起動した。両方の復元と BE スコアへの投影は独立したワールドで 3 回成功した。`packages/bridge/src/output-world.servers.test.ts` では BE コマンドによるスコア変更も正常停止・再起動後に残り、修正後に3回成功した。強制終了、部分書き込み、容量不足はこれらのテストでは検証していない。

### Java 1.20.4 の文法（#191）

固定した公式サーバーから生成した文法の版情報は DataVersion 3700、データパック形式 26 だった。`packages/bridge/src/versioned-grammar.servers.test.ts` で JSON テキスト、ゲームルール、チーム色、座標など14例の受理・不受理を生成文法のパーサと Java 1.20.4 で比較し、3回一致した。旧アイテムや particle の網羅的な対応を示すものではない。

## 実行コンテキストの正解照合（#231）

Java 26.3 の実サーバーで `execute-context`、`execute-anchor`、`execute-dimension`、`calls` の記録を再検証し、フェイクホストでも4本の正規化済み観測値が一致した。`calls` では、関数内の `@s` から読み出したスコアが近い順に `1, 2, 3`、遠い順に `3, 2, 1` になった。根拠は `packages/bridge/src/scenario/scenarios.servers.test.ts`、`packages/bridge/src/runtime-context-ir.data.test.ts`、`scenarios/datapack/calls.java.json`。

## attribute modifier とスポーン回転の版差（#301）

`packages/bridge/src/versioned-grammar-spawn-attribute.servers.test.ts` で、Java 1.20.6 の UUID と 1.21 の `minecraft:<uuid>` を使って同じカスタム modifier を操作し、3種類の演算で取得値・適用後の属性値・削除後の属性値が一致した。速度効果の組み込み modifier も、旧 UUID と新 ID `minecraft:effect.speed` で同じ値を取得できた。

同テストで、実行元の yaw が 20、pitch が 40 のとき、Java 1.21.8 の `setworldspawn 2 64 3 ~15` と 1.21.9 の `setworldspawn 2 64 3 ~15 0` はともに座標 `[2, 64, 3]` と yaw 35 を保存し、1.21.9 の pitch は 0 だった。`spawnpoint` の両版の構文も Java が受理した。プレイヤー不在のため、個人のスポーン地点の保存は測定していない。

## 変換時の版境界の連結（#302）

`packages/bridge/src/datapack-convert.servers.test.ts` では、Java 1.20.5、1.21.1、26.2 で保存したワールドを変換した。生成した `datapacks.js` に含まれる固定時刻指定、`execute if items` と時刻指定の組み合わせ、`data modify block` の IR はそれぞれ 26.3 の生成文法でパースした IR と一致した。名前空間を省いた `schedule clear` を含む関数は、変換レポートにパック名・ファイル名・行番号付きの診断が出て、関数ごと出力から省かれた。

`packages/bridge/src/rewrite.servers.test.ts` では、Java 1.20.5 で保存した `time set noon` のコマンドブロックが `time set 6000` に書き換わり、BDS が受理した。同じワールドの名前空間を省いた `schedule clear` と極端な `worldborder warning time` は、コマンドブロックの位置付きで診断された。

## 地形とコマンドのブロック状態の対応差（#111）

Java 26.3 の `blocks.json` が列挙する 1,286 ID・35,723 状態を測った。Geyser の固定表（`e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7`、BE 1.26.60）とは Java 側のキーが重複・欠落なしで一致した。Java 26.3 の保存形式で全状態を 70 チャンクの合成ワールドに置き、ファイルを開き直して全座標の状態を照合した。状態の間には空気を挟み、ゲーム内の tick を経由せずに Chunker 1.21.0 で `BEDROCK_R26_60` へ変換した。変換後の LevelDB を開き、全チャンクの目印と空気の対照セルを確認してから、各座標の全層を読んだ。

| BE 出力の比較 | Java 状態数 |
| --- | ---: |
| 主層が一致し、副層に非空気ブロックなし | 21,734 |
| 主層だけに差 | 632 |
| 副層だけに差 | 13,054 |
| 主層と副層の両方に差 | 303 |
| 合計 | 35,723 |

主層に差がある 935 状態のうち、47 状態は ID が異なり、888 状態は同じ ID で型付きプロパティが異なった。副層に非空気ブロックがある 13,357 状態ではすべて `minecraft:water[liquid_depth=0]` を読んだ。このうち 13,325 状態に Java の `waterlogged=true` があった。比較した Geyser 表の行は単一の BE ブロック状態を持つ。たとえば `beetroots[age=1]` の主層は Chunker が `minecraft:beetroot[growth=2]`、Geyser 表が `minecraft:beetroot[growth=3]`。BDS 1.26.66.1 で合成ワールドを開き、現行の書き換えが出力する `execute if block 61 67 15 minecraft:beetroot ["growth"=3] run say match` は成功数 0、同じ座標で `growth=2` を指定すると成功数 1 だった。ほかの状態の差は変換直後の保存値の比較で、コマンドの実行はこの例で測った。

### 配布マップでの頻度

差があった全 13,989 状態と、各状態の保存セル数・出現 ZIP 数は [差分一覧（TSV）](research/block-state-differences.tsv) に記録した。BE の文字列プロパティは引用符付き。副層が空欄の場合は、そのセルに非空気ブロックがなかった。

配布 ZIP 19 本に含まれる保存ワールド 18 件の全ディメンションから 483 region・265,760 チャンクを読んだ。パレットの添字を数えると 25,950,519,296 セル（空気を含む）で、そのうち 25,950,516,648 セルの ID とプロパティが 26.3 の状態表と完全一致した。26.x の文字列で保存された既定状態は 26.3 の既定値で補った。旧版の状態の改名や DataFixer による更新、コマンドの参照回数やプレイ中の変化は集計対象外。

| BE 出力の比較 | コーパスで出現した Java 状態数 | 保存セル数 |
| --- | ---: | ---: |
| 主層だけに差 | 110 | 518,777 |
| 副層だけに差 | 341 | 12,263 |
| 主層と副層の両方に差 | 1 | 757 |
| 合計 | 452 | 531,797 |

主層に差のあるセルは 519,534 個で、Java ID 別の上位は `brown_mushroom_block`（450,290）、`water`（52,681）、`lava`（11,770）。ビートルートの再現例と同じ `beetroots[age=1]` は 1 ZIP で 1 セル見つかった。

### 再現

`npm run setup:servers` と `npm run setup:mappings` を済ませ、Java 26.3 が生成した `level.dat` と Java ソースを起動できる JDK（実測は 21）を用意する。検証用の `level.dat` は、たとえば `npm run test:servers -- packages/bridge/src/playtest.servers.test.ts` で作成される `servers/java-26.3/je2be-test/level.dat` を使える。

```sh
scratch=$(mktemp -d)
node tools/block-state-audit/measure.ts "$scratch/run" servers/java-26.3/je2be-test/level.dat
python3 -I tools/block-state-audit/corpus.py /path/to/sample-map "$scratch/run/comparison.json" \
  servers/reports-26.3/reports/blocks.json "$scratch/differences.tsv"
```

BDS の照合には `BedrockServer.start({ world: "<scratch>/run/bedrock", tickingArea: [48, 0, 63, 15] })` を使い、上記の 2 コマンドを `exec` で実行した。関連する `playtest.servers.test.ts` と `rewrite.servers.test.ts` は計 11 件成功。対応策の検証は #323。

### 地形とコマンドのブロック状態を揃える（#323）

対象は #111 と同じ Java 26.3 の状態表、Chunker 1.21.0 の `BEDROCK_R26_60` 出力、Geyser 表 `e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7`。出典は [#111 の差分一覧](research/block-state-differences.tsv)。集計は保存セル数で、コマンド内の参照回数を表さない。

| 採用した Java ID | 主層差のある状態数 | 出現した保存セル数 | 採用理由 |
| --- | ---: | ---: | --- |
| `beetroots` | 1 | 1 | BDS で条件照合の失敗を再現した |
| `brown_mushroom_block` | 28 | 450,290 | コーパスの主層差で最多。多対一の検証に使った |

補正後、ビートルートの 4 状態は 4 つの主層の状態に対応する。茶色のキノコブロックの 64 状態は 11 の主層の状態に集約され、`huge_mushroom_bits=14` には 26 状態が対応する。#111 の Chunker 主層全件を逆引きすると、この 2 種の BE ID に落ちる別の Java ID はなかった。

補正した主層はワールド変換時の配置と条件で共有する。条件を満たす状態と満たさない状態を BE の条件 1 個で区別できないときは、`if` と `unless` のどちらも理由付きで未対応になる。水没を指定して配置する場合は、副層に水が入らない旨が警告される。表の適用は JAR、出力形式、対応表のリビジョンと入力のハッシュがこの計測条件に一致する場合に限る。版の更新時は #111 の手順で再計測し、BDS で再検証する。残りの主層差 906 状態には従来の表を使う。水・溶岩の 64,451 セルは #340 で追跡する。

[実サーバーテスト](../packages/bridge/src/chunker-block-mappings.servers.test.ts) では、Java が保存したワールドを Chunker で変換し、書き換えレポートのコマンドを BDS 1.26.66.1 で実行した。地形と `setblock`・`fill` の全配置セルで `beetroots[age=1]` の条件が成立し、`age=2` の対照セルでは `unless` の側だけが実行された。状態指定を省くと両方の齢が一致した。後続のスコア加算回数も条件ごとの成功件数と一致した。茶色のキノコブロックの Java 2 状態は、地形とコマンド配置の両方で `huge_mushroom_bits=14` に一致した。ID のみの条件は使え、同じ主層になる状態を区別しようとする条件は診断された。

同じテストで、Chunker が変換した上付きオークハーフブロックの乾いたセルと水没したセルは、向きだけを指定した条件では両方とも一致した。検証パックの `Block.isWaterlogged` では両セルを区別できた。どちらのセルでも `execute if block … minecraft:water` は成立しなかった。水没を指定した書き換え後の `setblock` で置いたブロックを同じ API で見ると乾いていた。

### マクロの引数を渡す経路（#316）

Java 26.3 の実サーバーで `macro-arguments`・`storage-macro` の記録を再現した（`scenarios.servers.test.ts`）。直接渡した double は型接尾辞なしの文字列に展開され、空白を含む文字列は引用符内の値として保持された。entity のパスから取得した値と block entity のルートから取得した座標が展開され、キーが欠けた呼び出しの成功値は 0 だった。storage から渡した2つの複合値によるスコア・storage の更新も正解 JSON に一致した。`macro.data.test.ts` では同じ観測項目を Node のフェイクホストで突き合わせた。

### マクロ行の型紙化と穴を埋める時間（#349）

2026-11-28 の非公開コーパスのマクロ 3,630 行（10 作品）を `tools/macro-template-corpus.ts` で `compileMacroTemplate` に通した。文法は pack.mcmeta の範囲で選んだ。型紙になったのは 1,247 行（34.4%、8 作品）だった。落ちた行の最多は entity 型の穴の 2,009 行（4 作品）で、うち 1,837 行は 1 作品の同じ形だった。型紙を保存形式に通して `expandMacro` で埋めると、Node v24.13.1 で 1 行あたり中央値 7.0〜8.4 µs（4 回）だった。同じ引数の繰り返しと違う引数の差は 0.5 µs 以下だった。うち約 3.6 µs は版の正規化だった。理由ごとの内訳・形・測定条件は [docs/research/macro-template-coverage.md](research/macro-template-coverage.md)。BE のスクリプトエンジンでの時間は測っていない。

### ランタイムのカスタムコマンド起動口（#317）

BDS 1.26.66.1 の `packages/runtime-host/src/launcher.servers.test.ts` で、オーバーワールドのコマンドブロックから渡した実行者・位置・向きを中核が使い、ネザーの指定位置にある対象を選んだ。成功した関数は `return 0` でも後続の条件付きブロックを動かし、比較器を点灯させた。`return fail` の行では、失敗前に設定したスコアは反映され、条件付きブロックは動かず、比較器は消灯したままだった。成否の伝わり方は M0 の `poc/launcher/launcher.servers.test.ts` と一致した。

続く条件付きブロックから起動口を呼ぶと、同じチェーンの先頭で設定したスコアを中核が読めた。ハンドラで同期実行できない委譲に達したケースでは診断が出て、委譲先のコマンドによるスコア変更は発生しなかった。

### ステータス効果の付与・解除（#319）

Java 26.3 の `data get entity … active_effects` と BDS 1.26.66.1 の `Entity.getEffect` を [変換シナリオ](../scenarios/convert/effects.json) と [Java の記録](../scenarios/convert/effects.java.json) で照合した。両版で継続時間の省略は30秒、無期限は残り tick が `-1` だった。12秒・増幅度2と、上限の1,000,000秒・増幅度255を変換後に読み返せた。Java の増幅度255は NBT の符号付き byte で `-1b` だった。BE は観測の間にも tick が進むため、有限の残り時間は10 tick 以内の差を許容した。

`clear <対象> <効果>` は指定した効果だけを解除し、`clear <対象>` と `execute as … run effect clear` は対象の両方の効果を解除した。比較用の別個体には両方の効果が残った。Java では実行者を設定せずにコンソールから `effect clear` を実行するとエンティティを要求された。`hideParticles` の真偽値を渡した変換コマンドで効果が付与され、Java の `true` では NBT の `show_particles` と `show_icon` がともに `0b` になった。

[ID 照合テスト](../packages/bridge/src/rewrite.servers.test.ts) では36種の変換先が BDS の効果レジストリにあり、ブタを対象にした付与で成功件数1が返った。`hero_of_the_village` の変換先は `village_hero`。残る `dolphins_grace`・`glowing`・`luck`・`unluck` は Java では付与され、BDS の効果レジストリに相当する項目がなく、同名の付与コマンドは BDS で構文エラーになった。

### ランタイムの load・tick 起動（#235）

BDS 1.26.66.1 で `scenarios/datapack/load-tick.json` の変換済みワールドを起動し、ランタイムの第 4 tick の確定世代と BE の投影を観測した。Java 26.3 の正解と、`clock/#tick = 4`、空の `after_reload`、`load` の後に tick 1〜4 を記録した順序が一致した。反復コマンドブロックの 4 行が欠けた。変換済みブロックからランタイム関数を起動する経路は #236、コマンドブロック起点との相対順序は #19 で扱う。根拠は `packages/bridge/src/scenario/scenarios.servers.test.ts`。

`packages/runtime-host/src/startup.servers.test.ts` では、BDS の初回起動と同じワールドの再起動で、各起動の最初の `tick` が同じ tick の `schedule` によるスコア変更を読み取った。再起動の `load` は前セッションで確定したスコアと storage を読み取った。

### データパックのシナリオを変換済みランタイムで照合（#102）

BDS 1.26.66.1 で、#96 の `calls`・`schedule`・`score-operations`・`storage-macro` の変換済みワールドを起動した。各 `run` 操作を1行の関数として変換器に通し、ランタイムの tick の合間に呼んだ（`bedrockRuntime: "actions"`、docs/scenarios.md）。結果を Java 26.3 の正解データと比べた（3回連続で同じ結果、`packages/bridge/src/scenario/scenarios.servers.test.ts`）。

- `score-operations`：全演算子、負数の除算・剰余（`-7 / 2 = -4`、`-7 % 2 = 1`、`7 / -2 = -4`、`7 % -2 = -1`）、加算のオーバーフロー（`-2147483648`）が一致した
- `schedule`：2 tick 後に `append` だけ、4 tick 後に `append` 2回、5 tick 後に `replace` が加わる順序が一致した。`replace` で以前の予約が消え、`clear` した関数は動かなかった
- `storage-macro`：`set`・`merge`・`append`、スコアの保存、storage の複合値からのマクロ展開が一致した
- `calls`：`return`・`return run`・`return fail`、`execute store result/success`、関数タグの順序（`second` → `first`）、スコア条件で動かない呼び出しが一致した。`summon minecraft:marker` は変換器が Java 専用エンティティとして未対応にしたため（代替エンティティは #383）、marker を実行者にした `executors` は Java の `[1,2,3,3,2,1]` に対して空だった

### 変換したコマンドブロックのチェーン起動（#321）

[自作シナリオ](../scenarios/convert/runtime-command-chain.json) を Java 26.3 で生成し、Chunker 1.21.0 を通したワールドを BDS 1.26.66.1 で起動した。先頭のインパルスをレッドストーンで起動すると、storage から取得した値がスコア `observed = 42` になった。存在しないパスの取得の直後にある条件付きブロックはスキップされ、末尾の加算は1回だけ動いた。東向きに曲がる部分のローカル座標に従ってエメラルドブロックが置かれ、後続の BE への委譲がその位置で条件を満たしてダイヤモンドブロックに置き換えた。両版の観測値は [Java の正解データ](../scenarios/convert/runtime-command-chain.java.json) と一致した。

BDS のカスタムコマンドの文字列引数では、`chain@0` を引用符なしで渡すと `@0` で構文エラーになった。引用符付きの `"chain@0"` は受理され、生成したワールドからの起動にも使えた。

### 書き込みのできる段階に移したチェーンの成否（#236）

BDS 1.26.66.1 の `packages/runtime-host/src/deferred-chain.servers.test.ts`（3回連続成功）で確かめた。`deferred` を付けたチェーンを `je2be:run` で起動すると、ハンドラはキューに積んで `Failure` を返し、毎tickの処理（`system.runInterval`）で丸ごと実行された。先頭のスコア設定の後、委譲した `tag @e[tag=…,c=1] add …` は、対象がいる行では `successCount` 1 でタグを付けて後ろの条件付きブロックを動かした。対象がいない行では条件付きブロックが動かず、スコアは設定されなかった。どちらの行でも先頭の比較器は点灯しなかった。同じ配置で `deferred` を外すと（ハンドラ内で実行）、委譲の成否が未確定のため対象がいる行でも条件付きブロックが動かなかった。

### エンティティとプレイヤーのスコア保持者（#331）

`packages/runtime-host/src/holders.servers.test.ts`（BDS 1.26.66.1、各3回）で確かめた。

- `ScoreboardObjective.setScore` に試験プレイヤーや防具立ての `Entity` を渡すと、参加者の種類はそれぞれ `Player` と `Entity` になり、同名の偽プレイヤーは作られない。名前の文字列を渡すと偽プレイヤーになる（#331 の本文）。試験プレイヤーと防具立ての `Entity.id` は `-8589934591` と `-8589934590` のような 32 ビットの範囲外の負の数字列だった。
- 関数内で `execute as <プレイヤー> run scoreboard players set @s held 7` と、防具立てへの `set @s held 5` を実行して投影した直後、委譲した `tag @s[scores={held=7}]` と `tag @s[scores={held=5}]` はそれぞれ実体にタグを付けた。
- ネイティブの `scoreboard players add @e[...] held 10` の後の `syncScores` で、防具立ての値 15 がランタイムの ID 保持者に取り込まれた。ネイティブで消したプレイヤーのスコアはランタイムからも消えた。ランタイムでの削除後、BE の参加者一覧から防具立ては消えた。
- 防具立てのスコアは再起動後も同じ `Entity.id` に付いていた。チャンクが読み込まれる前、その参加者の `ScoreboardIdentity.getEntity()` は例外を投げた（`Failed to call function 'getEntity'`）。起動時の投影はその ID の偽プレイヤーを作らず、読み込み後の変更と削除も実体に反映した。
- 中核はセレクタの保持者への `scoreboard players add` と `reset` に対応していない（`assessScore`）。テストは `set`・`remove` と、ID の文字列による `reset` を使った。

### 水・溶岩の流体状態（#340）

[実サーバーテスト](../packages/bridge/src/chunker-fluid-states.servers.test.ts)（Java 26.3、Chunker 1.21.0 `BEDROCK_R26_60`、BDS 1.26.66.1、3 回連続成功）で確かめた。Java で tick を止め、ガラスで囲んだセルに、水源から横に流れる水 `level=0..7` と溶岩 `level=0,2,4,6`、水源の下に流れ落ちる `level=8` の列、水源につながらない水 `level=3,10` と溶岩 `level=4,10` を置いて保存した。

- ロード直後の BDS では、全セルが Script API と `execute if block` の両方で `minecraft:water` / `minecraft:lava` と見え、`liquid_depth` は Java の `level` と同じ値だった。`flowing_water` / `flowing_lava` の条件は成立しなかった。何もせず 100 tick 待っても、水源につながらないセルを含めて変化しなかった。
- 上のガラスを石に置き換えて隣のブロックを更新すると、安定した流れは ID も水位も変わらず、水源につながらないセルは消えた。横の壁を開けて BDS が新しく流した水 `liquid_depth=3` も `minecraft:water` と見えた。
- 書き換えた `setblock` / `fill` は Geyser 表の `flowing_water ["liquid_depth"=N]` / `flowing_lava` を置く。水源の隣に置いた `level=1` は残り、水源につながらない水 `level=3` と溶岩 `level=4` は 200 tick 以内に消えた。同じ配置を Java で 200 tick 進めた結果と一致した。対照として静止の ID で置いた孤立した `water ["liquid_depth"=3]` は、200 tick 後も残り、隣の更新で消えた。水源の隣に `flowing_water` で置いたセルも、200 tick 後は `minecraft:water` と見えた。

このため #340 では、条件だけ静止の ID に置き換えた。地形・BDS が流した水・書き換えた配置の全セルで、ID だけの条件、同じ水位の `if`、違う水位の `unless` が成立し、同じ水位の `unless` と違う水位の `if` は成立しなかった。後続のスコア加算回数も成功件数と一致した。Java の `level` 16 値は BE の `liquid_depth` 16 値に一対一で対応するので、条件で未対応にする区別はない。補正前の表では ID だけの条件が複数の BE ID になって未対応になり、水位付きの条件は `flowing_*` を指定して成立しなかった。

残る差は地形の流体の更新で、Java で tick を止めて保存した水源につながらない流水は、BDS では隣が更新されるまで残る。

### 確定世代の強制終了・部分書き込み・容量（#200）

BDS 1.26.66.1、`@minecraft/server` 2.12.0-beta、変換と同じ `je2be_init` パックで測った。CI で確かめる性質は `packages/runtime-host/src/restart.servers.test.ts`（3 回連続で成功）、揺れる性質は `poc/state-durability/results.json`（`measure.ts`）にある。

- **正常停止**：スコア、約 100KB の storage（4 片に分割）、`load` で予約した 100 tick 後の `schedule` が、正常停止と再起動を 2 回またいで残った。予約は再起動後のランタイム tick 100 に、`tick` タグより前に実行された（`#later = 99`）
- **強制終了（SIGKILL）**：8 回の強制終了で、復元はすべて一貫した確定世代から成功し、片の欠けや索引の不整合は起きなかった。ただし、残る世代は起動中に確定した最新の世代ではなかった。`killWithoutSave` では、5 回とも、ある起動の `load` 直後（ランタイム tick 0）の世代か、それより前の世代に戻った。1〜70 秒（最大 1,425 tick）の進行が失われた。起動直後の `load` の確定が残るかどうかも、実行ごとに揺れた
- **`save hold` / `save query` / `save resume` の後の強制終了**：`Data saved. Files are now ready to be copied.` が出た後でも、保持した時点の世代が残ったのは 5 回中 1 回だった。残りは起動時か、前回の正常停止時の世代に戻った。ランタイムから保存の時点を確かめる手段は見つかっていない
- **部分書き込みの模擬**：確定していない世代の片（マーカーが指さない `je2be:state:<世代>:<slot>:<片>`）を書いて再起動しても、復元はそれを読まずに成功した。片は回収されずに残った。確定した世代の片を 1 件消すと、次の tick の確定が `state persistence failed: Error: missing state chunk <世代>/<slot>/<片>` で失敗して tick が止まった。再起動後も `[je2be] initialization failed` で止まり、初期データへの巻き戻しや一部だけの読み込みは起きなかった（`load` は動かない）
- **容量**：動的プロパティ 1 件の上限は UTF-8 で 32,767 バイト（既知、`poc/dynamic-properties/`）。32,767 バイトの値を 4,000 件（合計 131,135,243 バイト）書いても失敗せず、500 件ごとに約 50〜160ms かかった。正常停止の後、全件を読み直せた。確定マーカーの索引は 1 件の動的プロパティに収める。600 個の objective を持つ初期状態では、`state index exceeds dynamic property capacity` で初期化が止まり、マーカーは書かれなかった。切り詰めは起きなかった
- **マクロ**：`function test:macro {holder:"m",score:7}` と `with storage` による呼び出しは、BDS で中核と同じ結果になった。展開に失敗した呼び出し（引数の欠け、引数の境界を変える値）は、何も実行しなかった。失敗はスクリプトの `console.warn` で `[Scripting] [je2be] function test:macro: <理由>` としてコンテンツログ（`content-log-console-output-enabled`）に出た

### エンティティ NBT の読み取り（#345）

Java 26.3 で記録した `scenarios/datapack/entity-nbt-read.java.json`（Node のフェイクホストとの照合は `packages/bridge/src/runtime-context-ir.data.test.ts`）。

- `data get entity` の値は保存型の値に倍率を掛けて切り下げる。`Rotation` は float のため、`Rotation:[33.3f,12.7f]` の 10 倍は 332 と 126 になる。倍率なしの `Rotation[1]`（-30.25）は -31、`Motion[2]`（-0.125）は -1
- 添字なしの `Pos` は 3、`UUID` は 4（要素数）を返す。`UUID[3]`・`UUID[-1]` のように int 配列にも添字（負を含む）が使え、要素の int を返す
- 停止中の tick で召喚した `NoGravity` の防具立ては、召喚時の `Motion` をそのまま返す。`Motion` を指定しないマーカーも `Motion:[0.0,0.0,0.0]` を持つ
- `execute store result storage … double 0.001` は `data get` の結果（1250）を 1.25 の double として書く

### kill・tag・teleport をコマンドブロックに残す経路（#346）

Java 26.3 と BDS 1.26.66.1 で、変換を通す `scenarios/convert/entity-commands`（3 回連続で両エディションとも通過）。対象は防具立てと豚で、プレイヤーは測っていない（#363）。成否はコマンドごとの条件付きチェーンでスコアに残した成功・失敗で、成功件数そのものは比べていない。

- `kill @e[tag=…]`（防具立て・豚）、`execute as … run kill`（引数なし）は、40 tick 後に両エディションとも対象が残らなかった。一致しないセレクタの `kill` はどちらも失敗した
- `tag … add` は複数の対象に付き、すでに持つタグの `add` と、持たないタグの `remove` は、どちらのエディションでも失敗した。一致しないセレクタも失敗
- `tp` の絶対座標（小数）、`~` の相対座標、`execute … at @s run tp @s ~ ~ ~`、`<位置> <向き>`、`~45 ~10` の相対の向き、`facing <位置>`、`facing entity`（`feet` あり・なし、`entity` と `feet` を除いて BE の `facing <対象>` に書き換え）、`tp <対象> <対象>` で、座標とヨーが 0.01 以内で一致した。コマンドブロックからの `~` は両エディションとも、ブロックの x・z の中央を起点にした
- **防具立てのピッチ**：BE の防具立ては `tp` で付けたピッチを保たず、40 tick 後の観測では 0 だった（ヨーは一致）。同じ tick の `execute as … at @s run tp @s ^ ^ ^4` はピッチ -60 度の向きに動いた（座標が Java と一致）。40 tick 後の同じ操作は水平に 4 進んだ（Java は -60 度のまま 2 進む）。Java は `tp` で付けたピッチを保ち続ける。0 に戻るまでの tick 数は測っていない
- 防具立てのピッチが 40 tick 後に 0 になるため、`facing entity` の `feet`（Java の既定）と目の高さの違いは、このシナリオでは区別できていない。ヨーだけが一致を示す

### tellraw・titleraw の成分と successCount（#347）

Java 26.3 / BDS 1.26.66.1。`packages/bridge/src/text.servers.test.ts`（3 回連続で通過）。GameTest の試験用プレイヤー 1 人を置いて測った。コーパスの頻度と成分ごとの扱いは [text-components.md](text-components.md)。

- text・translate（`with`・`fallback` 付き）・score（名前、`*`、`@s`、`@p`、偽プレイヤー、値のない名前、ない目的）・selector（一致なしを含む）と、色・16 進の色・太字などの書式、`extra` の深さ 2 を書き換えた `tellraw`・`titleraw title/subtitle/actionbar` は、どれも successCount 1 だった
- successCount は受け取ったプレイヤーの数で、rawtext の中身では変わらない。BE の rawtext に未知のキー（`keybind`、`nbt`・`storage`、部分の `color`）を書いても、空の `rawtext` でも 1。`rawtext` を持たない Java 形式の JSON（`{"text":"x"}`）は 0、対象がいない `tellraw` は失敗した。表示されたかどうかは successCount では区別できない
- Java 26.3 のサーバーは `tellraw @a 12`（数だけのテキスト）と `color:"reset"` のテキストを拒否した（同テストの `uses inputs that Java 26.3 accepts`）
