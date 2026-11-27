# 確定世代の耐久性（#200）

ランタイムがスコア・storage・schedule を動的プロパティへ毎 tick 確定したとき、BDS の強制終了（SIGKILL）、`save hold`、大容量の書き込みの後にどの世代が残るかを測る。

```sh
npm run build:pack
node poc/state-durability/measure.ts   # 数分。results.json を書き換える
```

- `#restored` は復元された世代のランタイム tick（`load` で `#tick` を写す）。`#loads` はその世代までの `load` の回数に、今回の `load` を足した値
- `killWithoutSave`：同じワールドで、待ち時間を変えて強制終了と起動を繰り返す
- `saveHoldThenKill`：`save hold`・`save query`・`save resume` の直後に強制終了する。`restartedFirst` は事前に一度正常に再起動したワールド
- `volume`：32,767 バイトの値を 4,000 件（約 131MB）書き、正常に再起動して読み直す

CI で毎回確かめる性質は `packages/runtime-host/src/restart.servers.test.ts` にある。この測定は揺れる性質（どの世代が残るか）を記録するためのもので、CI では流さない。
