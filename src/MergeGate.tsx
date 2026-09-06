import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Collapse,
  Group,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconGitBranch,
  IconGitMerge,
  IconGitPullRequest,
} from "@tabler/icons-react";

import { openUrl } from "@tauri-apps/plugin-opener";

import * as api from "./api";
import { describeError } from "./errors";

/** The in-chat merge gate: what this thread changed, and the two ways to put
 *  it into the project.
 *
 *  It gates on exactly one thing — does this branch merge cleanly into the
 *  branch it was cut from — because that is the only question a merge can
 *  answer. No test result appears here and none is treated as permission:
 *  whether the work is *right* is the reviewer's call, and a card that showed
 *  a green tick next to Merge would be making that call for them.
 *
 *  Uncommitted work is not a wall either. An agent's edits are committed on
 *  the way through, carrying a message drafted by the local model that the
 *  user can read and rewrite before anything moves. */

type Props = {
  projectHash: string;
  threadId: string;
  worktree: api.WorktreeStatus;
  /** Opens the Source Control panel on this thread's worktree. */
  onViewDiff?: () => void;
  /** The worktree changed (a commit, a merge): re-poll. */
  onChanged?: () => void;
  /** Archive this thread — offered once its work has landed. */
  onArchive?: () => void;
  onError?: (message: string) => void;
};

/** Anything at all to put into the base branch: commits it does not have, or
 *  edits not yet committed. */
export function hasWorkToLand(worktree: api.WorktreeStatus): boolean {
  return worktree.ahead > 0 || !worktree.clean;
}

