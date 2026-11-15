# PoC の書き方

実機での検証（PoC）は `poc/<名前>/` に置く。仕様を確かめたら、結果をテストの期待値として固定し、`docs/findings.md` に根拠付きで記録する（CLAUDE.md「主張の確度」）。コマンドの意味の比較（Java と BE で同じコマンドの結果が同じか）は、PoC ではなく正解データのシナリオ（`docs/scenarios.md`）で書く。

## 構成

| パス | 内容 |
| --- | --- |
| `poc/<名前>/<名前>.servers.test.ts` | 実験とその期待値。CI では自動で `misc` グループに入る（`tools/server-test-groups.ts`） |
| `poc/<名前>/pack/` | BE のビヘイビアーパック（スクリプトを使うとき）。`manifest.json` の UUID は新しく作る |
| `poc/<名前>/src/main.ts` | パックのスクリプト。`tsconfig.json` を置き、ルートの `package.json` の `build:pack` に足す |
| `poc/<名前>/datapack/` | Java のデータパック（使うとき） |
| `poc/<名前>/results*.json` | 実測結果。根拠としてコミットする |

## 共通の小道具（`@je2be/bridge`）

| 関数 | 用途 |
| --- | --- |
| `BedrockServer.start({ behaviorPacks, world })` / `JavaServer.start({ datapacks, world })` | 新しいワールドで起動する。`restart()` で同じワールドのまま再起動 |
| `bds.exec(cmd)` / `bds.request(op, args)` | BE のコマンド実行、状態の取り出し（`scores`、`blocks`、`entities`、`ping`） |
| `java.exec(cmd)` / `java.dump({ blocks, scores, storage, entities })` | Java のコマンド実行、保存データからの状態の取り出し |
| `jsonLines(log, "POC", from?)` | パックが `console.log("POC " + JSON.stringify(x))` で出した行を集める |
| `waitForLog(log, pred, timeoutMs?, from?)` | 合図の行（例：`POC_DONE`）が出るまで待つ |
| `tickOrders(marks, filter?)` / `relativeOrder(summary, a, b)` | `{tick, source}` の記録を tick ごとの並びにまとめる（最初と最後の tick は除く） |
| `writeStructure(packDir, name, bytes)` / `createDataPack({ name: bytes })` | `.mcstructure` をパックに書く。`structure load je2be:<name>` で読み込む |
| `waitBedrockTicks(bds, n)` | BE で n tick 待つ |
| `buildMcstructure` / `commandBlock`（`@je2be/core`） | コマンドブロックなどを含む構造物を作る |

## 実験の決まり

- 結論を区別できる配置にする。比べたい要因だけを変え、ほかの要因（置いた順と座標順、エンティティの有無など）が結果に混ざらないようにする（#18、#6 の教訓）。
- 対照を置く。たとえばカスタムコマンドの成否を見るなら、BE のコマンドが成功・失敗する場合も並べる。
- 新しい実機テストは3回流してから PR を出す。実行ごとに揺れる性質は期待値にしない。
- 推定にとどまる結論は「推定」と書き、前提を添える。
