import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Modal as MantineModal,
  Progress,
  SegmentedControl,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconChevronRight,
  IconFoldDown,
  IconFoldUp,
  IconPencil,
  IconGitBranch,
  IconMinus,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import type { StructuredPatch, StructuredPatchHunk } from "diff";

import * as api from "./api";
import type { FileStatus, GraphCommit } from "./api";
import DiffRows from "./DiffRows";
import EditableDiffView from "./EditableDiffView";
import type { DiffView } from "./DiffRows";
import { describeError } from "./errors";
import { isOneSided, rowsFromHunk } from "./diffLines";
import { parseFilePatches, patchForHunk, pathFromPatch } from "./gitDiff";
import { relativeTime } from "./SessionList";

/** Survives remounts and app restarts: a reviewer who wants side-by-side
 *  wants it for the whole review, not for one file. */
const VIEW_KEY = "palisade.diffView";

type Props = {
  projectHash: string;
  /** Which working tree to show: this thread's isolated worktree when it has
   *  one, the project root otherwise.
   *
   *  Every write below is routed through the same id, so staging and
   *  discarding act on the tree that is actually on screen. An earlier
   *  revision made the pane read-only whenever this was set — writes went to
   *  the project root regardless, so the only safe thing to do was offer
   *  nothing. Routing them fixes the cause; the buttons come back. */
  threadId?: string;
  /** Show only this file's diff — set when a row in the Source Control
   *  panel is clicked, so "click a change" lands on that change rather
   *  than on the whole working tree. */
  focusPath?: string | null;
  onClearFocus?: () => void;
  /** Show this commit's diff instead of the working tree — set when a row
   *  in the Source Control panel's graph is clicked. Takes priority over
   *  `focusPath`: a commit and a working-tree file focus are two different
   *  questions ("what changed here" vs "what's still uncommitted"). */
  commit?: GraphCommit | null;
  onClearCommit?: () => void;
  /** Bumped when something outside this pane changed the working tree — an
   * agent turn finishing, or a save. Without it the diff is whatever it was
   * when the pane mounted, which is stale the moment the agent writes. */
  refreshToken?: number;
};

/** One changed file: its size at a glance, its diff on demand, and the two
 *  ways to act on it.
 *
 *  There is one list, not a list *and* a stack of every diff below it — the
 *  panel is narrow, and the same file appearing twice made it impossible to
 *  tell what the pane was for. The chevron expands this file's diff in place
 *  with its staging actions; the filename opens it as a real editable buffer.
 *
 *  ponytail: the bar is add/remove *ratio*, not magnitude, so a 2-line file
 *  and a 200-line one can look alike. Scale by total if that misleads. */
function ChangedFileRow({
  path,
  added,
  removed,
  isNew,
  expanded,
  onToggle,
  onOpen,
  children,
}: {
  path: string;
  added: number;
  removed: number;
  isNew: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  children?: React.ReactNode;
}) {
  const total = added + removed || 1;
  return (
    <div className="diff-scan-file" data-testid="diff-scan-file" data-path={path}>
      <Group gap={8} px={12} py={7} wrap="nowrap" className="diff-scan-row">
        <ActionIcon
          size="sm"
          variant="subtle"
          onClick={onToggle}
          aria-label={expanded ? `Collapse ${path}` : `Expand ${path}`}
          aria-expanded={expanded}
          data-testid="diff-row-expand"
        >
          <IconChevronRight
            size={13}
            style={{ transform: expanded ? "rotate(90deg)" : undefined }}
          />
        </ActionIcon>
        <Badge size="xs" variant="light" color={isNew ? "success" : "warn"}>
          {isNew ? "new" : "mod"}
        </Badge>
        <UnstyledButton
          onClick={onOpen}
          title={`Open ${path}`}
          style={{ flex: 1, minWidth: 0, textAlign: "left" }}
          data-testid="diff-row-open"
        >
          <Text size="xs" ff="monospace" truncate>
            {path}
          </Text>
        </UnstyledButton>
        <Progress.Root size="sm" style={{ width: 70, flex: "none" }}>
          <Progress.Section value={(added / total) * 100} color="success" />
          <Progress.Section value={(removed / total) * 100} color="danger" />
        </Progress.Root>
        <Text size="xs" ff="monospace" c="dimmed" style={{ width: 62, textAlign: "right" }}>
          +{added} −{removed}
        </Text>
        {/* The filename opens the file too, but a name that happens to be
            clickable is not an affordance — this is the one that says so. */}
        <Tooltip label={`Edit ${path}`} openDelay={300}>
          <ActionIcon
            size="sm"
            variant="subtle"
            onClick={onOpen}
            aria-label={`Edit ${path}`}
            data-testid="diff-row-edit"
          >
            <IconPencil size={13} />
          </ActionIcon>
        </Tooltip>
      </Group>
      {expanded && children}
    </div>
  );
}

