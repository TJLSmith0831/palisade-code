#!/usr/bin/env bash
# Tauri's Cargo runner, then Cargo's executable runner: keep Cargo's flags and artifact paths.
set -euo pipefail

if [[ "${1:-}" == "run" ]]; then
  export CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER="$0"
  export CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER="$0"
  exec cargo "$@"
fi
if [[ ! -f "${1:-}" || ! -x "${1:-}" ]]; then
  exec cargo "$@"
fi

source "$(dirname "$0")/codesign-identity.sh"
codesign --force --identifier com.tjlsmith0831.palisade-code --sign "$CODESIGN_ID" "$1"
exec "$@"
