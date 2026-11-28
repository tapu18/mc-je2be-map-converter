# マクロ行の型紙化の成功と診断、穴を埋める時間（#349）

#316 の型紙（`compileMacroTemplate`）に、配布マップのマクロ行を全部通した。どれだけが型紙になり、どの理由で落ちるかを数えた。あわせて、型紙の穴を埋める処理（`expandMacro`）の時間を Node で測った。

集計値、公式文法のリテラル・引数型だけを載せる。本文、値、独自名、作品名は載せない。作品は `dump_commands.py` の連番で表す。

## 再現手順

```sh
npm run setup:grammars   # 1.20.4〜26.3 の文法（pack_format の範囲で選ぶため全部要る）
python3 -I scripts/dump_commands.py sample-map > /tmp/commands.jsonl
node tools/macro-template-corpus.ts /tmp/commands.jsonl --bench
```

文法の選び方はデータパック変換（`packages/converter/src/datapacks.ts`）と同じにした。データパックの `pack.mcmeta` の範囲を `selectCommandGrammar` に渡し、ワールドの DataVersion には頼らない。範囲が複数の文法にまたがる行は、全候補で型紙にする。成否と理由がそろえば、その結果で数える。そろわない行は「範囲内の版で結果が異なる」として数える（該当 0 行）。

## 集計結果（2026-11-28、実測）

入力は 2026-11-28 時点の `sample-map/`（19 本）。マクロ行は 3,630 行、10 作品で、すべて関数の行だった。

- **型紙になった行は 1,247 行（34.4%）、8 作品**
- 全行が型紙になった作品は 2 作品
- 落ちた 2,383 行のうち **2,009 行（全体の 55.3%）は entity 型の穴**。そのうち 1,837 行は 1 作品の同じ形だった

### 作品別

| 作品 | マクロ行 | 型紙 | 割合 |
| --- | ---: | ---: | ---: |
| map-0 | 16 | 13 | 81.3% |
| map-1 | 114 | 114 | 100.0% |
| map-4 | 4 | 4 | 100.0% |
| map-8 | 3 | 0 | 0.0% |
| map-9 | 5 | 2 | 40.0% |
| map-10 | 36 | 19 | 52.8% |
| map-12 | 1,103 | 854 | 77.4% |
| map-13 | 131 | 0 | 0.0% |
| map-16 | 2,063 | 153 | 7.4% |
| map-18 | 155 | 88 | 56.8% |

### 診断の理由

理由の文は `compileMacroTemplate` の診断のまま載せる。「文法なし」は本スクリプトが付けた理由で、変換器では pack.mcmeta の診断になる。

| 理由 | 行数 | 割合 | 作品数 |
| --- | ---: | ---: | ---: |
| macro argument type minecraft:entity is unsupported or requires an ID mapping | 2,009 | 55.3% | 4 |
| 文法なし（pack_format 不明） | 134 | 3.7% | 2 |
| macro argument type minecraft:item_slots is unsupported or requires an ID mapping | 73 | 2.0% | 2 |
| macro hole crosses an argument boundary | 36 | 1.0% | 3 |
| macro argument type minecraft:resource_location is unsupported or requires an ID mapping | 32 | 0.9% | 2 |
| macro hole can change command shape | 18 | 0.5% | 4 |
| macro argument type minecraft:loot_modifier is unsupported or requires an ID mapping | 16 | 0.4% | 1 |
| 文法なし（unavailable） | 14 | 0.4% | 1 |
| macro argument type minecraft:dimension is unsupported or requires an ID mapping | 13 | 0.4% | 2 |
| macro argument type minecraft:item_stack is unsupported or requires an ID mapping | 12 | 0.3% | 2 |
| cannot determine fixed command shape and argument boundaries for macro | 9 | 0.2% | 3 |
| macro argument type minecraft:item_slot is unsupported or requires an ID mapping | 9 | 0.2% | 2 |
| macro argument type minecraft:item_predicate is unsupported or requires an ID mapping | 4 | 0.1% | 2 |
| macro values produce different command shapes | 1 | 0.0% | 1 |
| macro argument type minecraft:resource_key is unsupported or requires an ID mapping | 1 | 0.0% | 1 |
| macro argument type minecraft:block_state is unsupported or requires an ID mapping | 1 | 0.0% | 1 |
| macro argument type minecraft:resource is unsupported or requires an ID mapping | 1 | 0.0% | 1 |

