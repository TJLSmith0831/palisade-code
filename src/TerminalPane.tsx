import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import * as api from "./api";
import { localUrlsIn, openableUrl } from "./detectDevServerUrl";

type TerminalOutput = { terminalId: string; data: string; offset: number };

type Props = {
  projectHash: string;
  /** Which tab's PTY this view is attached to. */
  terminalId: string;
  /** False while another tab is showing: the pane stays mounted (so its
      shell keeps running) but skips the fit/focus work it can't do hidden. */
  visible?: boolean;
  /** Called when a local URL in the output is ⌘-clicked (Ctrl-click off macOS). */
  onOpenUrl?: (url: string) => void;
};

// xterm's canvas renderer doesn't accept the app's oklch() custom-property
// strings as fillStyle (silently falls back to its own black-on-white
// defaults — observed live in light mode). Resolving through a throwaway
// element gives back the browser's own computed rgb()/rgba() form, which
// canvas always accepts, regardless of what color syntax the var uses.
function resolveCssColor(varExpr: string): string {
  const probe = document.createElement("div");
  probe.style.color = varExpr;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  return resolved;
}

export default function TerminalPane({ projectHash, terminalId, visible = true, onOpenUrl }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Through a ref so the link handler always calls the current callback
  // without the terminal being rebuilt whenever a parent re-renders.
  const openUrlRef = useRef(onOpenUrl);
  openUrlRef.current = onOpenUrl;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--mono")
        .trim(),
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: resolveCssColor("var(--editor-bg)"),
        foreground: resolveCssColor("var(--fg)"),
        cursor: resolveCssColor("var(--accent)"),
        selectionBackground: resolveCssColor("var(--border)"),
      },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    // Local URLs in the output are links. Modifier-click, like every editor's
    // terminal: a plain click is how you start selecting text.
    const links = term.registerLinkProvider({
      provideLinks: (line, done) => {
        const text = term.buffer.active.getLine(line - 1)?.translateToString(true) ?? "";
        const found = localUrlsIn(text).map(({ start, text: url }) => ({
          text: url,
          range: { start: { x: start + 1, y: line }, end: { x: start + url.length, y: line } },
          activate: (event: MouseEvent) => {
            const target = openableUrl(url);
            if ((event.metaKey || event.ctrlKey) && target) openUrlRef.current?.(target);
          },
        }));
        done(found.length ? found : undefined);
      },
    });

    // Attach protocol: listen first, then spawn. The spawn call hands back the
    // tab's recent output, and live chunks that raced it are held in `pending`
    // and replayed minus whatever the backlog already contains (by offset).
    // Listening after spawning lost the shell's first prompt, and a view that
    // attached to a running shell (second window, first Run) saw nothing.
    let disposed = false;
    let attached = false;
    let exited = false;
    let attachedEnd = 0;
    const pending: TerminalOutput[] = [];

    const toBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const render = (chunk: TerminalOutput) => {
      if (chunk.offset < attachedEnd) return;
      // Bytes, not text: decoding each chunk as UTF-8 independently would
      // corrupt a multi-byte character split across a read boundary.
      // xterm's own write() keeps decoder state across calls, so hand it
      // raw bytes and let it reassemble anything split (App.tsx D45/D46).
      term.write(toBytes(chunk.data));
    };

    const attach = async () => {
      attached = false;
      try {
        const result = await api.terminalSpawn(projectHash, terminalId);
        if (disposed) return;
        term.reset();
        attachedEnd = result.end;
        if (result.backlog) term.write(toBytes(result.backlog));
        attached = true;
        pending.splice(0).forEach(render);
        // xterm was sized before the PTY existed, so its resize event had
        // nobody to tell; without this the shell stays at 80x24.
        api.terminalResize(terminalId, term.cols, term.rows).catch(() => {});
      } catch (err) {
        // A PTY that can't start (fd exhaustion, a missing $SHELL, the
        // per-project tab limit) has to say so where the user is looking —
        // an empty black rectangle reads as "still loading" forever.
        term.writeln(`\r\n[terminal error: ${err}]`);
      }
    };

    const onData = term.onData((data) => {
      if (exited) {
        // The shell ended on its own; any key starts a fresh one.
        exited = false;
        void attach();
        return;
      }
      if (attached) api.terminalInput(terminalId, data).catch(() => {});
    });
    // fit() on host resize below triggers this with the new dimensions,
    // which is also how the PTY hears about a panel drag-resize.
    const onResize = term.onResize(({ cols, rows }) => {
      if (attached) api.terminalResize(terminalId, cols, rows).catch(() => {});
    });

    const unlisten = Promise.all([
      listen<TerminalOutput>("terminal-output", ({ payload }) => {
        // Every tab hears every tab's output; only render our own, or two
        // open terminals would interleave into each other.
        if (payload.terminalId !== terminalId) return;
        if (attached) render(payload);
        else pending.push(payload);
      }),
      listen<{ terminalId: string }>("terminal-exit", ({ payload }) => {
        if (payload.terminalId !== terminalId) return;
        exited = true;
        attached = false;
        term.writeln("\r\n[process exited — press any key to restart]");
      }),
    ]);
    void unlisten.then(() => {
      if (!disposed) void attach();
    });

    const resizeObserver = new ResizeObserver(() => {
      // A hidden pane has zero height; fitting against it would tell the PTY
      // the window is 0 rows and reflow the running program's output.
      if (host.clientHeight > 0) fit.fit();
    });
    resizeObserver.observe(host);

    // Live theme toggle (App.tsx's data-theme attribute) or an "auto" user
    // switching OS appearance — re-resolve and hand xterm a fresh theme
    // object rather than waiting for the terminal to remount.
    const applyTheme = () => {
      term.options.theme = {
        background: resolveCssColor("var(--editor-bg)"),
        foreground: resolveCssColor("var(--fg)"),
        cursor: resolveCssColor("var(--accent)"),
        selectionBackground: resolveCssColor("var(--border)"),
      };
    };
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const colorScheme = window.matchMedia("(prefers-color-scheme: light)");
    colorScheme.addEventListener("change", applyTheme);

    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      colorScheme.removeEventListener("change", applyTheme);
      disposed = true;
      links.dispose();
      onData.dispose();
      onResize.dispose();
      void unlisten.then((offs) => offs.forEach((off) => off()));
      term.dispose();
      fitRef.current = null;
      // Deliberately does NOT kill the PTY: unmounting is a view concern
      // (panel collapsed, project switched), and the shell outlives it so a
      // running build survives. TerminalTabs owns the shell's lifetime.
    };
  }, [projectHash, terminalId]);

  // Becoming visible again means the host went from zero height to real
  // height, which the ResizeObserver above saw while it was still hidden.
  useEffect(() => {
    if (visible) fitRef.current?.fit();
  }, [visible]);

  return (
    <div
      className="ds-terminal-pane"
      data-testid="terminal-pane"
      // Hidden, not unmounted: unmounting disposes the xterm view, and we
      // want the tab's scrollback and its running process both intact.
      style={visible ? undefined : { display: "none" }}
    >
      {/* No header of its own: the tab strip above already names it and
          carries the placement control. */}
      <div className="ds-terminal-host" ref={hostRef} data-testid="terminal-host" />
    </div>
  );
}
