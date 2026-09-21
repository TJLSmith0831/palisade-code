import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { detectDevServerUrl } from "./detectDevServerUrl";
import type { Envelope } from "./api";

/** How much recent PTY output to keep while looking for a URL. A startup
 * banner is one short line; a few KB is far more than enough to catch one
 * split across two reads. */
const BUFFER_CHARS = 4096;

/** How long the PTY has to go quiet before its output is worth scanning.
 * ponytail: a plain guess — long enough to outlast a shell's redraw burst,
 * short enough that the preview still feels instant. */
const SETTLE_MS = 250;

/** CSI and OSC escape sequences, which otherwise glue themselves to the end
 * of a matched URL. */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const stripAnsi = (text: string) => text.replace(ANSI, "");

/**
 * Watches both output streams for a dev-server URL and reports the first one
 * that appears.
 *
 * Two streams, one regex (D9): `terminal-output` carries commands a human
 * ran, `executor-event`'s `toolResult` carries the ones an agent ran. Neither
 * knows about the other, and neither needs per-agent code.
 *
 * The same URL twice is ignored (D11): chatty dev servers reprint their
 * banner on every HMR reconnect, and re-navigating would steal focus each
 * time.
 */
export function useDevServerPreview(onDetect: (url: string) => void) {
  const lastUrl = useRef<string | null>(null);
  // Kept in a ref so a re-render never re-subscribes the listeners.
  const detect = useRef(onDetect);
  detect.current = onDetect;

  useEffect(() => {
    const report = (text: string) => {
      const url = detectDevServerUrl(text);
      if (!url || url === lastUrl.current) return;
      lastUrl.current = url;
      detect.current(url);
    };

    let buffer = "";
    let settle: ReturnType<typeof setTimeout> | undefined;
    const terminal = listen<{ terminalId: string; data: string }>(
      "terminal-output",
      ({ payload }) => {
      // Same base64 PTY bytes TerminalPane consumes, tagged with the tab they
      // came from now that a project can hold several shells at once. Every
      // tab is watched, not just the first: a dev server is as likely to be
      // started in the second one.
      //
      // Decoded defensively — this runs in an event handler, and a throw here
      // takes the whole render tree down with it (which is exactly what an
      // untagged `atob(payload)` did once the payload became an object).
      let chunk: string;
      try {
        chunk = atob(payload?.data ?? "");
      } catch {
        return;
      }
      // Latin-1 decoding is enough: the URL pattern is ASCII, and a mangled
      // multi-byte character elsewhere in the buffer can't produce a false
      // match.
      buffer = (buffer + chunk).slice(-BUFFER_CHARS);
      // Scan once the burst goes quiet, not per chunk. A shell's line editor
      // repaints the command you typed using cursor escapes, so mid-burst the
      // buffer holds half-drawn text — `…:4402/` briefly reads as `…:44`,
      // which is a *different* URL and sails straight past the dedup below.
      // Settling first means we only ever match the finished output.
      clearTimeout(settle);
      settle = setTimeout(() => report(stripAnsi(buffer)), SETTLE_MS);
      }
    );

    const agent = listen<Envelope>("executor-event", ({ payload: { event } }) => {
      // Each tool result is already a complete string — no buffering needed.
      if (event.kind === "toolResult") report(event.output);
    });

    return () => {
      clearTimeout(settle);
      void terminal.then((un) => un());
      void agent.then((un) => un());
    };
  }, []);
}
