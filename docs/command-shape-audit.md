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

## 形ごとの再検証（#166）

再現: 上記の監査の後、`node tools/shape-context-audit.ts /tmp/shape-audit.json /tmp/shape-context.json`。関数は読み込みのみで実行しない。Java 26.3 の `minecart_improvements` を有効にし、test_instance を `minecraft:always_pass`、timeline を `minecraft:day` に差し替えた。パック有効・監視関数の失敗・コンテキストエラーなしを確認した。実験設定を変えた 6 件の gamerule と参照先を差し替えた 9 件の test、4 件の time はすべて受理された。複数引数を同時に変えた検証ではなく、元候補の受理を意味しない。

次表は 72 候補（66 形）を漏れなく列挙する。管理コマンド等の行は関数の権限・実行文脈が原因の可能性があるが、同じ構文を安全にパースだけする独立の手段はまだ検証していないため未確定とする。`datapack create` も未確定。参照先・実験設定の行は上記の対照実験による分類であり、全引数の意味的妥当性やパーサの完全性は保証しない。

| 形 ID | 元候補 | 分類 |
| --- | --- | --- |
| ban targets&lt;minecraft:game_profile&gt; | `ban @s` | 未確定 |
| ban targets&lt;minecraft:game_profile&gt; reason&lt;minecraft:message&gt; | `ban @s probe` | 未確定 |
| ban-ip target&lt;brigadier:string&gt; | `ban-ip probe` | 未確定 |
| ban-ip target&lt;brigadier:string&gt; reason&lt;minecraft:message&gt; | `ban-ip probe probe` | 未確定 |
| banlist | `banlist` | 未確定 |
| banlist ips | `banlist ips` | 未確定 |
| banlist players | `banlist players` | 未確定 |
| datapack create id&lt;brigadier:string&gt; description&lt;minecraft:component&gt; | `datapack create probe {"text":"probe"}` | 未確定 |
| debug function name&lt;minecraft:function&gt; | `debug function minecraft:probe` | 未確定 |
| debug start | `debug start` | 未確定 |
| debug stop | `debug stop` | 未確定 |
| deop targets&lt;minecraft:game_profile&gt; | `deop @s` | 未確定 |
| gamerule max_minecart_speed | `gamerule max_minecart_speed` | 実験設定 |
| gamerule max_minecart_speed value&lt;brigadier:integer&gt; | `gamerule max_minecart_speed 1` | 実験設定 |
| gamerule max_minecart_speed value&lt;brigadier:integer&gt; | `gamerule max_minecart_speed 1000` | 実験設定 |
| gamerule minecraft:max_minecart_speed | `gamerule minecraft:max_minecart_speed` | 実験設定 |
| gamerule minecraft:max_minecart_speed value&lt;brigadier:integer&gt; | `gamerule minecraft:max_minecart_speed 1` | 実験設定 |
| gamerule minecraft:max_minecart_speed value&lt;brigadier:integer&gt; | `gamerule minecraft:max_minecart_speed 1000` | 実験設定 |
| jfr start | `jfr start` | 未確定 |
| jfr stop | `jfr stop` | 未確定 |
| kick targets&lt;minecraft:entity&gt; | `kick @s` | 未確定 |
| kick targets&lt;minecraft:entity&gt; reason&lt;minecraft:message&gt; | `kick @s probe` | 未確定 |
| op targets&lt;minecraft:game_profile&gt; | `op @s` | 未確定 |
| pardon targets&lt;minecraft:game_profile&gt; | `pardon @s` | 未確定 |
| pardon-ip target&lt;brigadier:string&gt; | `pardon-ip probe` | 未確定 |
| perf start | `perf start` | 未確定 |
| perf stop | `perf stop` | 未確定 |
| publish | `publish` | 未確定 |
| publish allowCommands&lt;brigadier:bool&gt; | `publish true` | 未確定 |
| publish allowCommands&lt;brigadier:bool&gt; port&lt;brigadier:integer&gt; | `publish true 0` | 未確定 |
| publish allowCommands&lt;brigadier:bool&gt; port&lt;brigadier:integer&gt; | `publish true 65535` | 未確定 |
| save-all | `save-all` | 未確定 |
| save-all flush | `save-all flush` | 未確定 |
| save-off | `save-off` | 未確定 |
| save-on | `save-on` | 未確定 |
| setidletimeout minutes&lt;brigadier:integer&gt; | `setidletimeout 0` | 未確定 |
| stop | `stop` | 未確定 |
| test locate tests&lt;minecraft:resource_selector&gt; | `test locate minecraft:probe` | 参照先 |
| test run tests&lt;minecraft:resource_selector&gt; | `test run minecraft:probe` | 参照先 |
| test run tests&lt;minecraft:resource_selector&gt; numberOfTimes&lt;brigadier:integer&gt; | `test run minecraft:probe 0` | 参照先 |
| test run tests&lt;minecraft:resource_selector&gt; numberOfTimes&lt;brigadier:integer&gt; untilFailed&lt;brigadier:bool&gt; | `test run minecraft:probe 0 true` | 参照先 |
| test run tests&lt;minecraft:resource_selector&gt; numberOfTimes&lt;brigadier:integer&gt; untilFailed&lt;brigadier:bool&gt; rotationSteps&lt;brigadier:integer&gt; | `test run minecraft:probe 0 true 0` | 参照先 |
| test run tests&lt;minecraft:resource_selector&gt; numberOfTimes&lt;brigadier:integer&gt; untilFailed&lt;brigadier:bool&gt; rotationSteps&lt;brigadier:integer&gt; testsPerRow&lt;brigadier:integer&gt; | `test run minecraft:probe 0 true 0 0` | 参照先 |
| test runmultiple tests&lt;minecraft:resource_selector&gt; | `test runmultiple minecraft:probe` | 参照先 |
| test runmultiple tests&lt;minecraft:resource_selector&gt; amount&lt;brigadier:integer&gt; | `test runmultiple minecraft:probe 0` | 参照先 |
| test verify tests&lt;minecraft:resource_selector&gt; | `test verify minecraft:probe` | 参照先 |
| tick freeze | `tick freeze` | 未確定 |
| tick query | `tick query` | 未確定 |
| tick rate rate&lt;brigadier:float&gt; | `tick rate 1` | 未確定 |
| tick rate rate&lt;brigadier:float&gt; | `tick rate 10000` | 未確定 |
| tick sprint stop | `tick sprint stop` | 未確定 |
| tick sprint time&lt;minecraft:time&gt; | `tick sprint 1` | 未確定 |
| tick step | `tick step` | 未確定 |
| tick step stop | `tick step stop` | 未確定 |
| tick step time&lt;minecraft:time&gt; | `tick step 1` | 未確定 |
| tick unfreeze | `tick unfreeze` | 未確定 |
| time of clock&lt;minecraft:resource&gt; query timeline&lt;minecraft:resource&gt; | `time of minecraft:overworld query minecraft:overworld` | 参照先 |
| time of clock&lt;minecraft:resource&gt; query timeline&lt;minecraft:resource&gt; repetition | `time of minecraft:overworld query minecraft:overworld repetition` | 参照先 |
| time query timeline&lt;minecraft:resource&gt; | `time query minecraft:overworld` | 参照先 |
| time query timeline&lt;minecraft:resource&gt; repetition | `time query minecraft:overworld repetition` | 参照先 |
| transfer hostname&lt;brigadier:string&gt; | `transfer probe` | 未確定 |
| transfer hostname&lt;brigadier:string&gt; port&lt;brigadier:integer&gt; | `transfer probe 1` | 未確定 |
| transfer hostname&lt;brigadier:string&gt; port&lt;brigadier:integer&gt; | `transfer probe 65535` | 未確定 |
| transfer hostname&lt;brigadier:string&gt; port&lt;brigadier:integer&gt; players&lt;minecraft:entity&gt; | `transfer probe 1 @s` | 未確定 |
| transfer hostname&lt;brigadier:string&gt; port&lt;brigadier:integer&gt; players&lt;minecraft:entity&gt; | `transfer probe 65535 @s` | 未確定 |
| unpublish | `unpublish` | 未確定 |
| whitelist add targets&lt;minecraft:game_profile&gt; | `whitelist add @s` | 未確定 |
| whitelist list | `whitelist list` | 未確定 |
| whitelist off | `whitelist off` | 未確定 |
| whitelist on | `whitelist on` | 未確定 |
| whitelist reload | `whitelist reload` | 未確定 |
| whitelist remove targets&lt;minecraft:game_profile&gt; | `whitelist remove @s` | 未確定 |

