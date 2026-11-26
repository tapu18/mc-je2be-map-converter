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
| `maxAttempts` | `3`。Issue ごとの進捗のない AI 起動回数の上限。CI 修正も数える |
| `maxTotalAttempts` | `10`。進捗の有無を問わない Issue ごとの AI 起動回数上限 |
| `maxRunsPerDay` | `12`。UTC の1日あたり AI 起動回数上限。日付が変われば再開 |
| `limitWaitSeconds` | `3600`。CLI が使用量の上限で失敗し、再開時刻を読み取れないときに待つ秒数。下記参照 |
| `autoMerge` | `true`。`false` なら PR 作成・修正まで進め、マージは手動 |
| `agentArgs` | `[]`。AI CLI に渡す追加引数の配列。シェルは介さない |
| `workerOverrides` | Issue のラベルごとの worker 設定。省略時は上書きなし。下記参照 |
| `manager` | PM 巡回の設定。省略すると無効。下記参照 |

## worker のモデルと CLI の使い分け

`workerOverrides` にラベルをキーとして `agent` と `agentArgs` を指定できる。省略した項目はトップレベルから継承し、引数配列は置換する（継承する引数も書き直す）。複数の設定ラベルが同じ Issue に付いている場合は起動せずエラーにする。設定は各起動時の Issue の最新ラベルで選び、PM には適用しない。具体的なモデルと費用上限は所有者が `agent-runner.json` に設定する。

