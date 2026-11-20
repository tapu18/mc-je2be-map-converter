# 配布マップの静的な対応率（#47）

ローカルの配布マップを、本文や作者のIDを公開せずに集計する。ゲーム内で実行せず、ワールドも書き換えない。

```sh
npm ci
npm run setup:servers
npm run setup:mappings
npm run setup:grammars
python3 -I scripts/dump_commands.py sample-map > /tmp/commands.jsonl
npm run coverage:corpus -- /tmp/commands.jsonl
```

入力は `dump_commands.py` のJSONL。調査対象を更新すると連番も変わるため、作品の識別子としては使わない。
入力本文は権利上リポジトリ・Issue・CIに含めない。出力には集計値と公式文法のリテラル・引数型だけを使い、
エラー文、引数値、関数やスコアの独自名は出さない。

## 数値の意味

行単位の出力可否は、変換器と同じ `rewriteCommand` で判定する。版は `selectCommandGrammar` で選ぶ。

- 無変更で出力／書換で出力：現在の書き換え実装がBEコマンドを返した行。BDSで全件実行した結果ではない。
- 未対応：パースできたが、現在の書き換え実装が出力できない行。将来ランタイムで実行できると実証した意味ではない。
- 構文不受理：選択した版のパーサが拒否した行。Javaのレジストリやパック内参照の検証は別途 `validate:commands` を使う。
- マクロ：実行時の値がないため未パース。文法なし：対象版の文法がない、版が不明、またはパック形式だけでは版を一意に選べない行。
- パース成功率の分母は「無変更＋書換＋未対応＋構文不受理」。マクロ・文法なしは分ける。
- 出力可能率の分母は全行。警告ありは別欄に数え、警告付きの出力も分かるようにする。分母0は `-`。

ID対応表と省略状態の既定値は固定JE 26.3の資材を使用する。旧版のIDや状態との差も未対応に含み得る。
旧版のパーサが受理しても、最新の書き換え実装が扱えるとは限らない。未対応の頻度にはこの差も含まれる（#72）。

設計上の経路は別の表にする（design.md 5.4）。関数の行は出力可能な形でも全て `runtime-required`。
マクロ、BEコマンド1個に出力できないCBも `runtime-required`。パース不受理・文法なしは `unresolved`。
他のCBは `native-candidate` であり、隣接するチェーン全体を解析した最終経路ではない。
このツールの入力にはチェーンの接続情報がないため、チェーン単位の振り分けは算出しない。

ランタイムは未実装であり、`runtime-required` は実行成功に含めない。
ギミックの成立率や進行阻害、手修正、クリア確認は #69、製品としての出力物の検証は #68、
許可を得た作品での最終確認は #48で扱う。行の多い型だけで、進行上の重要性は決められない。

## 集計結果（2026-11-16）

19本115,487行。版別文法は #70 の17版、対応表は承認済みの固定Geyser資材を使用。

静的な行単位の出力可否。実行成功・チェーンの出力可否・クリア可能性ではない。ランタイムは未実装。

ID対応とブロック既定値は固定JE 26.3 の資材を使用。旧版のID・状態との差は未対応に含み得る。

| 区分 | 行数 | 無変更で出力 | 書換で出力 | 未対応 | 構文不受理 | マクロ | 文法なし | パース成功率 | 出力可能率 | 警告あり |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 全体 | 115487 | 4870 | 8377 | 79628 | 58 | 3630 | 18924 | 99.94% | 11.47% | 1374 |
| cb | 3541 | 477 | 1020 | 1727 | 52 | 0 | 265 | 98.41% | 42.28% | 24 |
| fn | 111946 | 4393 | 7357 | 77901 | 6 | 3630 | 18659 | 99.99% | 10.50% | 1350 |
| map-0 | 603 | 63 | 154 | 370 | 0 | 16 | 0 | 100.00% | 35.99% | 79 |
| map-1 | 16564 | 0 | 0 | 0 | 0 | 114 | 16450 | - | 0.00% | 0 |
| map-2 | 33 | 1 | 31 | 1 | 0 | 0 | 0 | 100.00% | 96.97% | 0 |
| map-3 | 5 | 0 | 0 | 0 | 0 | 0 | 5 | - | 0.00% | 0 |
| map-4 | 2473 | 0 | 0 | 0 | 0 | 4 | 2469 | - | 0.00% | 0 |
| map-5 | 1309 | 186 | 443 | 680 | 0 | 0 | 0 | 100.00% | 48.05% | 2 |
| map-6 | 350 | 77 | 170 | 103 | 0 | 0 | 0 | 100.00% | 70.57% | 0 |
| map-7 | 343 | 46 | 69 | 228 | 0 | 0 | 0 | 100.00% | 33.53% | 2 |
| map-8 | 723 | 105 | 265 | 313 | 37 | 3 | 0 | 94.86% | 51.18% | 1 |
| map-9 | 501 | 77 | 193 | 226 | 0 | 5 | 0 | 100.00% | 53.89% | 3 |
| map-10 | 674 | 121 | 37 | 476 | 4 | 36 | 0 | 99.37% | 23.44% | 1 |
| map-11 | 3805 | 230 | 559 | 3011 | 5 | 0 | 0 | 99.87% | 20.74% | 271 |
| map-12 | 69092 | 908 | 1320 | 65760 | 1 | 1103 | 0 | 100.00% | 3.22% | 306 |
| map-13 | 925 | 151 | 40 | 601 | 2 | 131 | 0 | 99.75% | 20.65% | 0 |
| map-14 | 18 | 5 | 5 | 8 | 0 | 0 | 0 | 100.00% | 55.56% | 0 |
| map-15 | 1607 | 344 | 637 | 622 | 4 | 0 | 0 | 99.75% | 61.05% | 14 |
| map-16 | 10285 | 1481 | 3412 | 3329 | 0 | 2063 | 0 | 100.00% | 47.57% | 449 |
| map-17 | 2155 | 602 | 370 | 1178 | 5 | 0 | 0 | 99.77% | 45.10% | 97 |
| map-18 | 4022 | 473 | 672 | 2722 | 0 | 155 | 0 | 100.00% | 28.47% | 149 |

