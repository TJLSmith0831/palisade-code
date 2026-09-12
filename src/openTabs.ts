import { useCallback, useMemo, useRef, useState } from "react";

export type FileTab = {
  type: "file";
  path: string;
  /** Has unsaved edits. Owned here rather than by the editor pane: only the
   * active tab is mounted, so a pane-owned flag would be lost the moment you
   * switched away from a file you'd edited. */
  dirty: boolean;
  /** Whether the tab is showing the Markdown preview pane alongside the
   * WYSIWYG editor. Only meaningful for `.md`/`.markdown` files (which always
   * open in the RTE), but kept on every tab so it survives switching away
   * and back without resetting the view. */
  mdPreview: boolean;
};

export type SpecTab = {
  type: "spec";
  /** The OpenSpec change name, e.g. `vibe-spec-tabs`. */
  specName: string;
  /** Spec tabs are read-only (D4) — never dirty, no markdown preview. */
  dirty: false;
  mdPreview: false;
};

export type TableTab = {
  type: "table";
  /** Which saved connection this table belongs to — never its URL. */
  connectionId: string;
  connectionName: string;
  /** Null on SQLite, which has no schema layer. */
  schema: string | null;
  table: string;
  dirty: false;
  mdPreview: false;
};

export type QueryTab = {
  type: "query";
  connectionId: string;
  /** One query tab per connection, so its name is the connection's. */
  connectionName: string;
  dirty: false;
  mdPreview: false;
};

export type ChainTab = {
  type: "chain";
  /** The saved chain's name, or null for one being built from scratch. */
  chainName: string | null;
  dirty: false;
  mdPreview: false;
};

export type PreviewTab = {
  type: "preview";
  /** The URL loaded in the iframe, or null before anything is navigated to. */
  url: string | null;
  dirty: false;
  mdPreview: false;
};

export type OpenTab =
  | FileTab
  | SpecTab
  | TableTab
  | QueryTab
  | ChainTab
  | PreviewTab;

/** The stable string key for a tab — its identity in `activePath`, the
 * Mantine `Tabs` component, and session save/restore. File tabs use their
 * path; spec tabs use `spec:<name>` so `coerce` can recover them (D11, task 2.3).
 * Database tabs follow the same shape, keyed by connection so the same table
 * open on "dev" and on "staging" are two tabs, not one. */
export const tabKey = (tab: OpenTab): string => {
  switch (tab.type) {
    case "spec":
      return `spec:${tab.specName}`;
    case "table":
      return `table:${tab.connectionId}:${tab.schema ?? ""}:${tab.table}`;
    case "query":
      return `query:${tab.connectionId}`;
    // A new chain and a saved one are different tabs, so an unsaved draft
    // isn't replaced by clicking a saved chain in the sidebar.
    case "chain":
      return `chain:${tab.chainName ?? "new"}`;
    // Singleton: opening Preview again renavigates the one tab, it never
    // makes a second one (design.md, PreviewTab shape).
    case "preview":
      return "preview";
    default:
      return tab.path;
  }
};

/** How many closed tabs Cmd+Shift+T can walk back through. */
const REOPEN_DEPTH = 10;

/** Whether `path` is a Markdown file the RTE/preview applies to. Shared
 * by `TabBar` (button visibility), `FileEditorPane` (rendering guard), and
 * `open` (default RTE state) so there's one definition of "markdown". */
export const isMarkdownPath = (path: string | null): boolean => {
  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
};

/** Rewrites `path` when `from` is renamed to `to`, following directory
 * renames into their children. `null` when the path is unaffected. */
function renamedTo(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return null;
}