型の名前は、最初にパースできた試行値で穴が入った節の型である。別の値なら別の型になり得る。

## 上位の理由の形と、型紙にする案

形は値と名前を伏せた節の列である。リテラルは文法の語、引数は `<型>`、穴を含む引数は `<型:$>` で表す。穴を一つの値で埋め、最初にパースできた例から作った。全形はスクリプトの出力にある。

案はどれも未実装・未確認で、実装は #373 で行う。

### 1. entity 型の穴（2,009 行、4 作品）

| 行数 | 作品数 | 形 |
| ---: | ---: | --- |
| 1,837 | 1 | `data merge entity <entity:$> <nbt_compound_tag>` |
| 13 | 1 | `execute at <entity:$> align <swizzle> run summon <resource> <vec3> <nbt_compound_tag>` |
| 13 | 3 | `tag <entity:$> add <string>` |
| 12 | 1 | `execute if score <score_holder> <objective> matches <int_range> run tp <entity:$> <vec3> <rotation>` |
| 11 | 1 | `tp <entity:$> <vec3> <rotation>` |

68 形あり、上位は `data merge entity`・`tag`・`tp` の対象に穴がある形だった。

- 原因：`minecraft:entity` は `supportsMacroArgument` の対象外である（`packages/core/src/command/macro-arguments.ts`）。セレクタの `type=` などがエンティティ ID を含むため、外したと推定する。
- 案：entity の穴を型紙で受ける。実行時に埋めた値を entity の引数パーサで読み、プレイヤー名・UUID・ID を含まないセレクタならそのまま使う。`type=`・`nbt=` など ID 対応や変換が要る部分を含む値は、実行時の診断にする。最多の形が 1 作品の 1,837 行なので、これだけで型紙の割合は約 85% まで上がる（推定。他の穴が通るとすれば）。

### 2. 文法なし（148 行、3 作品）

- **pack_format 不明（134 行、2 作品）**：`pack.mcmeta` の範囲を `readPackFormatRange`（`packages/core/src/command/pack-format.ts`）が読めない。キーと値の形だけを見ると、1 作品は `min_format` が `[107, 1]` で `max_format` が整数 `107` だった。整数を `[107, 0]` と読むため、最小が最大を超えて無効になる。もう 1 作品は `max_format` が要素 1 個の配列 `[999]` だった。これらのデータパックは変換器でも全体が `invalid pack format` になる（推定。同じ関数を使うため）。Java がどう読むかは未確認で、#432 で実測する。
- **unavailable（14 行、1 作品）**：pack_format 16（1.20.1 相当）のパックだった。Java がマクロに対応したのは 1.20.2 から（未確認）で、対象外の版である。

### 3. 引数の境界をまたぐ穴（36 行、3 作品）

| 行数 | 作品数 | 形 |
| ---: | ---: | --- |
| 25 | 1 | `team add <string:$>` |
| 4 | 2 | `execute store result score <score_holder> <objective> run data get storage <resource_location> <nbt_path:$>` |
| 3 | 1 | `team join <team:$>` |
| 2 | 2 | `execute store result storage <resource_location> <nbt_path> int <double> run random value <int_range:$>` |

- 原因：試行値に空白入りの値（`0 0` など）がある。末尾の引数の後に省略できる引数が続くと、空白入りの値で穴が次の引数にまたがる。この場合は他の値が通っても診断で打ち切る。合成入力 `$team add $(t)` と `$data get storage a:b $(p)` でも同じ診断が出た（Java 26.3 の文法、本 Issue の作業中に確認）。
- 案：空白を含まない試行値だけで境界が定まるなら、型紙にする。実行時は埋めた値がその引数で読み切れることを確かめる（`expandMacro` は既にそうしている）。読み切れない値は、Java では引数の数が変わる。そのときだけ実行時にパースし直すか、診断にする。

### 4. item 系・ID 系の型（item_slots 73、resource_location 32、loot_modifier 16、dimension 13、item_stack 12、item_slot 9 など）

