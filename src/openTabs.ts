import { useCallback, useMemo, useRef, useState } from "react";

export type OpenTab = {
  path: string;
  /** Has unsaved edits. Owned here rather than by the editor pane: only the
   * active tab is mounted, so a pane-owned flag would be lost the moment you
   * switched away from a file you'd edited. */
  dirty: boolean;
};

/** How many closed tabs Cmd+Shift+T can walk back through. */
const REOPEN_DEPTH = 10;

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
 */
export function useOpenTabs() {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  // Recently closed, most recent last — the Cmd+Shift+T stack.
  const closed = useRef<string[]>([]);

  const open = useCallback((path: string) => {
    setTabs((current) =>
      current.some((tab) => tab.path === path) ? current : [...current, { path, dirty: false }]
    );
    setActivePath(path);
    closed.current = closed.current.filter((p) => p !== path);
  }, []);

  /** Removes tabs matching `matches`, keeping the selection sensible: when
   * the active tab goes, the neighbour to its right takes over, falling back
   * to the left (what every editor does). */
  const removeWhere = useCallback((matches: (path: string) => boolean, remember: boolean) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => matches(tab.path));
      if (index === -1) return current;
      const remaining = current.filter((tab) => !matches(tab.path));
      if (remember) {
        const gone = current.filter((tab) => matches(tab.path)).map((tab) => tab.path);
        closed.current = [...closed.current, ...gone].slice(-REOPEN_DEPTH);
      }
      setActivePath((active) => {
        if (active !== null && !matches(active)) return active;
        if (remaining.length === 0) return null;
        return remaining[Math.min(index, remaining.length - 1)].path;
      });
      return remaining;
    });
  }, []);

  const close = useCallback(
    (path: string) => removeWhere((candidate) => candidate === path, true),
    [removeWhere]
  );

  /** A file that no longer exists — dropped without offering to reopen it. */
  const dropPath = useCallback(
    (path: string) => removeWhere((candidate) => isAtOrUnder(candidate, path), false),
    [removeWhere]
  );

  const rename = useCallback((from: string, to: string) => {
    setTabs((current) =>
      current.map((tab) => {
        const next = renamedTo(tab.path, from, to);
        return next === null ? tab : { ...tab, path: next };
      })
    );
    setActivePath((active) => (active === null ? null : renamedTo(active, from, to) ?? active));
  }, []);

  const setDirty = useCallback((path: string, dirty: boolean) => {
    setTabs((current) => {
      const tab = current.find((t) => t.path === path);
      if (!tab || tab.dirty === dirty) return current;
      return current.map((t) => (t.path === path ? { ...t, dirty } : t));
    });
  }, []);

  const closeAll = useCallback(() => {
    setTabs([]);
    setActivePath(null);
    closed.current = [];
  }, []);

  const reopenLast = useCallback(() => {
    const path = closed.current.pop();
    if (path) open(path);
  }, [open]);

  /** Cycles in tab order rather than most-recently-used: MRU needs the
   * modifier held down to feel right, and discrete presses over tab order is
   * both simpler and predictable at the handful of tabs this app carries. */
  const cycle = useCallback(
    (direction: 1 | -1) => {
      setActivePath((active) => {
        if (tabs.length === 0) return null;
        const index = tabs.findIndex((tab) => tab.path === active);
        if (index === -1) return tabs[0].path;
        return tabs[(index + direction + tabs.length) % tabs.length].path;
      });
    },
    [tabs]
  );

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.path === activePath) ?? null,
    [tabs, activePath]
  );

  return {
    tabs,
    activePath,
    activeTab,
    activeIsDirty: activeTab?.dirty ?? false,
    anyDirty: tabs.some((tab) => tab.dirty),
    open,
    close,
    dropPath,
    rename,
    setDirty,
    closeAll,
    reopenLast,
    cycle,
  };
}
