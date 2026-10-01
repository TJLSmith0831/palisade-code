#!/usr/bin/env bash
# Usage: readiness-profile.sh APP PROFILE none|codex arm64|x86_64
# Same PROFILE resumes; a newly created PROFILE exercises first use.
set -euo pipefail
app=${1:?path to the readiness .app}
profile=${2:?absolute disposable profile path}
agent=${3:-none}
architecture=${4:-arm64}
[[ "$profile" = /* && "$profile" != / ]] || { echo "Use an absolute, non-root profile directory" >&2; exit 1; }
[[ "$profile" != */../* && "$profile" != */.. ]] || { echo "Parent traversal is not allowed" >&2; exit 1; }
[[ "$agent" = none || "$agent" = codex ]] || { echo "Agent must be none or codex" >&2; exit 1; }
[[ "$architecture" = arm64 || "$architecture" = x86_64 ]] || { echo "Architecture must be arm64 or x86_64" >&2; exit 1; }
binary="$app/Contents/MacOS/palisade-code"
[[ -x "$binary" ]] || { echo "Readiness app executable not found" >&2; exit 1; }
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" | /usr/bin/grep -qx 'com.tjlsmith0831.palisade-code.readiness' || { echo "Refusing to launch the normal app" >&2; exit 1; }
if [[ ! -e "$profile" ]]; then
  (umask 077; mkdir -p "$profile"; touch "$profile/.palisade-readiness-profile")
fi
[[ -f "$profile/.palisade-readiness-profile" ]] || { echo "Refusing an unmarked existing profile directory" >&2; exit 1; }
mkdir -p "$profile/store" "$profile/bin"
# Never remove arbitrary files: refuse reused discovery folders with surprises.
for entry in "$profile/bin"/*; do
  [[ -e "$entry" || -L "$entry" ]] || continue
  [[ -L "$entry" ]] || { echo "Unexpected discovery entry: $entry" >&2; exit 1; }
  case "${entry##*/}" in codex|npx|git|node|python3|openspec) ;; *) echo "Unexpected discovery entry: $entry" >&2; exit 1 ;; esac
  rm "$entry"
done
for tool in git node python3 openspec; do
  resolved=$(command -v "$tool" || true)
  [[ -z "$resolved" ]] || ln -s "$resolved" "$profile/bin/$tool"
done
if [[ "$agent" = codex ]]; then
  for tool in codex npx; do
    resolved=$(command -v "$tool" || true)
    [[ -z "$resolved" ]] || ln -s "$resolved" "$profile/bin/$tool"
  done
fi
{
  /usr/bin/sw_vers
  printf 'requested_architecture=%s\nagent_discovery=%s\n' "$architecture" "$agent"
  /usr/bin/shasum -a 256 "$binary" "$app/Contents/MacOS/llama-server"
} > "$profile/launch-evidence.txt"
# Codex ACP's advertised "Ask for approval" preset, not its auto-review default.
exec /usr/bin/env PALISADE_TEST_DIR="$profile" INITIAL_AGENT_MODE=read-only /usr/bin/arch -"$architecture" "$binary"
