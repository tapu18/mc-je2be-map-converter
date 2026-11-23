#!/usr/bin/env bash
# Merge a PR into main, retarget direct children before deleting its branch.
set -euo pipefail
pr="${1:?usage: tools/merge-pr.sh <PR-number>}"
[[ "$pr" =~ ^[0-9]+$ ]] || { echo 'PR number must be numeric' >&2; exit 1; }
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
info="$(gh pr view "$pr" -R "$repo" --json state,baseRefName,headRefName,headRefOid,isCrossRepository)"
[[ "$(jq -r .state <<<"$info")" == OPEN && "$(jq -r .baseRefName <<<"$info")" == main && "$(jq -r .isCrossRepository <<<"$info")" == false ]] || { echo 'Expected an open same-repository PR targeting main' >&2; exit 1; }
branch="$(jq -r .headRefName <<<"$info")"
sha="$(jq -r .headRefOid <<<"$info")"
"$(dirname "$0")/wait-pr-ci.sh" "$pr"
gh pr merge "$pr" -R "$repo" --merge --match-head-commit "$sha"
# Retarget all direct children before removing the base; failure leaves the branch intact.
gh pr list -R "$repo" --state open --base "$branch" --limit 1000 --json number --jq '.[].number' | while read -r child; do
  gh pr edit "$child" -R "$repo" --base main
done
# Delete only if the remote head is still the commit that was merged.
# Explicit lease protects a branch updated after the merge.
git push origin --force-with-lease="refs/heads/$branch:$sha" ":refs/heads/$branch"