export default function MergeGate({
  projectHash,
  threadId,
  worktree,
  onViewDiff,
  onChanged,
  onArchive,
  onError,
}: Props) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"suggest" | "generate" | "merge" | "pr" | null>(null);
  const [merged, setMerged] = useState(false);
  const fail = useCallback(
    (err: unknown) => onError?.(describeError(err)),
    [onError],
  );

  // The local model drafts a subject as soon as there is something to commit,
  // so the box is filled in before the user reaches it. An install without the
  // local model gets an empty box — an ordinary state, not an error, and not a
  // reason to spend an agent turn nobody asked for.
  const suggestedFor = useRef<string | null>(null);
  useEffect(() => {
    if (worktree.clean || message || suggestedFor.current === worktree.head) return;
    suggestedFor.current = worktree.head;
    setBusy("suggest");
    api
      .suggestCommitMessage(projectHash, threadId)
      .then((subject) => subject && setMessage(subject))
      .catch(() => undefined)
      .finally(() => setBusy((b) => (b === "suggest" ? null : b)));
  }, [projectHash, threadId, worktree.clean, worktree.head, message]);

  const workToLand = hasWorkToLand(worktree);
  const canLand = workToLand && worktree.mergeable;

  /** Commit whatever is uncommitted, so what lands is everything on screen.
   *  Staged one file at a time: concurrent index writes collide on
   *  `.git/index.lock` (the same reason SourceControlPanel does it in turn). */
  const commitIfDirty = async () => {
    if (worktree.clean) return;
    const files = await api.gitStatus(projectHash, threadId);
    for (const file of files) {
      await api.gitStageFile(projectHash, file.path, threadId);
    }
    await api.gitCommit(
      projectHash,
      message.trim() || "Agent changes from this thread",
      threadId,
    );
  };

  const generate = async () => {
    setBusy("generate");
    try {
      setMessage(await api.draftCommitMessage(projectHash, threadId));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const merge = async () => {
    setBusy("merge");
    try {
      await commitIfDirty();
      const result = await api.mergeThreadWorktree(projectHash, threadId);
      if (result.merged) {
        setMerged(true);
        setMessage("");
      } else {
        // A conflict is a place to work, not an error: say where it is, so a
        // session can be pointed there and resolve it like any other change.
        onError?.(
          result.conflictPath
            ? `Merge conflicts — the half-merged tree is at ${result.conflictPath} (branch ${result.conflictBranch}). Open it to resolve.`
            : result.detail,
        );
      }
      onChanged?.();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const openPr = async () => {
    setBusy("pr");
    try {
      await commitIfDirty();
      const url = await api.openThreadPr(projectHash, threadId);
      onChanged?.();
      await openUrl(url);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  if (merged) {
    return (
      <Card withBorder radius="md" p="9px 11px" data-testid="merge-gate-merged">
        <Group gap={8} wrap="nowrap">
          <ThemeIcon size={16} radius="xl" variant="light" color="teal">
            <IconCheck size={10} />
          </ThemeIcon>
          <Text size="xs" style={{ flex: 1 }}>
            Merged into <b>{worktree.baseBranch}</b>
          </Text>
          {onArchive && (
            <Button
              size="compact-xs"
              variant="default"
              onClick={onArchive}
              data-testid="merge-gate-archive"
            >
              Archive thread
            </Button>
          )}
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => setMerged(false)}
            data-testid="merge-gate-dismiss"
          >
            Dismiss
          </Button>
        </Group>
      </Card>
    );
  }

  return (
    <Card withBorder radius="md" p={0} data-testid="merge-gate">
      <UnstyledButton
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="merge-gate-toggle"
        style={{ width: "100%", padding: "9px 11px" }}
      >
        <Group gap={8} wrap="nowrap">
          <IconGitBranch size={13} />
          <Text size="xs" c="dimmed" ff="monospace" truncate>
            {worktree.branch}
          </Text>
          <Text size="xs" ff="monospace" span>
            <Text span c="teal">
              +{worktree.added}
            </Text>{" "}
            <Text span c="red">
              −{worktree.removed}
            </Text>
          </Text>
          <div style={{ flex: 1 }} />
          {!worktree.mergeable && (
            <Badge size="xs" variant="light" color="red">
              conflicts
            </Badge>
          )}
          <IconChevronDown
            size={14}
            style={{ transform: open ? "rotate(180deg)" : undefined }}
          />
        </Group>
      </UnstyledButton>

      <Collapse expanded={open}>
        <div style={{ borderTop: "1px solid var(--border)", padding: "10px 12px 12px" }}>
          <Group gap={8} py={4} wrap="nowrap" data-testid="gate-check-mergeable">
            <ThemeIcon
              size={16}
              radius="xl"
              variant="light"
              color={worktree.mergeable ? "teal" : "yellow"}
            >
              {worktree.mergeable ? <IconCheck size={10} /> : <IconAlertTriangle size={10} />}
            </ThemeIcon>
            <Text size="xs" style={{ flex: 1 }}>
              {worktree.mergeable
                ? `Merges cleanly into ${worktree.baseBranch}`
                : `Conflicts with ${worktree.baseBranch}`}
            </Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {worktree.ahead > 0 && `${worktree.ahead} ahead`}
              {worktree.ahead > 0 && !worktree.clean && " · "}
              {!worktree.clean && `+${worktree.added} −${worktree.removed} uncommitted`}
            </Text>
          </Group>

          {!worktree.clean && (
            <Group gap={6} mt={8} wrap="nowrap" data-testid="gate-commit-row">
              <TextInput
                size="xs"
                style={{ flex: 1 }}
                placeholder={
                  busy === "suggest"
                    ? "Drafting a message…"
                    : "Describe what this thread changed…"
                }
                value={message}
                onChange={(e) => setMessage(e.currentTarget.value)}
                aria-label="Commit message"
                data-testid="gate-commit-message"
              />
              <Tooltip label="Ask this thread's agent for a better message" openDelay={400}>
                <Button
                  size="compact-xs"
                  variant="default"
                  onClick={generate}
                  loading={busy === "generate"}
                  data-testid="gate-generate-message"
                >
                  Generate
                </Button>
              </Tooltip>
            </Group>
          )}

          {/* Wraps rather than shrinking. `nowrap` let these three squeeze
              below their own label widths in a narrow chat pane, which
              clipped them to "View dif" and "Open P" instead of moving the
              row onto a second line. */}
          <Group gap={8} mt={10} wrap="wrap">
            {onViewDiff && (
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={onViewDiff}
                data-testid="worktree-view-diff"
              >
                View diff
              </Button>
            )}
            <div style={{ flex: 1 }} />
            <Tooltip
              label={
                !workToLand
                  ? "Nothing to merge yet"
                  : !worktree.mergeable
                    ? "Resolve the conflicts with the base branch first"
                    : worktree.clean
                      ? `Merge into ${worktree.baseBranch}`
                      : `Commit these changes and merge into ${worktree.baseBranch}`
              }
            >
              <div>
                <Button
                  size="compact-xs"
                  leftSection={<IconGitMerge size={13} />}
                  disabled={!canLand}
                  loading={busy === "merge"}
                  onClick={merge}
                  data-testid="merge-thread"
                >
                  Merge to {worktree.baseBranch}
                </Button>
              </div>
            </Tooltip>
            <Button
              size="compact-xs"
              variant="default"
              leftSection={<IconGitPullRequest size={13} />}
              disabled={!workToLand}
              loading={busy === "pr"}
              onClick={openPr}
              data-testid="open-thread-pr"
            >
              Open PR
            </Button>
          </Group>
        </div>
      </Collapse>
    </Card>
  );
}
