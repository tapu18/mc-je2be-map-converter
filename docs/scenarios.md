# 正解データのシナリオ

Java版サーバーで実行した結果を正解として記録し、BE で実行した結果と比べる仕組み（#38、design.md 6章）。機能を実装するときは、先にシナリオを書いて Java の結果を記録し、BE 側がそれに一致するように作る。

## ファイル

| パス | 内容 |
| --- | --- |
| `scenarios/<分類>/<名前>.json` | シナリオ（手で書く） |
| `scenarios/<分類>/<名前>.java.json` | Java で記録した正解データ（自動で書かれる。コミットする） |
| `packages/bridge/src/scenario/` | 実行・正規化・比較の実装 |

## シナリオの形式

```json
{
  "description": "何を確かめるか",
  "setup": ["scoreboard objectives add t dummy"],
  "actions": [
    { "run": "scoreboard players set #a t 7" },
    { "commandBlocks": [{ "pos": [2, -50, 2], "kind": "impulse", "facing": "south", "command": "say hi" }] },
    { "ticks": 5 }
  ],
  "observe": { "scores": ["t"], "blocks": [{ "from": [10, -50, 10], "to": [12, -50, 12] }], "entityTags": ["probe"] },
  "bedrock": { "actions": [] },
  "knownDiffs": { "scores.t.#a": "差分の理由" }
}
```

- `setup` と `actions` は、読み込み範囲（x・z が 0〜63）の中で行う。地面は y=-61（両エディションとも平坦ワールド）。
- `run`：コマンドを1つ実行する。Java では誤り（`Unknown or incomplete command` など）があればシナリオの失敗になる。
- `commandBlocks`：コマンドブロックを置く。`kind` は `impulse` / `chain` / `repeat`、`facing` は Java の向きの名前。`alwaysActive` の既定は true。
- `ticks`：tick を進める。Java は `/tick freeze` の状態から `/tick step` で決定的に進む。BE は実時間で待つ（止められない）。
- `restart: true`：Java を保存・停止して同じワールドを再起動し、再び tick を停止する。起動から停止までには tick が進み得るため、境界時刻の期待値には使わない。BE 未実行（`bedrockPending`）の `actions` 専用。
- `observe`：比べる対象。スコアは目的変数ごと、ブロックは範囲、エンティティは指定のタグのどれかを持つものを「種類 タグ一覧」ごとに数える。
- `bedrock`：BE で実行する内容を変える場合（変換器ができるまでの手書きの対応）。省略すると同じものを実行する。
- `play`：変換を通すシナリオ（#61）。書くと、Java で `setup` と `actions` まで行ったワールドを保存して変換器（`convertWorld`：コマンドブロックのコマンドの書き換え＋Chunker＋エンティティとスコアの初期化パック）に通し、BE はその変換後のワールドから `play` を行う。Java は同じセッションのまま `play` を続ける。BE の操作を変えたいときは `bedrock` ではなく変換器を直す（`bedrock` とは併用できない）。例は `scenarios/convert/`
- `knownDiffs`：調査済みの差分と理由。ここにない差分はテストの失敗になる。差分がなくなったら消す（残っていると失敗になる）。

### データパックと BE 未実行

```json
{
  "description": "load で初期化した storage を関数で更新する",
  "setup": [],
  "datapack": {
    "functions": {
      "example:init": ["data modify storage example:state trace set value []"],
      "example:probe/append": ["data modify storage example:state trace append value 7"]
    },
    "functionTags": {
      "minecraft:load": { "values": ["example:init"] },
      "example:probe": { "values": ["example:probe/append"] }
    }
  },
  "actions": [{ "ticks": 1 }, { "run": "function #example:probe" }],
  "observe": { "storage": ["example:state"] },
  "bedrockPending": "M2 のデータパック実行が未実装"
}
```

- `datapack.functions` は、名前空間付きの関数 ID から .mcfunction の行の配列への対応。先頭の `/` を省き、マクロ行は `$` で始める。
- `datapack.functionTags` は、名前空間付きのタグ ID から Java のタグ JSON への対応。入れ子のタグは `"#example:other"` で参照する。`minecraft:load` と `minecraft:tick` も同じ形式で書く。
- Java は有効な空パックで起動する。tick を止めて `setup` を実行し、関数とタグを書き込んで `reload` を行う。関数が読み込まれてから `actions` へ進む。load・tick 関数を動かすには `ticks` で明示的に進める。
- `observe.storage` では ID ごとに Java の保存 NBT を JSON に変換した値を記録する。リストの並びは保存する。long は文字列になり、そのほかの数値型の区別は省く。
- `bedrockPending` は BE を実行できない理由。Java の記録と照合は通常どおり行い、BE のテストは理由付きでスキップする。`bedrock`、`play`、`knownDiffs` とは併用できない。
- `bedrockRuntime: "actions"` はデータパックの関数を変換済みランタイムで動かして比べる。Java は `setup` とパックの読み込みまでを保存して変換する。`actions` の各 `run` は BE 側だけ、シナリオ専用の名前空間 `je2be_scenario:action/<番号>` の1行の関数にして変換器に通す（BE には Java のコマンドを RCON のように直接ランタイムへ渡す口がないため）。BE ではランタイムの毎 tick の処理の合間（`schedule` の tick 番号が Java の `tick step` と同じになった時点）でその関数を順に呼び、`ticks` はランタイムの tick 番号で待つ。最後にスコアを投影してからスコアとランタイムの storage を観測する。中核が未対応として失敗した操作は止めずに続け、テストの出力に一覧を出す。その影響は差分として現れるので、理由を `knownDiffs` に書く。`run` と `ticks` だけを使える。
- `observe.storage` の差分は、根が複合値なら最上位のキーごとに出す（`storage.m2:calls.executors`）。既知の差分が同じ storage の別のキーの差分を隠さないようにするため。
- `bedrockRuntime: "load-tick"` は起動順序の検証に使う。Java の準備と最後の tick 操作の直前までを保存して変換し、BE の指定 tick でスコア投影と確定済み storage を観測する。実行モードのない `datapack` と `observe.storage` には `bedrockPending` が必要。

