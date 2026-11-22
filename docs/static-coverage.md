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
- マクロ：実行時の値がないため未パース。文法なし：対象版の文法がない、版が不明、行。範囲内で結果が異なる：候補の文法でパース結果が一致しない行。
- パース成功率の分母は「無変更＋書換＋未対応＋構文不受理」。マクロ・文法なし・範囲内で結果が異なる行は分ける。
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

## 集計結果（2026-11-22）

静的な行単位の出力可否。実行成功・チェーンの出力可否・クリア可能性ではない。ランタイムは未実装。

ID対応とブロック既定値は固定JE 26.3 の資材を使用。旧版のID・状態との差は未対応に含み得る。

| 区分 | 行数 | 無変更で出力 | 書換で出力 | 未対応 | 構文不受理 | マクロ | 文法なし | 範囲内で結果が異なる | パース成功率 | 出力可能率 | 警告あり |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 全体 | 115487 | 4955 | 11805 | 78494 | 58 | 3630 | 16455 | 90 | 99.94% | 14.51% | 2886 |
| cb | 3541 | 490 | 1315 | 1419 | 52 | 0 | 265 | 0 | 98.41% | 50.97% | 299 |
| fn | 111946 | 4465 | 10490 | 77075 | 6 | 3630 | 16190 | 90 | 99.99% | 13.36% | 2587 |
| map-0 | 603 | 77 | 180 | 330 | 0 | 16 | 0 | 0 | 100.00% | 42.62% | 96 |
| map-1 | 16564 | 0 | 0 | 0 | 0 | 114 | 16450 | 0 | - | 0.00% | 0 |
| map-2 | 33 | 2 | 31 | 0 | 0 | 0 | 0 | 0 | 100.00% | 100.00% | 0 |
| map-3 | 5 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | - | 0.00% | 0 |
| map-4 | 2473 | 30 | 1847 | 502 | 0 | 4 | 0 | 90 | 100.00% | 75.90% | 53 |
| map-5 | 1309 | 187 | 467 | 655 | 0 | 0 | 0 | 0 | 100.00% | 49.96% | 42 |
| map-6 | 350 | 77 | 179 | 94 | 0 | 0 | 0 | 0 | 100.00% | 73.14% | 9 |
| map-7 | 343 | 47 | 86 | 210 | 0 | 0 | 0 | 0 | 100.00% | 38.78% | 15 |
| map-8 | 723 | 104 | 350 | 229 | 37 | 3 | 0 | 0 | 94.86% | 62.79% | 81 |
| map-9 | 501 | 77 | 193 | 226 | 0 | 5 | 0 | 0 | 100.00% | 53.89% | 3 |
| map-10 | 674 | 124 | 65 | 445 | 4 | 36 | 0 | 0 | 99.37% | 28.04% | 23 |
| map-11 | 3805 | 231 | 888 | 2681 | 5 | 0 | 0 | 0 | 99.87% | 29.41% | 603 |
| map-12 | 69092 | 919 | 1444 | 65625 | 1 | 1103 | 0 | 0 | 100.00% | 3.42% | 391 |
| map-13 | 925 | 152 | 77 | 563 | 2 | 131 | 0 | 0 | 99.75% | 24.76% | 34 |
| map-14 | 18 | 5 | 8 | 5 | 0 | 0 | 0 | 0 | 100.00% | 72.22% | 0 |
| map-15 | 1607 | 345 | 912 | 346 | 4 | 0 | 0 | 0 | 99.75% | 78.22% | 272 |
| map-16 | 10285 | 1486 | 3541 | 3195 | 0 | 2063 | 0 | 0 | 100.00% | 48.88% | 577 |
| map-17 | 2155 | 605 | 798 | 747 | 5 | 0 | 0 | 0 | 99.77% | 65.10% | 502 |
| map-18 | 4022 | 487 | 739 | 2641 | 0 | 155 | 0 | 0 | 100.00% | 30.48% | 185 |

設計上の経路（別集計、全行を分母）。関数は出力可能な行もランタイムへ。CBのnativeはチェーン確認前の候補。

| 経路 | 行数 | 全行比 |
| --- | ---: | ---: |
| native-candidate | 1805 | 1.56% |
| runtime-required | 97079 | 84.06% |
| unresolved | 16603 | 14.38% |

