# NBT 付きの summon のキーと BE での再現手段（#357）

#182（エンティティ族）の最初の子。配布マップ19本（`sample-map/`、git 管理外）の `summon` を、エンティティの種類別・NBT のトップレベルのキー別に数え、上位のキーを BE で再現する手段に分けた。集計値だけを載せ、コマンドの文面と作品名は載せない。

対象は main `e790d10`。Java 26.3、BDS 1.26.66.1、`@minecraft/server` 2.12.0-beta.1.26.66-stable。全集計は [summon-nbt-counts.json](summon-nbt-counts.json)。

## 1. 数え方と台帳との突き合わせ

`tools/summon-nbt-corpus.ts` は、台帳（`tools/compatibility-corpus.ts`）と同じ選び方で行を数える。マクロ行を除き、版別文法（`corpusContext`）で読めた行のうち、終端の形（`terminalShape`）が `summon` のものを対象にする。`execute … run summon` も含む。

| 形 | 行 | 作品 |
| --- | ---: | ---: |
| `summon entity pos nbt` | 3,296 | 16 |
| `summon entity pos` | 9 | 3 |

**台帳との一致**：今の main の `docs/compatibility.jsonl` は 3,296 行・16 本で、集計と一致する（実測）。

**Issue の数（1,835 行・15 本）との差**：Issue は main `731352c` の台帳の数。差の 1,461 行・1 本は、Java 1.20.4 の文法で読んだ 1 作品の行と同数である（集計の `grammarVersions`、実測）。`731352c` の `compatibility-sources.json` では、文法のない行（`unavailable`）が 16,455 行あり、今は 5 行に減った。1.20.4 の文法は `a6fd820`（`731352c` の祖先）で入っていたので、`731352c` の台帳を作った環境に 1.20.4 の文法が入っていなかったと推定する（前提：台帳の生成手順がそれ以外同じであること）。台帳は 0d2ed94（#343）で作り直された。

再現手順：

```sh
npm run setup:servers && npm run setup:mappings && npm run setup:grammars
scratch=$(mktemp -d /tmp/je2be-summon.XXXXXX)
python3 -I scripts/survey_corpus.py /path/to/sample-map \
  --commands "$scratch/commands.jsonl" --definitions "$scratch/definitions.jsonl" > "$scratch/inventory.json"
node tools/summon-nbt-corpus.ts "$scratch/commands.jsonl"          # 表
node tools/summon-nbt-corpus.ts "$scratch/commands.jsonl" --json   # summon-nbt-counts.json
```

## 2. エンティティの種類

NBT 付きの 3,296 行のうち、BE にない Java 専用の種類（表示用・`marker`・`interaction`）が 2,243 行・15 本、BE にもある種類が 1,053 行・16 本。上位 15 種類（全 76 種類は JSON）：

| 種類 | 行 | 作品 |
| --- | ---: | ---: |
| `item_display` | 666 | 11 |
| `text_display` | 629 | 10 |
| `marker` | 469 | 9 |
| `interaction` | 373 | 10 |
| `armor_stand` | 291 | 9 |
| `arrow` | 108 | 1 |
| `block_display` | 106 | 6 |
| `item` | 77 | 9 |
| `experience_orb` | 60 | 2 |
| `firework_rocket` | 37 | 5 |
| `villager` | 31 | 3 |
| `wolf` | 24 | 3 |
| `area_effect_cloud` | 23 | 3 |
| `zombie` | 20 | 3 |
| `guardian` | 19 | 2 |

1 行のトップレベルのキーは 1〜3 個が 1,183 行、4 個以上が 2,113 行。

## 3. トップレベルのキー

上位 30（全 134 キーは JSON）。「主な種類」は種類とキーの組の上位。

