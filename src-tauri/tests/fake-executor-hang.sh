#!/bin/sh
# A turn that never finishes. Used to prove cancellation actually kills the
# process rather than merely detaching from it — the per-turn child used to be
# moved into the pump thread, out of `terminate()`'s reach.
#
# The turn message is passed through as an argument, so a test sends a path
# ending in `.pid` and this writes its own PID there; the test then checks the
# process is really gone. Blocks forever otherwise.

for arg in "$@"; do
  case "$arg" in
    *.pid) printf '%s' "$$" > "$arg" ;;
  esac
done

# One line of real output first, so the pump is already reading before the test
# cancels — otherwise the test could race the spawn itself.
printf '%s\n' '{"type":"item.completed","item":{"item_type":"agent_message","text":"working"}}'

while :; do
  sleep 1
done
