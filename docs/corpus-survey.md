# コーパス追加調査（#15）

2026-11-20、ローカルの19 ZIPを読み取り走査した。18ワールドと単体データパック1本、
配置済みコマンドブロック3,550個（非空3,541）、関数10,280個（非空10,155）、関数の実行行111,946行。
結果全体は [匿名集計JSON](corpus-survey.json)。作品名、関数名、コマンド本文、独自ID、座標、値は公開しない。
これは保存内容の静的な計数であり、実行頻度・使用中のパック・進行への重要性・ゲーム内での成功を測ったものではない。

## 再実行

```sh
npm ci
npm run setup:servers
npm run setup:mappings
npm run setup:grammars
npm run build:pack
# scratch はリポジトリ外の新しいディレクトリ。commands.jsonl は公開しない。
scratch=$(mktemp -d /tmp/je2be-survey.XXXXXX)
python3 -I scripts/survey_corpus.py /path/to/sample-map --commands "$scratch/commands.jsonl" > "$scratch/inventory.json"
node tools/survey-corpus.ts "$scratch/commands.jsonl" > "$scratch/analysis.json"
npm run check
npm run test:servers -- packages/bridge/src/rewrite.servers.test.ts packages/bridge/src/extract.servers.test.ts
```

抽出はZIPを展開せず、ワールド・データパック・リソースパックの入れ子ZIPとフォルダーを読む。
関数の空行・コメントは除き、継続行を結合する。重複ファイル・生成関数・無効なパック・旧形式と新形式の併存は除去しない。
`.mcfunction` と資源の存在を数えており、pack.mcmetaの対応範囲やオーバーレイの有効性は評価しない。
外部チャンクや未対応圧縮、ZIP/NBT読み取りエラーでは集計を中止する。今回その中止はなかった。
JSONとして不正な6ファイルは存在数に含め、内部の機能集計から除外した。

コマンドの版選択は `selectCommandGrammar`、行の出力可否は `staticCommandCoverage` を使う。
ID対応・既定状態は固定JE 26.3の資材。BEの実行結果との意味の一致はこの調査では検証していない。
版の文法を選べない18,924行（CB 265、関数18,659）、マクロ3,630行、構文不受理58行（CB 52、関数6）は
NBT/コマンド機能集計に含めない。版選択不能には対象外の1.20.4がある（#50、[既存の静的対応率](static-coverage.md)）。
頻度表はこの範囲の計数であり、コーパス全体の未知分を0とした結果ではない。

## NBTパス

パース済みの `data` コマンドは59,978行、構造化された `nbt=` セレクタ引数は317箇所。
`data` の明示パスは引数の出現ごとに数える（`from` の読取元も含む）。`data merge` と
`data modify ... merge value` の複合値は、マージに渡した末端キーを別集計する。
`nbt=` は照合する末端キーを、1引数内で重複を除いて数える（合計390）。否定も含む。
値・リスト添字を伏せ、リストを `[]`、照合フィルターを `{…}` に正規化する。
公開用の固定語彙にないキーは `<custom>`、storageのキーは全て `<custom>` に置換する。
したがって独自パス同士の同一性やフィルター内部のキーの頻度は復元できない。
`execute if data` / `store` 単独やテキスト中のNBT参照は、この `data` パス表の対象外。

| 区分 | パス・末端キー | 回数 |
| --- | --- | ---: |
| data entity | `{…}`（ルート照合パス） | 55,366 |
| data entity | `Pos[]` | 109 |
| data entity | `text` | 93 |
| data entity | `item.components.minecraft:custom_model_data` | 68 |
| data entity | `Motion[]` | 67 |
| data entity | `Rotation[]` | 54 |
| data entity | `UUID` | 46 |
| data entity | `interpolation_duration` | 42 |
| data entity | `Owner` | 37 |
| data block | `Items` | 37 |
| data block | `LootTable` | 5 |
| data block | `front_text.messages` | 5 |
| マージの末端キー entity | `start_interpolation` | 55,830 |
| マージの末端キー entity | `transformation[]` | 55,366 |
| マージの末端キー entity | `transformation.scale[]` | 540 |
| マージの末端キー entity | `transformation.left_rotation[]` / `right_rotation[]` / `translation[]` | 各482 |
| nbt= | `Item.components.minecraft:custom_data.Tags[]` | 66 |
| nbt= | `Item.id` | 47 |
| nbt= | `Inventory[].id` | 32 |
| nbt= | `Item.count` | 25 |
| nbt= | `OnGround` | 19 |
| nbt= | `active_effects[].id` | 19 |
| nbt= | `Inventory[].Slot` | 12 |

storageの明示パスは3,506箇所。形ごとの内訳、伏せたキーを含む全頻度はJSONに掲載した。
生成された変換行が多く、行数をそのまま作品数・実行時負荷に読み替えることはできない。
この調査で仮想NBT層の対応範囲や優先順位は変更しない。

## 関数全体の出力可否

非空関数10,155個中、全行が `unchanged` / `rewritten` となったものは **318個（3.13%）**。
空関数125個は分母から除外した。未対応・マクロ・不受理・文法不明が1行でもあれば該当しない。
関数呼出しは現行の書き換え器では未対応なので、呼出し先が単純でも該当しない。
呼出しグラフの展開・再帰・関数タグ・条件分岐・マクロ展開・到達可能性は評価していない。

