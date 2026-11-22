# 第三者データの出力調査と代替案（#142）

2026-11-22。これは #107 の所有者判断のための調査・未承認の提案であり、ライセンスや利用条件の解釈、再配布の可否はすべて**未確認**。ファイルを変換・抽出したことだけで権利上の扱いが変わるとは判断しない。#95 の受け渡しも未決定。

条件の原文は [Minecraft EULA](https://www.minecraft.net/en-us/eula)、[Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines)、[Geyser mappings LICENSE](https://github.com/GeyserMC/mappings/blob/e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7/LICENSE) と [README の権利留保](https://github.com/GeyserMC/mappings/blob/e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7/README.md)、[Chunker LICENSE](https://github.com/HiveGamesOSS/Chunker/blob/50aaf6d82e8b68929279161b790d95fdddfe0a40/LICENSE)。Geyser の MIT は Mojang 等の素材を再許諾しない旨の留保があり、MIT 表示だけでその素材の扱いは決まらない。原文の適用・解釈は所有者が判断する。

## 調査の範囲

`npm ci`, `setup:servers`, `setup:mappings`, `build:pack` 後、`packages/bridge/src/convert-cli.servers.test.ts` で Java 26.3 の新規ワールドにスコアとコマンドブロックを置き、CLI でディレクトリと `.mcworld` を生成して BDS 1.26.63.1 に読み込む。入力はテスト用で配布マップではない。固定資材は `tools/servers.json` と `packages/converter/src/geyser-source.ts`。以下のサイズは bytes、圧縮前、固定版での測定でありワールドや版で変わる。コード読解に基づく出力経路は未確認とし、検査できたファイルの存在・サイズと区別する。内容の一致検索だけでは派生情報の不在は証明できない。

| データ・出所 | 現行の用途と出力 | サイズ・条件の所在 |
| --- | --- | --- |
| Mojang Java サーバーの reports `commands.json` | 文法解析に変換時使用。元ファイルは出力にコピーしない（コード読解、未確認）。解析結果に基づく変換コマンドはワールドに入る | 583,592。上記 EULA・ガイドライン |
| 同 `blocks.json` | 既定ブロック状態の補完に変換時使用。元ファイルはコピーしない（コード読解、未確認）。選択された状態は出力に反映され得る | 7,330,564。同上 |
| Geyser mappings 固定 revision `e9271c00413bc75d0df5b3c4f1d9ca9c9764d4c7` と Mojang の blocks report から作る `mappings.json` | 変換時に ID・状態等を引く。表全体はコピーしない（コード読解、未確認）。選択した変換結果はコマンドやエンティティに反映され得る | 10,357,025。Geyser LICENSE・README と Mojang 条件 |
| Geyser の LICENSE と出典 NOTICE | ワールド直下と `behavior_packs/je2be_init/` に各1組 | LICENSE 1,094、NOTICE 452、各2部。上記 Geyser 原文 |
| 入力ワールドとその作者のデータ | Chunker による地形・状態の変換やスコア等の復元結果が出力に入る。入力ごとに権利者・条件が異なる | サイズは入力依存。各配布元の条件を確認。テスト入力は自作 |
| Chunker 1.21.0 のコード・内蔵変換情報 | 変換時に CLI を実行。JAR 自体は出力にコピーしない（コード読解、未確認）。生成した地形には変換結果が入る | JAR 31,883,497。上記 Chunker LICENSE、素材の権利は別途未確認 |

実生成した `.mcworld` は 37,108 bytes、展開後 12 ファイル計 55,207 bytes。`unzip -l` で `commands.json`・`blocks.json`・`mappings.json` はファイル名として存在せず、初期化パックは manifest 688、`scripts/main.js` 5,353、LICENSE 1,094、NOTICE 452 bytes（計 7,587）。ワールド DB は 44,191 bytes（4 ファイル）、`level.dat` は 1,768 bytes。この一覧は入力依存であり、DB や生成スクリプトの中に表の一部に由来する値がないという証明ではない。アーカイブと入力は公開せず、再現には上記テストで `JE2BE_ACCEPTANCE_ARTIFACTS` を空の一時ディレクトリに指定する。

## M2 の予定と比較

`docs/design.md` 5.2 の案はゲーム内マクロの解析に `commands.json` をパックへ同梱する。現行 CLI の出力ではなく予定である。#141 の [PoC](../../poc/runtime-load/README.md) は文法 583,592 bytes と派生 Geyser 表 10,357,025 bytes を文字列化して含むパックを生成し、圧縮前合計 12,624,623 bytes と測定した。これは実験用で製品の確定仕様ではなく、全対応やマクロ実行を検証していない。文法以外にも対応表とそこに由来するデータの扱いを判断する必要がある。

| 選択肢 | 利点・制約と #95 への影響（推定） |
| --- | --- |
| 原文法・対応表を同梱 | 全文法を使えるが配布物が大きく、権利判断が必要。#95 は文法版と表をパックへ渡す |
| 必要部分を独自形式に変換 | 対象を絞れば小型化の余地があるが、元データの派生物である可能性は残る。#141 の全文法再構成版は合計 12,210,907 bytes。必要範囲の決定・版管理・網羅性検証が必要。#95 は版付き形式の生成と読み込みを契約にする |
| 利用者環境で公式サーバーから生成 | 開発者が元データを同梱せずに済む可能性。生成物をワールドと共に他者へ渡すならその配布の判断は別途必要。JE の版、取得・生成、EULA 同意、オフラインと BE のみの利用者への導入負担がある。#95 は生成資材の入力・欠落時エラー・版を扱う |
| 独立に作成した限定文法・対応 | 元表を直接同梱しない経路の候補だが独立性、仕様情報の由来、網羅性と権利は未確認。#141 の手書き1命令・石1件の例は合計 50,929 bytes で実用品の見積もりではない。#95 は対応範囲・版・非対応の診断を渡す |

推奨は、#95 で通常関数を変換時に版付き IR にし、実行時パーサが必要なマクロだけを限定する #141 の案を基礎に、利用者環境での資材生成と独立文法の実現性を比較検証すること。これだけではマクロを解決せず、生成物を配布する場合の判断も回避できない。元データと変換物の扱い、利用者間でワールドを渡す範囲、対応表の由来について #107 の所有者判断を得てから #95 の契約を確定する。
