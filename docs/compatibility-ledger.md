# Java → Bedrock 互換性台帳（#105）

[台帳（JSONL）](compatibility.jsonl) · [族別・方式別の集計と未調査の頻度上位](compatibility-summary.md) · [生成元の版・コーパス集計（JSON）](compatibility-sources.json)

## 対象と行の意味

| 族 | Java 側の正本と項目 |
| --- | --- |
| `command` | `commands.json` にある `executable: true` の節と `execute` に redirect する修飾句。根から節までのリテラルと引数名・パーサー型をキーにする |
| `particle` / `sound` / `entity` | `registries.json` の `particle_type` / `sound_event` / `entity_type` |
| `component` / `advancement_trigger` | `data_component_type` / `trigger_type` |
| `loot_function` / `loot_condition` / `loot_entry` | `loot_function_type` / `loot_condition_type` / `loot_pool_entry_type`。条件は predicate とルートテーブルで共有 |
| `effect` / `attribute` / `game_rule` | `mob_effect` / `attribute` / `game_rule` |
| `click` / `hover` | Java サーバー配布 JAR の `ClickEvent.Action` / `HoverEvent.Action` のシリアライズ名。クライアント専用の列挙値も含む |

`datapack.json` から、advancement、predicate、loot table がデータパックに要素を持つことを確認する。
個別のブロック・アイテム・リソースパック形式などを追加するときは、族ごとに正本と集計範囲を決める。
対応する調査は #111（ブロック）と #119（リソースパック）で追跡する。

1行に1項目を置く。安定キーは `(family, id)`。生成順はキー順で、Java 側の出典を `javaSource` に持つ。

- `method` は `native`（ネイティブ）、`rewrite`（書き換え）、`runtime`（ランタイム）、`asset`（素材作成）、`approximation`（近似）、`impossible`（不可能）、`uninvestigated`（未調査）。
- `implementation` は `unknown`（不明）、`planned`（設計上の候補）、`partial`（確認範囲内で出力あり）、`output`（出力対応）、`loss-only`（イベント等を捨てる処理と警告のみ）。初版では機能全体の `output` 判定は付けていない。
- `loss` は確認した欠落や条件付きの制約。詳細が未確認の場合は `null`。`issue` は根拠になった実装または今後の検証を追跡する Issue 番号。未割り当ては `null`。
- `evidence` に確度 `measured`（実測）、`estimated`（推定）、`unconfirmed`（未確認）、出典と確認範囲を持つ。実測は記録された Java・BDS・必要な対応表の版に限定する。
- `frequency` は `lines`（コマンド行）、`definitions`（JSON定義ファイル）、`maps`（その項目を使う上位ZIPの本数）。未計数の欄は `null`、計数対象内で未検出なら `0`。コーパスを渡さなければ `frequency` 全体が `null`。

コマンド形の初期判定は未調査。生成器は引数の代表値で試験入力を作り、同じ実行可能節にパースされ、既存書き換え器が出力したときに方式を付ける。警告があれば近似、出力の文字列が変われば書き換え、他はネイティブ候補。
確度は未確認。値の組み合わせ、連鎖、実行成功の検証は #112 で追跡する。
対応表付きの音・粒子は近似扱い。BDS で成功件数 1 が返ったという実測には架空 ID も含まれるため、各 ID の再生・描画は引き続き未確認。
エンティティの ID はセレクター書き換えに限る。配置・振る舞いは別途確認が要る。
Geyser 対応表の出典と許諾表示は [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) にある。

## 頻度と進捗

#47 と同じ `selectCommandGrammar`・書き換え器、および #15 の読み取り専用スキャンを用いる。
コマンド行は、選択した版の文法から公式キーを作り、現在の台帳に同じキーがある場合に加算する。
`tp` のような redirect は行き先の実行可能節に対応づける。`execute ... run ...` は最後に実行するコマンドの節に加算する。
`run` のない実行可能な条件は末尾の `execute` 節に加算する。中間の修飾句もそれぞれ加算する。同じ修飾句が1行に繰り返されても1回と数える。修飾句の初期判定は未調査で、上書きファイルで判定できる。

