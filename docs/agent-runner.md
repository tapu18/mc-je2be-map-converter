# AI 管理プログラム

`npm run agents` で GitHub Issue を巡回し、Codex または Claude Code を1件ずつ起動する。既存の `docs/workflow.md` を使い、管理プログラムが着手権・実行上限・CI・マージを管理する。

## 起動

Linux / macOS / WSL、Node 24 以上、git、GitHub CLI (`gh`)、利用する AI の CLI が必要。`gh auth status` と `codex login status` または `claude auth status` で認証を確認する。GitHub の Issue 編集・PR 作成・push・マージができるアカウントを使う。`origin` はこのリポジトリを指すこと。

リポジトリのルートで実行する。

```sh
cp agent-runner.example.json agent-runner.json
# agent-runner.json を編集（対象マイルストーン等）
npm run agents -- --dry-run
npm run agents
```

`--dry-run` は候補の読み取りのみ。Issue・PR・作業ディレクトリ・状態ファイルを作成せず、AI も起動しない。`--once` は1回だけ巡回する。最初の巡回は claim の記録で終わり、次の巡回で着手権を再確認してから AI を起動する。

```sh
npm run agents -- --once
npm run agents -- --config /path/to/config.json
```

Ctrl+C / SIGTERM で停止する。実行中の CLI とその子プロセスを止め、ロックを解除する。再起動すると、同じブランチ・worktree と GitHub の最新状態から再開する。AI の会話セッションには依存せず、毎回 Issue・変更・履歴・既存 PR を読み直させる。

## 設定

`agent-runner.json` は git 管理外。設定は起動時に読み、変更後は再起動する。未知のキーはエラーにする。

| キー | 既定値・意味 |
| --- | --- |
| `repo` | 必須。`owner/repository`。この checkout で `gh repo view` が選ぶリポジトリと一致する必要がある |
| `agent` | `codex` または `claude`。既定 `codex` |
| `base` | `main`。worktree の起点と自動マージの対象 base |
| `milestone` | 省略時は全マイルストーン。指定時はその名前の ready Issue のみ新規着手する |
| `pollSeconds` | `60`。巡回終了から次の巡回までの秒数 |
| `timeoutSeconds` | `3600`。1回の AI 実行の上限秒数 |
| `maxAttempts` | `3`。Issue ごとの AI 起動回数上限。CI 修正も数える |
| `maxRunsPerDay` | `12`。UTC の1日あたり AI 起動回数上限。日付が変われば再開 |
| `autoMerge` | `true`。`false` なら PR 作成・修正まで進め、マージは手動 |
| `agentArgs` | `[]`。AI CLI に渡す追加引数の配列。シェルは介さない |

Codex は通常 `codex exec --sandbox workspace-write --json`、Claude は `claude -p --output-format stream-json --verbose` を使い、作業指示は標準入力で渡す。Codex に `--approve-for-me` を指定したときは、このフラグ自身が workspace-write を設定するため、競合する `--sandbox` は追加しない。CLI のバージョン・アカウントの制限・管理者ポリシーは別途適用される。

無人実行には、使用する CLI の権限設定で git・gh・必要なダウンロード・テストが許可されている必要がある。管理プログラムは sandbox や承認を無効化しない。Codex が対応している環境では `agentArgs: ["--approve-for-me"]` で自動承認レビューを使える（この環境の CLI で確認済み）。Claude では、必要なツールを明示する例として `agentArgs: ["--allowedTools", "Read,Edit,Write,Bash"]` が使える。Bash の許可範囲を絞る場合は、実際に必要なコマンドに合わせて CLI 側で設定する。worktree や共通の Git 管理領域への書き込み・ネットワークが拒否される場合も、CLI のログを確認して設定する。

設定サンプルでは Codex の `--approve-for-me` を指定している。Claude に切り替えるときは `agent` と併せて `agentArgs` も Claude 用に変更する。このフラグに非対応の古い Codex は更新するか、対応する権限設定に置き換える。

起動回数と実行時間の上限は、課金額・トークン数の厳密な上限ではない。必要ならプロバイダー側でも利用上限を設定する。

## 巡回の動き

1. 以前着手した Issue の最新状態と PR を照合する。
2. マージ条件が揃えば通常のマージコミットでマージする。最新 head SHA を指定し、確認後の push を検出する。
3. PR の CI が失敗・マージ競合・変更要求なら、同じ worktree で AI を再起動する。draft の PR も実装未完了として再実行する。CI 未登録・実行中・マージ待ちの PR は保留して次の仕事を探す。
4. 着手可能な `status:ready` を番号順に選ぶ。他の status、`needs-approval`、有効な claim、未完了の明示的依存があれば選ばない。
5. 一意の `claim:` コメントを記録し、次の巡回で先着を確認する。その後 `status:in-progress` にし、専用ブランチと worktree を用意して AI を起動する。

依存は同じリポジトリの Issue 番号で、本文に次のどちらかの形で記載する。背景やメモ内の通常の参照は依存として扱わない。明示的依存以外の条件も、人が確認してから `status:ready` にする。

