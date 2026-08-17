# Thread-level executor model and bypass preferences

Palisade's model and bypass controls began as client-side stored preferences with no effect on the executor. We decided to wire them to the next new session's argv, move the controls to the thread/composer level, and let each thread override a global default. A changed preference only affects the next new session; live sessions keep their original flags so an in-flight turn is not handed off to a different model or permission level. The new UI lives in the active thread's composer, similar to Devin Desktop's model and bypass controls.

## Considered Options

- **Apply immediately to live sessions.** Rejected because it would abort or corrupt an in-flight executor turn; waiting for the next session keeps the contract simple.
- **Keep controls in the chrome header.** Rejected because the setting is thread-specific and the composer is where the user is preparing the next turn.

## Consequences

- Each thread may override the global default, so the same user can run one thread in `Opus 5` with bypass and another in `Sonnet 5` without.
- Model labels map to executor-specific CLI aliases (`sonnet`, `opus`, `haiku` for Claude). Codex support is deferred because its model namespace does not share Anthropic's names.
- Bypass maps per-executor: Claude uses `--dangerously-skip-permissions`; Codex uses `--dangerously-bypass-approvals-and-sandbox`.
- The implementation must pass the resolved preferences from the client through Tauri to the spawn context.
