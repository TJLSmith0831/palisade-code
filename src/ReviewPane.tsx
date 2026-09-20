import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { IconExternalLink, IconGitPullRequest } from "@tabler/icons-react";

import type { FleetMerge, FleetVerify } from "./api";
import { statusChip } from "./SourceControlPanel";
import { relativeTime } from "./SessionList";
import { loadViewed, setViewed } from "./reviewState";

/** One thread's work, in one place: what changed, what a reviewer has read,
 *  what was actually verified, and the two ways to land it.
 *
 *  The verify strip only ever restates the verification record — a named
 *  command, its exit code, the commit it ran at. Nothing here says the work
 *  is complete, because nothing here can know that. Merge is enabled by a
 *  clean trial merge *and* a passing verify; landing without both is still
 *  possible, but only through a dialog that names what is missing. */

export type ReviewFile = {
  path: string;
  added: number;
  removed: number;
  status: "added" | "modified" | "deleted" | "renamed";
};

export type ReviewPaneProps = {
  threadId: string;
  /** The thread's own name — what is being reviewed, said before the branch
   *  it lives on. */
  title: string;
  branch?: string;
  baseBranch?: string;
  /** The same measurement the Fleet board shows for this thread. */
  diff: { added: number; removed: number; files: number; untracked?: number };
  files: ReviewFile[];
  loadingFiles: boolean;
  verify: FleetVerify;
  merge: FleetMerge;
  /** App supplies the existing DiffPane for that file. */
  renderDiff(path: string): React.ReactNode;
  onRunVerify(): void;
  onMerge(opts: { override: boolean }): void;
  onOpenPr(): void;
  onOpenInEditor(path: string): void;
  /** The way out of an empty review: back to the board that sent you here. */
  onBackToFleet(): void;
};

/** Reuses Source Control's chip tones; git has no porcelain code for the
 *  rename we are handed, so that one letter is spelled out here. */
const CODE = { added: "A", modified: "M", deleted: "D" } as const;
function fileGlyph(status: ReviewFile["status"]) {
  if (status === "renamed") return { letter: "R", tone: "warn" };
  return statusChip(CODE[status]);
}

const short = (commit?: string) => (commit ? commit.slice(0, 7) : "unknown commit");

/** The exact evidence sentence for each verify state. */
export function verifyLine(verify: FleetVerify, now = Date.now()): string {
  if (verify.state === "pass") {
    const age = verify.at ? relativeTime(verify.at, now) : "";
    return `Verified: ${verify.command ?? "verify"} exited 0 at ${short(verify.commit)}${age ? ` · ${age}` : ""}`;
  }
  if (verify.state === "fail") {
    return `Verify failed: ${verify.command ?? "verify"} at ${short(verify.commit)}`;
  }
  return "Not verified";
}

const MERGE_BLOCKER: Record<FleetMerge, string | null> = {
  clean: null,
  conflicts: "This branch conflicts with its base branch.",
  behind: "This branch is behind its base branch.",
  no_worktree: "This thread has no worktree to merge.",
};

