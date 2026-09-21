import { useCallback, useRef, useState } from "react";
import * as api from "../api";
import type { ThreadMeta } from "../api";
import type { CommandBarRequest } from "../App";

/** What a thread action needs from the shell around it. */
type Deps = {
  projectHash: string | null;
  /** The thread on screen, so an action on it can update what is shown. */
  activeThread: ThreadMeta | null;
  setThread: (thread: ThreadMeta | null) => void;
  setThreads: (threads: ThreadMeta[]) => void;
  /** Raises the app's command bar — see `CommandBarRequest`. */
  setBar: (bar: CommandBarRequest) => void;
  /** Surfaces a failure to the user. */
  fail: (err: unknown) => void;
  /** Worktree state per thread, for the unmerged-work check on archive. */
  worktrees: Map<string, { clean: boolean; ahead: number; baseBranch: string }>;
  loadWorktrees: () => void;
  setThreadArchived: (
    hash: string,
    threadId: string,
    archived: boolean
  ) => Promise<unknown>;
  selectThread: (hash: string, next: ThreadMeta | null) => Promise<void>;
};

/**
 * Rename, archive and delete a thread.
 *
 * One slice out of App.tsx's 4,500-line body. These three belong together:
 * each raises the same command bar, each reconciles the thread list
 * afterwards, and each has to decide what happens to the thread on screen if
 * it was the one acted on.
 *
 * The rules worth not losing, each with a test:
 *
 * * Archiving is reversible and must stay that way, so it never discards work
 *   on its own. The backend's sweep prunes only a worktree whose commits the
 *   base branch already has; unmerged work is the one case the user has to
 *   answer for, offered as its own destructive choice.
 * * Deleting reselects only when the deleted thread was the open one (D22),
 *   mirroring selectProject's `found[0] ?? null` fallback.
 */
export function useThreadActions({
  projectHash,
  activeThread,
  setThread,
  setThreads,
  setBar,
  fail,
  worktrees,
  loadWorktrees,
  setThreadArchived,
  selectThread,
}: Deps) {
  // In-flight archives. The ref is the double-click guard (readable in the
  // same tick, stable identity); the state exists only so rows re-render.
  const inFlight = useRef(new Set<string>());
  const [archivingIds, setArchivingIds] = useState<ReadonlySet<string>>(new Set());
  /** Runs one archive while `id` shows as archiving. Every Archive entry
   *  point goes through this, so none of them looks dead while it works. A
   *  second call for the same id is dropped and resolves `undefined`. */
  const withArchiving = useCallback(<T,>(id: string, work: () => Promise<T>) => {
    if (inFlight.current.has(id)) return Promise.resolve(undefined);
    const sync = () => setArchivingIds(new Set(inFlight.current));
    inFlight.current.add(id);
    sync();
    return work().finally(() => {
      inFlight.current.delete(id);
      sync();
    });
  }, []);

  const onRenameThread = useCallback(
    (target: ThreadMeta) => {
      if (!projectHash) return;
      setBar({
        kind: "input",
        label: "Thread title",
        value: target.title,
        submit: async (title) => {
          try {
            const renamed = await api.renameThread(projectHash, target.id, title);
            if (activeThread?.id === target.id) setThread(renamed);
            setThreads(await api.listThreads(projectHash));
          } catch (err) {
            fail(err);
          }
        },
      });
    },
    [projectHash, activeThread?.id, setBar, setThread, setThreads, fail]
  );

  const onArchiveThread = useCallback(
    (target: ThreadMeta) => {
      if (!projectHash) return;
      const archiving = !target.archived;
      const worktree = worktrees.get(target.id);
      const unmerged =
        archiving && worktree && (!worktree.clean || worktree.ahead > 0);
      void withArchiving(target.id, async () => {
        // Capture sidebar order before archiving removes the target from the
        // default list; it defines what "next" means to the person reading it.
        const before = await api.listThreads(projectHash);
        await setThreadArchived(projectHash, target.id, archiving);
          loadWorktrees();
          // An archived thread must never remain in the chat pane. Pick its
          // visible neighbour from the pre-refresh order so the transition is
          // predictable, then reconcile the list from the store.
          const nextThreads = await api.listThreads(projectHash);
          setThreads(nextThreads);
          if (archiving && activeThread?.id === target.id) {
            const visible = nextThreads.filter((thread) => !thread.archived);
            const oldIndex = before.findIndex((thread) => thread.id === target.id);
            const nextId = before.slice(oldIndex + 1).find((thread) => !thread.archived)?.id
              ?? before.slice(0, oldIndex).reverse().find((thread) => !thread.archived)?.id;
            await selectThread(projectHash, visible.find((thread) => thread.id === nextId) ?? null);
          }
          if (!unmerged) return;
          setBar({
            kind: "confirm",
            label: `"${target.title}" still has work that ${worktree.baseBranch} doesn't. Delete its worktree and branch anyway?`,
            confirmLabel: "Clean up",
            onConfirm: async () => {
              setBar(null);
              try {
                await api.pruneThreadWorktree(projectHash, target.id, true);
                loadWorktrees();
              } catch (err) {
                fail(err);
              }
            },
          });
      }).catch(fail);
    },
    [projectHash, activeThread?.id, worktrees, setThreadArchived, loadWorktrees, setThreads, selectThread, setBar, fail, withArchiving]
  );

  const onDeleteThread = useCallback(
    (target: ThreadMeta) => {
      if (!projectHash) return;
      setBar({
        kind: "confirm",
        label: `Delete "${target.title}"? This can't be undone.`,
        onConfirm: async () => {
          setBar(null);
          try {
            await api.deleteThread(projectHash, target.id);
            const found = await api.listThreads(projectHash);
            setThreads(found);
            if (activeThread?.id === target.id)
              await selectThread(projectHash, found[0] ?? null);
          } catch (err) {
            fail(err);
          }
        },
      });
    },
    [projectHash, activeThread?.id, setBar, setThreads, selectThread, fail]
  );

  return { onRenameThread, onArchiveThread, onDeleteThread, archivingIds, withArchiving };
}
