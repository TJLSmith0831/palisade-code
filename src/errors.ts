/** A friendly, consistent lead-in for surfaced errors — the raw detail (a Rust
 * `Result<T, String>` message, or a JS error) stays fully visible after it,
 * nothing is hidden, it just no longer looks like a raw crash dump. */
export function describeError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Couldn't complete that — ${detail}`;
}

/** Whether a surfaced error reads as "the agent's own login expired or was
 *  never completed" rather than a generic failure — the phrasing an ACP
 *  agent's CLI (Claude Code, Codex, …) uses when it isn't authenticated.
 *  There's no structured error code from any of them, so this is a text
 *  match on their observed wording rather than a machine-checkable status. */
export function isAuthError(message: string): boolean {
  return /unauthoriz|not logged in|not authenticated|(please |needs? to be )?(log|sign)(ged)? in( for| again| to)?|authentication (failed|required|expired)|re-?auth|session expired|token (expired|invalid)|credentials (expired|invalid)|\b401\b/i.test(
    message
  );
}
