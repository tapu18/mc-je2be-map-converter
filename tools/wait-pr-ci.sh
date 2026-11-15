#!/usr/bin/env bash
# PR の最新コミットの CI が終わるまで待ち、結果を表示する。成功なら 0、失敗・タイムアウトなら 1。
#
# push 直後は CI の実行がまだ登録されておらず、`gh pr checks --watch` がすぐ終わってしまう（#28 で起きた）。
# そのため、PR の head コミットに対応する実行が現れるのを待ってから、完了まで待つ。
#
# 使い方: tools/wait-pr-ci.sh <PR番号> [タイムアウト秒（既定 1200）]
set -euo pipefail

pr="${1:?usage: tools/wait-pr-ci.sh <PR番号> [timeout-seconds]}"
timeout_s="${2:-1200}"
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
deadline=$(( $(date +%s) + timeout_s ))

sha="$(gh pr view "$pr" -R "$repo" --json headRefOid --jq .headRefOid)"
echo "PR #$pr head $sha"

# 1. head コミットの実行が登録されるまで待つ
run_ids=""
while [ -z "$run_ids" ]; do
  run_ids="$(gh run list -R "$repo" --commit "$sha" --json databaseId --jq '.[].databaseId' 2>/dev/null || true)"
  if [ -z "$run_ids" ]; then
    [ "$(date +%s)" -ge "$deadline" ] && { echo "timeout: CI run for $sha was not registered"; exit 1; }
    sleep 5
  fi
done

# 2. すべての実行の完了を待つ
status=0
for id in $run_ids; do
  remaining=$(( deadline - $(date +%s) ))
  [ "$remaining" -le 0 ] && { echo "timeout waiting for run $id"; exit 1; }
  if ! timeout "$remaining" gh run watch "$id" -R "$repo" --exit-status --interval 15 >/dev/null 2>&1; then
    status=1
  fi
  echo "run $id"
  gh run view "$id" -R "$repo" --json conclusion,jobs --jq '"  conclusion=\(.conclusion)", (.jobs[] | "  \(.name): \(.conclusion)")'
done

# 3. 待っている間に新しいコミットが push されていないか
now_sha="$(gh pr view "$pr" -R "$repo" --json headRefOid --jq .headRefOid)"
if [ "$now_sha" != "$sha" ]; then
  echo "PR head changed to $now_sha while waiting; run again"
  exit 1
fi
exit "$status"