境界の追加検討: 明示されない整数・浮動小数の型限界の前後、上下限の外、引数を同時に変える組み合わせ、文字列・リソース・座標などの非数値境界を個別に比較する必要がある。将来版の long は JSON を number に変換する前に整数文字列を保持し、浮動小数の指数表記は Java が受理する字句形式を実測してから候補化する必要がある。今回これらの網羅やパーサ欠陥の有無は確定していない。未確定の管理系候補と境界の追試は #205 で扱う。

## 管理コマンドの再検証（#205）

Java 26.3 の新規ワールドに RCON で `execute if entity @e[tag=je2be_absent] run <候補>` を送った。対象タグのエンティティはいない。`stop` の後も `list` が応答し、不正な `stop garbage` は構文エラーになる対照で、実行せず末尾を解析することを確認した。再現: `node tools/admin-syntax-audit.ts`（結果は `/tmp/audit205.json`）。空応答はこの条件下で構文診断なしを意味し、実行時の成功は意味しない。候補は合成データ。

「仕様どおり」は候補がこの文脈で解析されたことに限定する。プレイヤー限定 `@s` は Java が拒否し既存パーサが受理する欠陥。`publish` / `unpublish` は専用サーバーのコマンドツリーに存在せず、元の構文を判定できない。

| 元候補 | 判定 |
| --- | --- |
| `ban @s` | 欠陥（プレイヤー限定セレクター） |
| `ban @s probe` | 欠陥（プレイヤー限定セレクター） |
| `ban-ip probe` | 仕様どおり（構文診断なし） |
| `ban-ip probe probe` | 仕様どおり（構文診断なし） |
| `banlist` | 仕様どおり（構文診断なし） |
| `banlist ips` | 仕様どおり（構文診断なし） |
| `banlist players` | 仕様どおり（構文診断なし） |
| `datapack create probe {"text":"probe"}` | 仕様どおり（構文診断なし） |
| `debug function minecraft:probe` | 仕様どおり（構文診断なし） |
| `debug start` | 仕様どおり（構文診断なし） |
| `debug stop` | 仕様どおり（構文診断なし） |
| `deop @s` | 欠陥（プレイヤー限定セレクター） |
| `jfr start` | 仕様どおり（構文診断なし） |
| `jfr stop` | 仕様どおり（構文診断なし） |
| `kick @s` | 仕様どおり（構文診断なし） |
| `kick @s probe` | 仕様どおり（構文診断なし） |
| `op @s` | 欠陥（プレイヤー限定セレクター） |
| `pardon @s` | 欠陥（プレイヤー限定セレクター） |
| `pardon-ip probe` | 仕様どおり（構文診断なし） |
| `perf start` | 仕様どおり（構文診断なし） |
| `perf stop` | 仕様どおり（構文診断なし） |
| `publish` | 確かめられない（専用サーバーで未提供） |
| `publish true` | 確かめられない（専用サーバーで未提供） |
| `publish true 0` | 確かめられない（専用サーバーで未提供） |
| `publish true 65535` | 確かめられない（専用サーバーで未提供） |
| `save-all` | 仕様どおり（構文診断なし） |
| `save-all flush` | 仕様どおり（構文診断なし） |
| `save-off` | 仕様どおり（構文診断なし） |
| `save-on` | 仕様どおり（構文診断なし） |
| `setidletimeout 0` | 仕様どおり（構文診断なし） |
| `stop` | 仕様どおり（構文診断なし） |
| `tick freeze` | 仕様どおり（構文診断なし） |
| `tick query` | 仕様どおり（構文診断なし） |
| `tick rate 1` | 仕様どおり（構文診断なし） |
| `tick rate 10000` | 仕様どおり（構文診断なし） |
| `tick sprint stop` | 仕様どおり（構文診断なし） |
| `tick sprint 1` | 仕様どおり（構文診断なし） |
| `tick step` | 仕様どおり（構文診断なし） |
| `tick step stop` | 仕様どおり（構文診断なし） |
| `tick step 1` | 仕様どおり（構文診断なし） |
| `tick unfreeze` | 仕様どおり（構文診断なし） |
| `transfer probe` | 仕様どおり（構文診断なし） |
| `transfer probe 1` | 仕様どおり（構文診断なし） |
| `transfer probe 65535` | 仕様どおり（構文診断なし） |
| `transfer probe 1 @s` | 仕様どおり（構文診断なし） |
| `transfer probe 65535 @s` | 仕様どおり（構文診断なし） |
| `unpublish` | 確かめられない（専用サーバーで未提供） |
| `whitelist add @s` | 欠陥（プレイヤー限定セレクター） |
| `whitelist list` | 仕様どおり（構文診断なし） |
| `whitelist off` | 仕様どおり（構文診断なし） |
| `whitelist on` | 仕様どおり（構文診断なし） |
| `whitelist reload` | 仕様どおり（構文診断なし） |
| `whitelist remove @s` | 欠陥（プレイヤー限定セレクター） |

境界の追試では `scoreboard players set x y` の 2147483647 は構文診断なし、2147483648 と -2147483649 は無効整数。`tick rate` は 1 と 10000 を受理し、0 と 10001 を範囲外として拒否、`1e2` は末尾データとして拒否した。`transfer probe` のポート 0 と 65536 は範囲外、1 と 65535 に `@s` を組み合わせた候補は構文診断なし。非数値では上記の `@s`、不正末尾、および `datapack create` の JSON 候補を確認した。これらは網羅ではない。

固定版の commands.json に `brigadier:long` はなく、将来版の境界・精度は実サーバーで確認できない。指数表記も上記 float の具体例のみで、将来版全体を保証しない。

将来版の long 精度は合成した `brigadier:long` 文法で追試した。`probe 9007199254740993` を現在のパーサは受理するが、値を `9007199254740992` に丸める（`packages/core/src/command/parser.test.ts`）。これは値の精度欠陥で、修正は #244 に分離する。固定版の Java で同じコマンドを比較した結果ではない。
