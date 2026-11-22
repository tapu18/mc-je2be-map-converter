# Java コマンドの追加検証（#59）

文法パーサの後に、**対象 Java サーバーが受理するか**を確認する追加検証。
変換レポートに組み込める JSON と API を提供する。JE→BE の書き換え・ワールド生成自体は行わない。

## 使い方

入力は `scripts/dump_commands.py` と同じ JSON Lines。各行に `cmd` を持つ。
任意の `id` を付ければ、ファイル・行・ブロック座標等と診断結果を結び付けられる。
省略時は JSONL の行番号が識別子になる。

```json
{"id":"function:test:demo:1","cmd":"execute if predicate test:ready run say ready"}
{"id":"block:0,64,0","cmd":"attribute @s minecraft:generic.max_health base set 20"}
```

```sh
npm run setup:servers
npm run validate:commands -- ./servers/commands.jsonl --datapack ./my-pack --out ./servers/command-validation.json
npm run validate:commands -- ./servers/commands.jsonl --datapack ./my-pack.zip
npm run validate:commands -- ./servers/commands.jsonl --world ./my-java-world
```

`--datapack` は繰り返して指定できる。パック間で参照する定義をまとめて渡す。
入力には **同じワールド・同じパック構成のコマンドだけ**を含める。複数マップのコマンドを
まとめたコーパスに全マップのパックを混ぜると、別マップの定義で参照が解決する恐れがある。
指定順に新規ワールドのパックを有効化し、実際の有効パック一覧も結果に記録する。

`--datapack` はディレクトリと ZIP に対応する。`--world` は `level.dat` の `Data.DataPacks.Enabled` / `Disabled`
を読み、有効な `file/` パックだけを保存された順序で渡す。ZIP も展開済みパックも同じ方法で
関数本文を空にする。無効・未選択のパックはコピーしない。組み込みパックも元の有効順で
指定し、固定 Java に存在しない場合はコンテキストエラーにする。
有効パックの欠落や不正な保存リストはエラーとし、勝手に全パックを有効化しない。
`--world` と `--datapack` の併用は拒否する。元のワールドや ZIP・ディレクトリを変更せず、
検証用の空ワールドで判定する。

既定の出力は git 管理外の `servers/command-validation.json`。
標準出力は出力先と件数のみ。詳細の診断には作者の ID、ファイル名や Java のエラー文が
含まれるため、配布マップを調べたレポートはリポジトリ・Issue・公開ログへ貼らない。

終了コードは、判定できた行に拒否・未解決参照がある場合、またはパックの読み込みに
失敗した場合に1。マクロ等の未判定行は件数と `complete: false` で示す。
終了コード0だけで、全コマンドの検証が済んだとは判断しない。

## 判定とレポート

対象の Java 版は `tools/servers.json` の固定版（現在26.3）。各コマンドを独立した関数にして
読み込ませ、関数のパース失敗をログから得る。コマンド本文は実行しない。

| 診断コード | 意味 |
| --- | --- |
| `java-invalid-id` | 固定レジストリの ID を Java が受理しなかった（例: 26.3 での旧 `generic.` 属性名） |
| `java-invalid-value` | コンポーネント、粒子オプション、インライン定義等の値を Java が受理しなかった |
| `java-invalid-command` | その他の読み込み時の拒否。新しいエラー表現も原文を残してここに分類する |
| `java-unresolved-reference` | predicate、loot table、item modifier、タグ等の参照が解決できない。定義の渡し忘れやロード失敗もあり、直ちに元コマンドの不正とは判定しない |
| `java-not-checked` | マクロ・空行・コメント・複数行・未結合の継続行、またはパックを読み込めず未判定 |
| `java-context-error` | パックの未有効化、リソースの読み込みエラー、パックが原因の起動失敗 |

