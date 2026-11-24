# 承認済みの提案：機能の族と書き換え・ランタイム

#172 の調査。#110 で案 A が 2026-11-23 に承認された。基準は main の `9633e7f`（2026-11-23）。コードの読み取りに基づく集計であり、将来の衝突減少や移行コストは推定。ランタイムの中核を core に置きホストを分離する #95 の構成を前提とし、実行モデル・状態・データの未決事項（#93、#94、#107）を先取りしない。

## 数え方と現状

行数は両端を含む物理行（空行・コメントを含む）。族固有の連続範囲のみ数え、共有部や型宣言は別扱い。複数の族に使う行を重複計上しないため、合計はファイル全体と一致しない。「形」は実行可能な全文法の分岐数ではなく、表に示した登録キーまたは selector 引数キーの数で、同一キー内のオプションや対応 ID の数ではない。パーサが読めることは BE への書き換え対応を意味しない。

| 族 | rewrite.ts 固有範囲・行数 | arguments.ts 固有範囲・行数 | 形（定義） | 主なテスト |
| --- | --- | --- | --- | --- |
| セレクタ | 52–168: 117 | 163–297: 135 | 書き換え 21 キー、解析 21 キー（各 switch の case、x/y 等も個別） | `parser.test.ts` 引数、`rewrite.test.ts` selector、`rewrite.servers.test.ts`、`scenarios/convert/selectors.json` |
| テキスト・メッセージ | 246–281: 36、title 342–346: 5 | JSON 514–551: 38 | コマンド登録 say/tellraw/title の 3、引数登録 component/message/style の 3 | `rewrite.test.ts` text、`parser.test.ts` 引数、実機 rewrite |
| ブロック | 220–244: 25、setblock/fill/clone 359–378: 20 | 352–383: 32 | コマンド 3、引数 block_state/block_predicate 2 | `rewrite.test.ts`、`parser.test.ts`、実機 rewrite、`scenarios/convert/block-predicates.json` |
| アイテム | give 501–513: 13 | 384–455: 72 | コマンド 1、引数 item_stack/item_predicate 2 | `parser.test.ts`、`rewrite.test.ts`、実機 rewrite |
| サウンド | playsound 379–391: 13 | 固有処理なし（resource を共有） | コマンド 1、固有引数登録 0 | 実機 rewrite、`scenarios/convert/sound-particles.json`、`packages/bridge/src/sound-particles.servers.test.ts` |
| パーティクル | particle 392–414: 23 | 登録内 631–636: 6 | コマンド 1、引数登録 1 | 実機 rewrite、上記 sound-particles シナリオ・テスト |
| 効果 | effect 415–432: 18 | 固有処理なし（resource 共有） | コマンド 1、固有引数登録 0 | 実機 rewrite |
| スコア | scoreboard 465–500: 36 | scoreHolder 492–499: 8 | コマンド 1、引数 score_holder 1 | `rewrite.test.ts`、`parser.test.ts`、実機 rewrite |
| その他命令 | teleport 347–358: 12、gamemode/time/weather/difficulty/gamerule 433–464: 32、kill/tag 340–341: 2 | 固有範囲は下記共有部 | コマンド登録 8 | `rewrite.test.ts`、実機 rewrite |
| execute・共通 | 171–217、283–336、515–559 など | 1–162、299–351、456–491、500–513、553–705 など（上記登録内粒子を除く） | execute の switch は as/at/rotated/facing/anchored/align/in/positioned/if/unless の 10 キー | `parser.test.ts` toCommandIR、`rewrite.test.ts`、実機 rewrite |

共通の `rewriteNode` は selector・block・text 等を節ごとに処理し、同じコマンドが複数族に依存する。`arguments.ts` の登録表は共有の resource、座標、NBT 等を含む。音の ID 表は `MappingLookup`、テキスト変換は `rawtext.ts`、効果・エンティティ ID は `bedrock-command-ids.ts` にあり、上表の行数に含めない。現在の `rewrite.ts` は 559 行、`arguments.ts` は 705 行。

再現手順（基準コミットを checkout した作業ツリーで実行）:

```sh
wc -l packages/core/src/command/{rewrite,arguments}.ts
rg -n '^(export )?(function|const|class) |^  [a-z]+:|^    case ' packages/core/src/command/{rewrite,arguments}.ts
rg -n '^describe|^  it\(' packages/core/src/command/{parser,rewrite}.test.ts packages/bridge/src/rewrite.servers.test.ts
 git log --first-parent --oneline -- packages/core/src/command/rewrite.ts packages/core/src/command/arguments.ts
```

表の範囲を `sed -n '開始,終了p'` で確認し、`終了 - 開始 + 1` で行数を求める。キーは各 switch または登録表を目視で数える。範囲は機械的な責務分割ではなく、この基準での調査上の分類。

### 直近 PR の衝突

`git log --first-parent` で基準までに対象ファイルを変更した全5件は #60、#71、#73、#82、#92。各 PR の本文とコミット見出しを `gh pr view <番号> --json body,commits` で確認した範囲では、**対象2ファイルの衝突解消を明記した件数は 0/5**。#71、#73、#92 には main 取り込みがあるが、それ自体は衝突の証拠ではない。PR 本文・コミット見出しだけでは未記録の解消を検出できず、真の衝突件数や族別の件数は不明。衝突が起きなかったと結論しない。今後は解消時に PR・ファイル・族を記録して比較する。

## 候補

| | A: 族ごとのディレクトリ（推奨） | B: 現状の処理を維持し対応表だけ分離 |
| --- | --- | --- |
| 共有解析・判定 | 共通 parser の `ParsedNode` / `CommandIR` を入力とし、族の純粋な適用可能性判定を両経路が呼ぶ。判定結果に理由・警告・必要な文脈を持たせ、BE コマンド生成と runtime 実行は別にする | 同じ契約は導入可能だが判定が大きなファイルに残り、二重実装を避ける規約が必要 |
| 並行作業 | 族内に判定・書き換え・実行・対応表・単体テストを置けば別族の編集は分かれる見込み。登録・共通 parser・複数族の命令は競合し得る | 表の編集は分かれるが、分岐とテストの共通ファイルへの集中は残る |
| 移行 | 大きい。循環依存、公開 API、Editor の範囲重複や処理順を守る必要がある。既存の統合・実機テストを維持 | 小さい。現状の呼び出し順と API を保ちやすい |
| 限界 | 分類を誤ると共通処理が重複する。登録点や統合テストは共有のまま | ディレクトリ分離だけでは共有判定を保証しない |

A の配置例は `core/src/features/<family>/{capability,rewrite,runtime}.ts` と近傍テスト。名前や登録の仕組みは実装時に決める。セレクタ・テキスト・ブロックのような横断引数は独立した族として参照し、execute と命令の合成は共通層に残す。パーサ型とホスト契約は共有し、Minecraft API は core に入れない。入力の IR と、構文不正・ネイティブ可否・警告を混同しない判定型を定義する必要がある。現在の `unsupported` は未実装と BE に表せない場合を含み、そのまま runtime の実行可能性とは見なせない。ネイティブ不可でも runtime 実装がない場合は明示的に未対応とする。

推奨は A を目標とし、承認後に共通の判定契約と 1 族の縦切りで検証し、既存結果・警告・編集順を比較してから段階的に移すこと。B は当面の差分は小さいが #110 の共有判定と独立した追加の目的を規約だけで支える。いずれも同一解析結果の再利用は設計・テストで保証する必要があり、配置変更だけでは保証されない。runtime の実装、ホスト制約、Java と BE の意味の一致は未確認。
