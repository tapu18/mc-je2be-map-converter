# 配布マップのコマンドの型（集計）

検証用マップ（M1、#46）に何を詰め込むかを頻度で決めるための集計（#45）。配布マップ19本（`sample-map/`、リポジトリにはない）から、コマンドを「型」に抽象化して数えた。**作者が書いた部分（名前、タグ、数値、文章、NBT の中身、独自の名前空間の ID）はすべて伏せてあり、マップ名も載せない。** 残るのは、文法のキーワード・バニラの ID・セレクタの引数のキー名・座標の形式・演算子だけ。

## 型の読み方

| 表記 | 意味 |
| --- | --- |
| `NAME` | 伏せた名前（目的変数、タグ、プレイヤー名、表示スロットなど） |
| `N` | 数値、範囲 |
| `POS(abs)` / `POS(rel)` / `POS(local)` / `POS(mixed)` | 座標3つ組（絶対 / `~` / `^` / 混在） |
| `@e[tag,type]` | セレクタ（引数のキーだけ。値は伏せる） |
| `minecraft:stone[...]{nbt}` | バニラの ID。`[...]` はブロックの状態またはアイテムのデータコンポーネント、`{nbt}` は NBT 付き |
| `ns:ID` | minecraft 以外の名前空間の ID（関数名など） |
| `{nbt}` / `[list]` / `STR` / `MACRO` | NBT、リスト（JSON のテキストなど）、文字列、マクロの差し込み |

## M1 の検証用マップに入れる型

M1 はコマンドブロックだけの検証用マップを対象にする（データパックの関数、NBT 付きの召喚、Java 専用エンティティは M2 以降）。下の表から、コマンドブロックでの出現数とマップ数が多いものを選んだ。

| 検証用マップ | 入れる型 | 根拠（下の表） |
| --- | --- | --- |
| F1 起動とブロック操作 | レッドストーンで起動するインパルス（`setblock POS(abs) minecraft:redstone_block` で起動）、`setblock POS(abs/rel) <ブロック>`（状態付きを含む）、`fill POS(abs) POS(abs)`、`clone POS(abs/rel)` | チェーンの形の1位（902個・15本）、型の `setblock` / `fill` / `clone` |
| F2 チェーン | インパルスの長さ2〜5（条件なし・条件付き）、常時実行のリピート（長さ1、条件付きの2個目）、レッドストーンで動くリピート | チェーンの形の上位 |
| F3 スコア | `scoreboard objectives add/remove/setdisplay`、`players set/add/operation`（`=`・`+=`・`-=`・`*=`・`/=`・`%=`、負の数を含む）、`execute if score ... matches` | 関数でも上位。`/=`・`%=` は #42 で両エディションの意味の違いが見つかっている |
| F4 セレクタ | `@e[distance,limit,sort,tag]`、`@e[tag,type]`、`@e[limit,tag,type]`、`@a[distance]`、`@a[dx,dy,dz,x,y,z]`、`@e[scores,tag]`、`@p`、`kill`・`tp` での使用 | セレクタの表 |
| F5 プレイヤー向けの出力 | `tellraw @a [list]`（JSON）と `{nbt}`（SNBT）、`title @a title`、`execute as @a at @s run playsound`、`particle`、`give @p <アイテム>` | 型の上位。状態として観測できないため、比べ方は #46 で決める（変換後のコマンド文字列を比べる、など） |

M2 以降に回すもの（参考）：`function`（コマンドブロックの型の1位、312個・9本）、`summon ... {nbt}`（`text_display`、`armor_stand`、`interaction`、`marker`）、`data modify` / `data merge`、`execute on`、`advancement revoke`。

## 作り直し方

```sh
# 文法とレジストリをデータ生成で作る（Mojang のデータなのでリポジトリには含めない）
java -DbundlerMainClass=net.minecraft.data.Main -jar servers/java-26.3/server.jar --reports --output /tmp/je2be-reports
python3 -I scripts/command_patterns.py --reports /tmp/je2be-reports/reports --top 30 --markdown sample-map
```

## 集計結果（2026-11-15、Java 26.3 の文法で抽象化、上位30）

対象：19本、コマンドブロック 3550個、関数の実行行 113090行

