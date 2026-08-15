import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Modal as MantineModal } from "@mantine/core";
import type { StructuredPatch, StructuredPatchHunk } from "diff";

import * as api from "./api";
import type { FileStatus } from "./api";
import DiffRows from "./DiffRows";
import { describeError } from "./errors";
import { rowsFromHunk } from "./diffLines";
import { parseFilePatches, patchForHunk, pathFromPatch } from "./gitDiff";

type Props = {
  projectHash: string;
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
}: {
  file: StructuredPatch;
  actionLabel: string;
  onHunkAction: (hunk: StructuredPatchHunk) => void;
  onStageAll?: () => void;
  onDiscard?: () => void;
  busy: boolean;
}) {
  return (
    <div className="diff-file" data-testid="diff-file">
      <div className="diff-file-head">
        <span className="diff-file-path">{pathFromPatch(file)}</span>
        <span className="diff-spacer" />
        {onDiscard && (
          <button onClick={onDiscard} disabled={busy} data-testid="discard-btn">
            Discard
          </button>
        )}
        {onStageAll && (
          <button onClick={onStageAll} disabled={busy} data-testid="stage-all-btn">
            Stage all
          </button>
        )}
      </div>
      {file.hunks.map((hunk, i) => (
        <div key={i} className="diff-hunk">
          <div className="diff-hunk-head">
            <button onClick={() => onHunkAction(hunk)} disabled={busy} data-testid="hunk-action-btn">
              {actionLabel}
            </button>
          </div>
          <DiffRows rows={rowsFromHunk(hunk)} />
        </div>
      ))}
    </div>
  );
}

export default function DiffPane({
  projectHash,
  refreshToken,
  focusPath,
  onClearFocus,
}: Props) {
  const [isRepo, setIsRepo] = useState(true);
  const [status, setStatus] = useState<FileStatus[]>([]);
  const [workingFiles, setWorkingFiles] = useState<StructuredPatch[]>([]);
  const [stagedFiles, setStagedFiles] = useState<StructuredPatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<{ path: string; untracked: boolean } | null>(null);

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
        api.gitStatus(projectHash),
        api.gitWorkingDiff(projectHash),
        api.gitStagedDiff(projectHash),
      ]);
      setStatus(nextStatus);
      setWorkingFiles(parseFilePatches(working));
      setStagedFiles(parseFilePatches(staged));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [projectHash]);

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
            color="var(--danger)"
            variant="light"
            m="12px 16px 0"
            style={{ whiteSpace: "pre-wrap" }}
            data-testid="diff-error"
          >
            {error}
          </Alert>
        )}
        <p className="empty">This project isn't a git repository yet.</p>
        <button
          onClick={() => run(() => api.gitInit(projectHash))}
          disabled={busy}
          data-testid="init-repo-btn"
        >
          Initialize Repository
        </button>
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
          color="var(--danger)"
          variant="light"
          m="12px 16px 0"
          style={{ whiteSpace: "pre-wrap" }}
          data-testid="diff-error"
        >
          {error}
        </Alert>
      )}

      {isClean && !error && <p className="empty">Nothing to commit — working tree clean.</p>}

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
              onHunkAction={(hunk) => run(() => api.gitUnstageHunk(projectHash, patchForHunk(file, hunk)))}
              busy={busy}
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
              onHunkAction={(hunk) => run(() => api.gitStageHunk(projectHash, patchForHunk(file, hunk)))}
              onStageAll={() => run(() => api.gitStageFile(projectHash, pathFromPatch(file)))}
              onDiscard={() => setConfirmDiscard({ path: pathFromPatch(file), untracked: false })}
              busy={busy}
            />
          ))}
          {shownUntracked.map((entry) => (
            <div key={entry.path} className="diff-file" data-testid="diff-untracked-file">
              <div className="diff-file-head">
                <span className="diff-file-path">{entry.path}</span>
                <Badge size="xs" variant="light" color="var(--success)">
                  new
                </Badge>
                <span className="diff-spacer" />
                <button
                  onClick={() => setConfirmDiscard({ path: entry.path, untracked: true })}
                  disabled={busy}
                  data-testid="discard-untracked-btn"
                >
                  Discard
                </button>
                <button
                  onClick={() => run(() => api.gitStageFile(projectHash, entry.path))}
                  disabled={busy}
                  data-testid="stage-untracked-btn"
                >
                  Stage
                </button>
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
          <label>
            Discard changes to "{confirmDiscard.path}"? This can't be undone.
          </label>
          <div className="confirm-actions">
            <button onClick={discard} className="danger" data-testid="confirm-discard" autoFocus>
              Discard
            </button>
            <button onClick={() => setConfirmDiscard(null)}>Cancel</button>
          </div>
        </MantineModal>
      )}
    </div>
  );
}