/** Adds and removes in one file's patch, for the scan row's bar. */
export function patchStat(file: StructuredPatch): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}

function FileDiff({
  file,
  actionLabel,
  onHunkAction,
  onStageAll,
  onDiscard,
  busy,
  view,
}: {
  file: StructuredPatch;
  actionLabel: string;
  onHunkAction?: (hunk: StructuredPatchHunk) => void;
  onStageAll?: () => void;
  onDiscard?: () => void;
  busy: boolean;
  view: DiffView;
}) {
  // An added or deleted file has no opposite side, so side-by-side would put
  // a full-height column of blank cells next to it — indistinguishable from a
  // broken render. Decided per file rather than per hunk so the columns don't
  // flip partway down, and left as the reviewer's own toggle everywhere else.
  const rowsByHunk = file.hunks.map((hunk) => rowsFromHunk(hunk));
  const effectiveView: DiffView =
    view === "split" && rowsByHunk.every(isOneSided) ? "inline" : view;
  return (
    <div className="diff-file" data-testid="diff-file">
      <div className="diff-file-head">
        <span className="diff-file-path">{pathFromPatch(file)}</span>
        <span className="diff-spacer" />
        {onDiscard && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="danger"
            leftSection={<IconTrash size={12} />}
            onClick={onDiscard}
            disabled={busy}
            data-testid="discard-btn"
          >
            Discard
          </Button>
        )}
        {onStageAll && (
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconPlus size={12} />}
            onClick={onStageAll}
            disabled={busy}
            data-testid="stage-all-btn"
          >
            Stage all
          </Button>
        )}
      </div>
      {file.hunks.map((hunk, i) => (
        <div key={i} className="diff-hunk">
          {onHunkAction && (
            <div className="diff-hunk-head">
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={
                  actionLabel === "Unstage hunk" ? (
                    <IconMinus size={12} />
                  ) : (
                    <IconPlus size={12} />
                  )
                }
                onClick={() => onHunkAction(hunk)}
                disabled={busy}
                data-testid="hunk-action-btn"
              >
                {actionLabel}
              </Button>
            </div>
          )}
          <DiffRows rows={rowsByHunk[i]} view={effectiveView} />
        </div>
      ))}
    </div>
  );
}

