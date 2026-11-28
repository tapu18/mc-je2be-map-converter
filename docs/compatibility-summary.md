# 互換性台帳の集計

Java 26.3 / BDS 1.26.66.1 / Geyser `e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7`。再生成手順と数値の範囲は [互換性台帳](compatibility-ledger.md)。

| 族 | 項目数 | 方式の内訳 | 台帳に対応づいた行・定義ファイル | 対応表・代表入力で出力ありと判定した項目の頻度比 | 書き換え器の出力行の割合 | 作品数 |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| advancement_trigger | 58 | uninvestigated 58 | — 行・714 定義 | 0.00% | — | 8 |
| attribute | 40 | uninvestigated 40 | 22 行・— 定義 | 0.00% | 0.00% | 4 |
| click | 8 | uninvestigated 8 | 331 行・— 定義 | 0.00% | 23.26% | 4 |
| command | 1489 | native 58 / rewrite 129 / runtime 68 / approximation 74 / uninvestigated 1160 | 198030 行・— 定義 | 65.01% | — | 18 |
| component | 122 | uninvestigated 122 | 1702 行・— 定義 | 0.00% | 0.00% | 12 |
| effect | 40 | rewrite 36 / impossible 4 | 594 行・— 定義 | 96.63% | 87.54% | 16 |
| entity | 161 | rewrite 126 / asset 5 / uninvestigated 30 | 8987 行・— 定義 | 31.59% | 7.27% | 17 |
| game_rule | 59 | native 1 / rewrite 27 / impossible 31 | 181 行・— 定義 | 63.54% | 65.19% | 9 |
| hover | 3 | uninvestigated 3 | 238 行・— 定義 | 0.00% | 1.26% | 3 |
| loot_condition | 20 | uninvestigated 20 | — 行・271 定義 | 0.00% | — | 6 |
| loot_entry | 9 | uninvestigated 9 | — 行・618 定義 | 0.00% | — | 7 |
| loot_function | 42 | uninvestigated 42 | — 行・1170 定義 | 0.00% | — | 5 |
| particle | 128 | approximation 92 / uninvestigated 36 | 1985 行・— 定義 | 77.93% | 3.63% | 14 |
| sound | 1991 | approximation 1917 / uninvestigated 74 | 1924 行・— 定義 | 97.25% | 86.12% | 15 |

| 方式 | 全項目数 |
| --- | ---: |
| native | 59 |
| rewrite | 318 |
| runtime | 68 |
| asset | 5 |
| approximation | 2083 |
| impossible | 35 |
| uninvestigated | 1602 |
| 合計 | 4170 |

入力があったアーカイブ 19 本、進捗・predicate・ルートテーブル定義 1325 ファイル。
全 115487 行のうち、版選択不能 5、範囲内で結果が異なる 90、マクロ 3630、構文不受理 2373、パース済みで形が対応づかない 1584。
形が対応づいた 107805 行で書き換え器が出力したのは 21200 行（19.67%、全入力の 18.36%）。うち警告付き 3570 行。

## 未調査の頻度上位20件（行数）

| 族 | 項目 | 行数 | 作品数 |
| --- | --- | ---: | ---: |
| command | `data modify entity target<minecraft:entity> targetPath<minecraft:nbt_path> merge value value<minecraft:nbt_tag>` | 55584 | 2 |
| command | `summon entity<minecraft:resource> pos<minecraft:vec3> nbt<minecraft:nbt_compound_tag>` | 3296 | 16 |
| command | `execute on passengers` | 2070 | 3 |
| command | `data merge entity target<minecraft:entity> nbt<minecraft:nbt_compound_tag>` | 947 | 9 |
| command | `particle name<minecraft:particle> pos<minecraft:vec3> delta<minecraft:vec3> speed<brigadier:float> count<brigadier:integer> force viewers<minecraft:entity>` | 937 | 6 |
| command | `data modify entity target<minecraft:entity> targetPath<minecraft:nbt_path> set value value<minecraft:nbt_tag>` | 798 | 8 |
| command | `particle name<minecraft:particle> pos<minecraft:vec3> delta<minecraft:vec3> speed<brigadier:float> count<brigadier:integer> force` | 501 | 5 |
| command | `execute unless data storage source<minecraft:resource_location> path<minecraft:nbt_path>` | 383 | 5 |
| component | `minecraft:custom_model_data` | 341 | 2 |
| command | `data get storage target<minecraft:resource_location> path<minecraft:nbt_path>` | 334 | 5 |
| command | `execute on origin` | 330 | 2 |
| click | `run_command` | 328 | 3 |
| particle | `minecraft:dust` | 290 | 6 |
| command | `execute if predicate predicate<minecraft:loot_predicate>` | 280 | 3 |
| component | `minecraft:custom_name` | 276 | 9 |
| command | `execute if data entity source<minecraft:entity> path<minecraft:nbt_path>` | 265 | 7 |
| component | `minecraft:lore` | 260 | 4 |
| command | `function name<minecraft:function> with storage source<minecraft:resource_location>` | 253 | 5 |
| command | `advancement revoke targets<minecraft:entity> only advancement<minecraft:resource_key>` | 245 | 5 |
| hover | `show_text` | 238 | 3 |

## 未調査の頻度上位20件（定義ファイル数）

| 族 | 項目 | 定義ファイル数 | 作品数 |
| --- | --- | ---: | ---: |
| loot_entry | `minecraft:item` | 506 | 7 |
| loot_function | `minecraft:set_name` | 361 | 5 |
| advancement_trigger | `minecraft:player_interacted_with_entity` | 283 | 5 |
| loot_function | `minecraft:set_lore` | 240 | 3 |
| loot_function | `minecraft:set_components` | 200 | 3 |
| loot_condition | `minecraft:entity_properties` | 166 | 5 |
| loot_function | `minecraft:set_custom_data` | 133 | 2 |
| advancement_trigger | `minecraft:player_hurt_entity` | 132 | 4 |
| loot_function | `minecraft:set_count` | 101 | 4 |
| advancement_trigger | `minecraft:impossible` | 93 | 4 |
| advancement_trigger | `minecraft:tick` | 92 | 3 |
| loot_entry | `minecraft:empty` | 45 | 3 |
| loot_entry | `minecraft:loot_table` | 43 | 2 |
| advancement_trigger | `minecraft:using_item` | 40 | 4 |
| loot_function | `minecraft:set_custom_model_data` | 31 | 2 |
| advancement_trigger | `minecraft:inventory_changed` | 24 | 5 |
| advancement_trigger | `minecraft:consume_item` | 24 | 4 |
| loot_condition | `minecraft:any_of` | 24 | 2 |
| loot_function | `minecraft:set_damage` | 23 | 2 |
| loot_condition | `minecraft:random_chance` | 21 | 2 |
