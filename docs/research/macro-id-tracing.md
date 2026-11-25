# マクロの ID 候補調査（途中）

Issue #239 の途中結果。配布マップの内容・名前は公開しない。

## 再現

固定サーバーと対応表を `npm ci && npm run setup:servers && npm run setup:mappings && npm run build:pack` で用意する。非公開コーパスは元の ZIP のまま読み、抽出結果を公開しない一時領域に置く。

```sh
python3 -I scripts/dump_macro_sources.py /path/to/sample-map > /tmp/macro-sources.jsonl
node tools/trace-macro-ids.ts /tmp/macro-sources.jsonl servers/reports-26.3/reports/commands.json
```

JSONL には関数 ID、storage 名、コマンド本文が含まれる。リポジトリ、Issue、PR、CI の成果物に載せない。不要になったら削除する。出力は集計のみ。抽出は ZIP のワールドと独立パックを対象にし、有効パックや優先順位、overlay を解決しない。同一ワールドの同名関数は区別せず、タグ・動的呼び出しは解決しない。現段階では非対応 ZIP を黙って飛ばす場合があり、完全性を保証しない。

## 暫定結果と未完了

2026-11-25 の非公開コーパスで、3,630 行・4,089 穴、試探失敗 15 行。固定版 26.3 の文法で最初に成功する置換だけを採用し、item/block の引数の ID 部分に位置する穴は 2 件。2 件のうち 1 件は storage のルートを渡す呼び出し、1 件はインライン引数の呼び出しを検出した。storage の穴について単純な直接 `set value` と `merge` 内の文字列候補は 0 件。同じ storage には `merge` と他の操作があるが、実行順や操作の影響は未解決。コマンドや関数の到達可能性は調べていない。

これは網羅数でも、実行時の候補が存在しない証明でもない。有限試探では穴が別の構文として解釈され得る。失敗行、同名関数の上書き、別の呼び出し形式、関数タグ、動的 storage 操作、`merge` や複合値の書き込みは未解決。`matchingWrite` はパスが近い書き込みを機械的に拾った件数で、値候補を意味しない。`literalCandidate` は引数フィールドへの直接 `set value` の単純な文字列、`mergeCandidate` は単純なキーのパスをたどれる `data merge` の文字列を候補とするだけで、実行順や動的な上書きを考慮せず候補集合の完全性を保証しない。

完了には、各穴について可能な構文の範囲を明示し、呼び出しの種別と storage の定数・動的な書き込み、複合値を追跡し、未解決の理由を重複なく集計する必要がある。合成データによるテストを拡張して抽出漏れと公開情報の混入を検証し、結果を #107 に報告する。
