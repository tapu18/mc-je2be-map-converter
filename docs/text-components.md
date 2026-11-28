# tellraw・title のテキスト成分（#347）

`tellraw`・`title`（`title`・`subtitle`・`actionbar`）のテキストを、成分の種類・書式・`extra` の深さで数え、今の書き換え（`packages/core/src/features/text/`）が BE の rawtext に移せる範囲を BDS で確かめた記録。台帳の該当行（`docs/compatibility.jsonl` の `tellraw …`・`title … {actionbar,subtitle,title} …`）の根拠になる。

- 基準：Java 26.3 / BDS 1.26.66.1、配布マップ 19 本（`sample-map/`、git 管理外）のうちテキストを持つ行がある 17 作品
- 集計値だけを載せる。コマンドの文面・作品名・翻訳キー・ID は載せない（`tools/text-components.ts` は分類名だけを出す）
- 見た目（色・書式が同じに見えるか）は比べていない。層4（#114）の後

## 確度のまとめ

| 主張 | 確度 | 根拠 |
| --- | --- | --- |
| 下の表の行数・作品数 | 実測 | `tools/text-components.ts`（再現手順は下） |
| text・translate（`with`・`fallback` を含む）・score（名前、`*`、`@s`、`@p`、偽プレイヤー、値のない名前、ない目的）・selector と、各書式・`extra` の深さ 2 を書き換えた `tellraw`・`titleraw` は、試験用プレイヤー 1 人に対して BDS の successCount が 1 | 実測 | `packages/bridge/src/text.servers.test.ts`（3 回連続で通過） |
| BDS の successCount は受け取ったプレイヤーの数で、rawtext の中身では変わらない。未知のキー（`keybind`・`nbt`・`color`）、空の `rawtext`、ない目的の score でも 1。`rawtext` のない Java 形式の JSON は 0、対象がいなければ失敗 | 実測 | 同テストの `BEDROCK_PROBES` と対照 |
| そのため、成分が BE で表示されるか（落ちるか）は successCount では区別できない。BE が成分を黙って捨てるかは未確認 | 推定（上の実測から） | 表示の比較は #114 |
| Java 26.3 は `tellraw @a 12`（数だけのテキスト）と `color:"reset"` を拒否する。変換器の文法はどちらも読む | 実測 | 同テストの `uses inputs that Java 26.3 accepts` |

## 成分ごとの扱い

| 成分・書式 | 書き換え | 理由 |
| --- | --- | --- |
| `text`・文字列・数・真偽値 | rawtext の `text` | — |
| `translate`（`with`） | rawtext の `translate`・`with`。警告 | 翻訳キーが BE で同じ文になるとは限らない。引数に書式つきの複数の部分（score・selector を含む）があると unsupported |
| `fallback` | 落とす（警告なし） | BE の rawtext にない。未知の翻訳キーの代わりの文は出ない |
| `score` | rawtext の `score`。名前のセレクタは BE の書き方に変える | BE で書けないセレクタ（`team=` など）は unsupported |
| `selector` | rawtext の `selector` | `separator` は落として警告 |
| `nbt`（storage・entity・block） | unsupported。理由「ランタイムで値を読んで文字にする必要がある（#345 の後）」 | BE の rawtext にない。変換レポートのチェーンの理由にも同じ文を出す（`packages/converter/src/command-chains.ts`） |
| `keybind`・`object` | unsupported | BE の rawtext にない |
| 色の名前・`bold`・`italic`・`underlined`・`strikethrough`・`obfuscated` | `§` の書式コード | 見た目の一致は未確認 |
| 16 進の色 | 16 色のうち近い色の `§` コード。警告 | BE の rawtext に 16 進の色はない |
| `click_event`・`hover_event`（旧 `clickEvent`・`hoverEvent`）・`insertion`・`font`・`shadow_color` | 落として警告 | BE にない。クリック・ホバーの再現は #178・#184 |

集計中に見つけた不具合を直した：型の混ざったリスト（SNBT では文字列の要素が `{"": …}` に包まれる）の先頭が文字列のとき、その文字列を落とし「未知のキー ''」と警告していた。26.3 の文法で読んだ場合、この修正で rawtext が変わる行は 68 行・4 作品（`return run` の先を除く）。`return run tellraw …` の 105 行も、テキストのコマンドとして数えるようにした。

## コーパスの集計

対象：パースでき、テキストを持つ `tellraw`・`title`（`execute … run`・`return run` の先を含む）3265 行・17 作品。版が選べない・版で結果が異なる行 0 行は除いた。
1行に複数の種類・書式があれば、それぞれに1回数える。

### コマンドの形

| 形 | 行数 | 作品数 |
| --- | ---: | ---: |
| `tellraw` | 2778 | 16 |
| `title … actionbar` | 266 | 11 |
| `title … title` | 166 | 15 |
| `title … subtitle` | 55 | 10 |

### 成分の種類

