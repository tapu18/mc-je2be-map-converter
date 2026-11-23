#!/usr/bin/env bash
set -euo pipefail
issue="${1:?usage: tools/new-worktree.sh <issue-number>}"
[[ "$issue" =~ ^[0-9]+$ ]] || { echo 'Issue number must be numeric' >&2; exit 1; }
root="$(git rev-parse --show-toplevel)"
path="$(dirname "$root")/je2be-$issue"
git fetch origin main
git worktree add -b "$issue-work" "$path" origin/main
cd "$path"
npm ci
npm run setup:servers
npm run build:pack
