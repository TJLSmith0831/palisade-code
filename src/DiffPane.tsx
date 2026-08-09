import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Modal as MantineModal } from "@mantine/core";
import type { StructuredPatch, StructuredPatchHunk } from "diff";

import * as api from "./api";
import type { FileStatus } from "./api";
import DiffRows from "./DiffRows";
import { describeError } from "./errors";
import { rowsFromHunk } from "./diffLines";
import { parseFilePatches, patchForHunk, pathFromPatch } from "./gitDiff";

type Props = { projectHash: string };

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

export default function DiffPane({ projectHash }: Props) {
  const [isRepo, setIsRepo] = useState(true);
  const [status, setStatus] = useState<FileStatus[]>([]);
  const [workingFiles, setWorkingFiles] = useState<StructuredPatch[]>([]);
  const [stagedFiles, setStagedFiles] = useState<StructuredPatch[]>([]);
  const [aheadBehind, setAheadBehind] = useState<[number, number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState<{ path: string; untracked: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const repo = await api.gitIsRepo(projectHash);
      setIsRepo(repo);
      if (!repo) {
        setStatus([]);
        setWorkingFiles([]);
        setStagedFiles([]);
        setAheadBehind(null);
        setError(null);
        return;
      }
      const [nextStatus, working, staged, ab] = await Promise.all([
        api.gitStatus(projectHash),
        api.gitWorkingDiff(projectHash),
        api.gitStagedDiff(projectHash),
        api.gitAheadBehind(projectHash),
      ]);
      setStatus(nextStatus);
      setWorkingFiles(parseFilePatches(working));
      setStagedFiles(parseFilePatches(staged));
      setAheadBehind(ab);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [projectHash]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  const commit = () =>
    run(async () => {
      await api.gitCommit(projectHash, message);
      setMessage("");
    });

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

  const untracked = status.filter((f) => f.code === "??");
  const hasStaged = stagedFiles.length > 0;
  const isClean = workingFiles.length === 0 && stagedFiles.length === 0 && untracked.length === 0;
  const [ahead, behind] = aheadBehind ?? [0, 0];

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

      <div className="diff-sticky-controls">
        <div className="diff-sync-bar">
          <button onClick={() => run(() => api.gitFetch(projectHash))} disabled={busy} data-testid="fetch-btn">
            Fetch
          </button>
          <button
            onClick={() => run(async () => void (await api.gitPull(projectHash)))}
            disabled={busy}
            data-testid="pull-btn"
          >
            Pull{aheadBehind && behind > 0 ? ` (${behind})` : ""}
          </button>
          <button
            onClick={() => run(async () => void (await api.gitPush(projectHash)))}
            disabled={busy}
            data-testid="push-btn"
          >
            Push{aheadBehind && ahead > 0 ? ` (${ahead})` : ""}
          </button>
        </div>

        <div className="diff-commit-box">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Commit message"
            aria-label="Commit message"
            data-testid="commit-message"
          />
          <button
            onClick={commit}
            disabled={busy || !message.trim() || !hasStaged}
            data-testid="commit-btn"
          >
            Commit
          </button>
        </div>
      </div>

      {isClean && !error && <p className="empty">Nothing to commit — working tree clean.</p>}

      {hasStaged && (
        <section className="diff-section" data-testid="staged-section">
          <h2 className="ds-section-heading">Staged Changes</h2>
          {stagedFiles.map((file) => (
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

      {(workingFiles.length > 0 || untracked.length > 0) && (
        <section className="diff-section" data-testid="changes-section">
          <h2 className="ds-section-heading">Changes</h2>
          {workingFiles.map((file) => (
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
          {untracked.map((entry) => (
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
