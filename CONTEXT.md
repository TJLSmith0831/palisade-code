# Floo Network Context

Terms for the cross-machine agent harness that drives Claude Code or Codex through spec-then-build sessions.

## Language

**Thread**:
A project-scoped conversation with a default intent (spec or go). It owns messages and can hold multiple live or closed executor sessions.
_Avoid_: chat, conversation

**Session**:
A live or closed invocation of an executor on a thread. A new session picks up the thread's current model and bypass preferences.
_Avoid_: run, turn

**Executor**:
The detected CLI (claude or codex) that Floo spawns to process a thread's turn.
_Avoid_: agent, model

**Model preference**:
The model a thread (or the global default) should use for the next new executor session.
_Avoid_: model setting, model choice

**Bypass preference**:
A per-thread or global flag that tells the executor to skip permission/approval prompts for the next new session.
_Avoid_: skip permissions, permission toggle

**Global default**:
The model and bypass values used when a thread has no per-thread override, stored in the client's default preference keys.
_Avoid_: default setting

**Thread override**:
A per-thread model and bypass value that supersedes the global default for that thread.
_Avoid_: thread preference