function isAtOrUnder(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/**
 * The set of files the editor has open, and which one is showing.
 *
 * Replaces the single `selectedFile` the app used to carry. Kept out of
 * `App.tsx` so the tab rules (what closing the active tab selects next,
 * how a directory rename propagates) are testable on their own and don't
 * add another hundred lines to a component that already has plenty.
 *
 * Spec tabs (D1) are first-class peers of file tabs: they share the same
 * list, the same selection/closing/cycling semantics, and the same
 * `activePath` key. A spec tab's key is `spec:<name>`; a file tab's key is
 * its path. File-only operations (`setDirty`, `setMdPreview`, `rename`,
 * `dropPath`) are no-ops on spec tabs.
 */
export function useOpenTabs() {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  // Recently closed keys, most recent last — the Cmd+Shift+T stack.
  const closed = useRef<string[]>([]);

  const open = useCallback((path: string) => {
    setTabs((current) =>
      current.some((tab) => tabKey(tab) === path)
        ? current
        : [
            ...current,
            { type: "file" as const, path, dirty: false, mdPreview: false },
          ]
    );
    setActivePath(path);
    closed.current = closed.current.filter((k) => k !== path);
  }, []);

  /** Adds a non-file tab, or re-selects it when it is already open. */
  const openTab = useCallback((tab: OpenTab) => {
    const key = tabKey(tab);
    setTabs((current) =>
      current.some((t) => tabKey(t) === key) ? current : [...current, tab]
    );
    setActivePath(key);
    closed.current = closed.current.filter((k) => k !== key);
  }, []);

  /** Open an OpenSpec change as a read-only spec tab (D1/D3). */
  const openSpec = useCallback(
    (specName: string) =>
      openTab({ type: "spec", specName, dirty: false, mdPreview: false }),
    [openTab]
  );

  /** Open a database table as a data-grid tab (D1). */
  const openTable = useCallback(
    (
      connectionId: string,
      connectionName: string,
      schema: string | null,
      table: string
    ) =>
      openTab({
        type: "table",
        connectionId,
        connectionName,
        schema,
        table,
        dirty: false,
        mdPreview: false,
      }),
    [openTab]
  );

  /** Open a chain on the canvas. The sidebar finds chains; the tab is where
   * they're built (DESIGN.md's side-panel rule). */
  const openChain = useCallback(
    (chainName: string | null) =>
      openTab({ type: "chain", chainName, dirty: false, mdPreview: false }),
    [openTab]
  );

  /** Open the SQL editor for a connection — one tab per connection. */
  const openQuery = useCallback(
    (connectionId: string, connectionName: string) =>
      openTab({
        type: "query",
        connectionId,
        connectionName,
        dirty: false,
        mdPreview: false,
      }),
    [openTab]
  );

  /** Open the singleton Preview tab, or focus/renavigate the one already
   * open. The single entry point for both the "+" menu (no url) and
   * dev-server auto-detection (a url) — D9/D11/D13. Passing no url keeps
   * whatever is already loaded. */
  const openPreview = useCallback((url?: string) => {
    setTabs((current) => {
      const existing = current.find((t) => t.type === "preview");
      if (!existing)
        return [
          ...current,
          {
            type: "preview" as const,
            url: url ?? null,
            dirty: false as const,
            mdPreview: false as const,
          },
        ];
      if (url === undefined || existing.url === url) return current;
      return current.map((t) =>
        t.type === "preview" ? { ...t, url } : t
      );
    });
    setActivePath("preview");
    closed.current = closed.current.filter((k) => k !== "preview");
  }, []);

  /** Removes tabs matching `matches`, keeping the selection sensible: when
   * the active tab goes, the neighbour to their right takes over, falling back
   * to the left (what every editor does). */
  const removeWhere = useCallback(
    (matches: (key: string) => boolean, remember: boolean) => {
      setTabs((current) => {
        const index = current.findIndex((tab) => matches(tabKey(tab)));
        if (index === -1) return current;
        const remaining = current.filter((tab) => !matches(tabKey(tab)));
        if (remember) {
          // Database tabs stay out of the reopen stack: a key alone can't
          // rebuild one (a query tab also carries its connection's name), and
          // they are one click away in the database panel regardless.
          const gone = current
            .filter((tab) => matches(tabKey(tab)))
            .filter((tab) => tab.type === "file" || tab.type === "spec")
            .map(tabKey);
          closed.current = [...closed.current, ...gone].slice(-REOPEN_DEPTH);
        }
        setActivePath((active) => {
          if (active !== null && !matches(active)) return active;
          if (remaining.length === 0) return null;
          return tabKey(remaining[Math.min(index, remaining.length - 1)]);
        });
        return remaining;
      });
    },
    []
  );

  const close = useCallback(
    (key: string) => removeWhere((candidate) => candidate === key, true),
    [removeWhere]
  );

  /** A file that no longer exists — dropped without offering to reopen it. */
  const dropPath = useCallback(
    (path: string) =>
      removeWhere((candidate) => isAtOrUnder(candidate, path), false),
    [removeWhere]
  );

  const rename = useCallback((from: string, to: string) => {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.type !== "file") return tab;
        const next = renamedTo(tab.path, from, to);
        return next === null ? tab : { ...tab, path: next };
      })
    );
    setActivePath((active) =>
      active === null ? null : (renamedTo(active, from, to) ?? active)
    );
  }, []);

  /**
   * Gives a chain tab the identity of the chain it was just saved as (D15) —
   * `from` is the tab's chain-tab key before saving (`null` for an unnamed
   * one, so its key was `chain:new`), `to` the name it was just saved under.
   * A no-op when `to` already matches, so saving an already-named chain
   * repeatedly doesn't thrash `activePath`.
   */
  const renameChain = useCallback((from: string | null, to: string) => {
    if (from === to) return;
    setTabs((current) =>
      current.map((tab) =>
        tab.type === "chain" && tab.chainName === from
          ? { ...tab, chainName: to }
          : tab
      )
    );
    setActivePath((active) =>
      active === tabKey({ type: "chain", chainName: from, dirty: false, mdPreview: false })
        ? tabKey({ type: "chain", chainName: to, dirty: false, mdPreview: false })
        : active
    );
  }, []);

  const setDirty = useCallback((path: string, dirty: boolean) => {
    setTabs((current) => {
      const tab = current.find((t) => tabKey(t) === path);
      if (!tab || tab.type !== "file" || tab.dirty === dirty) return current;
      return current.map((t) =>
        t.type === "file" && tabKey(t) === path ? { ...t, dirty } : t
      );
    });
  }, []);

  /** Toggles the Markdown preview pane for a tab. No-op for a path that isn't
   * open, so callers don't have to guard against a stale toggle firing after
   * a tab closes. */
  const setMdPreview = useCallback((path: string, mdPreview: boolean) => {
    setTabs((current) => {
      const tab = current.find((t) => tabKey(t) === path);
      if (!tab || tab.type !== "file" || tab.mdPreview === mdPreview)
        return current;
      return current.map((t) =>
        t.type === "file" && tabKey(t) === path ? { ...t, mdPreview } : t
      );
    });
  }, []);

  const closeAll = useCallback(() => {
    setTabs([]);
    setActivePath(null);
    closed.current = [];
  }, []);

  const reopenLast = useCallback(() => {
    const key = closed.current.pop();
    if (!key) return;
    if (key.startsWith("spec:")) {
      openSpec(key.slice("spec:".length));
    } else {
      open(key);
    }
  }, [open, openSpec]);

  /** Cycles in tab order rather than most-recently-used: MRU needs the
   * modifier held down to feel right, and discrete presses over tab order is
   * both simpler and predictable at the handful of tabs this app carries. */
  const cycle = useCallback(
    (direction: 1 | -1) => {
      setActivePath((active) => {
        if (tabs.length === 0) return null;
        const index = tabs.findIndex((tab) => tabKey(tab) === active);
        if (index === -1) return tabKey(tabs[0]);
        return tabKey(tabs[(index + direction + tabs.length) % tabs.length]);
      });
    },
    [tabs]
  );

  const activeTab = useMemo(
    () => tabs.find((tab) => tabKey(tab) === activePath) ?? null,
    [tabs, activePath]
  );

  return {
    tabs,
    activePath,
    activeTab,
    activeIsDirty: activeTab?.dirty ?? false,
    activeMdPreview: activeTab?.mdPreview ?? false,
    anyDirty: tabs.some((tab) => tab.dirty),
    open,
    openSpec,
    openTable,
    openChain,
    openQuery,
    openPreview,
    close,
    dropPath,
    rename,
    renameChain,
    setDirty,
    setMdPreview,
    closeAll,
    reopenLast,
    cycle,
  };
}

export type OpenTabs = ReturnType<typeof useOpenTabs>;