### コマンドブロック：コマンド名（execute はサブコマンドと run の先）

| 出現数 | マップ数 | 型 |
| ---: | ---: | --- |
| 515 | 7 | `setblock` |
| 404 | 4 | `summon` |
| 312 | 9 | `function` |
| 296 | 7 | `tellraw` |
| 158 | 6 | `give` |
| 155 | 5 | `playsound` |
| 141 | 5 | `fill` |
| 129 | 7 | `scoreboard` |
| 115 | 3 | `kill` |
| 108 | 5 | `clone` |
| 93 | 2 | `execute[as at] run playsound` |
| 66 | 4 | `particle` |
| 56 | 6 | `tp` |
| 47 | 5 | `execute[as at function] run function` |
| 41 | 3 | `title` |
| 38 | 1 | `execute[positioned as function] run function` |
| 37 | 2 | `execute[positioned function] run function` |
| 37 | 2 | `execute[unless entity summon] run summon` |
| 29 | 3 | `execute[at] run particle` |
| 29 | 1 | `execute[if blocks function] run function` |
| 27 | 2 | `execute[positioned as at function] run function` |
| 26 | 5 | `effect` |
| 25 | 4 | `execute[as at] run tp` |
| 24 | 1 | `team` |
| 23 | 1 | `execute[positioned] run kill` |
| 22 | 2 | `execute[if blocks] run setblock` |
| 20 | 1 | `execute[as at on function] run function` |
| 20 | 1 | `execute[as at positioned] run playsound` |
| 20 | 1 | `execute[positioned if entity] run setblock` |
| 18 | 2 | `bossbar` |

### コマンドブロック：型

| 出現数 | マップ数 | 型 |
| ---: | ---: | --- |
| 312 | 9 | `function ns:ID` |
| 193 | 3 | `setblock POS(abs) minecraft:air` |
| 187 | 4 | `tellraw @a [list]` |
| 101 | 2 | `summon minecraft:text_display POS(rel) {nbt}` |
| 93 | 1 | `kill @e[distance,limit,sort,tag]` |
| 90 | 4 | `setblock POS(abs) minecraft:redstone_block` |
| 83 | 1 | `tellraw @a {nbt}` |
| 76 | 3 | `setblock POS(rel) minecraft:air` |
| 73 | 3 | `summon minecraft:armor_stand POS(rel) {nbt}` |
| 71 | 1 | `setblock POS(abs) minecraft:oak_sign[...]{nbt}` |
| 69 | 3 | `fill POS(abs) POS(abs) minecraft:air` |
| 69 | 3 | `clone POS(abs) POS(abs) POS(abs)` |
| 54 | 1 | `summon minecraft:interaction POS(rel) {nbt}` |
| 47 | 2 | `summon minecraft:marker POS(rel) {nbt}` |
| 38 | 2 | `clone POS(rel) POS(rel) POS(rel)` |
| 36 | 1 | `execute positioned POS(rel) run function ns:ID` |
| 36 | 4 | `tp @p POS(abs)` |
| 35 | 4 | `execute as @p at @s run function ns:ID` |
| 34 | 1 | `particle minecraft:basic_flame_particle POS(rel)` |
| 34 | 1 | `execute as @a at @s run playsound minecraft:block.note_block.guitar master @s POS(rel) N N` |
| 32 | 1 | `give @p minecraft:carved_pumpkin[...]{nbt}` |
| 30 | 2 | `title @a title [list]` |
| 30 | 1 | `playsound NAME @p NAME N N` |
| 27 | 1 | `execute positioned POS(rel) as @a[dx,dy,dz] run function ns:ID` |
| 25 | 2 | `execute positioned POS(abs) as @p at @s run function ns:ID` |
| 22 | 1 | `scoreboard objectives setdisplay NAME NAME` |
| 22 | 2 | `scoreboard objectives remove NAME` |
| 21 | 1 | `summon minecraft:item_display POS(rel) {nbt}` |
| 20 | 1 | `execute as @a at @s positioned POS(rel) run playsound minecraft:entity.witch.celebrate master @s POS(rel) N N` |
| 19 | 1 | `tellraw @a[distance] {nbt}` |

### チェーンの形（起点の種類と起動方法、長さ、2個目以降の条件付き）