export default function ReviewPane({
  threadId,
  title,
  branch,
  baseBranch,
  diff,
  files,
  loadingFiles,
  verify,
  merge,
  renderDiff,
  onRunVerify,
  onMerge,
  onOpenPr,
  onOpenInEditor,
  onBackToFleet,
}: ReviewPaneProps) {
  const [viewed, setViewedSet] = useState<Set<string>>(() => loadViewed(threadId));
  const [selected, setSelected] = useState(0);
  const [overrideOpen, setOverrideOpen] = useState(false);

  useEffect(() => {
    setViewedSet(loadViewed(threadId));
    setSelected(0);
  }, [threadId]);

  const selectedFile = files[Math.min(selected, Math.max(files.length - 1, 0))];

  const toggleViewed = useCallback(
    (path: string, next: boolean) => setViewedSet(setViewed(threadId, path, next)),
    [threadId],
  );

  // j/k/v/o, ignored while typing so the chat composer keeps its keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (!files.length) return;
      if (e.key === "j") setSelected((i) => Math.min(i + 1, files.length - 1));
      else if (e.key === "k") setSelected((i) => Math.max(i - 1, 0));
      else if (e.key === "v" && selectedFile) toggleViewed(selectedFile.path, !viewed.has(selectedFile.path));
      else if (e.key === "o" && selectedFile) onOpenInEditor(selectedFile.path);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files.length, selectedFile, viewed, toggleViewed, onOpenInEditor]);

  const viewedCount = useMemo(
    () => files.filter((f) => viewed.has(f.path)).length,
    [files, viewed],
  );

  const mergeBlocker = MERGE_BLOCKER[merge];
  const canMerge = mergeBlocker === null && verify.state === "pass";
  const missing = [
    mergeBlocker,
    verify.state === "pass" ? null : verify.state === "fail"
      ? `Verify failed: ${verify.command ?? "verify"} at ${short(verify.commit)}.`
      : "No verification has been run on this branch.",
  ].filter(Boolean) as string[];

  return (
    <div className="review-pane" data-testid="review-pane">
      <div className="review-header">
        <Text size="sm" fw={600} data-testid="review-title">
          {title}
        </Text>
        <Text size="xs" c="dimmed" data-testid="review-subtitle">
          {branch ? `${branch}${baseBranch ? ` → ${baseBranch}` : ""} · ` : ""}
          +{diff.added} −{diff.removed} · {diff.files} files
          {(diff.untracked ?? 0) > 0 && ` · ${diff.untracked} new`}
        </Text>
      </div>

      <Group className="review-verify" justify="space-between" wrap="nowrap">
        <Text size="sm" data-testid="review-verify-line" data-state={verify.state}>
          {verifyLine(verify)}
        </Text>
        {verify.state === "pass" ? null : (
          <Button size="xs" variant="default" onClick={onRunVerify}>
            Run verify
          </Button>
        )}
      </Group>

      <div className="review-body">
        <div className="review-files">
          <Text size="xs" c="dimmed" className="review-files-header" data-testid="review-viewed-count">
            {/* The branch lives in the header now; saying it twice only
                crowds the column the file names need. */}
            {viewedCount} of {files.length} viewed
          </Text>
          {loadingFiles ? (
            <Group className="review-files-loading" gap="xs">
              <Loader size="xs" />
              <Text size="xs" c="dimmed">Loading files…</Text>
            </Group>
          ) : files.length === 0 ? (
            <Stack className="review-files-empty" gap="xs" align="flex-start">
              <Text size="xs" c="dimmed">
                No file changes yet. Files the agent edits or creates appear here.
              </Text>
              <Button size="xs" variant="subtle" onClick={onBackToFleet}>
                Back to fleet
              </Button>
            </Stack>
          ) : (
            files.map((file, i) => {
              const glyph = fileGlyph(file.status);
              return (
                <UnstyledButton
                  key={file.path}
                  className="review-file-row"
                  data-selected={i === selected || undefined}
                  onClick={() => setSelected(i)}
                >
                  <Checkbox
                    size="xs"
                    aria-label={`Viewed ${file.path}`}
                    checked={viewed.has(file.path)}
                    onChange={(e) => toggleViewed(file.path, e.currentTarget.checked)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span
                    className={`ds-sc-status ds-sc-status-${glyph.tone}`}
                    aria-label={`status ${glyph.letter}`}
                  >
                    {glyph.letter}
                  </span>
                  <span className="review-file-path">{file.path}</span>
                  <span className="review-file-stat">+{file.added} −{file.removed}</span>
                </UnstyledButton>
              );
            })
          )}
        </div>

        <div className="review-diff">
          <Group justify="space-between" className="review-diff-header" wrap="nowrap">
            <Text size="xs" c="dimmed">{selectedFile?.path ?? "No file selected"}</Text>
            <Group gap="xs" wrap="nowrap">
              {selectedFile ? (
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconExternalLink size={14} />}
                  onClick={() => onOpenInEditor(selectedFile.path)}
                >
                  Open
                </Button>
              ) : null}
            </Group>
          </Group>
          {selectedFile ? renderDiff(selectedFile.path) : null}
        </div>
      </div>

      <Group className="review-actions" justify="flex-end" wrap="nowrap">
        {canMerge ? (
          <Button size="xs" onClick={() => onMerge({ override: false })}>
            Merge
          </Button>
        ) : (
          <>
            {/* A disabled button that never says why is a dead end. Name the
                one thing that would enable it. */}
            <Text size="xs" c="dimmed" data-testid="review-merge-blocker">
              {merge === "clean"
                ? "Merge needs a passing verify"
                : "Merge needs a clean base"}
            </Text>
            <Button size="xs" disabled>
              Merge
            </Button>
            <Button size="xs" variant="default" onClick={() => setOverrideOpen(true)}>
              Merge anyway…
            </Button>
          </>
        )}
        <Button
          size="xs"
          variant="default"
          leftSection={<IconGitPullRequest size={14} />}
          onClick={onOpenPr}
        >
          Open PR
        </Button>
      </Group>

      <Modal opened={overrideOpen} onClose={() => setOverrideOpen(false)} title="Merge anyway?">
        <Stack gap="sm">
          <Text size="sm">Merging now goes ahead without:</Text>
          {missing.map((m) => (
            <Text key={m} size="sm" c="dimmed">{m}</Text>
          ))}
          <Group justify="flex-end">
            <Button size="xs" variant="default" onClick={() => setOverrideOpen(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              color="danger"
              onClick={() => {
                setOverrideOpen(false);
                onMerge({ override: true });
              }}
            >
              Merge anyway
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
