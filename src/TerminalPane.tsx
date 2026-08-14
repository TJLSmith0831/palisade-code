import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import * as api from "./api";

type Props = {
  projectHash: string;
  placement: "bottom" | "sidebar";
  onTogglePlacement: () => void;
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

export default function TerminalPane({ projectHash, placement, onTogglePlacement }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "'Geist Mono', 'SF Mono', ui-monospace, Menlo, monospace",
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
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    api
      .terminalSpawn(projectHash)
      .then((replaced) => {
        // Only one terminal exists at a time, so switching projects kills
        // the previous project's shell. Say so in the terminal itself
        // rather than letting a running build vanish without a word.
        if (replaced) {
          term.writeln(`\r\n[closed the terminal for "${replaced}" — one shell at a time]`);
        }
      })
      .catch((err) => term.writeln(`\r\n[terminal error: ${err}]`));

    const onData = term.onData((data) => {
      api.terminalInput(data).catch(() => {});
    });
    // fit() (initial + on host resize below) triggers this with the new
    // dimensions, which is also how the PTY hears about a panel drag-resize.
    const onResize = term.onResize(({ cols, rows }) => {
      api.terminalResize(cols, rows).catch(() => {});
    });

    const unlisten = listen<string>("terminal-output", ({ payload }) => {
      // Bytes, not text: decoding each chunk as UTF-8 independently would
      // corrupt a multi-byte character split across a read boundary.
      // xterm's own write() keeps decoder state across calls, so hand it
      // raw bytes and let it reassemble anything split (App.tsx D45/D46).
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      term.write(bytes);
    });

    const resizeObserver = new ResizeObserver(() => fit.fit());
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
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
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
    };
  }, [projectHash]);

  return (
    <div className="ds-terminal-pane" data-testid="terminal-pane">
      {/* In the bottom panel the tab strip above already says "Terminal" and
          carries the placement control — a second header there was pure
          duplicate chrome. In the sidebar there is no strip, so it stays. */}
      {placement === "sidebar" && (
        <div className="ds-editor-toolbar">
          <span className="ds-editor-path">Terminal</span>
          <span className="ds-editor-spacer" />
          <button
            className="ds-editor-save-btn"
            onClick={onTogglePlacement}
            data-testid="terminal-placement-toggle"
          >
            Move to bottom
          </button>
        </div>
      )}
      <div className="ds-terminal-host" ref={hostRef} data-testid="terminal-host" />
    </div>
  );
}