| 種類 | 行数 | 作品数 | rawtext に出せた行 |
| --- | ---: | ---: | ---: |
| `text` | 3257 | 17 | 2912 |
| `translate` | 74 | 3 | 73 |
| `score` | 226 | 12 | 213 |
| `selector` | 146 | 8 | 140 |
| `keybind` | 5 | 1 | 0 |
| `nbt` | 335 | 4 | 0 |

### 書式・付属のキー

| キー | 行数 | 作品数 |
| --- | ---: | ---: |
| `color` | 1469 | 16 |
| `color_hex` | 788 | 6 |
| `bold` | 538 | 12 |
| `italic` | 42 | 5 |
| `underlined` | 13 | 2 |
| `strikethrough` | 11 | 1 |
| `obfuscated` | 17 | 3 |
| `font` | 151 | 1 |
| `click` | 331 | 4 |
| `hover` | 238 | 3 |
| `with` | 2 | 2 |
| `separator` | 1 | 1 |
| `fallback` | 72 | 1 |

### extra の深さ

| 深さ | 行数 | 作品数 |
| --- | ---: | ---: |
| `0` | 1418 | 17 |
| `1` | 1770 | 14 |
| `2` | 77 | 1 |

### nbt 成分の読み先

| 読み先 | 行数 | 作品数 |
| --- | ---: | ---: |
| `storage` | 332 | 4 |
| `block` | 3 | 1 |

### rawtext への書き換えの結果（テキスト単体／行全体）

| 結果 | 行数 | 作品数 |
| --- | ---: | ---: |
| `text output / line rewritten` | 2365 | 17 |
| `text output / line unsupported` | 552 | 10 |
| `text unsupported / line unsupported` | 348 | 4 |

### テキストの書き換えの問題（文面と ID を伏せた分類）

| 分類 | 行数 | 作品数 |
| --- | ---: | ---: |
| `warning: 16進の色 #… を近い書式コードの色に寄せた` | 788 | 6 |
| `unsupported: テキストの nbt 成分（storage・エンティティ・ブロックの値の表示）は BE の rawtext にないため、ランタイムで値を読んで文字にする必要がある（仮想 NBT 層 #345 の後）` | 335 | 4 |
| `warning: BE にない 'clickEvent' を落とした` | 320 | 3 |
| `warning: BE にない 'hoverEvent' を落とした` | 238 | 3 |
| `warning: BE にない 'font' を落とした` | 151 | 1 |
| `warning: 翻訳キー '…' は BE で同じ文になるとは限らない` | 74 | 3 |
| `warning: BE にない 'click_event' を落とした` | 11 | 1 |
| `unsupported: score の対象のセレクタ: …` | 8 | 1 |
| `unsupported: keybind は BE にない` | 5 | 1 |

### テキストは出せたが行全体が unsupported になった理由（テキスト以外）

| 理由 | 行数 | 作品数 |
| --- | ---: | ---: |
| `execute if predicate は BE にない（ランタイムで評価する。未実装）` | 162 | 2 |
| `<ID> は BE にない（代替エンティティは未実装）` | 129 | 5 |
| `return の書き換えは未対応` | 125 | 6 |
| `execute if data は BE にない（ランタイムで評価する。未実装）` | 84 | 2 |
| `predicate= はランタイムで評価する（未実装）` | 45 | 2 |
| `BE にチームはない（team=）` | 15 | 3 |
| `nbt= はランタイムで評価する（未実装）` | 7 | 3 |
| `execute unless predicate は BE にない（ランタイムで評価する。未実装）` | 6 | 1 |
| `execute unless data は BE にない（ランタイムで評価する。未実装）` | 5 | 3 |
| `execute unless dimension は BE にない（ランタイムで評価する。未実装）` | 3 | 1 |
| `execute unless loaded は BE にない（ランタイムで評価する。未実装）` | 2 | 1 |
| `ブロックの NBT の条件（<ID>{...}）はランタイムで評価する（未実装）` | 2 | 1 |
| `execute on は BE コマンドに変換できない` | 1 | 1 |

「行全体が unsupported」は、テキストは rawtext にできても、同じ行の `execute if predicate` や Java 専用のエンティティの種類など、テキスト以外の理由でコマンド 1 個にできないもの。

## 再現手順

コーパスを利用できる環境で、#15 と同じ ZIP を読み取り、非公開の入力を一時ディレクトリに作る（[互換性台帳](compatibility-ledger.md#再生成と差分)と同じ入力）。

```sh
npm run setup:servers
npm run setup:mappings
npm run setup:grammars
scratch=$(mktemp -d /tmp/je2be-text.XXXXXX)
python3 -I scripts/survey_corpus.py /path/to/sample-map \
  --commands "$scratch/commands.jsonl" --definitions "$scratch/definitions.jsonl" > "$scratch/inventory.json"
node tools/text-components.ts --commands "$scratch/commands.jsonl"
```

BDS での確認は `npx vitest run --config vitest.servers.config.ts packages/bridge/src/text.servers.test.ts`（`npm run build:pack` の後）。