- 音・粒子・効果・属性・ゲームルールは該当するコマンド引数、エンティティは `summon` とセレクターの明示 ID を数える。旧ゲームルール名は既存変換器が扱う `keepInventory` のみ対応づける。
- データコンポーネントはアイテム引数とアイテム述語のコンポーネント参照、クリック・ホバーはパース済みのテキスト／スタイル内のアクションを数える。埋め込み NBT、本や看板の保存データ、リソース内のテキストは範囲外。
- 進捗の `trigger`、predicate とルートテーブルの `condition`、ルートテーブルの `function` とエントリーの `type` を定義JSON内で走査する。インライン定義やコマンドから定義への参照解決は範囲外。不正な JSON は入力ファイル数に含む。
- 同じ項目は1行または1定義ファイルにつき1回。族の行・定義ファイル数は各項目の件数を足すため、同じ行・定義が別項目にも入る。族の作品数は重複を除く。公開出力には公式語彙と計数結果を使う。本文・パック名・ファイル名・独自ID・作品ごとの集計は 一時 JSONL に留める。

集計の「対応表・代表入力で出力ありと判定した項目の頻度比」は、族ごとに `partial` または `output` の項目で観測した行数／定義ファイル数を、台帳に対応づいた同じ単位の総数で割る。未調査、素材の候補、`loss-only` は分子から除く。
ID 等の族の「書き換え器の出力行の割合」は、台帳に対応づいた ID 参照の行数を分母とし、その行を既存書き換え器が出力した数を分子とする。版選択やパースに失敗した行、および現在の台帳にない ID は含まない。同じ行が異なる ID を参照すればそれぞれ数える。定義のみの族は対象外。項目判定の比率は対応表や代表入力に基づき、行自体の出力を意味しない。コマンド全体についても、形が対応づいた実際の行の出力数を別に載せる。
どちらも静的な指標。観測外の用途、ゲーム内の実行成功、進行への重要性は別途検証する。

## 再生成と差分

固定サーバー資材に加え、JDK の `javap` を PATH に用意する。`commands.json` とレジストリに載らないテキスト操作の列挙を、データ生成に使った同じサーバー JAR から取得する。

```sh
npm ci
npm run setup:servers
npm run setup:mappings
npm run ledger:compatibility -- --out servers/compatibility
```

コーパスを利用できる環境では #15 と同じ ZIP を読み取り、2つの非公開ファイルを一時ディレクトリに作る。

```sh
npm run setup:grammars
scratch=$(mktemp -d /tmp/je2be-ledger.XXXXXX)
python3 -I scripts/survey_corpus.py /path/to/sample-map \
  --commands "$scratch/commands.jsonl" --definitions "$scratch/definitions.jsonl" \
  > "$scratch/inventory.json"
npm run ledger:compatibility -- --out "$scratch/generated" \
  --commands "$scratch/commands.jsonl" --definitions "$scratch/definitions.jsonl" \
  --previous docs/compatibility.jsonl
```

Java・BE を更新したら、固定バージョンと対応表を更新して資材のセットアップと実サーバーテストを再実行する。
出力の `compatibility-diff.json` は、キーの追加・削除と、方式・実装状況・欠落・担当・根拠の前後を一覧にする。
頻度の変化は `compatibility-summary.md` と行の `frequency`、入力の差は `compatibility-sources.json` で確認する。
確認後に `compatibility.jsonl`、`compatibility-summary.md`、`compatibility-sources.json` を `docs/` へ反映する。

## 人が決めた判定

[上書きファイル](compatibility-verdicts.jsonl) は1行1 JSON、キーは `family` と `id`。各キーは一度だけ書く。`method`、`implementation`、`issue`、`loss` は必要な欄だけ指定でき、省略した欄は機械判定を使う。`null` は明示的な上書き。各行に `evidence`（`confidence` は `measured` / `estimated` / `unconfirmed`、`source` は根拠、`scope` は確認範囲）を必ず記す。実測・推定・未確認の区別は [CLAUDE.md](../CLAUDE.md) に従う。

```json
{"family":"entity","id":"minecraft:example","method":"impossible","issue":106,"evidence":{"confidence":"unconfirmed","source":"Issue #106","scope":"調査対象の例"}}
```

生成器は既定でこのファイルを読み、`--verdicts FILE` で別の入力も指定できる。上書きは集計にも反映する。`compatibility-diff.json` は `--previous` がなくても出力し、`overrides.conflicts` に指定欄ごとの機械判定と上書き値、`overrides.missing` に生成元に存在しないキーの上書き行を残す。根拠の違いも出すため、差分は矛盾の自動判定ではなく確認対象である。消失キーは台帳に追加しない。