## 比較の決まり

- ブロックは Java 形式（`minecraft:oak_stairs[facing=east,half=top]`）にそろえて比べる。BE のブロックの対応表は ID 対応（#14）ができるまで最小限で、対応がないものは「比べられなかった値」として表示する。調査用では失敗にしないが、requiredObservationsで必須にした対象なら失敗にする。
- エンティティのタグは順序を無視する（Java は集合として保存する）。
- `entityDetails: true` を指定すると、`entityTags` に一致した各エンティティの名前とブロック座標も比べる。位置は各座標を切り下げ、セル内の移動を許容する。種類・タグの組ごとに配列で比べるため、同じタグを持つエンティティが増減すると差分になる。
- `entityScores` に目的変数名を列挙すると、Java はエンティティの UUID、BE はエンティティのスコアボード ID から値を取得し、`entityDetails` 内で比較する。配置だけを確かめる `play: []` の例は `convert/placed-entities`。防具立ての小数座標と向きは `placed-entities.servers.test.ts` で別に確認する。

- `entityEffects` は一意に付けたエンティティタグから、観測する Java の効果 ID の配列への対応。Java は `data get entity`、BE は `getEffect` を使う。効果なしは `null` として比較し、対象が見つからなければ失敗する。増幅度と無期限（`-1`）は完全一致を求め、有限の残り時間は BE の観測時刻のずれとして10 tick まで許容する。
- `entityPoses` は一意に付けたエンティティタグの配列。各エンティティの小数の座標と向き（`[ピッチ, ヨー]`、ヨーは -180 以上 180 未満にそろえる）を小数第3位に丸めて比べる。座標と向きは 0.01 まで許容し、ヨーは 360 度の回り込みを考慮する。見つからなければ `null`（存否を比べる）、同じタグが複数あれば失敗する。例は `convert/entity-commands`

## 実行と記録

```sh
npx vitest run --config vitest.servers.config.ts packages/bridge/src/scenario   # 全シナリオを実行
JE2BE_RECORD=1 npm run scenarios:record                                          # 正解データを記録し直す（Java だけ）
```

- 正解データがないシナリオは、手元では実行時に記録される。CI では失敗になるので、記録してからコミットする。
- Java版サーバーのバージョンを上げたら記録し直し、差分を確かめてからコミットする。
- 1シナリオごとに新しいワールドで起動する（1本あたり十数秒）。`bedrockPending` の場合は Java だけを起動する。
- データパックの Java 照合に絞る場合は、上の Vitest コマンドに `-t 'scenario datapack/.*java'` を付ける。

## ギミックとしての評価

パース成功率・静的な出力可否と、ギミックの成立率は別の指標とする。
`docs/evaluation.md` に従い `evaluations/` へ開始条件・操作・成功条件・必須機能・進行上の必須／任意を記録する。
成立の根拠には対応するシナリオ・実行したコミットを残し、手修正・既知差分・比較不能を隠さない。
必須ギミックが未検証ならクリア確認済みとしない。サーバー内検証だけでは実クライアントの通しプレイを確認したことにならない。
集計は `npm run evaluate:gimmicks -- evaluations/scores-chain.observed.json`。

## 製品の出力を確かめるとき

`play` で変換を通すシナリオには `requiredObservations`（正規化後の `scores.t`・`blocks` 等）を必ず書く。
必須項目の不足・比較不能は成功にしない。knownDiffsを許容した成功と完全一致は区別して結果を表示する。
変換後は `worldSettings: "preserve"` で設定を補わず起動する。観測用のtickingareaは使うため、
利用者の読み込み範囲や実クライアントの取り込みまで確認した意味ではない。詳細は `docs/output-validation.md`。

### 旧版 Java の記録と照合

`npm run setup:grammars -- 1.20.6 1.21.4 1.21.11 26.2` で固定サーバーを用意する。
`JE2BE_JAVA_VERSION=1.20.6 JE2BE_RECORD=1 npm run scenarios:record -- -t 'scenario (datapack|scores)/.*java'` のように版を指定すると、`<名前>.java.1.20.6.json` に記録する。`JE2BE_RECORD` を省くとその版の記録と照合する。既定版の記録と BE の比較は従来の `.java.json` を使う。版別実行では Java のテストだけを選ぶ。

`execute-zero-observations.java*.json` は通常のシナリオ形式ではなく、#220 の保存 NBT とコマンド応答の実測記録である。`JE2BE_JAVA_VERSION=1.20.6 JE2BE_RECORD=1 npx vitest run --config vitest.servers.config.ts packages/bridge/src/execute-zero.servers.test.ts` で版別に記録し、`JE2BE_RECORD` を外して照合する。既定版は `JE2BE_JAVA_VERSION` も省く。旧版には上記 `setup:grammars` が必要。
