/** A friendly, consistent lead-in for surfaced errors — the raw detail (a Rust
 * `Result<T, String>` message, or a JS error) stays fully visible after it,
 * nothing is hidden, it just no longer looks like a raw crash dump. */
export function describeError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Couldn't complete that — ${detail}`;
}
