import { profileStorage as localStorage } from "../profileStorage";
import { useCallback, useState } from "react";
import * as api from "../api";
import type { ThreadMeta } from "../api";

/**
 * Per-thread preferences, and the one pending choice that has nowhere to live
 * yet.
 *
 * Pulled out of App.tsx, which held 50 useState calls in a single 4,500-line
 * component. This is one of the coherent slices: the storage key, the parse,
 * the defaulting rule, the toggles and the create-a-thread path that applies a
 * choice made before the thread existed — all of which only ever move
 * together. The fifth hook in this directory, following the shape the other
 * four already set.
 */

export type ThreadPrefs = { bypass: boolean };

const threadPrefsKey = (hash: string, threadId: string) =>
  `palisade:thread-prefs:${hash}:${threadId}`;

const getThreadPrefs = (hash: string, threadId: string): ThreadPrefs | null => {
  const raw = localStorage.getItem(threadPrefsKey(hash, threadId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ThreadPrefs>;
    if (typeof parsed.bypass === "boolean") {
      return { bypass: parsed.bypass };
    }
  } catch {
    // fall through to default
  }
  return null;
};

export const setThreadPrefs = (
  hash: string,
  threadId: string,
  prefs: ThreadPrefs
) => {
  localStorage.setItem(threadPrefsKey(hash, threadId), JSON.stringify(prefs));
};

// Every never-configured thread starts in Accept mode (D6) — no global
// default a thread's own toggle could silently promote for every other one.
export const resolvePrefs = (hash: string, threadId: string): ThreadPrefs =>
  getThreadPrefs(hash, threadId) ?? { bypass: false };

export function useThreadPrefs() {
  // The thread's *next* session flags. Only the permission-mode toggle below
  // writes these; the effective values are resolved before each
  // session-starting call so a live session keeps its original flags
  // (design.md Decision 2).
  const [threadPrefs, setThreadPrefsState] = useState<ThreadPrefs>({
    bypass: false,
  });
  const [prefsMenuOpen, setPrefsMenuOpen] = useState(false);

  /** The worktree choice made in a composer that has no thread yet, handed to
   *  whichever thread gets created next. Sticky for the session and always
   *  reflected by the composer's badge, so it is never a hidden setting. */
  const [pendingWorktreeEnabled, setPendingWorktreeEnabled] = useState(true);

  /** Adopt whatever the given thread has stored. */
  const loadFor = useCallback((hash: string, threadId: string) => {
    setThreadPrefsState(resolvePrefs(hash, threadId));
  }, []);

  /** Flip this thread's permission mode, storing it as we go. */
  const toggleBypass = useCallback(
    (hash: string, threadId: string) => {
      const prefs = { bypass: !threadPrefs.bypass };
      setThreadPrefs(hash, threadId, prefs);
      setThreadPrefsState(prefs);
    },
    [threadPrefs.bypass]
  );

  /** Create a thread and apply that pending choice to it. Every creation path
   *  goes through here so the choice cannot be dropped by whichever route the
   *  user happened to take into a new thread. */
  const createThreadWithPrefs = useCallback(
    async (projectHash: string, title = "New thread"): Promise<ThreadMeta> => {
      const created = await api.createThread(projectHash, title);
      if (pendingWorktreeEnabled) return created;
      try {
        return await api.setThreadWorktreeEnabled(projectHash, created.id, false);
      } catch {
        // A project that isn't a git repo has no isolation to turn off. The
        // thread is still fine, so don't fail creation over it.
        return created;
      }
    },
    [pendingWorktreeEnabled]
  );

  return {
    threadPrefs,
    setThreadPrefsState,
    prefsMenuOpen,
    setPrefsMenuOpen,
    pendingWorktreeEnabled,
    setPendingWorktreeEnabled,
    loadFor,
    toggleBypass,
    createThreadWithPrefs,
  };
}

export type ThreadPrefsState = ReturnType<typeof useThreadPrefs>;
