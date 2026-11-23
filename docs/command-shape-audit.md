# コマンド形の Java 監査（#112）

再現: `npm run setup:servers && npm run setup:mappings && node tools/shape-java-audit.ts /tmp/shape-audit.json`。出力 JSON は各形 ID、候補、Java の診断、パーサの判定と終端形、書き換え結果を含む。入力は合成データで、配布マップは使わない。台帳の command 行の ID と対応する。

Java 26.3 の関数読み込みで 1,424 形、1,520 候補を測定した。生成不能 0、Java 受理 1,448、不受理 72、パーサと Java の判定不一致 72、パーサ終端形違い 0。書き換えは unsupported 1,298、unchanged 86、rewritten 136 で例外なし。66 形には Java が受理した候補がない。

以下は全72件を診断の内容で分類した記録であり、原因をすべて特定したという意味ではない。特に関数読み込みは管理コマンドや実験設定・レジストリの制約を受けるため、不一致を直ちにパーサの欠陥とは判定できない。参照先や実験機能の設定を変えての再検証は未実施。

## ルートが関数で認識されない（52件）

- `ban @s`
- `ban @s probe`
- `ban-ip probe`
- `ban-ip probe probe`
- `banlist`
- `banlist ips`
- `banlist players`
- `debug function minecraft:probe`
- `debug start`
- `debug stop`
- `deop @s`
- `jfr start`
- `jfr stop`
- `kick @s`
- `kick @s probe`
- `op @s`
- `pardon @s`
- `pardon-ip probe`
- `perf start`
- `perf stop`
- `publish`
- `publish true`
- `publish true 0`
- `publish true 65535`
- `save-all`
- `save-all flush`
- `save-off`
- `save-on`
- `setidletimeout 0`
- `stop`
- `tick freeze`
- `tick query`
- `tick rate 1`
- `tick rate 10000`
- `tick sprint stop`
- `tick sprint 1`
- `tick step`
- `tick step stop`
- `tick step 1`
- `tick unfreeze`
- `transfer probe`
- `transfer probe 1`
- `transfer probe 65535`
- `transfer probe 1 @s`
- `transfer probe 65535 @s`
- `unpublish`
- `whitelist add @s`
- `whitelist list`
- `whitelist off`
- `whitelist on`
- `whitelist reload`
- `whitelist remove @s`

## datapack create が認識されない（1件）

- `datapack create probe {"text":"probe"}`

## gamerule が認識されない（6件）

- `gamerule max_minecart_speed`
- `gamerule max_minecart_speed 1`
- `gamerule max_minecart_speed 1000`
- `gamerule minecraft:max_minecart_speed`
- `gamerule minecraft:max_minecart_speed 1`
- `gamerule minecraft:max_minecart_speed 1000`

## test_instance の参照先がない（9件）

- `test locate minecraft:probe`
- `test run minecraft:probe`
- `test run minecraft:probe 0`
- `test run minecraft:probe 0 true`
- `test run minecraft:probe 0 true 0`
- `test run minecraft:probe 0 true 0 0`
- `test runmultiple minecraft:probe`
- `test runmultiple minecraft:probe 0`
- `test verify minecraft:probe`

## timeline の参照先がない（4件）

- `time of minecraft:overworld query minecraft:overworld`
- `time of minecraft:overworld query minecraft:overworld repetition`
- `time query minecraft:overworld`
- `time query minecraft:overworld repetition`

## 範囲の制限

候補は各引数の代表値と、数値引数の文法に明示された上下限を一つずつ入れ替える。範囲外、引数間の組み合わせ、暗黙の型限界や非数値型の境界は網羅しない。JSON の数値を JavaScript の number で読むため、安全整数を超える long 境界や指数表記が必要な極端な浮動小数の値は厳密さを保証しない。今回の固定版の明示境界にはそのような値は現れなかったが、将来の版に対しては未検証。Java が受理したことは対象形を Java 側で通った証拠ではなく、終端形の確認はこのパーサ側だけである。未受理候補と境界の追加検証は #166、書き換えの BDS 構文受理や CI は #165 に分離した。
