#!/bin/sh
# Fake executor for integration tests (E7). One stub, both shapes:
#
#   Claude-style: reads newline-delimited JSON turns on stdin and emits a
#                 canned stream-json sequence per turn, staying alive between
#                 turns like the real persistent process.
#   Codex-style:  invoked with `exec [resume --last] "<message>"`, emits one
#                 canned JSONL turn, and exits.
#
# The crash path lives in the sibling fake-executor-crash.sh.

emit_claude_turn() {
  printf '%s\n' '{"type":"system","subtype":"init","session_id":"fake"}'
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"considering"}]}}'
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"echo hi"}}]}}'
  printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"hi","is_error":false}]}}'
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"done thinking"}]}}'
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false}'
}

emit_codex_turn() {
  printf '%s\n' '{"type":"item.started","item":{"id":"c1","item_type":"command_execution","command":"echo hi"}}'
  printf '%s\n' '{"type":"item.completed","item":{"id":"c1","item_type":"command_execution","aggregated_output":"hi","exit_code":0}}'
  printf '%s\n' '{"type":"item.completed","item":{"id":"c2","item_type":"agent_message","text":"done thinking"}}'
  printf '%s\n' '{"type":"turn.completed"}'
}

# Codex-style: the invocation carries the message as an argument.
case "$1" in
  exec)
    emit_codex_turn
    exit 0
    ;;
esac

# Claude-style: one canned turn per line of stdin, process stays alive.
while IFS= read -r _line; do
  emit_claude_turn
done