| # | キー | 行 | 作品 | 主な種類（行） |
| ---: | --- | ---: | ---: | --- |
| 1 | `Tags` | 3,104 | 16 | item_display 666、text_display 627、marker 468、interaction 365、armor_stand 291 |
| 2 | `Rotation` | 1,425 | 9 | item_display 491、text_display 358、interaction 228、arrow 108 |
| 3 | `transformation` | 1,216 | 10 | item_display 638、text_display 568 |
| 4 | `billboard` | 937 | 4 | item_display 471、text_display 466 |
| 5 | `item` | 645 | 9 | item_display 645 |
| 6 | `text` | 601 | 9 | text_display 601 |
| 7 | `teleport_duration` | 464 | 3 | item_display 421 |
| 8 | `background` | 441 | 7 | text_display 441 |
| 9 | `height` | 394 | 10 | interaction 367 |
| 10 | `width` | 392 | 10 | interaction 367 |
| 11 | `Invulnerable` | 360 | 12 | armor_stand 157、villager 28 |
| 12 | `PersistenceRequired` | 304 | 7 | villager 31、wolf 24、zombie 19 |
| 13 | `DeathLootTable` | 286 | 4 | guardian 19、skeleton 16、zombie 16 |
| 14 | `Invisible` | 249 | 7 | armor_stand 249 |
| 15 | `NoGravity` | 238 | 9 | armor_stand 145 |
| 16 | `Marker` | 232 | 7 | armor_stand 232 |
| 17 | `Health` | 230 | 4 | item 15、guardian 14 |
| 18 | `Silent` | 215 | 9 | armor_stand 57、villager 31 |
| 19 | `data` | 211 | 2 | marker 204 |
| 20 | `NoAI` | 179 | 7 | villager 31、armor_stand 14 |
| 21 | `shadow` | 173 | 4 | text_display 173 |
| 22 | `CustomName` | 172 | 6 | villager 27、marker 12 |
| 23 | `active_effects` | 160 | 5 | wither 12、slime 10 |
| 24 | `Small` | 160 | 3 | armor_stand 160 |
| 25 | `attributes` | 153 | 2 | armor_stand 13、piglin 12 |
| 26 | `Motion` | 147 | 5 | arrow 108 |
| 27 | `Team` | 115 | 3 | — |
| 28 | `NoBasePlate` | 113 | 4 | armor_stand 113 |
| 29 | `CanPickUpLoot` | 109 | 2 | — |
| 30 | `crit`・`damage`・`PierceLevel` | 各 108 | 1 | arrow 108 |

- Issue の例の `text_display` + `text` は 601 行・16 本中 9 本
- 同じ意味の新旧の名前が並ぶ（`attributes` 153 と `Attributes` 105、`equipment` 92 と `ArmorItems` 76・`HandItems` 65、`item` と `Item` は種類が別）。どちらを読むかは書いた版で決まる（#247）
- `Passengers` は 62 行・6 本。中のエンティティのキーは JSON の `passengerKeys`（`id` 298、`transformation` 180、`Tags` 173）

## 4. 上位 10 キーの再現手段

分類は Issue の 4 つ：**引数**（BE の `summon` の引数で書ける）、**Script**（Script API で召喚の直後に設定できる）、**保持**（ランタイムが値を持つだけ）、**不可**（再現できない）。型定義の行番号は `node_modules/@minecraft/server/index.d.ts`（2.12.0-beta.1.26.66-stable）。BDS の実測は `poc/summon-nbt/`（`summon-nbt.servers.test.ts`、3 回連続で通過、結果は `results.json`）。防具立てとゾンビで試した。

| # | キー | 分類 | 手段と根拠 | 確度 |
| ---: | --- | --- | --- | --- |
| 1 | `Tags` | Script | `Entity.addTag`（10246行）。召喚と同じ tick と次の tick で `getTags` に 3 つとも読み戻せた | 実測 |
| 2 | `Rotation` | 引数 | BE の `summon <種類> <位置> <yaw> <pitch>` で yaw・pitch とも付いた（防具立て・ゾンビ）。`Entity.setRotation`（11033行）でも同じ tick に読み戻せ、防具立ては次の tick も保った。`spawnEntity` の `initialRotation`（29530行）は yaw だけ。防具立ては 40 tick 後にピッチが 0 に戻る（`findings.md` #346）ため、Java のピッチを保つには保持が要る | 実測 |
| 3 | `transformation` | 保持 | BE に対応する欄がない。動的プロパティ（`setDynamicProperty` 10946行）に JSON の文字列で持ち、同じ tick・次の tick に読み戻せた。`minecraft:scale` の `value` は読み取り専用（13951行）で、個体ごとの拡大は Script API で書けない。表示は代替エンティティの方式（#383）次第 | 保持：実測。表示：未確認（#383） |
| 4 | `billboard` | 保持 | 同上（BE に欄がない。動的プロパティで保持できた）。正面を向ける表示は #383 | 保持：実測。表示：未確認（#383） |
| 5 | `item` | 保持（＋BE コマンド） | `item_display` の表示する物。`EntityEquippableComponent` は「プレイヤーにある」（11741–11742行）で、防具立て・ゾンビでは `getComponent("minecraft:equippable")` が `undefined` だった。代わりに `replaceitem entity … slot.weapon.mainhand` / `slot.armor.head` で書け、`hasitem` で読み戻せた（書き込みのできる文脈で `runCommand` が要る）。代替エンティティに持たせて見せるかは #383 | Script 不可・`replaceitem`：実測。表示：未確認（#383） |
| 6 | `text` | 引数／Script（文字だけ） | 名前として見せるなら、BE の `summon … <spawnEvent> <名前>` と `Entity.nameTag`（10085行）で書け、改行を含む `Hello\nWorld` も読み戻せた。テキスト成分の変換は `text-components.md`（#347）。色・背景・行幅・揃えは名前では表せず保持。名前の表示で足りるかは #383 | 名前：実測。見た目：未確認（#383） |
| 7 | `teleport_duration` | 保持 | 表示用エンティティの移動の補間時間。BE に欄がなく、保持だけできた。補間して見せる手段は #383・M5（design.md 5.8） | 保持：実測。表示：未確認（#383） |
| 8 | `background` | 保持 | `text_display` の背景色。名前の表示に背景色を変える API は型定義にない。保持だけできた | 保持：実測。表示：未確認（#383） |
| 9 | `height` | 保持 | `interaction` の当たり判定の高さ。型定義に当たり判定の大きさを書く API はない（`collision_box` の型がない、`minecraft:scale` は読み取り専用）。保持だけできた。個体ごとの大きさはカスタムエンティティの定義（#383） | 保持：実測。当たり判定：未確認（#383） |
| 10 | `width` | 保持 | `height` と同じ | 同上 |

