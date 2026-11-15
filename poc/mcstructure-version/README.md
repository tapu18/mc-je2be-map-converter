# .mcstructure のバージョン検証（#9）

BDS 1.26.63.1 の `setblock` で3種類のコマンドブロックを新規作成し、`structure save je2be:native_versions 20 -50 0 20 -50 2 false disk true` で保存する。生成器が渡した値を読み戻すだけにならないよう、この保存データを基準にする。

実測値はブロックパレットの `version=18168865`（`0x01153c21`）、コマンドブロックの `Version=55`。`native.mcstructure` はBDSが保存したNBTをそのまま取り出したもの。`results.json` はその値と、生成した構造物で実行したスコアを記録する。製品バージョンから保存形式のバージョンを計算しない。

```sh
npm ci
npm run setup:servers
npm run build:pack
npx vitest run --config vitest.servers.config.ts poc/mcstructure-version/version.servers.test.ts
```

テストはこのworktree専用の新規ワールドを使う。新規作成した3種類を保存した後、既定値で生成した別の構造物を読み込み、インパルス・条件付きチェーン・リピートから新しい `execute` 構文が動くことをスコアで確認する。読み込み後にも保存し、BDSが出力するバージョン値と比較する。両方の検証が通ったときだけ根拠データを更新する。

[`structure save` の `disk`](https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/structure) はワールドのデータベースに保存する。停止後、`leveldb-log.ts` で `structuretemplate_je2be:native_versions` のWALレコードを取り出す。このヘルパーは [LevelDBのログ形式](https://github.com/google/leveldb/blob/main/doc/log_format.md) と [WriteBatchの形式](https://github.com/google/leveldb/blob/main/db/write_batch.cc) に従い、ブロック境界で分割されたレコードを連結する。CRCの検証やSST読み込みは扱わないため、汎用のワールド読み込みには使わない。対象キーがWALになければ失敗する。

このBDSが保存したNBTは `format_version=2`、`compression=0` だった。生成器は引き続き `format_version=1` を出力し、その読み込み・実行が通ることをこのテストで確認する。形式全体の移行はこのIssueの対象外。