```markdown
Depends on: #12, #15
```

```markdown
### 依存
- #12
- #15
```

AI は必要な依存取得・実装・検証・push・PR 作成を行う。完了条件の確認前は draft、確認できたら ready にする。管理側は完了条件の意味そのものを検証できないため、この ready 化を AI による完了確認として扱う。

自動マージは、Issue が開いていて保留でなく、PR が ready、指定 base 宛て、Issue の closing reference があり、GitHub のマージ状態が `CLEAN` で、変更要求がない場合に限る。現在の CI の `check (型チェックとNodeのテスト)` と5つの `servers / ...` がすべて成功し、それ以外のチェックにも未完了・失敗がないことを要求する。チェックが未登録ならマージしない。CI のジョブ名を変えるときは `tools/agent-runner/policy.ts` の一覧も更新する。

`needs-approval` は Issue・PR のどちらにあっても保留する。承認コメントの自然言語判定は行わない。人が承認コメントを書き、該当する Issue / PR の `needs-approval` を外して再開させる。`status:blocked` / `status:paused` も再開時に解除する。積み上げた PR は base が違う間は自動マージしない。最初の版では積み上げの base 変更・ブランチ削除は自動化しない。

上限到達や PR の未マージクローズは `status:blocked` にして、再開情報を Issue に記録する。原因を直して `status:ready` に戻すと、同じ worktree で実行回数をリセットして再開する。Issue のクローズは完了として扱う。管理対象外の既存作業を勝手に引き継がず、状態ファイルにある Issue だけを再開する。

## 状態・ログ・排他制御

端末には時刻と Issue 番号付きで AI の進捗メッセージ、実行コマンドと完了・失敗、ファイル変更を表示する。コマンドの長い出力や生の JSON、推論内容は表示しない。AI 実行中は60秒ごとに経過時間・最後のログ更新からの秒数・直近の動作も表示する。ログ更新が途絶えた場合も、ハートビート自体は AI が進んでいる保証ではなく、管理側が実行終了を待っていることを示す。

巡回時は承認待ち・CI の成功数・日次上限・次の巡回までの待ち時間も表示する。生の詳細ログは従来どおり保存する。この表示変更は管理プログラムの次回起動から反映され、すでに実行中のプロセスには影響しない。

共通 Git ディレクトリの `agent-runner/` に保存する。通常は `.git/agent-runner/`。別 worktree から起動しても共通のロックを使う。

- `state.json`：担当 Issue、claim、ブランチ、worktree、試行回数、日次実行数。更新は一時ファイルから rename する。
- `<Issue番号>-<時刻>.log`：AI の標準出力・標準エラー。実装の進捗や CLI の権限エラーを確認できる。
- `worktrees/<Issue番号>/`：作業用 checkout。再開・調査用に完了後も保持する。不要になったら `git worktree remove <パス>` で削除する。強制削除はしない。
- `lock`：管理プロセスの PID と起動時刻。多重起動時はエラーにする。

SIGKILL・OS 障害ではロックが残る。`lock` の PID と AI・実サーバーの残存プロセスを確認し、必要なら停止してからロックを手動で削除する。PID だけで安全性を断定できないため、自動でロックを奪わない。状態ファイルは削除せず再利用する。

他のエージェントは既存の claim 手順を守る。管理側が競争に負けたときは `claim-cancelled: <管理側のエージェント名>` を記録して手を引く。手動の claim を取り消す場合も、この形式を使う。GitHub コメントによる先着確認は分散ロックそのものではないため、複数マシンから管理プログラムを同時稼働させない。

GitHub の通信障害では担当と回数を保持して次の巡回で再試行する。日次上限に達していても CI の巡回・マージは続く。CLI の引数エラー（終了コード2）・実行ファイル未検出・実行権限不足では、その回の起動回数を戻して管理プログラムを異常終了させる。設定やインストールを直してから再起動する。それ以外の認証不備や作業中の失敗は起動回数を消費する。エラー時はログ末尾も端末に表示する。

## 常駐

まず端末で動作を確かめる。自動起動させる場合の systemd ユーザーサービス例（`WorkingDirectory`、Node の絶対パス、`PATH` は実環境に合わせる）。リポジトリ内のプログラムを直接起動し、シェルの起動設定には依存しない。

```ini
[Unit]
Description=JE2BE AI issue runner

[Service]
Type=simple
WorkingDirectory=/home/tapukoko/code/mc-je2be-map-converter
Environment=PATH=/home/tapukoko/.local/bin:/home/tapukoko/.nvm/versions/node/v24.13.1/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/tapukoko/.nvm/versions/node/v24.13.1/bin/node tools/agent-runner.ts --config agent-runner.json
Restart=on-failure
RestartSec=30
KillMode=control-group
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/je2be-agents.service` に配置後、`systemctl --user daemon-reload` と `systemctl --user enable --now je2be-agents` で起動する。停止は `systemctl --user stop je2be-agents`。ログは `journalctl --user -u je2be-agents -f`。ログアウト中の常駐には、ユーザーサービスを継続できるホスト設定が別途必要。
