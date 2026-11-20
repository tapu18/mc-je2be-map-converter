# 開発の進め方（複数エージェント向け）

複数のAIエージェントが並行して開発し、人は判断と実機確認を担う。作業の正本は GitHub の Issue と PR で、リポジトリ内の文書は設計（`design.md`）と実測した事実（`findings.md`）を持つ。

定期巡回で Codex / Claude Code を起動する管理プログラムは [agent-runner.md](agent-runner.md) を参照。`npm run agents -- --dry-run` で候補を確認できる。

## 役割

| 役割 | 担うこと |
| --- | --- |
| 人（リポジトリ所有者） | `needs-approval` の判断、段階の関門（M0の完了など）の承認、実クライアントでのプレイ確認 |
| エージェント | Issue の着手から PR のマージまで。新しく見つけた作業の Issue 化 |

## 管理の単位

- **マイルストーン**：段階（M0〜M5、`design.md` 7章）
- **Issue**：1つのPRで完了できる作業。完了条件は機械的に確かめられる形で書く
- **ラベル**

| ラベル | 意味 |
| --- | --- |
| `status:ready` | 着手可能。担当なし |
| `status:in-progress` | 作業中。担当は Issue の `claim:` コメントで示す |
| `status:in-review` | PR を提出済み。CI 待ち、または `needs-approval` の承認待ち。マージされると Issue は閉じる |
| `status:paused` | 中断。再開手順が Issue のコメントにある |
| `status:blocked` | 他の Issue か人の判断を待っている |
| `needs-approval` | 人の承認が必要。PRをマージする前に承認をもらう |
| `type:*` / `area:*` | 種類と分野 |

## 作業の流れ

### 1. 着手する

1. `gh issue list --label status:ready --milestone "<現在の段階>"` から選ぶ。依存（Issueの「依存」欄）が終わっていないものは選ばない。
2. ラベルを `status:in-progress` に付け替え、`claim: <エージェント名>（ブランチ <ブランチ名>）` とコメントする。
3. コメントを読み直し、自分より前に別の `claim:` があれば手を引く（先に書いた方が担当）。
4. エージェント名は作業ごとに一意にする（例：`claude-poc-tick`）。全員が同じGitHubアカウントを使うため、assignee では区別できない。

### 2. 作業する

- **worktree を分ける。** 同じディレクトリで複数のエージェントが作業しない。
  ```sh
  git worktree add ../je2be-<Issue番号> -b <Issue番号>-<短い説明> origin/main
  cd ../je2be-<Issue番号> && npm ci && npm run setup:servers
  ```
- ブランチ名は `<Issue番号>-<短い説明>`（例：`3-poc-tick-order`）。
- 1コミット1目的。`npm run check` が通る状態でコミットする。
- こまめに push する。途中で止まっても、別のエージェントがブランチから再開できるようにするため。
- 区切りごとに、Issue に進捗コメント（何をしたか、何を確かめたか、次の一手）を書く。
- 実測した事実は `docs/findings.md` に根拠（テスト名、コミット）付きで追記する。設計に関わるものは `docs/design.md` にも反映する。
- 作業中に見つけた別の作業は、新しい Issue にする。今の PR に混ぜない。

### 3. PRを出してマージする

1. `gh pr create` で PR を出す。本文に `Closes #<番号>` を書く（テンプレートあり）。
2. CI（`check` と、グループごとの `servers / <グループ>`）が通るのを待つ。実機テストのグループ分けは `tools/server-test-groups.ts`（新しいテストは自動で `misc` に入る）。`performance` は時間がかかるため、PR では関連する変更があるときだけ流れ、main への push では常に流れる。待つときは `tools/wait-pr-ci.sh <PR番号>` を使う（push 直後は CI が未登録で `gh pr checks --watch` がすぐ終わり、待ったつもりで素通りすることがあるため。#28 で発生）。失敗したら直す。
3. マージの条件：
   - CI が通っている
   - Issue の完了条件を満たしている
   - `needs-approval` が付いた Issue・PR は、人の承認コメントがある
4. **条件を満たせば、エージェントが自分でマージしてよい**（2026-11-15 に所有者が許可）。`needs-approval` の PR は、承認コメントを得るまでマージしない。待つ間は Issue のラベルを `status:in-review` にして次の Issue に進む。
   - マージの方式は通常のマージコミット（`gh pr merge <番号> --merge`）。スカッシュは積み上げた PR で衝突を起こすため使わない。
   - マージ待ちの PR に依存する作業は、その PR のブランチから派生させ、PR の base をそのブランチにする（積み上げ）。
   - 積み上げた PR をマージする手順：
     1. 下の PR を `--delete-branch` を付けずにマージする（**base のブランチを先に消すと、上に積んだ PR が自動でクローズされる**）
     2. 上の PR の base を main に切り替える（`gh pr edit <番号> --base main`）。base が main 以外のままマージすると `Closes #番号` で Issue が閉じない
     3. 下の PR のブランチを削除する（`git push origin --delete <ブランチ>`）
     4. 上の PR の CI が通っていることを `tools/wait-pr-ci.sh` で確かめてマージする（base を変えたり main を取り込んだりした後は、CI をもう一度待つ）
5. マージ後、worktree を片付ける（`git worktree remove`）。

### 4. 中断する

1. 作業中のブランチを push する。
2. Issue に再開手順をコメントする（どこまで済んだか、次に何をするか、気をつけること）。
3. ラベルを `status:paused` にする。`claim:` は取り消したと明記する。

## 衝突を避けるために

- `docs/findings.md` や `docs/design.md` の同じ節を、複数のPRが同時に編集しないようにする。追記は節の末尾に行う。衝突したら、main を取り込んで解消してから push する。
- 実サーバーを使うテストは、worktree ごとの `servers/` を使う。同時に起動するとポートが衝突する（#2 で解消予定）。
- `tools/servers.json`（サーバーのバージョン）を上げる PR は、ほかの作業と分ける。

## 人へのエスカレーション

人の判断がチャットなど GitHub の外で示された場合は、受け取ったエージェントが該当する Issue にコメントとして記録する（日付と判断の内容）。ほかのエージェントはその記録を承認として扱う。

次の場合は作業を止め、Issue に `needs-approval` を付けて質問を書く。

- 設計（`docs/design.md`）の方針を変える必要がある
- 外部への影響がある（新しいリポジトリやサービスの作成、公開、費用の発生）
- ライセンスや配布マップの権利に関わる判断