これは現行実装で全行をBEコマンドに出力できる割合であり、BEだけで同じ動作が保証された関数の割合ではない。
設計5.4の「関数はランタイム」の方針も変えない。意味の差や警告を含めた確認は各シナリオで行う。

| 関数の実行行の判定 | 行数 |
| --- | ---: |
| 無変更で出力 | 4,393 |
| 書き換えて出力 | 7,357 |
| 未対応 | 77,901 |
| マクロ | 3,630 |
| 文法を選べない | 18,659 |
| 構文不受理 | 6 |

## コンパレーターとコマンドブロックの書き換え

全ディメンションの保存済みチャンクのパレットとブロック座標から計数し、チャンク境界も照合した。JEのfacingは入力側を指す（下記の実サーバーテストで確認）。

| 配置の計数 | 個数 |
| --- | ---: |
| コンパレーター全数 | 19 |
| 6面のいずれかでCBに隣接するコンパレーター（重複除去） | 16 |
| コンパレーターとCBの隣接ペア | 22 |
| 背面入力位置にCBがあるコンパレーター | 15 |

上下隣接や側面隣接も16個の内数。15個は向きも照合した数だが、信号が実際に変化した実測ではない。

| 書き換えに関係する静的な行数 | 行数 |
| --- | ---: |
| CBのNBT固有キー（Command / auto / SuccessCount / TrackOutput / LastOutput）を明示更新するdata行 | 0 |
| CBを置くsetblock行（全て関数内） | 56 |
| dataによるblock更新行（全て実行時の位置/ディメンションが未判定） | 135 |
| CB内の直接setblock / fill / cloneの書込範囲が保存済みCBと重なる行 | 6 |
| 上記のうち、そのコマンドを書いたCB自身と重なる行 | 1 |

最後の2行は書込先の範囲の重なりであり、実際に変更された個数ではない。`keep` / `replace` / `masked` 等の
実行時条件は評価していない。cloneは書込先だけを数え、moveによる移動元の消去は含めない。
直接コマンドの整数絶対座標と `~` の整数相対座標だけを解決し、executeの先、関数の呼出し元、ローカル座標、
マクロ座標、ゲーム中に生成されるCBは未判定とする。0行は固有キーの明示更新がなかったという意味で、
動的にCBを書き換える処理が存在しないという断定ではない。`data modify ... set from` の転送内容も未判定。

## リソースパック、進捗、predicate、ルートテーブル

リソースはファイルの存在とJSON中の定義の数。実際の描画や読込の検証はしていない。

| 機能 | 件数 |
| --- | ---: |
| モデルファイル | 890 |
| 旧モデルのcustom_model_data override | 371 |
| 新itemモデル定義ファイル | 298 |
| 新itemモデルのcustom_model_data property参照 | 56 |
| フォントJSON | 76 |
| フォントprovider（bitmap / space / ttf） | 553 / 69 / 60 |
| シェーダーファイル | 3 |
| テクスチャファイル | 1,174 |
| sounds配下のファイル / sounds.json | 25 / 4 |

| データパック機能 | 定義・参照の数 |
| --- | ---: |
| advancement JSON / 関数報酬 | 616 / 470 |
| trigger: tick / impossible / inventory_changed | 125 / 93 / 93 |
| trigger: using_item / player_killed_entity / entity_hurt_player / consume_item | 40 / 38 / 35 / 24 |
| predicate JSON | 195 |
| predicate条件: entity_properties / location_check / any_of / random_chance / inverted / all_of | 246 / 67 / 24 / 20 / 20 / 10 |
| loot_table JSON / pools | 514 / 627 |
| loot entry type: item / loot_table / empty / alternatives | 1,915 / 138 / 57 / 8 |
| loot条件: match_tool / random_chance | 15 / 6 |
| パース済みコマンド: advancement / loot / predicate リテラル | 300 / 404 / 284 |
| セレクタ: advancements= / predicate= | 79 / 461 |

trigger・条件・entryはJSON全体の入れ子を走査するため、1ファイルに複数を数える。
公開語彙以外の種類は `<other>` にまとめ、JSONに掲載した。関数報酬はIDを伏せて存在だけを数える。
参照はコマンドのリテラル/セレクタ引数の出現数であり、参照先の解決や実際の発火は検証していない。
これらの変換対応は今回追加していない。

## 検証の根拠

`tools/survey-corpus.test.ts` と `scripts/test_survey_corpus.py` は独自キー・値の匿名化、
storageの伏せ字、関数の全行判定、入れ子ZIPの関数/進捗/predicate/loot、継続行、空関数、不正JSON、
動的な書換先を未判定に残すことを合成データで検証する。`npm run check` に含まれる。
Java/BDSの既存 `rewrite.servers.test.ts` / `extract.servers.test.ts` も実行した。
`corpus-survey.servers.test.ts` は実JEで比較器の入力側がfacing側であることを、逆向きとの出力差（15 / 0）で検証する。
入力源を比較器の設置後に置き、隣接更新で評価を起動する。3回連続成功した。
私有マップはCIには投入しないため、CIは集計の合成テストと既存の実機回帰テストを実行する。