使い分けのラベルは次の2つ。PM が Issue を `status:ready` にするときに付ける（基準は [roles.md の PM](roles.md#pm)）。ラベルがなければトップレベルの設定で起動する。

| ラベル | 付ける Issue | 設定の例 |
| --- | --- | --- |
| （なし） | 通常の実装・調査 | トップレベルの `agent` / `agentArgs` |
| `model:light` | 文書の修正、ラベルや設定の小さな変更、手順の決まった版の更新など、判断の少ないもの | 同じ CLI の軽いモデル |
| `model:strong` | 設計をまたぐ実装、原因のわからない不具合、前回の起動で終わらなかったもの | 強いモデル、または別の CLI（Claude など） |

```json
{
  "agent": "codex",
  "agentArgs": ["--approve-for-me", "-m", "通常のモデル"],
  "workerOverrides": {
    "model:light": { "agentArgs": ["--approve-for-me", "-m", "軽いモデル"] },
    "model:strong": { "agent": "claude", "agentArgs": ["--model", "強いモデル", "--permission-mode", "auto"] }
  }
}
```

Claude を worker や PM にするときは、`agentArgs` に `--permission-mode`（例 `auto`）か `--allowedTools` を入れる。非対話の `claude -p` はツールの承認を求められないため、ないと起動前にエラーにする。codex の `-m` と Claude の `--model` の値は起動前に検査する。

設定を変更したら管理プログラムを再起動する。起動時の CLI と実際の引数を状態ファイルと各起動ログに記録するため、引数に秘密情報を入れない。

### 使用量の上限

CLI が使用量の上限（codex の `You’ve hit your usage limit`、Claude の `result` のエラーなど）で失敗した場合、管理プログラムは終了しない。その起動は回数に数えず（起動記録は `counted: false`、`limited: true`）、状態ファイルの `limits` にその CLI の再開時刻を記録する。再開時刻はメッセージ（`try again at 2:21 PM`、`resets 3pm`、`|<epoch秒>`）から読み、読めなければ `limitWaitSeconds` 後とする。時刻はこのマシンの時刻帯で読む。

再開時刻までは、その CLI を使う Issue の起動と新しい claim を見送り、別の CLI を使う Issue は進める。PM の CLI が上限に達した場合は、PM の巡回の記録を戻し、再開後に PM を起動する。上限は CLI（アカウント）ごとに扱い、モデルごとには分けない。上限に達したときに別の CLI へ自動で切り替えることはしない。

```sh
npm run agents -- --report
```

読み取り専用の JSON Lines を Issue ごとに出力する。`launches` は記録された起動数、`runs` は各起動の agent・実際の CLI 引数（モデル指定を含む）・開始終了時刻・所要ミリ秒・上限に数えたか・使用量の上限で失敗したか（`limited`）、`merged` は現在 GitHub 上でそのブランチの PR がマージ済みかを示す。起動エラーも履歴に残り `counted` は false、強制終了など終了時刻がない場合の所要時間は null。旧バージョンの履歴は復元できず、`legacyAttempts` は最後に保存されたリセット可能な試行回数であり累計ではない。旧履歴と新履歴が混在する Issue は新しい記録のみ集計する。GitHub 接続と設定が必要で、管理プログラムや状態ファイルは変更しない。

## PM 巡回

実装担当（worker）とは別に、マイルストーン全体の進捗・依存・重複・停滞を確認し、次の作業を整える PM を起動できる。PM と worker の役割の定義は [roles.md](roles.md)。`npm run agents` の同じループ・ロックを使い、実装担当との同時実行はしない。実装中の作業を中断せず、終了後の次の巡回で PM の起動時刻を判定する。

`manager` が省略された既存設定は従来どおり PM 無効。設定サンプルでは有効。PM を有効にした最初の巡回では PM を先に1回起動し、その次の巡回から実装作業を進める。以後は既定6時間ごと、または着手できる仕事がなく、前回から1時間以上経った場合に起動する。間隔は終了時刻から数える。起動時刻も保存するため、強制終了・再起動で連続起動しない。

実装を Codex、PM を Claude にする例（既存のトップレベル設定に `manager` を追加）:

```json
{
  "agent": "codex",
  "agentArgs": ["--approve-for-me"],
  "manager": {
    "enabled": true,
    "agent": "claude",
    "agentArgs": ["--model", "sonnet", "--allowedTools", "Read,Glob,Grep,Bash"],
    "intervalSeconds": 21600,
    "runWhenIdle": true,
    "minIntervalSeconds": 3600,
    "timeoutSeconds": 1800,
    "maxRunsPerDay": 4,
    "instructions": "新しいIssueを増やす前に、M1の依存関係と停滞中の作業を優先して整理する。"
  }
}
```

| `manager` 内のキー | 省略時の値・意味 |
| --- | --- |
| `enabled` | `false`。PM の有効・無効 |
| `agent` | `codex`。`codex` / `claude` を実装担当と独立して選択 |
| `agentArgs` | `[]`。PM 専用の追加引数。実装担当の引数は引き継がない。モデルも `--model` 等で指定できる |
| `intervalSeconds` | `21600`。通常の起動間隔（6時間） |
| `runWhenIdle` | `true`。着手可能な仕事がない場合に通常間隔より早く起動する |
| `minIntervalSeconds` | `3600`。仕事がない場合でも守る最短間隔。通常間隔以下にする |
| `timeoutSeconds` | `1800`。PM 1回の実行上限（30分） |
| `maxRunsPerDay` | `4`。PM 独立の日次起動上限（UTC）。実装担当の起動回数を消費しない |
| `instructions` | `""`。PM 標準指示に追加する任意の指示 |

PM の対象はトップレベルの `repo`・`base`・`milestone`。既存設計の範囲で Issue の作成・未担当 Issue の依存/完了条件/優先度/状態の整理を行える。既存 Issue と重複しないこと、進行中の claim やブランチに介入しないこと、承認待ちを勝手に解除しないことを起動指示で伝える。ソースの実装・編集や PR のマージは担当しない。これらの役割分担は AI への指示であり、GitHub トークンの権限を技術的に分割するものではない。

端末には `[PM]` 付きで進捗を表示する。詳細ログは共通 Git ディレクトリの `agent-runner/manager-<時刻>.log`、成功時の報告は同名の `.md` と `manager-latest.md` に保存する。PM は前回の報告を読み、扱った観点の続きから始める。報告は、見つけた問題と作った Issue、人の判断が必要なもの、扱った観点と次回に回したもの、基本の整備で変えたこと、の順に短く書く。

PM の主な仕事は、プロジェクトの進め方の批判的なレビュー。所有者に指摘される前に、計画の甘さ・作業の抜け・前提の食い違い・先のリスクを自分で見つけ、根拠を付けて Issue にする。観点は、計画の粒度と見通し（必要な作業量を Java のデータ生成の出力やコーパスの集計で数えて計画と比べる）、閉じた Issue の実質、テストと検証、コードの構成、前提の食い違い、製品としての配布、権利と外部依存、版の追従とリスク、進め方の振り返り。毎回、前回扱っていない観点を2つ以上選んで深く調べ、扱った観点と次回に回したものを報告に残す。

巡回の最初に、[判断の受付](roles.md#判断の受付)の Issue にある返信のない所有者のコメントを判断の Issue に記録し、巡回の最後に `npm run decisions -- --update` で一覧を更新する。

指摘は報告に書くだけにせず、Issue を作るか既存の Issue にコメントする。重複は `gh issue list --state all --search` で確かめる。新しく作る Issue は1回10件までで、それを超えるときは親の Issue に一覧を書く。設計の変更・権利・費用・マイルストーンの組み直しは、判断の Issue（問い・選択肢・推奨の節）にして `needs-approval` を付ける。依存が解けた Issue の `status:ready` 化と停滞の検出も行うが、短く済ませる。

基本の整備では、開いている Issue のうち `status:*` 未設定のものも分類する。依存完了・承認不要・現在の段階で着手可能・1つの PR で完了・機械的な完了条件が揃ったものを `status:ready` にする。条件不足や未完了の依存があれば `status:blocked` として阻害要因・解除条件を本文に残す。依存以外の阻害要因は、本文に独立した `Blocked: <理由>` 行で記録する。人の判断が必要なら `needs-approval` も付ける。新規作成時も同じ判定で状態ラベルを付ける。着手権のある作業・進行中・レビュー中・明示的に中断された作業には介入しない。worker が止めた Issue の依存行の付け替えには [作業手順の例外](workflow.md#4-中断する) を適用する。ready が0件なら、その理由と解除条件を報告する。状態未設定の Issue を実装担当が直接拾う仕組みにはせず、PM が条件を確認してからキューに入れる。

- 巡回の終わりに着手可能な ready を10件前後そろえる。足りない場合は、族の追跡 Issue や大きな Issue から、1回の worker 起動で完了できる子 Issue を切る（#271）。
- 同じファイルを編集するだけの理由で依存を足さない。競合は後からマージする側が rebase で解消する。表の形を変えるなど、構造の変更が後続作業の前提になる場合は依存として先に置いてよい。

PM はリポジトリのファイルを編集せず、実サーバーのテストも流さない。読み取りだけの集計スクリプトは、リポジトリの外で実行してよい。深く調べるため、`timeoutSeconds` は 3600 程度を勧める。追加の指示は `manager.instructions` で調整できる。

時刻・日次回数は既存の `state.json` の `manager` に追加保存する。古い状態ファイルはそのまま使える。通常の失敗・タイムアウトでも間隔と上限を守って再試行する。CLI 起動エラーでは PM の今回の起動記録を戻して管理プログラムを停止する。実装担当の上限に達していても PM の定期巡回は可能。

設定変更は次回起動から反映する。稼働中のプロセスを変更したり止めたりしない。`--dry-run` は PM の設定を表示するだけで、PM も起動しない。

Codex は通常 `codex exec --sandbox workspace-write --json`、Claude は `claude -p --output-format stream-json --verbose` を使い、作業指示は標準入力で渡す。Codex に `--approve-for-me` を指定したときは、このフラグ自身が workspace-write を設定するため、競合する `--sandbox` は追加しない。CLI のバージョン・アカウントの制限・管理者ポリシーは別途適用される。

無人実行には、使用する CLI の権限設定で git・gh・必要なダウンロード・テストが許可されている必要がある。管理プログラムは sandbox や承認を無効化しない。Codex が対応している環境では `agentArgs: ["--approve-for-me"]` で自動承認レビューを使える（この環境の CLI で確認済み）。Claude では、必要なツールを明示する例として `agentArgs: ["--allowedTools", "Read,Edit,Write,Bash"]` が使える。Bash の許可範囲を絞る場合は、実際に必要なコマンドに合わせて CLI 側で設定する。worktree や共通の Git 管理領域への書き込み・ネットワークが拒否される場合も、CLI のログを確認して設定する。

設定サンプルでは Codex の `--approve-for-me` を指定している。Claude に切り替えるときは `agent` と併せて `agentArgs` も Claude 用に変更する。このフラグに非対応の古い Codex は更新するか、対応する権限設定に置き換える。

起動回数と実行時間の上限は、課金額・トークン数の厳密な上限ではない。必要ならプロバイダー側でも利用上限を設定する。

## 巡回の動き

1. 以前着手した Issue の最新状態と PR を照合する。
2. マージ条件が揃えば通常のマージコミットでマージする。最新 head SHA を指定し、確認後の push を検出する。
3. PR の CI が失敗・マージ競合・変更要求なら、同じ worktree で AI を再起動する。draft の PR も実装未完了として再実行する。CI 未登録・実行中・マージ待ちの PR は保留して次の仕事を探す。worker には完了条件を満たすか時間切れまで作業を続けるよう指示し、区切りの記録は終了理由にしない。再実行時は前回が未完了だったことを伝え、PR が `DIRTY` なら base を取り込んで競合解消と CI の確認を指示する。失敗したチェックがあれば名前も伝える。
4. 着手可能な `status:ready` を番号順に選ぶ。他の status、`needs-approval`、有効な claim、未完了の明示的依存があれば選ばない。
5. 一意の `claim:` コメントを記録し、次の巡回で先着を確認する。その後 `status:in-progress` にし、専用ブランチと worktree を用意して AI を起動する。

各巡回の初めに、開いている Issue のうち、有効な claim がなく、状態ラベルが `status:blocked` のみで、`needs-approval` と本文の `Blocked: <理由>` 行がないものを調べる。明示的な依存が1件以上あり、すべて閉じていれば `status:ready` に変更し、Issue に一度だけ理由を通知する。

依存は同じリポジトリの Issue 番号で、本文に次のどちらかの形で記載する。背景やメモ内の通常の参照は依存として扱わない。依存以外の阻害要因が解消したら、PM が `Blocked: <理由>` 行を外して着手可否を判定する。

```markdown
Depends on: #12, #15
```

```markdown
### 依存
- #12
- #15
```

AI は必要な依存取得・実装・検証・push・PR 作成を行う。完了条件の確認前は draft、確認できたら ready にする。管理側は完了条件の意味そのものを検証できないため、この ready 化を AI による完了確認として扱う。

自動マージは、Issue が開いていて保留でなく、PR が ready、指定 base 宛て、Issue の closing reference があり、GitHub のマージ状態が `CLEAN` で、変更要求がない場合に限る。head SHA に対応する pull_request イベントの CI ワークフロー（`.github/workflows/ci.yml`）の最新実行が成功し、PR のチェックが1件以上登録され、すべて完了（成功・スキップ・中立）していることを要求する。ワークフロー実行やチェックが未登録ならマージしない。ジョブ名の変更は判定に影響しない。ワークフローのパスを変更する場合は管理プログラムの取得先も変更する。

自動マージ直前には base の CI ワークフローの push 実行から、取消を除く最新の完了結果を確認する。結果がないか成功以外ならマージしない。失敗時は端末に表示し、当該コミットに関連付く PR の closing Issue に通知する。該当 Issue がなければ調査 Issue を作り、同じコミットの通知は重複させない。base と PR の共通祖先からの変更に同じパスがある場合は PR ブランチに base を取り込み、新しい head の CI 成功を待つ。取得エラーもマージを阻止する。base が判定直後に外部で更新される競合は GitHub 側で原子的に防げない。

`needs-approval` は Issue・PR のどちらにあっても保留する。承認コメントの自然言語判定は行わない。人が承認コメントを書き、該当する Issue / PR の `needs-approval` を外して再開させる。`status:blocked` / `status:paused` も再開時に解除する。積み上げた PR は base が違う間は自動マージしない。最初の版では積み上げの base 変更・ブランチ削除は自動化しない。

worker が途中で終了するときは `status:paused` を付けず、進捗と再開手順を Issue に残す。次の巡回で同じ worktree から再実行し、起動回数を数える。管理対象の Issue に `status:paused` がある場合は端末に表示し、人が外すまで再開しない旨を Issue に一度だけコメントする。

worker が依存や判断を待つ場合、待つ Issue を本文に `Depends on: #番号` で明示し、理由と再開手順をコメントして `status:blocked` にする。判断は判断 Issue に記録し、その `needs-approval` を外してから閉じる。管理対象で claim が有効な worker 待機は、明示された依存が1件以上あり全件 closed、本人・依存先・開いている PR に `needs-approval` がなく、他の status がない場合に限り ready を経て同じ worktree で再開する。依存がない場合や取得できない場合は自動再開しない。実行回数上限など管理プログラム自身の停止は従来どおり人が原因を解消し ready に戻す。`status:paused` は人の明示的な中断であり自動解除しない。

起動前後のリモートブランチを比較し、前の先端を含む新しいコミットが push されていれば `maxAttempts` の回数を戻す。ブランチの新規作成だけでは、base から新しいコミットがない限り進捗に数えない。確認に失敗した場合や push がない場合は回数を消費する。`maxTotalAttempts` と日次上限は push があっても消費する。CLI の起動前エラーはどちらの Issue 上限にも数えない。旧状態の合計は保存済みの試行回数から始まる。

上限到達や PR の未マージクローズは `status:blocked` にして、再開情報を Issue に記録する。原因を直して `status:ready` に戻すと、同じ worktree で両方の Issue 上限をリセットして再開する。Issue のクローズは完了として扱う。管理対象外の既存作業を勝手に引き継がず、状態ファイルにある Issue だけを再開する。

別案として Codex CLI の `codex exec resume <SESSION_ID> <PROMPT>` は既存セッションへ追加指示を送れる（ローカルの `--help` で確認）。同じ文脈を保てる一方、セッション ID の保存・再開失敗・時間と回数の制御が別途必要になる。今回の方式は既存の起動と worktree の再開を維持し、push を検証して上限だけを調整する。

## 状態・ログ・排他制御

端末には時刻と Issue 番号付きで AI の進捗メッセージ、実行コマンドと完了・失敗、ファイル変更を表示する。コマンドの長い出力や生の JSON、推論内容は表示しない。AI 実行中は60秒ごとに経過時間・最後のログ更新からの秒数・直近の動作も表示する。ログ更新が途絶えた場合も、ハートビート自体は AI が進んでいる保証ではなく、管理側が実行終了を待っていることを示す。

巡回時は承認待ち・CI の成功数・日次上限・次の巡回までの待ち時間も表示する。生の詳細ログは従来どおり保存する。この表示変更は管理プログラムの次回起動から反映され、すでに実行中のプロセスには影響しない。

共通 Git ディレクトリの `agent-runner/` に保存する。通常は `.git/agent-runner/`。別 worktree から起動しても共通のロックを使う。

- `state.json`：担当 Issue、claim、ブランチ、worktree、試行回数、日次実行数。更新は一時ファイルから rename する。
- `<Issue番号>-<時刻>.log`：AI の標準出力・標準エラー。実装の進捗や CLI の権限エラーを確認できる。
- `worktrees/<Issue番号>/`：作業用 checkout。マージ済み PR が Issue に紐付き、base に取り込まれ、後続 PR がなく、ブランチの先端が一致する場合に次の巡回で片付ける。未追跡ファイル・変更やロックがある worktree は残す。無視ファイルは、生成物（`node_modules`・`servers`・`dist`・`__pycache__`、各パックのビルド出力、`*.tsbuildinfo`）だけなら消し、それ以外（`sample-map/` など）があれば残す。削除できない場合はログを見て手動で確認する。強制削除はしない。
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
