import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import { detectDevServerUrls } from "./detectDevServerUrl";
import { DevServerTracker, type DevServer } from "./devServers";

/** How much recent output to keep per terminal while looking for a URL. A
 * startup banner is one short line; a few KB is far more than enough. */
const BUFFER_CHARS = 4096;

/** How long a terminal has to go quiet before its output is worth scanning.
 * ponytail: a plain guess — long enough to outlast a shell's redraw burst,
 * short enough that the chip still feels instant. */
const SETTLE_MS = 250;

/** A terminal that never goes quiet is scanned anyway after this long, so a
 * chatty tab can't hide its own banner. */
const MAX_WAIT_MS = 1000;

/** How often the running servers are checked. */
const POLL_MS = 1500;

const reachable = (url: string) => api.previewProbe(url).then((reason) => reason === null);

/**
 * The dev servers running for this project, for the chips that offer to open
 * them in Preview.
 *
 * Two sources feed one tracker: terminal output, and what agents say — a
 * message or a tool result that names a local URL. Neither is trusted. A URL
 * only becomes a chip once something answers there (`DevServerTracker`), which
 * is what keeps a README, a log line or an agent's example out, and what
 * removes the chip when the server stops.
 *
 * Nothing here opens a tab: a URL in output is not evidence anyone wants a
 * browser. Opening is the caller's decision.
 */
export function useDevServers(projectHash: string | null, threadIds: readonly string[]) {
  const [tracker] = useState(() => new DevServerTracker());
  const [servers, setServers] = useState<DevServer[]>([]);

  // Read through refs so a re-render (App does, constantly) never resubscribes.
  const project = useRef(projectHash);
  project.current = projectHash;
  const threads = useRef(threadIds);
  threads.current = threadIds;

  const checking = useRef(false);
  const check = useCallback(async () => {
    if (checking.current || tracker.size === 0) return;
    checking.current = true;
    try {
      if (await tracker.check(reachable)) setServers(tracker.live());
    } finally {
      checking.current = false;
    }
  }, [tracker]);

  // A different project has different servers.
  useEffect(() => {
    tracker.clear();
    setServers([]);
  }, [projectHash, tracker]);

  useEffect(() => {
    const timer = setInterval(() => void check(), POLL_MS);
    return () => clearInterval(timer);
  }, [check]);

  useEffect(() => {
    const found = (urls: string[], origin: DevServer["origin"]) => {
      if (urls.length === 0) return;
      for (const url of urls) tracker.add(url, origin);
      void check();
    };

    // Per terminal, so one tab's output can neither splice into another's nor
    // keep it from being scanned.
    const tabs = new Map<string, { buffer: string; timer?: ReturnType<typeof setTimeout>; since: number }>();
    const scan = (terminalId: string) => {
      const tab = tabs.get(terminalId);
      if (!tab) return;
      clearTimeout(tab.timer);
      tab.since = 0;
      const urls = detectDevServerUrls(tab.buffer);
      // Scanned output is spent: kept, an old banner would re-announce a
      // server that has since stopped every time the tab printed anything.
      if (urls.length > 0) tab.buffer = "";
      found(urls, "terminal");
    };

    const output = listen<{ terminalId: string; data: string }>("terminal-output", ({ payload }) => {
      const id = payload?.terminalId;
      if (!project.current || !id?.startsWith(`${project.current}:`)) return;
      // Decoded defensively — this runs in an event handler, and a throw here
      // takes the whole render tree down with it.
      let chunk: string;
      try {
        chunk = atob(payload.data ?? "");
      } catch {
        return;
      }
      const tab = tabs.get(id) ?? { buffer: "", since: 0 };
      tabs.set(id, tab);
      // Latin-1 decoding is enough: the URL pattern is ASCII, and a mangled
      // multi-byte character elsewhere can't produce a false match.
      tab.buffer = (tab.buffer + chunk).slice(-BUFFER_CHARS);
      // Scan once the burst goes quiet, not per chunk. A shell's line editor
      // repaints the command you typed using cursor escapes, so mid-burst the
      // buffer holds half-drawn text — `…:4402/` briefly reads as `…:44`.
      const now = Date.now();
      if (!tab.since) tab.since = now;
      clearTimeout(tab.timer);
      if (now - tab.since >= MAX_WAIT_MS) scan(id);
      else tab.timer = setTimeout(() => scan(id), SETTLE_MS);
    });

    // An agent's own words: the whole message, or a finished tool result.
    // (Streaming deltas are skipped — the complete message follows.)
    const agent = listen<{ threadId: string; event: { kind: string; text?: string; output?: string } }>(
      "executor-event",
      ({ payload }) => {
        if (!threads.current.includes(payload?.threadId)) return;
        const { event } = payload;
        const text = event.kind === "text" ? event.text : event.kind === "toolResult" ? event.output : undefined;
        if (text) found(detectDevServerUrls(text), "agent");
      }
    );

    return () => {
      for (const tab of tabs.values()) clearTimeout(tab.timer);
      void output.then((un) => un());
      void agent.then((un) => un());
    };
  }, [tracker, check]);

  const dismiss = useCallback(
    (url: string) => {
      tracker.remove(url);
      setServers(tracker.live());
    },
    [tracker]
  );

  return { servers, dismiss };
}
