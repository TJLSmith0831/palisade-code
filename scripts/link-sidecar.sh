#!/usr/bin/env bash
# Symlinks the gitignored llama.cpp sidecar binary + bundled models from the
# main checkout into this worktree, since `git worktree add` only copies
# tracked files and these are large local-only build inputs (see
# src-tauri/tauri.conf.json's externalBin + .gitignore).
set -euo pipefail

cd "$(dirname "$0")/.."

main_checkout="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
[ -n "$main_checkout" ] || exit 0
[ "$(cd "$main_checkout" && pwd)" != "$(pwd)" ] || exit 0

for triple in aarch64-apple-darwin x86_64-apple-darwin universal-apple-darwin; do
  sidecar="src-tauri/llama-server-$triple"
  if [ ! -e "$sidecar" ] && [ -e "$main_checkout/$sidecar" ]; then
    ln -s "$main_checkout/$sidecar" "$sidecar"
    echo "link-sidecar: linked $sidecar from main checkout"
  fi
done

resources="src-tauri/resources"
if [ ! -e "$resources" ] && [ -e "$main_checkout/$resources" ]; then
  ln -s "$main_checkout/$resources" "$resources"
  echo "link-sidecar: linked $resources from main checkout"
fi