| 出現数 | マップ数 | 型 |
| ---: | ---: | --- |
| 902 | 15 | `impulse(レッドストーン) 長さ1 条件なし` |
| 251 | 10 | `repeat(常時) 長さ1 条件なし` |
| 226 | 3 | `impulse(レッドストーン) 長さ2 条件-` |
| 219 | 7 | `repeat(レッドストーン) 長さ1 条件なし` |
| 106 | 2 | `impulse(レッドストーン) 長さ2 条件?` |
| 56 | 4 | `impulse(レッドストーン) 長さ4 条件---` |
| 45 | 2 | `impulse(レッドストーン) 長さ3 条件--` |
| 44 | 2 | `impulse(レッドストーン) 長さ5+ 条件----…` |
| 20 | 2 | `impulse(レッドストーン) 長さ5+ 条件----` |
| 16 | 2 | `repeat(常時) 長さ2 条件?` |
| 15 | 3 | `None(レッドストーン) 長さ1 条件なし` |
| 14 | 1 | `None(常時) 長さ1 条件なし` |
| 12 | 2 | `repeat(レッドストーン) 長さ2 条件-` |
| 9 | 1 | `repeat(レッドストーン) 長さ5+ 条件----…` |
| 8 | 1 | `repeat(レッドストーン) 長さ3 条件--` |
| 6 | 1 | `impulse(レッドストーン) 長さ5+ 条件????…` |
| 5 | 2 | `impulse(レッドストーン) 長さ3 条件??` |
| 5 | 1 | `repeat(レッドストーン) 長さ2 条件?` |
| 3 | 2 | `repeat(常時) 長さ2 条件-` |
| 3 | 1 | `repeat(レッドストーン) 長さ5+ 条件----` |
| 2 | 2 | `repeat(常時) 長さ3 条件??` |
| 2 | 2 | `impulse(常時) 長さ1 条件なし` |
| 2 | 2 | `repeat(常時) 長さ4 条件---` |
| 2 | 1 | `repeat(レッドストーン) 長さ4 条件---` |
| 1 | 1 | `repeat(レッドストーン) 長さ3 条件??` |

### データパックの関数：コマンド名

| 出現数 | マップ数 | 型 |
| ---: | ---: | --- |
| 55493 | 4 | `execute[if entity data] run data` |
| 5440 | 13 | `data` |
| 4747 | 15 | `scoreboard` |
| 3576 | 13 | `fill` |
| 3397 | 10 | `execute[if score function] run function` |
| 3393 | 13 | `particle` |
| 2521 | 14 | `function` |
| 2120 | 13 | `setblock` |
| 1920 | 1 | `execute[on function] run function` |
| 1825 | 14 | `summon` |
| 959 | 14 | `tag` |
| 948 | 10 | `execute[if score] run scoreboard` |
| 766 | 14 | `tellraw` |
| 640 | 13 | `playsound` |
| 590 | 15 | `kill` |
| 583 | 8 | `advancement` |
| 546 | 8 | `execute[store result] run scoreboard` |
| 490 | 2 | `execute[if score as data entity] run data` |
| 470 | 5 | `execute[store result score data] run data` |
| 465 | 11 | `execute[as function] run function` |
| 447 | 6 | `execute[positioned function] run function` |
| 403 | 13 | `effect` |
| 395 | 4 | `execute[if score data] run data` |
| 393 | 14 | `tp` |
| 360 | 11 | `schedule` |
| 345 | 6 | `execute[if score summon] run summon` |
| 339 | 8 | `execute[if entity function] run function` |
| 323 | 3 | `execute[if data] run tellraw` |
| 318 | 9 | `execute[if score] run tellraw` |
| 312 | 8 | `item` |

### データパックの関数：型

