# ID 対応表の入手元と検証案（#14）

2026-11-15 調査。同日、所有者が Geyser の採用とライセンス表示を承認（#14 コメントに記録）。
ID・ブロックステートの対応と変換に必要な情報を使う。検証手順は以下の提案段階。
外部資料・ソースを読んだ事項は、このプロジェクトの区分では「未確認」とする。
以下の件数はファイルの静的集計であり、BDS 上での互換性の実測ではない。
サーバーでの検証は後述の手順で行う。`findings.md` への追記はその後とする。

## 調査対象を固定する

| 資料 | 固定した版 | 記載・用途（未確認） |
| --- | --- | --- |
| [GeyserMC/mappings](https://github.com/GeyserMC/mappings/tree/e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7) | `e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7` | README は JE 26.3 / BE 1.26.60 向けと記載 |
| [GeyserMC/mappings-generator](https://github.com/GeyserMC/mappings-generator/tree/2ded44ee4f6f2c0b4164f2878c8c5dc515bdb961) | `2ded44ee4f6f2c0b4164f2878c8c5dc515bdb961` | 出力形式・生成方法の説明。生成器を本プロジェクトで実行したわけではない |
| [HiveGamesOSS/Chunker](https://github.com/HiveGamesOSS/Chunker/tree/50aaf6d82e8b68929279161b790d95fdddfe0a40) | 1.21.0、`50aaf6d82e8b68929279161b790d95fdddfe0a40` | 既に採用済みの地形変換器。対応は版別の Java 実装にある |
| [kbinani/je2be-core](https://github.com/kbinani/je2be-core/tree/8dfc4de1ba5c7f72e804abea8663380c0dbd5680) | `8dfc4de1ba5c7f72e804abea8663380c0dbd5680` | 比較用。C++ のブロック・アイテム・エンティティ変換実装がある |

本プロジェクトの検証対象は `tools/servers.json` の JE 26.3 / BDS 1.26.63.1。
Geyser の BE 1.26.60 と同一バージョンではないので、そのまま適合済みとは扱わない。
旧 JE 1.20.5 以降についても、現行の表だけで網羅できるという確認はしていない。

## ライセンスの比較（未確認・採用判断用）

| 候補 | 一次資料の表示 | 組み込む場合の扱いの提案 |
| --- | --- | --- |
| Geyser mappings / generator | [mappings LICENSE](https://github.com/GeyserMC/mappings/blob/e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7/LICENSE) は MIT、著作権表示は GeyserMC。[README](https://github.com/GeyserMC/mappings/blob/e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7/README.md) は、許諾対象を貢献者が権利を持つ独自の部分に限定し、Mojang / Microsoft の素材を再許諾しないと明記 | 派生 JSON に元ファイル・コミット・加工方法を記録。配布する変換器と生成パックの両方に著作権表示と MIT 本文を含める。Minecraft 由来データの再配布範囲の判断は MIT 表示だけで済ませず、所有者の採用承認の対象にする |
| Chunker | [LICENSE](https://github.com/HiveGamesOSS/Chunker/blob/50aaf6d82e8b68929279161b790d95fdddfe0a40/LICENSE) は MIT、著作権表示は Hive Games | 移植する対応処理・生成した表にも出典を保持し、上と同様に配布物へ表示・許諾文を含める。CLI の採用承認と対応表の転載承認を分ける |
| je2be-core | [LICENSE](https://github.com/kbinani/je2be-core/blob/8dfc4de1ba5c7f72e804abea8663380c0dbd5680/LICENSE) は GPL v3 本文、リポジトリ表示は GPL-3.0 | 今回の同梱元候補から外す。コードや表の複写・翻訳を行わない。取り込む場合は派生物の配布条件を別途判断する。別プロセスで動かすことと、対応処理をコピーすることを同じ扱いにしない |

この PR では外部のコード・表は取り込まず、承認に基づいて `THIRD_PARTY_NOTICES.md` に
Geyser の著作権表示・MIT 本文を追加する。派生表を生成する実装ではこの表示を
変換器の配布物と表を含む生成パックへ同梱する。

### ID 対応表とゲームから抽出したデータの区別

Geyser の生成物には、対応表のほかに `item_data_components.json`（JE アイテムの既定
コンポーネント）、`item_components.nbt`（BE のアイテムコンポーネント）、
`block_shapes.nbt` / `collisions.nbt`（形状・当たり判定）等もある。
これは generator README の記載であり、対応表に画像や音声が混入しているという意味ではない。
今回必要なのは ID・状態とその変換情報で、これらの生成データ一式の同梱は採用範囲に含めない。
README の権利留保だけを根拠に、必要な ID 対応表の利用に具体的な問題があると確認した
わけではない。ID のような識別情報もゲームに由来するが、そのことと個々のデータの
著作権上の扱いは別の論点であり、本調査では後者を法的に判定していない。

## 対象範囲と不足

「データがある」「BE に同名 ID がある」「JE と同じ意味で実行できる」を別々に確認する。
Geyser は接続中の JE サーバーを前提としたネットワーク変換であり、BE ワールドで自立して
実行する本プロジェクトとは役割が違う。

| 分類 | Geyser mappings の固定版で確認した資料 | Chunker / je2be の比較と採用時の不足 |
| --- | --- | --- |
| ブロック・ステート | `blocks.nbt`。generator README は JE の各状態から BE 状態への表と説明。`blocks_debug.json` は生成出力として説明されるが mappings リポジトリの固定版にはない | Chunker の `JavaBlockIdentifierResolver` → 中間型 → `BedrockBlockIdentifierResolver` と `BedrockStateGroups` は版別変換。地形との一致を検証する基準に使える。je2be は `src/java-block-data.cpp` 等の C++ 実装で、独立した汎用 JSON 表としては扱えない |
| アイテム | `items.json` 1,658 件。全行に `bedrock_identifier`、202 行に `bedrock_data`。ネットワーク用の block runtime ID もある | Chunker もアイテム resolver とポーション等の追加処理を持つ。名前だけの変換では状態・ダメージ値・コンポーネントを落とす。je2be は `src/java-item.cpp` 等に変換処理 |
| エンティティ | 固定版のファイル一覧に独立したエンティティ対応表はない。`util.json` の `dangerous_entities` は対応表ではない | Chunker のエンティティ処理が存在することは通常エンティティの移送保証にはならない。既存の実測は `design.md` 5.8 / #6 を参照。je2be には `src/java-entity.cpp` 等がある。BE の登録 ID と JE の一覧から別に照合し、marker・表示系等は代替経路へ |
| サウンド | `sounds.json` 1,991 件。`playsound_mapping` が非空の行は 1,917 件、欠落・空は 74 件。`bedrock_mapping`・`level_event` 等も含む | `playsound` 用 ID とプロトコルイベントを区別する。表の行数を再生可能数に数えない。音量・ピッチ変換も別に確認する |
| パーティクル | `particles.json` 125 件。`bedrock_id` は `minecraft:` 92 件、`geyseropt:` 13 件、欠落 20 件。イベント型の行もある | `geyseropt:` はバニラ BDS に存在すると仮定しない。イベント種別を `/particle` 引数にしない。色・速度・形など JE 引数の再現は別問題 |
| ステータス効果 | `effects.json` は `SOUND_CRAFTER_CRAFT` 等のレベルイベント対応であり、ポーション効果の表ではない | Chunker の `BedrockEffectIDResolver` は数値保存 ID を中間 enum に対応させる。`/effect` や Script API の文字列 ID への直接流用はできない。BE `EffectTypes` との照合が必要 |
| エンチャント | 固定版のファイル一覧に独立した対応表はない | Chunker の `BedrockEnchantmentIDResolver` は保存用数値 ID。JE 名・BE API 名・保存 ID を区別する。JE 固有・データパック定義は未対応として明示する |

Geyser の形式説明は [generator README の Data generated](https://github.com/GeyserMC/mappings-generator/blob/2ded44ee4f6f2c0b4164f2878c8c5dc515bdb961/README.md#data-generated)、
件数は固定版の [`items.json`](https://github.com/GeyserMC/mappings/blob/e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7/items.json)、
[`sounds.json`](https://github.com/GeyserMC/mappings/blob/e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7/sounds.json)、
[`particles.json`](https://github.com/GeyserMC/mappings/blob/e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7/particles.json) を JSON として数えたもの。
置換や近似も行数に含むため、互換率としては使わない。

Chunker の具体的な参照箇所：

- [ブロック resolver](https://github.com/HiveGamesOSS/Chunker/blob/50aaf6d82e8b68929279161b790d95fdddfe0a40/cli/src/main/java/com/hivemc/chunker/conversion/encoding/bedrock/base/resolver/identifier/BedrockBlockIdentifierResolver.java)
- [状態グループ](https://github.com/HiveGamesOSS/Chunker/blob/50aaf6d82e8b68929279161b790d95fdddfe0a40/cli/src/main/java/com/hivemc/chunker/conversion/encoding/bedrock/base/resolver/identifier/BedrockStateGroups.java) の `STAIRS` は `weirdo_direction` と `upside_down_bit` を指定。ただし向きの値は実測前には確定しない
- [アイテム resolver](https://github.com/HiveGamesOSS/Chunker/blob/50aaf6d82e8b68929279161b790d95fdddfe0a40/cli/src/main/java/com/hivemc/chunker/conversion/encoding/bedrock/base/resolver/identifier/BedrockItemIdentifierResolver.java)
- [効果 ID](https://github.com/HiveGamesOSS/Chunker/blob/50aaf6d82e8b68929279161b790d95fdddfe0a40/cli/src/main/java/com/hivemc/chunker/conversion/encoding/bedrock/base/resolver/itemstack/BedrockEffectIDResolver.java)・[エンチャント ID](https://github.com/HiveGamesOSS/Chunker/blob/50aaf6d82e8b68929279161b790d95fdddfe0a40/cli/src/main/java/com/hivemc/chunker/conversion/encoding/bedrock/base/resolver/itemstack/BedrockEnchantmentIDResolver.java)

## 両サーバーで検証する方法（提案、未実行）

### 1. 入力と実行環境を固定する

`tools/servers.json`、使用した対応表のコミット、ファイルの SHA-256、抽出器の版、
JE / BE / Script API の版を結果 JSON に保存する。BE の API は
`packages/bridge-pack/package.json` の `@minecraft/server` 固定版を使い、
宣言は `node_modules/@minecraft/server/index.d.ts` で確認する。
以降の API 使用案はその宣言を読んだ段階であり、実機での利用確認は別途行う。

### 2. JE の母数を取る

`npm run setup:servers` が生成する `servers/reports-26.3/reports/blocks.json` と
`registries.json` を入力にする。今回手元のレポートを集計した母数は、ブロック 1,286 種・
35,723 状態、アイテム 1,658、エンティティ 161、サウンド 1,991、パーティクル 128、
ステータス効果 40。Geyser particles の 125 行と JE の 128 種という件数差も、
キー集合を突き合わせるまでは「3種類だけ未対応」と解釈しない。

エンチャントはこの `registries.json` に項目がない。固定サーバー jar のバニラデータと、
対象ワールドのデータパックが有効な状態のレジストリを別途取得する手順を実装する。
バニラの表だけでカスタム定義まで対応済みにしない。旧 JE はその版のレポート・
保存形式で照合し、26.3 の数値 runtime ID を旧版に流用しない。

### 3. BE の登録値と実行結果を取る

既存ブリッジに検証用のカタログ取得を追加する案とする。

| 分類 | 固定 API 宣言を根拠にした取得・確認案 | 合格条件 |
| --- | --- | --- |
| ブロック | `BlockTypes.getAll()`、候補の各 `BlockPermutation.resolve(id, states)` と `getAllStates()`。`BlockStates.getAll()` / `validValues` は候補の妥当性確認に使う | 候補状態が受理され、読み戻した型・値が一致。全状態の無差別直積は作らない |
| アイテム | `ItemTypes.getAll()` と `ItemStack` の生成、インベントリへ設定して読み戻す。アイテムデータの互換性は別のシナリオで観測 | ID の存在に加え、必要なコンポーネント・個数・状態が維持される |
| エンティティ | `EntityTypes.getAll()` と、隔離した座標で `spawnEntity` → 既存 `entities` ダンプ。生成できない登録型も記録 | 生成と読み戻しが成功。タグ・回転・必要な属性を別に照合。通常型と代替型を分ける |
| 効果 | `EffectTypes.getAll()` の `getName()`。専用エンティティに付与して `getEffects()` で読み戻す | 型・増幅度・残り時間を tick 差を含め照合。即時効果は体力変化で測る |
| エンチャント | `EnchantmentTypes.getAll()` の `id` / `maxLevel`。適合するアイテムへ付与して読み戻す | ID・レベル・付与可否を照合。保存用整数 ID との混同がない |
| 音・粒子 | 候補の `/playsound`・`/particle` または対応 API の実行結果とエラーを記録。候補 ID の取得元は Geyser の文字列フィールド等に限定する | サーバーの受付成功は構文確認まで。実際の再生・見た目は接続クライアントで確認し、未確認を別に残す |

ブリッジの JSON 応答分割を使い、エラーを行単位で残す。試験ごとに初期状態を戻し、
スポーン・アイテム数を制限する。実機テストの実装後は `CLAUDE.md` に従って3回実行する。

### 4. 地形とコマンドの結果を突き合わせる

JE で全状態を小分けの試験領域に配置して保存し、Chunker 1.21.0 で BE に変換する。
変換後の BE ワールドから既存 `blocks` ダンプで ID・状態を読み出す。同じ JE 状態を
対応表で書き換えたコマンド／ランタイムでも別の座標へ置き、両者を比較する。
物理更新や隣接状態が変わるブロックは配置前後・読み込み後を分け、足場等の条件も記録する。

最初の回帰セットは階段の4方向×上下、直線・内外角・水没、スラブ、丸太、扉、
レッドストーン部品。BE が独立した状態として保存しない JE の形状は、近隣配置と挙動で確認する。
`execute if block` の部分指定は全状態からの単純置換だけで済むとは仮定せず、
JE の一致集合と BE の一致集合も比較する。水没のような別レイヤーの差も損失として記録する。

### 5. 数値で不足を残す

JE の全 ID / 状態を母数に、`exact`（検証済み）、`approximate`（差分あり）、
`runtime`（代替実装）、`unsupported`、`unverified` を分けて出力する。
対象の不存在、変換時の欠落、BDS の拒否、状態不一致、地形との不一致を別々に数える。
複数の JE 状態が同じ BE 状態になる対応も記録する。往復一致だけでは可逆でない変換を
誤判定するため、片方向の期待結果・実行挙動を正解とする。

## 採用案と承認後の作業

**推奨（推定）**：ブロック・アイテムは Geyser の固定表を入力候補にし、既採用の Chunker
と実 BDS で一致を検証する。Geyser は配布済みの機械可読形式があり、現行 JE が合うため。
不一致は優先順位だけで上書きせず、出典と再現ケースを保存して個別に判断する。
音・粒子は文字列 ID のある行を候補に限定する。エンティティ・効果・エンチャントは
両サーバーのカタログを基に小さな明示表を作り、Chunker の処理を補助資料にする。

パックには検証した文字列 ID・状態・追加引数だけを正規化した小さな表として同梱する案とする。
ネットワーク runtime ID や Geyser 固有リソースへの依存は出力表に入れない。
JE 旧版の正規化、コンポーネント変換、独自データパック定義はこの表とは別に対応状況を持つ。

所有者が承認したのは Geyser を対応表の入手元にすることとライセンス表示。
`design.md` 5.3・8章へこの判断を反映した。ゲームから抽出した生成データ全体の
同梱まで承認されたとは解釈しない。#56 でブロック・アイテム対応表の取得・正規化・
参照と代表状態の BDS 検証を実装。BE カタログ全体や地形との比較は後続。
実機検証前に「全種対応」とは表記しない。

## 対応表の生成と利用（#56）

```sh
npm run setup:servers
npm run setup:mappings
```

出力は `servers/mappings/` の次の3ファイル。このディレクトリは git 管理外。

- `mappings.json`: スキーマ版、出典・コミット・JE/BE 版・元データの SHA-256 と、正規化した対応行
- `LICENSE.geyser.txt`: 対応表と同じ固定版から取得・検証した MIT 許諾文
- `NOTICE.txt`: 出典、著作権表示と同梱要件

表を配布する変換器や生成パックには **3ファイルを一緒に含める**。パックの生成処理は
まだ実装していないため、このコマンドがワールドやビヘイビアーパックを生成するわけではない。
JSON にはブロック35,723状態、アイテム1,658件、サウンド1,917件、パーティクル92件の
対応を格納する。コンポーネント、形状、ネットワーク runtime ID 等のフィールドは除く。
サウンドには `sounds.json` の `playsound_mapping`、パーティクルには `particles.json` の
`bedrock_id` のうち `minecraft:` 名前空間を使う。いずれも #14 で承認済みの固定版
から抽出し、Geyser 固有のエミッターやイベント数値は出力しない。既存のブロック・アイテム表を
引き続き読み込める。音と粒子を変換する場合は `npm run setup:mappings` で表を再生成する。

取得元は `packages/converter/src/geyser-source.ts` の固定コミットと SHA-256。
`blocks.nbt`・`items.json`・`sounds.json`・`particles.json`・`LICENSE` を `servers/geyser-source/` に取得する。
JE の `blocks.json` も固定 SHA-256 と照合する。Geyser の配列位置と JE の数値状態 ID を
誤って別版で結び付けないため、同じ件数だけでは受理しない。版を変えるときはソース固定値と
JE レポートを一緒に検証し直す。JE 旧版のコマンドや保存状態は別途正規化が必要。

取得済みのファイルだけで再生成する場合：

```sh
npm run setup:mappings -- --offline
# 保存先や JE レポートを明示する場合
npm run setup:mappings -- --offline --source-dir ./servers/geyser-source --blocks ./servers/reports-26.3/reports/blocks.json --out ./servers/mappings-copy
```

取り込み処理の `fetchGeyserSources` / `generateGeyserMappings` は `@je2be/converter`、
型と `MappingLookup` は Node / DOM 非依存の `@je2be/core` から利用できる。
ホストで読み込んだ JSON を `MappingTables` として渡す：

```ts
import { MappingLookup, type MappingTables } from "@je2be/core";

function useMappings(tables: MappingTables) {
  const lookup = new MappingLookup(tables);
  return lookup.block("minecraft:oak_stairs", {
    facing: "east", half: "top", shape: "straight", waterlogged: "false",
  });
}
```

`block` は JE の **完全な状態**でのみ照合する。既定値の省略や `execute if block` の部分条件を
自動補完しない。未登録 ID は `unknown-block`、既知 ID の状態不足は `incomplete-state`、
不正なキーや値は `unknown-state`。`item` の未登録は `unknown-item`。

`mapped` は対応行の存在だけを表す。`verification` は常に `unverified` とし、
この API だけで挙動の等価性を断定しない。`sharedBy` は同じ出力 ID・明示状態（アイテムは
ID・data 値）の行数で、複数入力の集約を発見する手掛かり。等価性や損失の完全な分類ではない。
ブロックの `waterlogged: true` は別レイヤーの水等を扱う必要がある入力を示すが、
水を配置する処理自体は含まない。BE 側の `target.states` は明示された状態だけであり、
サーバーが補う既定状態を網羅していないこともある。

`packages/bridge/src/mappings.servers.test.ts` で、BDS 1.26.63.1 が代表16状態（石・レンガ、
丸太3軸、スラブ3種、乾いた直線階段4方向×上下）を受理し、型と表で明示した状態を
読み戻せることを確認する。階段の向きの意味、水没、全状態の挙動互換はこのテストの対象外。