未対応の型（上位25、重複を除かず行数で集計。引数の値は掲載しない）

| 型 | CB | 関数 | 合計 |
| --- | ---: | ---: | ---: |
| `execute if entity <minecraft:entity> → data modify entity <minecraft:entity> <minecraft:nbt_path> merge value <minecraft:nbt_tag>` | 0 | 55366 | 55366 |
| `execute if score <minecraft:score_holder> <minecraft:objective> matches <minecraft:int_range> → function <minecraft:function>` | 1 | 2545 | 2546 |
| `execute on passengers → function <minecraft:function>` | 0 | 1920 | 1920 |
| `summon <minecraft:resource> <minecraft:vec3> <minecraft:nbt_compound_tag>` | 402 | 674 | 1076 |
| `function <minecraft:function>` | 203 | 769 | 972 |
| `data modify storage <minecraft:resource_location> <minecraft:nbt_path> append value <minecraft:nbt_tag>` | 0 | 970 | 970 |
| `execute if score <minecraft:score_holder> <minecraft:objective> matches <minecraft:int_range> → execute as <minecraft:entity> → data merge entity <minecraft:entity> <minecraft:nbt_compound_tag>` | 0 | 464 | 464 |
| `particle <minecraft:particle> <minecraft:vec3> <minecraft:vec3> <brigadier:float> <brigadier:integer> force <minecraft:entity>` | 2 | 434 | 436 |
| `data modify storage <minecraft:resource_location> <minecraft:nbt_path> set value <minecraft:nbt_tag>` | 0 | 408 | 408 |
| `function <minecraft:function> with storage <minecraft:resource_location> <minecraft:nbt_path>` | 0 | 379 | 379 |
| `data merge entity <minecraft:entity> <minecraft:nbt_compound_tag>` | 3 | 348 | 351 |
| `execute store result storage <minecraft:resource_location> <minecraft:nbt_path> int <brigadier:double> → scoreboard players get <minecraft:score_holder> <minecraft:objective>` | 0 | 338 | 338 |
| `execute as <minecraft:entity> → function <minecraft:function>` | 15 | 298 | 313 |
| `execute store result score <minecraft:score_holder> <minecraft:objective> → data get storage <minecraft:resource_location> <minecraft:nbt_path>` | 0 | 296 | 296 |
| `data modify storage <minecraft:resource_location> <minecraft:nbt_path> set from storage <minecraft:resource_location> <minecraft:nbt_path>` | 0 | 279 | 279 |
| `execute if entity <minecraft:entity> → execute at <minecraft:entity> → execute on origin → tp <minecraft:entity> <minecraft:vec3> <minecraft:rotation>` | 0 | 276 | 276 |
| `execute as <minecraft:entity> → particle <minecraft:particle> <minecraft:vec3> <minecraft:vec3> <brigadier:float> <brigadier:integer> force <minecraft:entity>` | 0 | 260 | 260 |
| `execute if score <minecraft:score_holder> <minecraft:objective> matches <minecraft:int_range> → function <minecraft:function> with storage <minecraft:resource_location> <minecraft:nbt_path>` | 0 | 254 | 254 |
| `advancement revoke <minecraft:entity> only <minecraft:resource_key>` | 0 | 245 | 245 |
| `execute if data storage <minecraft:resource_location> <minecraft:nbt_path> → tellraw <minecraft:entity> <minecraft:component>` | 0 | 244 | 244 |
| `data remove storage <minecraft:resource_location> <minecraft:nbt_path>` | 0 | 241 | 241 |
| `execute if entity <minecraft:entity> → function <minecraft:function>` | 1 | 216 | 217 |
| `kill <minecraft:entity>` | 2 | 210 | 212 |
| `execute as <minecraft:entity> → execute at <minecraft:entity> → function <minecraft:function>` | 46 | 148 | 194 |
| `execute if data storage <minecraft:resource_location> <minecraft:nbt_path> → function <minecraft:function>` | 0 | 188 | 188 |

次に実装を検討する候補は、上位のエンティティNBT操作・関数呼び出し・storage・execute storeである。
NBTを伴うsummonもCB側で402行ある。サウンド・パーティクル等の単一BEコマンドへの拡張は #72。
頻度は重複を含み、1本の生成コードが占める割合も大きいので、全作品への効果や進行の重要性とは分けて考える。