export default function DiffPane({
  projectHash,
  threadId,
  refreshToken,
  focusPath,
  onClearFocus,
  commit,
  onClearCommit,
}: Props) {
  /** A thread's worktree is the ordinary case now, not a special read-only
   *  one — used only to word the empty state for whose tree it is. */
  const isWorktree = threadId !== undefined;
  const [isRepo, setIsRepo] = useState(true);
  const [status, setStatus] = useState<FileStatus[]>([]);
  const [workingFiles, setWorkingFiles] = useState<StructuredPatch[]>([]);
  const [stagedFiles, setStagedFiles] = useState<StructuredPatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<{ path: string; untracked: boolean } | null>(null);
  /** The file open in the editable single-file view, or null while scanning
   *  the list. Scan to find what matters, open it to read — and, since it is
   *  the real buffer, to fix it. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Files whose diff is open inline. A set, not one selection: comparing two
   *  files means seeing both. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const [view, setView] = useState<DiffView>(
    () => (localStorage.getItem(VIEW_KEY) as DiffView | null) ?? "inline"
  );
  const pickView = (next: DiffView) => {
    setView(next);
    localStorage.setItem(VIEW_KEY, next);
  };

  const refresh = useCallback(async () => {
    try {
      const repo = await api.gitIsRepo(projectHash);
      setIsRepo(repo);
      if (!repo) {
        setStatus([]);
        setWorkingFiles([]);
        setStagedFiles([]);
        setError(null);
        return;
      }
      const [nextStatus, working, staged] = await Promise.all([
        api.gitStatus(projectHash, threadId),
        api.gitWorkingDiff(projectHash, threadId),
        api.gitStagedDiff(projectHash, threadId),
      ]);
      setStatus(nextStatus);
      setWorkingFiles(parseFilePatches(working));
      setStagedFiles(parseFilePatches(staged));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [projectHash, threadId]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshToken]);

  const [commitFiles, setCommitFiles] = useState<StructuredPatch[]>([]);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  useEffect(() => {
    if (!commit) return;
    let cancelled = false;
    setCommitLoading(true);
    setCommitError(null);
    api
      .gitCommitDiff(projectHash, commit.hash)
      .then((diff) => {
        if (!cancelled) setCommitFiles(parseFilePatches(diff));
      })
      .catch((err) => {
        if (!cancelled) setCommitError(describeError(err));
      })
      .finally(() => {
        if (!cancelled) setCommitLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [commit, projectHash]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
        await refresh();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const discard = () => {
    if (!confirmDiscard) return;
    const { path, untracked } = confirmDiscard;
    setConfirmDiscard(null);
    run(() => api.gitDiscardFile(projectHash, path, untracked, threadId));
  };

  if (!isRepo) {
    return (
      <div className="diff-pane" data-testid="diff-pane">
        {error && (
          <Alert
            color="danger"
            variant="light"
            m="12px 16px 0"
            style={{ whiteSpace: "pre-wrap" }}
            data-testid="diff-error"
          >
            {error}
          </Alert>
        )}
        <p className="empty">This project isn't a git repository yet.</p>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconGitBranch size={13} />}
          onClick={() => run(() => api.gitInit(projectHash))}
          disabled={busy}
          data-testid="init-repo-btn"
        >
          Initialize Repository
        </Button>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="diff-pane diff-pane-editing" data-testid="diff-pane">
        <EditableDiffView
          projectHash={projectHash}
          threadId={threadId}
          path={editing}
          patch={workingFiles.find((f) => pathFromPatch(f) === editing)}
          onBack={() => setEditing(null)}
          onSaved={refresh}
        />
      </div>
    );
  }

  if (commit) {
    return (
      <div className="diff-pane" data-testid="diff-pane">
        <div className="diff-commit-bar" data-testid="diff-commit-bar">
          <div className="diff-commit-bar-text">
            <span className="diff-commit-bar-subject">{commit.subject}</span>
            <span className="diff-commit-bar-meta">
              <span className="diff-commit-bar-hash">{commit.hash.slice(0, 7)}</span>
              {commit.author} · {relativeTime(commit.date)}
            </span>
          </div>
          <span className="diff-spacer" />
          <button onClick={onClearCommit} data-testid="diff-clear-commit">
            Show working changes
          </button>
        </div>
        {commitError && (
          <Alert
            color="danger"
            variant="light"
            style={{ whiteSpace: "pre-wrap" }}
            data-testid="diff-error"
          >
            {commitError}
          </Alert>
        )}
        {commitLoading && !commitError && <p className="empty">Loading commit…</p>}
        {!commitLoading && !commitError && commitFiles.length === 0 && (
          <p className="empty">This commit made no file changes.</p>
        )}
        {commitFiles.map((file) => (
          <FileDiff
            key={pathFromPatch(file)}
            file={file}
            actionLabel=""
            busy={false}
            view={view}
          />
        ))}
      </div>
    );
  }

  const focused = <T extends StructuredPatch>(files: T[]) =>
    focusPath ? files.filter((f) => pathFromPatch(f) === focusPath) : files;
  const shownWorking = focused(workingFiles);
  const shownStaged = focused(stagedFiles);
  /** A new file is discarded by deleting it, not by restoring it from HEAD —
   *  now that untracked files arrive as real patches, the row that renders
   *  one still has to know which kind of discard it needs. */
  const untrackedPaths = new Set(
    status.filter((f) => f.code === "??").map((f) => f.path)
  );
  // Untracked files reach the working diff as synthesized "new file" patches,
  // so only the ones git could not diff at all (binary, unreadable) still
  // need the bare name-only row — listing the rest twice is the bug.
  const workingPaths = new Set(workingFiles.map(pathFromPatch));
  const untracked = status.filter(
    (f) => f.code === "??" && !workingPaths.has(f.path)
  );
  const shownUntracked = focusPath
    ? untracked.filter((f) => f.path === focusPath)
    : untracked;
  /** Only files with a diff to show can be expanded — a binary or unreadable
   *  untracked file has nothing behind its row, and counting it would leave
   *  "Expand all" permanently unfinished. */
  const expandablePaths = shownWorking.map(pathFromPatch);
  const allExpanded =
    expandablePaths.length > 0 && expandablePaths.every((path) => expanded.has(path));

  const isClean =
    workingFiles.length === 0 && stagedFiles.length === 0 && untracked.length === 0;

  return (
    <div className="diff-pane" data-testid="diff-pane">
      {error && (
        <Alert
          color="danger"
          variant="light"
          m="12px 16px 0"
          style={{ whiteSpace: "pre-wrap" }}
          data-testid="diff-error"
        >
          {error}
        </Alert>
      )}

      {isClean && !error && (
        <p className="empty">
          {isWorktree
            ? "No changes in this thread yet."
            : "Nothing to commit — working tree clean."}
        </p>
      )}

      {/* Reading a rewrite line-by-line and reading it as a replacement are
          different jobs; the toggle is per reviewer, not per file. */}
      {!isClean && (
        <div className="diff-toolbar" data-testid="diff-toolbar">
          <span className="diff-spacer" />
          <SegmentedControl
            size="xs"
            value={view}
            onChange={(next) => pickView(next as DiffView)}
            data-testid="diff-view-toggle"
            data={[
              { label: "Inline", value: "inline" },
              { label: "Side by Side", value: "split" },
            ]}
          />
        </div>
      )}

      {focusPath && (
        <div className="diff-focus-bar" data-testid="diff-focus-bar">
          <span className="diff-file-path">{focusPath}</span>
          <span className="diff-spacer" />
          <button onClick={onClearFocus} data-testid="diff-show-all">
            Show all changes
          </button>
        </div>
      )}

      {(shownWorking.length > 0 || shownUntracked.length > 0) && (
        <section className="diff-section" data-testid="diff-scan-list">
          <Group gap={8} wrap="nowrap" pr={12}>
            <h2 className="ds-section-heading" style={{ flex: 1 }}>
              Changed Files
            </h2>
            {/* Reads the current state rather than a remembered intent: after
                opening two files by hand, the button offers the thing that is
                still left to do. */}
            <Button
              size="compact-xs"
              variant="subtle"
              leftSection={
                allExpanded ? <IconFoldUp size={13} /> : <IconFoldDown size={13} />
              }
              onClick={() =>
                setExpanded(allExpanded ? new Set() : new Set(expandablePaths))
              }
              data-testid="diff-expand-all"
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </Button>
          </Group>
          {shownWorking.map((file) => {
            const path = pathFromPatch(file);
            const stat = patchStat(file);
            const untrackedFile = untrackedPaths.has(path);
            return (
              <ChangedFileRow
                key={path}
                path={path}
                added={stat.added}
                removed={stat.removed}
                isNew={untrackedFile}
                expanded={expanded.has(path)}
                onToggle={() => toggleExpanded(path)}
                onOpen={() => setEditing(path)}
              >
                <FileDiff
                  file={file}
                  actionLabel="Stage hunk"
                  onHunkAction={(hunk) =>
                    run(() =>
                      api.gitStageHunk(projectHash, patchForHunk(file, hunk), threadId)
                    )
                  }
                  onStageAll={() =>
                    run(() => api.gitStageFile(projectHash, path, threadId))
                  }
                  onDiscard={() =>
                    setConfirmDiscard({ path, untracked: untrackedFile })
                  }
                  busy={busy}
                  view={view}
                />
              </ChangedFileRow>
            );
          })}
          {/* Files git could not diff at all (binary, unreadable) still get a
              row — with nothing to expand, only the two actions. */}
          {shownUntracked.map((entry) => (
            <ChangedFileRow
              key={entry.path}
              path={entry.path}
              added={0}
              removed={0}
              isNew
              expanded={false}
              onToggle={() => undefined}
              onOpen={() => setEditing(entry.path)}
            >
              <Group gap={8} px={12} pb={8} justify="flex-end">
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="danger"
                  leftSection={<IconTrash size={12} />}
                  onClick={() => setConfirmDiscard({ path: entry.path, untracked: true })}
                  disabled={busy}
                  data-testid="discard-untracked-btn"
                >
                  Discard
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<IconPlus size={12} />}
                  onClick={() => run(() => api.gitStageFile(projectHash, entry.path, threadId))}
                  disabled={busy}
                  data-testid="stage-untracked-btn"
                >
                  Stage
                </Button>
              </Group>
            </ChangedFileRow>
          ))}
        </section>
      )}

      {shownStaged.length > 0 && (
        <section className="diff-section" data-testid="staged-section">
          <h2 className="ds-section-heading">Staged Changes</h2>
          {shownStaged.map((file) => (
            <FileDiff
              key={pathFromPatch(file)}
              file={file}
              actionLabel="Unstage hunk"
              onHunkAction={(hunk) =>
                run(() =>
                  api.gitUnstageHunk(projectHash, patchForHunk(file, hunk), threadId)
                )
              }
              busy={busy}
              view={view}
            />
          ))}
        </section>
      )}

      {confirmDiscard && (
        <MantineModal
          opened
          onClose={() => setConfirmDiscard(null)}
          title={`Discard changes to "${confirmDiscard.path}"?`}
          transitionProps={{ duration: 0 }}
        >
          <Text size="sm">
            Discard changes to "{confirmDiscard.path}"? This can't be undone.
          </Text>
          <Group justify="flex-end" gap="sm" mt="lg">
            <Button
              size="xs"
              variant="default"
              onClick={() => setConfirmDiscard(null)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              color="danger"
              onClick={discard}
              data-testid="confirm-discard"
              autoFocus
            >
              Discard
            </Button>
          </Group>
        </MantineModal>
      )}
    </div>
  );
}
