import {
  LSPClient,
  languageServerExtensions,
  type LSPClientConfig,
} from "@codemirror/lsp-client";
import * as api from "./api";
import { makeTransport } from "./lsp";

// One LSPClient per (project, language) — D15's "per language per project"
// lifecycle, held here rather than in the editor component so switching
// files (or closing a tab) doesn't restart the server.

export type Diagnostic = {
  /** Project-relative path, so the Problems tab can open the file. */
  path: string;
  line: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source: string | null;
};

type Entry = {
  client: LSPClient;
  transport: ReturnType<typeof makeTransport>;
};

const clients = new Map<string, Entry>();

/** Every diagnostic currently published, keyed by file URI. */
const diagnostics = new Map<string, Diagnostic[]>();

export const DIAGNOSTICS_CHANGED = "floo:lsp-diagnostics";

const SEVERITY: Record<number, Diagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

/** LSP's `PublishDiagnosticsParams` → the flat rows the Problems tab shows. */
export function toDiagnostics(
  params: { uri: string; diagnostics?: unknown[] },
  projectRoot: string
): Diagnostic[] {
  const prefix = `file://${projectRoot.replace(/\/$/, "")}/`;
  const decoded = decodeURI(params.uri);
  const path = decoded.startsWith(prefix)
    ? decoded.slice(prefix.length)
    : decoded.replace(/^file:\/\//, "");
  return (params.diagnostics ?? []).map((raw) => {
    const d = raw as {
      range?: { start?: { line?: number } };
      severity?: number;
      message?: string;
      source?: string;
    };
    return {
      path,
      // LSP lines are 0-based; every UI that shows a line number is 1-based.
      line: (d.range?.start?.line ?? 0) + 1,
      severity: SEVERITY[d.severity ?? 1] ?? "error",
      message: d.message ?? "",
      source: d.source ?? null,
    };
  });
}

/** Worst-first, then by file and line — an error 400 lines down still
 *  outranks a hint at the top. */
export function sortDiagnostics(rows: Diagnostic[]): Diagnostic[] {
  const rank = { error: 0, warning: 1, info: 2, hint: 3 };
  return [...rows].sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      a.path.localeCompare(b.path) ||
      a.line - b.line
  );
}

export function allDiagnostics(): Diagnostic[] {
  return sortDiagnostics([...diagnostics.values()].flat());
}

/** Test seam and project-switch reset. */
export function clearDiagnostics() {
  diagnostics.clear();
  window.dispatchEvent(new Event(DIAGNOSTICS_CHANGED));
}

/** Records what a server just said about one file. Exported because it is
 *  the single ingest point for the Problems tab — the notification handler
 *  below is one caller, not the only possible one. */
export function publishDiagnostics(uri: string, rows: Diagnostic[]) {
  // An empty list means "this file is clean now" — dropping the key is what
  // makes a fixed error disappear from the Problems tab.
  if (rows.length === 0) diagnostics.delete(uri);
  else diagnostics.set(uri, rows);
  window.dispatchEvent(new Event(DIAGNOSTICS_CHANGED));
}

/**
 * The client for one language in one project, started on first use. Returns
 * null when the backend has no server to offer — the editor then runs with
 * syntax highlighting alone, which is the whole point of D14's graceful
 * degradation.
 */
export async function clientFor(
  projectHash: string,
  projectRoot: string,
  language: string
): Promise<LSPClient | null> {
  const key = `${projectHash}:${language}`;
  const existing = clients.get(key);
  if (existing) return existing.client;

  const status = await api.lspStart(projectHash, language);
  if (status.state !== "running") return null;

  const transport = makeTransport(projectHash, language);
  const config: LSPClientConfig = {
    rootUri: `file://${projectRoot}`,
    extensions: languageServerExtensions(),
    notificationHandlers: {
      "textDocument/publishDiagnostics": (_client, params) => {
        publishDiagnostics(
          (params as { uri: string }).uri,
          toDiagnostics(params as { uri: string }, projectRoot)
        );
        // false: the built-in `serverDiagnostics()` extension still gets it
        // and draws the in-editor squiggles.
        return false;
      },
    },
  };
  const client = new LSPClient(config);
  client.connect(transport);
  clients.set(key, { client, transport });
  return client;
}

/** Tears down every client for a project — call on project switch. */
export async function disposeProject(projectHash: string) {
  for (const [key, entry] of [...clients]) {
    if (!key.startsWith(`${projectHash}:`)) continue;
    entry.transport.dispose();
    clients.delete(key);
  }
  clearDiagnostics();
  await api.lspShutdown(projectHash).catch(() => {
    // Nothing running is the same outcome as shutting it down.
  });
}