設計上の経路（別集計、全行を分母）。関数は出力可能な行もランタイムへ。CBのnativeはチェーン確認前の候補。

| 経路 | 行数 | 全行比 |
| --- | ---: | ---: |
| native-candidate | 1497 | 1.30% |
| runtime-required | 95008 | 82.27% |
| unresolved | 18982 | 16.44% |

未対応の型（上位25、重複を除かず行数で集計。引数の値は掲載しない）

| 型 | CB | 関数 | 合計 |
| --- | ---: | ---: | ---: |
| `execute if entity <minecraft:entity> → data modify entity <minecraft:entity> <minecraft:nbt_path> merge value <minecraft:nbt_tag>` | 0 | 55366 | 55366 |
| `execute if score <minecraft:score_holder> <minecraft:objective> matches <minecraft:int_range> → function <minecraft:function>` | 1 | 2520 | 2521 |
| `execute on passengers → function <minecraft:function>` | 0 | 1920 | 1920 |
| `data modify storage <minecraft:resource_location> <minecraft:nbt_path> append value <minecraft:nbt_tag>` | 0 | 970 | 970 |
| `summon <minecraft:resource> <minecraft:vec3> <minecraft:nbt_compound_tag>` | 402 | 552 | 954 |
| `function <minecraft:function>` | 203 | 740 | 943 |
| `execute if score <minecraft:score_holder> <minecraft:objective> matches <minecraft:int_range> → execute as <minecraft:entity> → data merge entity <minecraft:entity> <minecraft:nbt_compound_tag>` | 0 | 464 | 464 |
| `particle <minecraft:particle> <minecraft:vec3> <minecraft:vec3> <brigadier:float> <brigadier:integer> force <minecraft:entity>` | 2 | 434 | 436 |
| `data modify storage <minecraft:resource_location> <minecraft:nbt_path> set value <minecraft:nbt_tag>` | 0 | 408 | 408 |
| `function <minecraft:function> with storage <minecraft:resource_location> <minecraft:nbt_path>` | 0 | 379 | 379 |
| `execute store result storage <minecraft:resource_location> <minecraft:nbt_path> int <brigadier:double> → scoreboard players get <minecraft:score_holder> <minecraft:objective>` | 0 | 334 | 334 |
| `execute as <minecraft:entity> → function <minecraft:function>` | 15 | 296 | 311 |
| `execute as <minecraft:entity> → playsound <minecraft:resource_location> block <minecraft:entity> <minecraft:vec3> <brigadier:float> <brigadier:float>` | 0 | 299 | 299 |
| `execute store result score <minecraft:score_holder> <minecraft:objective> → data get storage <minecraft:resource_location> <minecraft:nbt_path>` | 0 | 296 | 296 |
| `data modify storage <minecraft:resource_location> <minecraft:nbt_path> set from storage <minecraft:resource_location> <minecraft:nbt_path>` | 0 | 279 | 279 |
| `execute if entity <minecraft:entity> → execute at <minecraft:entity> → execute on origin → tp <minecraft:entity> <minecraft:vec3> <minecraft:rotation>` | 0 | 276 | 276 |
| `execute as <minecraft:entity> → particle <minecraft:particle> <minecraft:vec3> <minecraft:vec3> <brigadier:float> <brigadier:integer> force <minecraft:entity>` | 0 | 260 | 260 |
| `execute if score <minecraft:score_holder> <minecraft:objective> matches <minecraft:int_range> → function <minecraft:function> with storage <minecraft:resource_location> <minecraft:nbt_path>` | 0 | 254 | 254 |
| `advancement revoke <minecraft:entity> only <minecraft:resource_key>` | 0 | 245 | 245 |
| `execute if data storage <minecraft:resource_location> <minecraft:nbt_path> → tellraw <minecraft:entity> <minecraft:component>` | 0 | 244 | 244 |
| `data remove storage <minecraft:resource_location> <minecraft:nbt_path>` | 0 | 241 | 241 |
| `execute if entity <minecraft:entity> → function <minecraft:function>` | 1 | 216 | 217 |
| `kill <minecraft:entity>` | 2 | 205 | 207 |
| `data merge entity <minecraft:entity> <minecraft:nbt_compound_tag>` | 3 | 200 | 203 |
| `playsound <minecraft:resource_location> master <minecraft:entity> <minecraft:vec3> <brigadier:float> <brigadier:float>` | 108 | 95 | 203 |


次に実装を検討する候補は、上位のエンティティNBT操作・関数呼び出し・storage・execute storeである。
NBTを伴うsummonもCB側で402行ある。サウンド・パーティクル等の単一BEコマンドへの拡張は #72。
頻度は重複を含み、1本の生成コードが占める割合も大きいので、全作品への効果や進行の重要性とは分けて考える。
