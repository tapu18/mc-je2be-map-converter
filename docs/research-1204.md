# Java 1.20.4 の調査（#145、対象版の変更ではない）

2026-11-22。調査用の 1.20.4 は正式な文法カタログには追加しない。Mojang の [版マニフェスト](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json) の [1.20.4 版情報](https://piston-meta.mojang.com/v1/packages/417a1afaf3fc8a3c35e573e9d3c76a90a7fc7330/1.20.4.json) に記載されたサーバーの SHA-1 は `8dd1a28015f51b1803213892b50b7b4fc76e594d`。配布 jar 内の `version.json` は DataVersion 3700、データパック形式 26。`--reports` は commands.json を生成した（SHA-256 `daf47c51cdd3995653f3ae4dd1605300672d90b43babfc73a9e1d3228835f6e1`）。

再現（コーパス JSONL は非公開の一時領域に置き、出力・コミットしない）:

```sh
npm ci
npm run setup:servers
npm run setup:mappings
npm run build:pack
JE2BE_GRAMMAR_CACHE=/tmp/je2be-grammars node --input-type=module -e 'import {setupJavaGrammar} from "@je2be/converter"; await setupJavaGrammar({version:"1.20.4",url:"https://piston-data.mojang.com/v1/objects/8dd1a28015f51b1803213892b50b7b4fc76e594d/server.jar",sha1:"8dd1a28015f51b1803213892b50b7b4fc76e594d",functionDirectory:"functions"})'
npm run setup:grammars -- 1.20.5
python3 -I scripts/dump_commands.py /path/to/sample-map > /tmp/commands-private.jsonl
node tools/research-1204.ts /tmp/commands-private.jsonl
npx vitest run --config vitest.servers.config.ts packages/bridge/src/upgrade-1204.servers.test.ts
```

生成した文法を executable 終端と redirect ごとの経路に展開し、リテラル名・引数パーサとその properties・redirect 先で比較した。引数名は無視する。旧 1,091、翌版 1,115、共通 1,039、旧のみ 52、新のみ 76。これは文法木の形の差であり、引数型内部の仕様変更を数えない。

DataVersion 3700 の 16,564 行はマクロ 114、パース成功 14,123、構文不受理 2,327。マクロを除く成功率 85.85%。無変更 1,128、書換 3,353、未対応 9,642、構文不受理 2,327、マクロ 114。全行を分母とする静的出力可能率は 27.05%（4,481 行）。固定 JE 26.3 の ID 対応表とブロック既定値を使う推定であり、実行成功率ではない。パーサの不受理は Java サーバー自身の不受理を意味しない。`parse-corpus.ts --commands` では不受理 2,327 行のうち先頭が particle の行が 2,312 行だった。

パース成功行に限定し、解析された引数から数えると、`tag` をキーに含む NBT パスは 139 行、`components` を含むパスは 0 行、テキスト引数は 716 行、コンポーネント付きアイテム引数は 0 行だった。失敗行とマクロは含まないため、全行での使用数ではない。

調査専用に旧アイテム `id{NBT}` を読み取る引数パーサを使った再解析では、非マクロ 16,450 行中 14,135 行が成功し、旧アイテム引数を含む行は 12、`tag` パスは 139、`components` パスは 0、テキスト引数は 716 行だった。この補助パーサは出力可能率の集計には使わない。残る不受理 2,315 行とマクロ 114 行は対象外であり、全行の正確な使用数は未確定。

不受理の非マクロ行の先頭コマンドは `particle` 2,312 行、`effect` 3 行だった。これらは調査対象のアイテム引数・NBT パス・テキスト引数を取らないため、上記の件数は非マクロ全体の件数として扱える。ただしパーサ自体の誤判定の可能性は残る。マクロ 114 行は実行時の置換値がないため対象構文を確定できず、全行での件数はそれぞれ旧アイテム 12〜126、`tag` パス 139〜253、`components` パス 0〜114、テキスト引数 716〜830 の保守的な範囲にとどまる。この範囲は各マクロ行が対象構文を使うか不明として算出したもので、実際の使用数の推定ではない。

表層文字列の目印の行数は item `{` 候補 230、item `[` 候補 195、`tag` 候補 322、`components` 候補 0、テキスト系コマンド候補 988。`tools/research-1204.ts` の正規表現で、文字列中の一致や別の括弧を含み得る候補数であり、各構文の正確な使用行数ではない。特に `[` はセレクターにも一致する。

実サーバーテストは合成 1.20.4 ワールドを固定版 26.3 にコピーして開く。テスト対象の旧アイテムは `CustomModelData` が `minecraft:custom_model_data` に移り、コマンドブロックの Command と関数ファイルの文字列は一致した。エンティティの CustomName の内容は残った。個別のサンプルに対する実測であり、あらゆる NBT の変換を保証しない。1.20.4 の jar がなければこのテストはスキップする。
