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
| 500個を2チャンクに密集させると全経路とも200更新/tick、8チャンクに分散すると500更新/tickになった。どちらも平均tick間隔は約50msのため、tick間隔だけでは処理量の低下を見抜けない。閾値の切り分けは下記の #31 | 同上 |
| runIntervalでキューを反映する最小処理では、custom経由は起動と同tick、scriptevent経由は1tick後に加算された。キュー処理件数の合計と各IDのスコア差分の合計は一致した | 同上 |
| BDS 1.26.63.1 では1チャンクに常時実行リピートを99/100/101/200個置くと、それぞれ毎tick 99/100/100/100更新。150+50個ではチャンクごとに100+50更新、平面の200個を8ブロックずらして100+100個に分けると100+100更新。Java 26.3 は同じどの配置でも40 tickで各ブロックが40回更新した | [#31 実機テスト](../poc/repeat-density/density.servers.test.ts)、[根拠データ](../poc/repeat-density/results.json) |
| BDS の1チャンク200個では各ブロックが40 tickで20回更新した。上下2層を置く順を反転しても、逆順の配置を保存・再起動しても、各ブロック20回・合計100更新/tickだった。100個の直下にチェスト100個、または稼働中のホッパー100個と搬出先のチェスト100個を置いても、毎tick100更新だった | [配置と測定方法](../poc/repeat-density/README.md)、[根拠データ](../poc/repeat-density/results.json)（#31、#18 の相対順テストを参照） |
| BDS の1チャンク200個は `maxCommandChainLength`（1・100000）、`functionCommandLimit`（1・10000）、`randomTickSpeed`（0・100）を変えても毎tick100更新だった。プレイヤーなしの常時読み込みエリアでは `tick-distance`（4→12）と `persistent-ticking-area-max-chunks`（100→16）の変更後も毎tick100更新。 `commandBlocksEnabled` を false にすると0更新、true で100更新に戻った | [設定別の結果](../poc/repeat-density/README.md#実測結果)、[根拠データ](../poc/repeat-density/results.json)（#31） |

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
| スコアの演算 | `operation` の全9演算子を記録した。負数を含む除算では −7 / 2 と 7 / −2 がともに −4、剰余はそれぞれ 1 と −1。最大の int に `+= 1` すると −2147483648 になった | [score-operations.java.json](../scenarios/datapack/score-operations.java.json) |
| storage とマクロ | `merge` は入れ子の既存キーを残し、指定したキーを更新・追加した。スコアを storage に保存し、2組の引数でマクロを呼ぶと、それぞれの名前に対応するスコア −7 と 12 が付いた | [storage-macro.java.json](../scenarios/datapack/storage-macro.java.json) |
| 予約実行 | `append` の2件は予約から 2、4 tick 後に動いた。`replace` を使った関数は古い予約の 2 tick 後には動かず、5 tick 後に1回動いた。`clear` で取り消した 3、6 tick 後の2件は、7 tick 後まで記録されなかった | [schedule.java.json](../scenarios/datapack/schedule.java.json) |
| load と tick | tick を止めて `reload` を済ませた時点の記録は空。最初の `tick step` で load が先に1回動いた。続く4組は各組で tick 関数 → 反復コマンドブロックの順に動き、各組の両方が同じ tick 番号 1〜4 を記録した | [load-tick.java.json](../scenarios/datapack/load-tick.java.json) |

## 実機 CI の計時（#108）

2026-11-21 の [main の CI 実行 44900032141](https://github.com/tapu18/mc-je2be-map-converter/actions/runs/44900032141) では、Vitest の計時で正解シナリオ 15 本に約 206 秒、bridge グループに約 826 秒かかった。そのうち `versioned-grammar.servers.test.ts` は約 310 秒だった。変換シナリオの連続した BE 照合の完了間隔は約 19〜22 秒だった。ジョブ開始から実機テストのステップ開始までの時間は各グループで 40 秒以内だった。

## schedule の保存・再起動（#123）

Java 26.3 の [schedule-restart](../scenarios/datapack/schedule-restart.json) では、100 tick 後の関数を予約して 30 tick 進め、保存・停止して同じワールドを再起動した。再起動直後とさらに 50 tick 後は未実行、100 tick 後には実行済みだった（[記録](../scenarios/datapack/schedule-restart.java.json)）。予約時と関数の実行時のゲーム内時刻の差は 100 tick だった。したがって、この実験では停止前に進めた 30 tick を含め、予定は予約時からのゲーム内 tick を維持していた。再起動直後の残り時間は 50 tick より長く 100 tick 以下だった。起動中にも tick が進むため、再起動直後の正確な残り tick 数や長期停止中の実時間の影響はこの実験では測っていない。

## execute の追加修飾句（#134）

Java 26.3 の [execute-extra](../scenarios/datapack/execute-extra.json) で観測した（[正解データ](../scenarios/datapack/execute-extra.java.json)）。負座標の `align xyz` は [-2, -60, 8]、`align xz` は [-2, -59.3, 8] になった。防具立てへの `facing entity` は feet と eyes で pitch が異なり、`rotated as` は対象の [90, 30]、`positioned as` は対象の位置を得た。

石・水・葉を積んだ列で `positioned over` の高さは world_surface と motion_blocking が 73、motion_blocking_no_leaves が 72、ocean_floor が 73 だった。この配置に限る観測である。`if blocks` は一致した2ブロックで all・masked とも結果 2、空気を含む範囲では masked が対応先の非空気を無視した。不一致、読み込み外チャンク、ディメンションの条件も同シナリオに記録した。

### スコア保持者とゼロ除算（#140）

| 実測 | 根拠 |
| --- | --- |
| Java 26.3 と BDS 1.26.63.1 で、`#hidden`、英字40・41・256文字、UUID形式の36文字を文字列の保持者として設定すると、記録した値は一致した。これは名前の最大長や、実在するエンティティとの対応を示さない | `scenarios/scores/runtime-boundaries.json` と Java 正解データ |
| ゼロ除数による `/=` の後、被除数 7 は両版で変わらなかった | 同上。成否はこのシナリオでは比較していない |
| 同じゼロ除算をコマンドブロックから実行すると、条件付き後続は Java では動かず BE では動いた | `scenarios/scores/zero-division-success.json` と Java 正解データ |
| 固定 UUID を持つ防具立てに対し、その UUID 文字列でスコアを設定すると Java では実体に 7 が付いた。BE で防具立てと同じ文字列の保持者を作っても実体にはスコアが付かなかった | `scenarios/scores/uuid-holder.json` と Java 正解データ |

### ランタイム用パーサ・文法・対応表の読み込み（#141）

Java 26.3 の commands.json と Geyser 対応表、既存パーサを組み込んだ PoC は BDS 1.26.63.1 で3回とも初回コマンドをパースできた。起動要求からパースまで 602 / 783 / 613 ms、スクリプト内の JSON.parse は 159 / 193 / 178 ms、パックの圧縮前合計は 12,624,623 bytes。測定範囲・環境と限界は [PoC](../poc/runtime-load/README.md)、記録は [results.json](../poc/runtime-load/results.json)。

### コマンド形の候補（#112）

Java 26.3 で `node tools/shape-java-audit.ts /tmp/shape-java-audit-112.json` を実行し、1,424 形の 1,520 候補を関数の読み込みで判定した。Java が 1,448 候補を受理し、パーサとの不一致は 72、パーサが到達した終端形の不一致は 0 だった。書き換えの結果は unsupported 1,298、unchanged 86、rewritten 136。Java の関数では使用できないコマンドや存在しない参照を含むため、この不一致数をパーサの欠陥数とは扱えない。BDS の全候補の構文判定は行っていない。

BDS 1.26.63.1 の使い捨てワールドで、Java が受理した候補のうち書き換え結果が rewritten または unchanged の 222 件を `BedrockServer.exec` で直接実行したところ、いずれも例外を返さなかった。一方、対照の `time set bogus` も例外なし・successCount 0 だった。同じ実験で不正な effect 引数、不正なブロック ID、不正なコマンド名は構文エラーを返した。したがって直接実行で例外がないことも、全引数の構文受理の証拠にはできない。

### Java 1.20.4 ワールドの更新（#145）

合成した 1.20.4 ワールドを Java 26.3 で開いた実サーバーテストでは、コマンドブロックの `Command` と関数ファイルの文字列が保存され、チェスト内アイテムの `CustomModelData` は `minecraft:custom_model_data` に移った。防具立ての `CustomName` の内容も残った。対象はテスト内の各1例である。根拠は `packages/bridge/src/upgrade-1204.servers.test.ts`（3回成功）、再現方法と文法・コーパスの調査は `docs/research-1204.md`。

### Actions の定期実行（#222）

2026-11-23 UTC の Actions API では schedule の実行履歴が 0 件で、CI と Version canary の workflow はともに active、Actions は enabled だった。隔離登録が空の状態で `include_quarantine=true` を指定した [手動 CI](https://github.com/tapu18/mc-je2be-map-converter/actions/runs/45154796628) は成功し、隔離ジョブは生成されなかった。

同日の [手動 Version canary](https://github.com/tapu18/mc-je2be-map-converter/actions/runs/45154550420) は検出、API、セットアップ、実機、Java 再記録、台帳生成がすべて成功し、`scenarios.diff` は空だった。artifact の候補は Java 26.3、BDS 1.26.66.1、Chunker 1.21.0 で、固定 BDS 1.26.63.1 との差を検出した。版上げの追跡は #227。
