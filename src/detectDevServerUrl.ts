/** Matches a local dev-server URL in arbitrary output — terminal bytes or an
 * agent tool call's stdout, the same pattern for both (D3/D5/D9). */
const DEV_SERVER_URL = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"'<>]*/g;

/**
 * The last local URL in `text`, or null.
 *
 * Last rather than first: dev servers that print several lines put the
 * network/alias URLs after the `Local:` one, and the most recently printed
 * banner is the one that reflects the server now running.
 */
export function detectDevServerUrl(text: string): string | null {
  const matches = text.match(DEV_SERVER_URL);
  if (!matches) return null;
  // Trailing punctuation from prose like "listening on http://localhost:3000."
  return matches[matches.length - 1].replace(/[.,;)]+$/, "");
}