| 出現数 | マップ数 | 型 |
| ---: | ---: | --- |
| 55366 | 1 | `execute if entity @s[tag] run data modify entity @s {nbt} merge value {nbt}` |
| 2318 | 6 | `execute if score @s NAME matches N run function ns:ID` |
| 2040 | 1 | `particle minecraft:dust POS(abs) POS(abs) POS(abs) POS(abs)` |
| 1966 | 4 | `data merge entity @e[limit,tag,type] {nbt}` |
| 1920 | 1 | `execute on passengers run function ns:ID` |
| 1555 | 13 | `function ns:ID` |
| 842 | 12 | `scoreboard players set NAME NAME N` |
| 554 | 1 | `fill POS(rel) POS(rel) minecraft:smooth_quartz` |
| 540 | 8 | `advancement revoke @s only ns:ID` |
| 540 | 1 | `fill POS(rel) POS(rel) minecraft:white_stained_glass_pane` |
| 516 | 2 | `data modify storage ns:ID NAME append value {nbt}` |
| 464 | 1 | `execute if score NAME NAME matches N as @e[tag,type] run data merge entity @s {nbt}` |
| 435 | 4 | `execute positioned POS(abs) run function ns:ID` |
| 417 | 11 | `scoreboard players set @s NAME N` |
| 384 | 3 | `data modify storage NAME NAME set from storage NAME NAME` |
| 360 | 4 | `function ns:ID with storage NAME NAME` |
| 353 | 11 | `scoreboard objectives add NAME NAME` |
| 316 | 12 | `scoreboard players add NAME NAME N` |
| 315 | 9 | `execute if score NAME NAME matches N run function ns:ID` |
| 315 | 1 | `execute if score NAME NAME matches N run summon minecraft:item_display POS(abs) {nbt}` |
| 309 | 2 | `{nbt}` |
| 304 | 3 | `data remove storage NAME NAME` |
| 299 | 7 | `tag @s remove NAME` |
| 298 | 4 | `summon minecraft:text_display POS(abs) {nbt}` |
| 295 | 1 | `data modify storage NAME NAME append value {nbt}` |
| 290 | 2 | `fill POS(rel) POS(rel) minecraft:water` |
| 289 | 1 | `fill POS(rel) POS(rel) minecraft:clay` |
| 288 | 2 | `execute if data storage NAME NAME run tellraw @s [list]` |
| 284 | 7 | `clone POS(abs) POS(abs) POS(abs)` |
| 276 | 1 | `execute if entity @s[tag] at @s on origin run tp @s POS(local) ~ ~` |

### セレクタと引数のキー（コマンドブロックと関数の合計）

| 出現数 | マップ数 | 型 |
| ---: | ---: | --- |
| 77090 | 17 | `@s` |
| 56435 | 10 | `@s[tag]` |
| 4053 | 18 | `@a` |
| 3059 | 10 | `@e[limit,tag,type]` |
| 2673 | 14 | `@e[tag,type]` |
| 1415 | 14 | `@e[tag]` |
| 1409 | 8 | `@e[scores,tag]` |
| 1258 | 8 | `@e[limit,tag]` |
| 727 | 12 | `@a[tag]` |
| 720 | 6 | `@e[limit,sort,tag,type]` |
| 525 | 1 | `@e[limit,sort,tag,type,x,y,z]` |
| 473 | 12 | `@a[distance]` |
| 436 | 15 | `@p` |
| 309 | 2 | `@n[scores,tag]` |
| 213 | 3 | `@a[dx,dy,dz,x,y,z]` |
| 203 | 1 | `@n[scores,tag,type]` |
| 200 | 4 | `@a[team]` |
| 198 | 3 | `@n[tag]` |
| 190 | 1 | `@e[predicate,tag]` |
| 176 | 5 | `@s[scores]` |
| 166 | 5 | `@a[dx,dy,dz]` |
| 164 | 1 | `@e[limit,scores,sort,tag,type]` |
| 158 | 10 | `@e[nbt,type]` |
| 151 | 12 | `@a[scores]` |
| 148 | 3 | `@n[tag,type]` |
| 127 | 7 | `@e[limit,sort,tag]` |
| 118 | 4 | `@a[scores,tag]` |
| 117 | 5 | `@e[distance,limit,sort,tag]` |
| 114 | 8 | `@e[distance,tag,type]` |
| 113 | 9 | `@e[distance,tag]` |

### 座標の形式（3つ組。abs=絶対、rel=~、local=^、mixed=混在）

| 出現数 | マップ数 | 型 |
| ---: | ---: | --- |
| 20730 | 19 | `POS(abs)` |
| 15099 | 16 | `POS(rel)` |
| 1791 | 12 | `POS(local)` |
| 699 | 11 | `POS(mixed)` |

