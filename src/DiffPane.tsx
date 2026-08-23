import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal as MantineModal,
  SegmentedControl,
  Text,
} from "@mantine/core";
import {
  IconGitBranch,
  IconMinus,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import type { StructuredPatch, StructuredPatchHunk } from "diff";

import * as api from "./api";
import type { FileStatus } from "./api";
import DiffRows from "./DiffRows";
import type { DiffView } from "./DiffRows";
import { describeError } from "./errors";
import { rowsFromHunk } from "./diffLines";
import { parseFilePatches, patchForHunk, pathFromPatch } from "./gitDiff";

/** Survives remounts and app restarts: a reviewer who wants side-by-side
 *  wants it for the whole review, not for one file. */
const VIEW_KEY = "palisade.diffView";

type Props = {
  projectHash: string;
  /** Read this thread's isolated worktree instead of the project root.
   *
   *  Staging, discarding and committing are hidden while it is set: those
   *  act on the project root, and offering them over a worktree's diff would
   *  stage a file the user is not looking at. Reviewing a thread's work is
   *  reading; the Source Control panel is where changes get committed. */
  threadId?: string;
  /** Show only this file's diff — set when a row in the Source Control
   *  panel is clicked, so "click a change" lands on that change rather
   *  than on the whole working tree. */
  focusPath?: string | null;
  onClearFocus?: () => void;
  /** Bumped when something outside this pane changed the working tree — an
   * agent turn finishing, or a save. Without it the diff is whatever it was
   * when the pane mounted, which is stale the moment the agent writes. */
  refreshToken?: number;
};

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
          <DiffRows rows={rowsFromHunk(hunk)} view={view} />
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
}: Props) {
  // Reviewing another tree is read-only: every write below targets the
  // project root, so the buttons would act on a file that is not on screen.
  const readOnly = threadId !== undefined;
  const [isRepo, setIsRepo] = useState(true);
  const [status, setStatus] = useState<FileStatus[]>([]);
  const [workingFiles, setWorkingFiles] = useState<StructuredPatch[]>([]);
  const [stagedFiles, setStagedFiles] = useState<StructuredPatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<{ path: string; untracked: boolean } | null>(null);
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
    run(() => api.gitDiscardFile(projectHash, path, untracked));
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

  const focused = <T extends StructuredPatch>(files: T[]) =>
    focusPath ? files.filter((f) => pathFromPatch(f) === focusPath) : files;
  const shownWorking = focused(workingFiles);
  const shownStaged = focused(stagedFiles);
  const untracked = status.filter((f) => f.code === "??");
  const shownUntracked = focusPath
    ? untracked.filter((f) => f.path === focusPath)
    : untracked;
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
          {readOnly
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

      {shownStaged.length > 0 && (
        <section className="diff-section" data-testid="staged-section">
          <h2 className="ds-section-heading">Staged Changes</h2>
          {shownStaged.map((file) => (
            <FileDiff
              key={pathFromPatch(file)}
              file={file}
              actionLabel="Unstage hunk"
              onHunkAction={
                readOnly
                  ? undefined
                  : (hunk) => run(() => api.gitUnstageHunk(projectHash, patchForHunk(file, hunk)))
              }
              busy={busy}
              view={view}
            />
          ))}
        </section>
      )}

      {(shownWorking.length > 0 || shownUntracked.length > 0) && (
        <section className="diff-section" data-testid="changes-section">
          <h2 className="ds-section-heading">Changes</h2>
          {shownWorking.map((file) => (
            <FileDiff
              key={pathFromPatch(file)}
              file={file}
              actionLabel="Stage hunk"
              onHunkAction={
                readOnly
                  ? undefined
                  : (hunk) => run(() => api.gitStageHunk(projectHash, patchForHunk(file, hunk)))
              }
              onStageAll={
                readOnly
                  ? undefined
                  : () => run(() => api.gitStageFile(projectHash, pathFromPatch(file)))
              }
              onDiscard={
                readOnly
                  ? undefined
                  : () => setConfirmDiscard({ path: pathFromPatch(file), untracked: false })
              }
              busy={busy}
              view={view}
            />
          ))}
          {shownUntracked.map((entry) => (
            <div key={entry.path} className="diff-file" data-testid="diff-untracked-file">
              <div className="diff-file-head">
                <span className="diff-file-path">{entry.path}</span>
                <Badge size="xs" variant="light" color="success">
                  new
                </Badge>
                <span className="diff-spacer" />
                {!readOnly && (
                  <>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="danger"
                      leftSection={<IconTrash size={12} />}
                      onClick={() =>
                        setConfirmDiscard({ path: entry.path, untracked: true })
                      }
                      disabled={busy}
                      data-testid="discard-untracked-btn"
                    >
                      Discard
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      leftSection={<IconPlus size={12} />}
                      onClick={() =>
                        run(() => api.gitStageFile(projectHash, entry.path))
                      }
                      disabled={busy}
                      data-testid="stage-untracked-btn"
                    >
                      Stage
                    </Button>
                  </>
                )}
              </div>
            </div>
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