エラーの詳細分類は Java 26.3 の実測メッセージに基づく。原文を保持し、版更新でメッセージが
変わっても未知のエラーを成功扱いしない。エラー行は `results` の `invalid` と
`unresolved-reference` に分ける。未判定は `not-checked` として成功数に含めない。
`complete` は対象行をすべて判定できたかを示し、拒否された行が0であることや、実行時の
成功を表すものではない。拒否の件数は `summary` を見る。

レポートは `schemaVersion: 1`、`mode: function-load`、`contextFunctions: placeholders`。
Java の対象版、パック構成、件数、入力識別子付きの結果・警告を含む。
`sourceContext`（`--world` 指定時）に元の DataVersion・有効/無効 ID・対応する入力パスと
順序を記録する。`limitations` に、元の版の文法・pack_format・定義は移行しないことと、
固定 Java での拒否を元の版での不正と解釈できない旨（#58）を常に記録する。
旧版のマップを26.3へ渡した結果は「26.3で受理できない」という意味であり、元の版でも
不正とは限らない。版ごとの文法・サーバーの選択は #58。

## パックの読み込みと制限

パックのコピーでは `.mcfunction` の本文を空にし、関数 ID と JSON 定義・タグ・オーバーレイを
残す。load/tick 等から処理が走っても入力関数の本文は実行されない。
元パックの関数が全て正しいかを調べるには、その関数の行も検証対象として入力する。
コピーに含まれるシンボリックリンクは拒否する。
ZIP の絶対パス・親ディレクトリへの参照・リンク・重複エントリも拒否する。ZIP は最大 10,000 エントリ、圧縮ファイルと展開後の合計はそれぞれ 256 MiB まで。

判定用パックがロードされなかったのに全行成功とする誤判定を防ぐため、有効パック一覧と、
必ず読み込みに失敗する監視用関数のログを確認する。パックのレジストリ定義が壊れて
サーバーが起動できない場合は、各行の不正を推測せず、コンテキスト失敗と未判定を返す。
ロック競合、ポート、ファイル I/O 等の障害は検証結果に置き換えず呼び出しエラーにする。

読み込み時の判定だけなので、存在する関数を実行できるか、スコア目標やエンティティが
実行時に存在するか、マクロ展開後のコマンド、元パック全体の実行可否までは保証しない。
パックのログで既知の読み込みエラーを拾うが、`contextErrors` が空であることも、
元パック全体の健全性の保証ではない。

## API とレジストリ検証の方針

- `@je2be/bridge`: `checkJavaSyntax(commands, { datapacks })` は既存の判定配列を返す。
  読み込み状況も必要な場合は `inspectJavaSyntax` を使う。パック起因の起動失敗時は
  後者が `checked: false` を返し、前者は例外にする。
- `@je2be/converter`: `readJavaValidationContext(world)` で保存された構成を取得し、
  返された `{ datapacks, packOrder }` を `inspectJavaSyntax` に渡す。レポートの
  `sourceContext` にも同じ構成を渡す。組み込みパックを挟んだ有効順も保つ。
- `@je2be/converter`: `javaValidationSkipReason` で未判定行を除き、`inspectJavaSyntax` の結果を
  `buildJavaValidationReport` に渡す。結果の不足・入力順の取り違え・入力 ID の重複を拒否する。

**判断**: `registries.json` の一覧照合をパーサの合否へ追加しない。現在の文法判定を維持し、
データパックを含む Java の読み込みを追加検証の正解とする。一覧照合だけではデータ駆動の
定義・タグやコンポーネントの型の制約まで判定できず、存在しても使えない値を見逃したり、
パック由来の正しい参照を拒否する可能性があるため。ゲーム内のパーサにサーバー依存を入れない。

検証の根拠は `packages/bridge/src/java-validation.servers.test.ts`。独自 fixture の定義参照、
ID と値の拒否、パックのロード失敗、入力・load関数が実行されないことを実サーバーで確かめる。
ZIP とディレクトリの同等性・オーバーレイ・保存された無効パックの除外は
`packages/bridge/src/validation-context.servers.test.ts` で確かめる。
