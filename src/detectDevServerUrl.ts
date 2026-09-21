/** Matches a local dev-server URL in terminal output. Wildcard binds
 * (`0.0.0.0`, `[::]`) are what servers print when they listen everywhere —
 * python's http.server does — and are matched too, then rewritten to
 * `localhost`, the address a browser can actually open. */
const DEV_SERVER_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s"'<>]*/g;

/** CSI and OSC escape sequences, which otherwise glue themselves to the ends
 * of a matched URL (a coloured port is `:\x1b[1m5173\x1b[22m`). */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Trailing punctuation from prose like "listening on http://localhost:3000." */
const TRAILING = /[.,;)\]}]+$/;

export const stripAnsi = (text: string) => text.replace(ANSI, "");

/**
 * The last local URL in `text`, or null.
 *
 * Last rather than first: dev servers that print several lines put the
 * network/alias URLs after the `Local:` one, and the most recently printed
 * banner is the one that reflects the server now running.
 */
export function detectDevServerUrl(text: string): string | null {
  const matches = stripAnsi(text).match(DEV_SERVER_URL);
  if (!matches) return null;
  return openableUrl(matches[matches.length - 1].replace(TRAILING, ""));
}

/** A matched URL as a browser can open it: wildcard binds become `localhost`. */
export function openableUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (["0.0.0.0", "[::]", "[::1]"].includes(url.hostname)) url.hostname = "localhost";
    return url.toString();
  } catch {
    return null;
  }
}

/** Every local URL in one line of already-plain text, with where it starts —
 * what a terminal link provider needs to underline it. */
export function localUrlsIn(line: string): { start: number; text: string }[] {
  return [...line.matchAll(DEV_SERVER_URL)].map((m) => ({
    start: m.index ?? 0,
    text: m[0].replace(TRAILING, ""),
  }));
}

/** Every distinct local server named in `text`, openable, in order of
 * appearance. An agent's message can name several (a frontend and its API). */
export function detectDevServerUrls(text: string): string[] {
  const origins = new Set<string>();
  for (const { text: raw } of localUrlsIn(stripAnsi(text))) {
    const url = openableUrl(raw);
    if (url) origins.add(originOf(url));
  }
  return [...origins].map((origin) => `${origin}/`);
}

/** `scheme://host:port` — a server's identity, ignoring the page path. */
export const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/** Two URLs that open the same page: `:3000` and `:3000/` are one server. */
export const sameDevServer = (a: string, b: string) =>
  a.replace(/\/$/, "") === b.replace(/\/$/, "");
