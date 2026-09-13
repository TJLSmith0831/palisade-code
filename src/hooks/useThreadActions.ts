import { useCallback } from "react";
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
      setThreadArchived(projectHash, target.id, archiving)
        .then(() => {
          loadWorktrees();
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
        })
        .catch(fail);
    },
    [projectHash, worktrees, setThreadArchived, loadWorktrees, setBar, fail]
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

  return { onRenameThread, onArchiveThread, onDeleteThread };
}
