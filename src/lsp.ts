import { listen } from "@tauri-apps/api/event";
import type { Transport } from "@codemirror/lsp-client";
import * as api from "./api";

// The frontend half of Amendment 2. `@codemirror/lsp-client` needs a
// Transport — three methods — and Tauri's command + event channel is one,
// so there is no WebSocket bridge here (see `src-tauri/src/lsp.rs`'s note).

/** File extension → the LSP `languageId` Palisade starts a server for. Mirrors
 *  `SERVERS` in `src-tauri/src/lsp.rs`; a language missing here just means
 *  no server is started, and the editor keeps its syntax highlighting. */
const byExtension: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  json: "json",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
};

/** Which *server* serves this file, or null when Palisade knows none. One
 *  server covers several document languages: typescript-language-server
 *  handles .ts and .tsx alike. */
export function languageForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  return (ext && byExtension[ext]) ?? null;
}

/** The `languageId` the *document* is opened with. Distinct from the server
 *  key: a .tsx opened as "typescript" makes the server parse JSX as
 *  comparison operators and report a file full of syntax errors that
 *  aren't there. */
export function documentLanguageId(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "tsx") return "typescriptreact";
  if (ext === "jsx") return "javascriptreact";
  return languageForPath(path);
}

/** A `file://` URI for a project-relative path. */
export function fileUri(projectRoot: string, relativePath: string): string {
  const root = projectRoot.replace(/\/$/, "");
  // Only the path segments are encoded — the separators have to survive.
  const encoded = `${root}/${relativePath}`
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `file://${encoded}`;
}

/**
 * A Transport for one language server. Subscribers get every JSON-RPC body
 * that server sends; `send` writes one back.
 *
 * The event stream carries every language's traffic, so each transport
 * filters for its own — one listener per language would multiply listeners
 * for no gain.
 */
export function makeTransport(
  projectHash: string,
  language: string
): Transport & { dispose: () => void } {
  const handlers = new Set<(value: string) => void>();
  const unlisten = listen<{ language: string; body: string }>(
    "lsp-message",
    (event) => {
      if (event.payload.language !== language) return;
      for (const handler of handlers) handler(event.payload.body);
    }
  );

  return {
    send(message: string) {
      void api.lspSend(projectHash, language, message).catch(() => {
        // A dead server is reported through `lsp-status`, which the status
        // bar already shows — throwing here would take the editor with it.
      });
    },
    subscribe(handler: (value: string) => void) {
      handlers.add(handler);
    },
    unsubscribe(handler: (value: string) => void) {
      handlers.delete(handler);
    },
    dispose() {
      handlers.clear();
      void unlisten.then((off) => off());
    },
  };
}

/** The status-bar label for a server state — short, and never just "off". */
export function stateLabel(status: api.LspStatus | null): string {
  if (!status) return "No language server";
  switch (status.state) {
    case "running":
      return `${status.server} running`;
    case "starting":
      return `${status.server} starting…`;
    case "crashed":
      return `${status.server} crashed — restarting (${status.restarts}/3)`;
    case "disabled":
      return `${status.server} disabled after ${status.restarts} crashes`;
    case "notInstalled":
      return `${status.server} not installed`;
    case "unsupported":
      return "No language server for this file";
  }
}

/** Which semantic token the dot uses — colour is never the only signal. */
export function stateTone(state: api.LspState | null): string {
  switch (state) {
    case "running":
      return "success";
    case "starting":
    case "crashed":
      return "warn";
    case "disabled":
      return "bad";
    default:
      return "muted";
  }
}
