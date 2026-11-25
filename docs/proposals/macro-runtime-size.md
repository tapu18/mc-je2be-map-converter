# マクロ型紙の実行時資材の見積もり（未承認）

関連: #240、[型紙の提案](macro-template.md)、#100、#107。これは設計決定でも完成実装のサイズでもない。型紙が安全に固定できる行だけを扱い、穴のある引数全体を実行時に読み直すという仮定で、既存実装を代理として数える。穴が区切りを変更する場合、命令名を作る場合や固定できない行には別途フォールバックまたは明示的な拒否が必要で、そのコストは含まない。#238 の固定可能性と #239 の動的 ID の調査を合わせて判断する。

## 型別処理と表

下表は `packages/core/src/command/arguments.ts` の対応を読んだ候補で、完全性・Java との等価性は未確認。各行のコードは同じファイルと補助関数を共有するため、型ごとの独立バイト数は切り出せない。各行とも既存の代理コードは `arguments.ts` 28,807 bytes（UTF-8、型注釈・コメント込み）であり、行ごとに合算しない。共通の `reader.ts` 4,362、`snbt.ts` 8,552、`rawtext.ts` 11,309、書換 `rewrite.ts` 26,102、表参照 `mappings.ts` 7,449 bytes も必要になりうる。これはソースの上限候補であり、依存関係・最小化・バンドル後の大きさではない。型紙の保存・展開・境界検証、版別正規化、実行器は未実装でバイト数未測定。

| 穴が属する引数型 | 実行時の候補処理と必要になりうる表 |
| --- | --- |
| bool、integer、long、float、double、string | 値・範囲・引用の読み取り。固定の範囲条件は型紙に保存 |
| entity、game_profile、score_holder | 名前・セレクタとその条件を解析。動的 entity ID 等の変換が必要なら対応表 |
| block_pos、column_pos、vec2、vec3、rotation、angle | 絶対・相対・ローカル座標を読み取る |
| block_state、block_predicate | ID・状態・NBT の読み取りとブロック状態対応表、既定値 |
| item_stack、item_predicate | ID・コンポーネント等の読み取りとアイテム対応表 |
| nbt_compound_tag、nbt_tag、nbt_path、style、context_*_provider | SNBT・パスの読み取り。版ごとの境界変換が必要 |
| component、message | 版別 JSON/SNBT テキストとセレクタの読み取り・変換 |
| resource_location、resource、resource_key、resource_or_tag、resource_or_tag_key、resource_selector、function、dimension、feature、loot_table、loot_predicate、loot_modifier、dialog、particle | ID・タグまたはインライン値の読み取り。用途により音・パーティクル等の対応表や版別レジストリ |
| objective、team、objective_criteria、operation、int_range、float_range、time、uuid、swizzle | 名前、演算、範囲、単位等の検査 |
| color、entity_anchor、gamemode、heightmap、template_mirror、template_rotation、item_slot、item_slots、slot_source、scoreboard_slot、team_color、swing_animation、hex_color | 固定語彙・スロット・色の検査。コード内の列挙を含む |

実行時の動的値を任意に取れる場合、固定部分に現れた ID だけでは表の必要範囲を確定できない。変換器で確定した定数だけを持つ案と、全候補を持つ案の正しさ・出所は #239 と #107 で検討する。既存の Geyser 由来 `mappings.json` の各値を `JSON.stringify` した UTF-8 バイト数は blocks 10,107,330、items 133,698、sounds 109,935、particles 5,336、source 654、schemaVersion 1。キー・区切り・整形を除くので合計は元ファイル 10,357,025 と一致しない。表の各部分はデータサイズで、索引や実行時ヒープサイズではない。ブロック既定値など追加データ、版別の表、型紙そのものは含まない。全表を必要とするという証明ではない。

### 既存パーサの処理区間別の代理サイズ

