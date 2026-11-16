# 版別のコマンド文法（#58）

Java サーバーの固定版とは別に、代表的なリリースのサーバーから `commands.json` を生成する。
BDS や `tools/servers.json` の版を切り替えるものではない。

## 生成と選択

```sh
npm run setup:servers
npm run setup:grammars
# 一部の版だけ必要な場合
npm run setup:grammars -- 1.20.6 1.21.4
```

取得元と SHA-1 は `tools/java-grammars.json`、現行版は `tools/servers.json` に固定する。
アーカイブは `JE2BE_GRAMMAR_CACHE` または `~/.cache/je2be-grammars` へ保存し、取得後も
キャッシュ利用時も SHA-1 を照合する。実行には `setup:servers` が用意する JRE を使う。
出力は git 管理外の `servers/grammars/<版>/`：

- `server/`: 当該版のサーバーと、実機検証専用のワールド・ログ
- `generated/reports/commands.json`: 当該サーバーのデータ生成器が出す文法
- `grammar.json`: DataVersion・パック形式・テキスト形式・元サーバーの取得元とハッシュ・文法の SHA-256

サーバー配布物中の `version.json` から DataVersion とパック形式を読む。数値を版名から推測しない。
データ生成器の出力とサーバーの作業先は別ディレクトリにする。
ゲーム由来の文法やサーバー本体をリポジトリには含めない。

| 生成・検証するリリース | DataVersion | データパック形式 | テキスト |
| --- | ---: | ---: | --- |
| 1.20.5 | 3837 | 41 | JSON |
| 1.20.6 | 3839 | 41 | JSON |
| 1.21.4 | 4189 | 61 | JSON |
| 1.21.5 | 4325 | 71 | SNBT |
| 1.21.11 | 4671 | 94.1 | SNBT |
| 26.3 | 5023 | 121 | SNBT |

`@je2be/converter` の `loadJavaGrammars()` / `loadGrammarTree()` で生成済みの文法を読み、
`@je2be/core` の `selectCommandGrammar()` に渡す。

1. ワールドの DataVersion があれば、**その版に一致する文法だけ**を選ぶ。
2. DataVersion がない単体パックは `pack_format` で選ぶ。同じ形式に複数の文法があれば、
   文法の SHA-256 とテキスト形式が一致する場合だけ共通の代表を選ぶ。
3. 文法が未生成・版が不明・異なる文法で曖昧な場合は、`unavailable` / `ambiguous` を返す。
   近い版や最新版に黙って置き換えない。

DataVersion とパック形式の両方がある場合はワールドの DataVersion を優先する。
古い形式を宣言したパックを新しいワールドで使うこともあるため、数値が一致しないだけでは拒否しない。
上表以外のリリース、プレリリース、スナップショットの網羅はまだ行っていない。
追加する場合は、公式の取得元・ハッシュ・関数ディレクトリ名を固定して同じ実機比較を行う。

## コーパスでの利用

```sh
python3 -I scripts/dump_commands.py sample-map > /tmp/commands.jsonl
node tools/parse-corpus.ts /tmp/commands.jsonl
node tools/parse-corpus.ts /tmp/commands.jsonl --java
```

`parse-corpus.ts` は行ごとの版で文法を選ぶ。`文法なし` の行は構文エラーとは別に数え、
パース成功率の母数からも分ける。`--java` は、選んだ文法のサーバーへ同じコマンドを渡す。
重複は「版とコマンドの組」で除き、版が違う同一文字列を混同しない。
データパック内の定義はこの集計では読み込まないため、参照不足と値の検証による差は残る。
パックを含む追加検証は `docs/command-validation.md` を参照。

`--commands <commands.json>` は手動指定の調査用として残す。この場合は指定者が版を判断する。
ファイルだけでは実行する Java 版を確定できないため、`--commands` と `--java` は併用しない。
集計以外の失敗コマンド・診断の詳細は公開しない。

## 実測した境目と書き換え候補

根拠は `packages/bridge/src/versioned-grammar.servers.test.ts`。次の形式を各リリースの
`checkJavaSyntax` と、その版の文法を使うパーサで比較する。

| 形式 | 1.20.5 / 1.20.6 / 1.21.4 | 1.21.5 | 1.21.11 / 26.3 |
| --- | --- | --- | --- |
| `tellraw @a {"text":"x"}` | 受理 | 受理 | 受理 |
| `tellraw @a {text:'x'}`・`{text:"x",bold:1b}` | 拒否 | 受理 | 受理 |
| JSON のスラッシュのエスケープを含むテキスト | 受理 | 拒否 | 拒否 |
| `gamerule keepInventory true` | 受理 | 受理 | 拒否 |
| `gamerule keep_inventory true` | 拒否 | 拒否 | 受理 |
| `setworldspawn 0 64 0 ~15` | 受理 | 受理 | 拒否 |
| `setworldspawn 0 64 0 90 0` | 拒否 | 拒否 | 受理 |

テキスト形式の境目は安定リリース1.21.4と1.21.5で確認した。`textFormatFor` は
DataVersion 4325、パック形式71を境にする。スナップショットでの最初の導入版は対象外。
JSON 指定時は JSON の文字列・配列・複合値の終端を読み、JSON 構文を検証してから
既存のテキスト中間表現へ正規化する。JSON 固有のエスケープを SNBT として先に拒否せず、
逆に SNBT 専用表記を JSON として受理することも防ぐ。

書き換えの候補は、旧 gamerule 名、旧 `minecraft:angle`（単一の角度）から新しい回転引数への対応、
JSON / SNBT のテキストから BE rawtext への変換（#62）。ゲームルール名が変わった最初の
リリースや、BE 側の正しい引数はこの比較だけでは確定しない。追加の実測なしに一律置換しない。
旧文法の `minecraft:color` と現行の `minecraft:team_color` は色名と `reset` を読み、
装飾名 `bold` を色として受理しない。
