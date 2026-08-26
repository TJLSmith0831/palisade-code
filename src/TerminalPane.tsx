import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import * as api from "./api";

type Props = {
  projectHash: string;
  /** Which tab's PTY this view is attached to. */
  terminalId: string;
  /** False while another tab is showing: the pane stays mounted (so its
      shell keeps running) but skips the fit/focus work it can't do hidden. */
  visible?: boolean;
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

export default function TerminalPane({ projectHash, terminalId, visible = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);

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

    api.terminalSpawn(projectHash, terminalId).catch((err) => {
      // A PTY that can't start (fd exhaustion, a missing $SHELL, the
      // per-project tab limit) has to say so where the user is looking —
      // an empty black rectangle reads as "still loading" forever.
      term.writeln(`\r\n[terminal error: ${err}]`);
    });

    const onData = term.onData((data) => {
      api.terminalInput(terminalId, data).catch(() => {});
    });
    // fit() (initial + on host resize below) triggers this with the new
    // dimensions, which is also how the PTY hears about a panel drag-resize.
    const onResize = term.onResize(({ cols, rows }) => {
      api.terminalResize(terminalId, cols, rows).catch(() => {});
    });

    const unlisten = listen<{ terminalId: string; data: string }>(
      "terminal-output",
      ({ payload }) => {
        // Every tab hears every tab's output; only render our own, or two
        // open terminals would interleave into each other.
        if (payload.terminalId !== terminalId) return;
        // Bytes, not text: decoding each chunk as UTF-8 independently would
        // corrupt a multi-byte character split across a read boundary.
        // xterm's own write() keeps decoder state across calls, so hand it
        // raw bytes and let it reassemble anything split (App.tsx D45/D46).
        const bytes = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
        term.write(bytes);
      }
    );

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
      onData.dispose();
      onResize.dispose();
      unlisten.then((un) => un());
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