型別の規模を比較するため、既存 `arguments.ts` の連続する行を UTF-8 のソースバイト数で区切った。型紙にそのまま使えることを示す値ではなく、注釈・コメント・改行を含む。共通処理や変換処理を含まないため完成コードの上限でも下限でもない。複数型で共有し、相互に呼び出す区間もあるため合算して独立サイズと見なせない。

| 型・処理 | 行（両端を含む） | bytes |
| --- | ---: | ---: |
| resource ID・タグ | 94–116 | 1,098 |
| 整数・浮動小数の範囲 | 117–135 | 873 |
| 座標 | 136–163 | 1,017 |
| entity 等のセレクタ | 164–299 | 4,137 |
| NBT パス | 300–352 | 2,119 |
| block state・predicate | 353–384 | 1,058 |
| item stack・predicate | 385–453 | 2,207 |
| 名前・境界・entity 等の共有補助と固定語彙 | 457–513 | 3,207 |
| component の JSON 読み取り | 515–552 | 1,520 |
| 各型の入口と単純型の処理 | 554–末尾 | 8,162 |

最後の区間には bool、数値、string、message、時間、UUID、固定語彙などの処理と、上の区間への振り分けが混在する。SNBT・基本読み取り・書換は前述の別ファイルにあり、動的 ID 変換の必要量も含まれない。再現例（`a` と `b` は表の行番号）: `node -e 'const s=require("fs").readFileSync("packages/core/src/command/arguments.ts","utf8").split(/(?<=\n)/); const [a,b]=process.argv.slice(1).map(Number); console.log(Buffer.byteLength(s.slice(a-1,b).join("")))' 164 299`。末尾は `wc -l packages/core/src/command/arguments.ts` で確認する。

## 全文法案との比較と測定方法

| 対象 | 観測値 | 限界 |
| --- | --- | --- |
| 既存製品用 `main.js` | 6,168 bytes、起動要求から結果ログまで 1,085 / 1,022 / 1,082 ms | #217、BDS 1.26.63.1。manifest・生成データを除く。マクロなし |
| Java 26.3 `commands.json` | 583,592 bytes | 生成元ファイル、圧縮前 |
| 全文法 PoC | パック合計 12,624,623 bytes、起動要求から初回パース 602 / 783 / 613 ms | [記録](../../poc/runtime-load/README.md)、BDS 1.26.63.1。manifest と JS を含む、対応表を含むが使用検証は一部。上の製品用と入口・測定操作が異なり時間差を負荷の差と解釈できない |
| 型紙案 | 上記の共有ソースと必要な表が代理指標。完成パック・起動時間・メモリは未測定 | 型紙処理、フォールバック、表の範囲が未確定。全文法不要とも、全文法案より小さいとも断定できない |

再現: `npm ci && npm run setup:servers && npm run setup:mappings && npm run build:pack` 後、`wc -c packages/core/src/command/{arguments,reader,snbt,rawtext,rewrite}.ts packages/core/src/mappings/mappings.ts servers/reports-26.3/reports/commands.json servers/mappings/mappings.json`。表の内訳は `node -e 'const x=JSON.parse(require("fs").readFileSync("servers/mappings/mappings.json")); for(const [k,v] of Object.entries(x)) console.log(k,Buffer.byteLength(JSON.stringify(v)))'`。固定版・出典は `tools/servers.json` と生成表の `source` を参照。全文法 PoC と基準のサーバーテストは各 README と `packages/runtime-host/src/bundle.servers.test.ts` を参照。生成された第三者データはコミットしない。

メモリのバイト数は、JSON 文字列・パース済みオブジェクト・`MappingLookup` の複数 Map と型紙・キャッシュが共存しうるため、ファイルサイズから求められない。BDS が使えるヒープ計測手段を確認し、同じ版・ワールド・ホスト・試行回数で基準と両方式のピークおよびロード後を測る必要がある。現状は未測定であり、保存サイズをメモリサイズとして扱わない。全型の動的値、複数穴、元版別の正規化、失敗時の診断と Java 実サーバー比較も未検証。