**不可**に分けたキーは上位 10 にはない。上位 10 のうち 7 キー（3〜5、7〜10）は表示用エンティティと `interaction` だけが持ち、見た目と当たり判定は #383 の代替エンティティの方式が決めるまで再現の可否が決まらない。

## 5. 11 位以降（参考）

型定義を読んだだけのものは未確認。実測は #89 の配置済みエンティティ（`findings.md`「変換前に配置したエンティティの復元」）。

| キー | 行 | 分類の見込み | 根拠 | 確度 |
| --- | ---: | --- | --- | --- |
| `Invulnerable` | 360 | 不可（代替エンティティなら定義で） | 型定義に無敵を書く API が見当たらない。#89 はレポートに出す | 未確認 |
| `PersistenceRequired` | 304 | Script | `SpawnEntityOptions.initialPersistence`（29523行）。BDS の保存値 `Persistent: 1` は #89 で確認 | API：未確認 |
| `DeathLootTable` | 286 | 保持＋ランタイムのドロップ | BE は種類の定義で落とし物が決まる。個体ごとの変更は型定義に見当たらない | 未確認 |
| `Invisible` | 249 | Script | `Entity.addEffect`（10184行）の透明化。防具立ての透明化の効果は #89 で再起動後も残った | 実測（#89） |
| `NoGravity`・`Marker`・`Small`・`NoBasePlate` | 238・232・160・113 | 不可（防具立て）／代替エンティティ | 型定義に書く API が見当たらない。#89 はレポートに出す | 未確認 |
| `Health` | 230 | Script | `EntityHealthComponent.setCurrentValue`（11324行） | 未確認 |
| `Silent`・`NoAI` | 215・179 | 不可／代替エンティティ | 型定義に見当たらない。#89 はレポートに出す | 未確認 |
| `data` | 211 | 保持 | `marker` の任意データ。`data get entity` の読み取り（#345）と同じ仮想 NBT 層に持つ | 推定 |
| `CustomName` | 172 | 引数／Script | `nameTag`。#89 で名前は Java と一致 | 実測（#89） |
| `active_effects` | 160 | Script | `Entity.addEffect`（10184行）。`effect` の変換は #319 | 未確認 |

## 6. 実装の子 Issue の案（行数の順）

1. **仮想 NBT 層の書き込み：Java 専用の種類の初期値を保持する**（2,243 行・15 本。`Tags` を除くキー：`transformation` 1,216、`billboard` 937、`item` 645、`text` 601、`teleport_duration` 464、`background` 441、`height`・`width` 約 390、`data` 211、`shadow` 173 …）。`summon` の NBT を動的プロパティに持ち、#345 の読み取り（`data get entity`）と合わせる。代替エンティティの種類と見た目は #383 に依存
2. **summon の共通キー：`Tags` と `Rotation`**（`Tags` 3,104 行・16 本、`Rotation` 1,425 行・9 本）。BE の `summon` の引数（yaw・pitch・名前）と、召喚直後の `addTag`。種類を問わず効く。防具立てのピッチを保つ扱いは #427
3. **BE にもある種類の状態のキー**（1,053 行・16 本。`Invulnerable` 360、`PersistenceRequired` 304、`DeathLootTable` 286、`Invisible` 249、`NoGravity` 238、`Marker` 232、`Health` 230、`Silent` 215、`NoAI` 179、`CustomName` 172、`active_effects` 160 …）。#89 の配置済みエンティティの変換（`packages/converter/src/placed-entities.ts`）と同じ対応表を使い、書けないキーはレポートに出す
4. **`Passengers`**（62 行・6 本）。乗せる側と乗る側を召喚し、`EntityRideableComponent.addRider`（13865行、未確認）で組む