- item_slots（73 行）は 1 作品の `execute if items entity <entity> <item_slots:$> <item_predicate> …` だった。スロット名は Java と BE で違うため、実行時の対応表が要る。
- resource_location（32 行）はすべて `bossbar` の ID だった。BE に bossbar がなく、中核でのエミュレートが前提になる。ID の対応表は要らない（推定）。
- dimension（13 行）は `execute in <dimension:$>` だった。値の候補はバニラの3次元とデータパックの次元である。
- 案：ID を対応表に通す型（item_stack、item_predicate、block_state、loot_modifier、item_slot(s)）は、#239 の ID 候補の追跡と、ランタイムの対応表の同梱（#240 の見積もり）を前提にする。ID を変えない型（bossbar の resource_location、dimension）は、許可の一覧に足す候補にする。

### 5. コマンドの形が変わり得る穴（18 行、4 作品）

`execute positioned <vec3:$> …`、`tp <entity> <vec3:$> …` などで、座標の穴が並ぶ形だった。合成入力 `$tp @s $(x) $(y) $(z)` でも同じ診断が出た。

- 原因：穴の前に固定の文字がない。そのため、同じ位置で競合するリテラル（`positioned as`、`tp` の別の分岐など）と区別できない。
- 案：実行時に値が競合リテラルに一致したら診断する。一致しなければ型紙の形を使う。

## 穴を埋める時間（Node、実測）

`--bench` で、型紙になった行を保存形式（`serializeCommandIR` → `deserializeCommandIR`）に通した。それに試行値を入れ、`expandMacro` の時間を測った。各条件で全行を 1 周し、20 周の中央値・最小・最大を 1 行あたりに換算した。Node v24.13.1、WSL2。

対象は 1,236 行である。1,247 行のうち、試行値（整数、名前、NBT、`@s`、座標、ID）で 2 回埋められなかった 11 行を除いた。

| 条件 | 中央値 | 最小 | 最大 |
| --- | ---: | ---: | ---: |
| 同じ引数の繰り返し | 7.69 µs | 6.60 µs | 11.72 µs |
| 毎回違う引数 | 7.63 µs | 7.36 µs | 14.24 µs |
| キャッシュ当たり（引数から鍵を作って `Map` を引く） | 0.36 µs | 0.29 µs | 0.69 µs |
| 内訳：版の正規化（`normalizeCommandIR`）だけ | 3.57 µs | 3.36 µs | 8.22 µs |
| 参考：埋めた文字列を文法でパースし直す | 7.50 µs | 6.93 µs | 8.94 µs |

表は 1 回分である。さらに 3 回流すと、展開の中央値は 7.0〜8.4 µs、キャッシュ当たりは 0.34〜0.38 µs、正規化だけは 3.5〜3.8 µs の範囲だった。同じ引数と違う引数の差は 0.5 µs 以下で、回によって大小が入れ替わった。

- 同じ引数と違う引数で差がない。`expandMacro` には引数で変わる経路がなく、毎回同じ処理をするためである。
- 約半分は版の正規化（元版 → 26.3 の書き換え）である。
- 埋めた文字列を全文法でパースし直す場合と同程度だった。型紙の利点は、実行時に文法（26.3 で 583,592 bytes）を持たずに済むことで、速さではない。

### キャッシュの結論：今は入れない

- 1 行あたり約 8 µs は、1 tick（50 ms）に約 6,000 行を埋められる計算になる（Node での値）。コーパスで最もマクロ行が多い作品でも、全関数のマクロ行の合計は 2,063 行である。それを毎 tick すべて埋めても約 16 ms で、1 tick に収まる（推定。呼び出しの頻度は静的には数えていない）。
- キャッシュの当たりは 0.36 µs で、1 行あたり約 7 µs 減る。その代わりに、引数ごとの IR を持つメモリと、外れ時の鍵生成（約 0.4 µs）が増える。違う引数で毎回呼ぶ使い方では効かない。
- 先に効く手は、正規化を変換時に済ませることである。元版と 26.3 で書き換えのない引数なら、実行時に正規化しなくてよい。そうすれば約半分を減らせる（推定）。これは型紙の方式の変更なので、#373 で扱う。
- BE のスクリプトエンジンでの時間は未測定で、Node より遅い可能性がある（未確認）。#374 の BDS 検証で、マクロ付き関数の時間が問題になったら判断し直す。キャッシュの子 Issue は今は作らない。
