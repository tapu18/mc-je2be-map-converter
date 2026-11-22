# ランタイム読み込み PoC

`npm ci && npm run setup:servers && npm run setup:mappings && npm run build:pack` の後、`npx vitest run --config vitest.servers.config.ts poc/runtime-load/runtime-load.servers.test.ts`。生成パックと Mojang データは Git に入れない。`prepare.ts` は既存パーサを型除去して ES modules にし、commands.json と Geyser 対応表を文字列として同梱する。別途、同じ文法を圧縮 JSON に再構成した版と、手書きの1命令文法・石1件の対応表の代替ファイルを `servers/` に作る。後者は全機能版ではない。

[results.json](results.json) は Java 26.3 の生成文法、Geyser 固定 revision、BDS 1.26.63.1、API 2.12.0-beta、Linux の1環境での記録。3回とも `scoreboard players set example test 1` のパースが成功し、対応表の6つのトップレベル項目を確認した。対応表の全項目の利用やマクロ実行は検証していない。

雛形の生成は先に済ませ、毎回新しいワールドをコピーして起動。`startToParseMs` はテスト側の `BedrockServer.start` 呼び出し直前からスクリプトのパース完了時刻までで、ワールド準備、BDS 起動、JS モジュールのロードを含む。プロセス単体の起動時間でもパックだけのロード時間でもない。壁時計の `Date.now()` はミリ秒分解能であり、同じマシンで測る。`loaded - start` はスクリプト本体で JSON.parse 2回を行う時間で、静的 import の読み込みは含まない。`end - loaded` は3回とも0msであり、ゼロコストを意味しない。

結果は 602 / 783 / 613 ms、JSON.parse は 159 / 193 / 178 ms。既存パックやマシン負荷の影響を分離していない。測定値は目安であり性能保証ではない。圧縮前の manifest と実行ファイル合計は 12,624,623 bytes（対応表 JSON 10,357,025 bytes、commands.json 583,592 bytes。JS 文字列化でサイズ増）。手書き1命令・石1件だけの代替データは 624 bytes、同じコードと manifest の合計は 50,929 bytes。後者は生成サイズのみで BDS の実行・全機能・権利を検証していない。実用的な全対象を網羅する独自形式のサイズは未確認。

元の JSON ファイルを同梱せず、全ての文法ノードを圧縮 JSON に再構成し同じ対応表と合わせた場合は、データ 12,160,602 bytes、同じコードと manifest の合計 12,210,907 bytes。これは同じデータの変換物であり、権利上の同梱可否は #107 の判断待ち。サイズだけを生成し、BDS でこの版の起動時間は測っていない。
