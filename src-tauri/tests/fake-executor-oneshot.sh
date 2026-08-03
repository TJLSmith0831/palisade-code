#!/bin/sh
# A Claude-style executor that answers one turn cleanly and then exits anyway.
# The persistent process is supposed to outlive its turns, so this still has to
# surface as a crash — a clean Done on the last turn must not mask the process
# dying underneath the user afterwards.
IFS= read -r _line
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"bye"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false}'
exit 0
