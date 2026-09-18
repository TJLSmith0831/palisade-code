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
  onChanged?: () => Promise<void> | void;
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
  const [busy, setBusy] = useState<"suggest" | "generate" | "commit" | "merge" | "pr" | null>(null);
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
      .then((subject) => typeof subject === "string" && subject && setMessage(subject))
      .catch(() => undefined)
      .finally(() => setBusy((b) => (b === "suggest" ? null : b)));
  }, [projectHash, threadId, worktree.clean, worktree.head, message]);

  const workToLand = hasWorkToLand(worktree);
  const baseState = worktree.baseState ?? "unavailable";
  const baseBlocked = baseState !== "clean";
  const canMerge = workToLand && worktree.clean && worktree.mergeable && !baseBlocked;
  const canOpenPr = workToLand && worktree.clean;

  /** Commit whatever is uncommitted, so what lands is everything on screen.
   *  Staged one file at a time: concurrent index writes collide on
   *  `.git/index.lock` (the same reason SourceControlPanel does it in turn). */
  const commit = async () => {
    setBusy("commit");
    try {
    const files = await api.gitStatus(projectHash, threadId);
    for (const file of files) {
      await api.gitStageFile(projectHash, file.path, threadId);
    }
    await api.gitCommit(
      projectHash,
      message.trim() || "Agent changes from this thread",
      threadId,
    );
      await onChanged?.();
      setMessage("");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
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
      await onChanged?.();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const openPr = async () => {
    setBusy("pr");
    try {
      const url = await api.openThreadPr(projectHash, threadId);
      await onChanged?.();
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
          <ThemeIcon size={16} radius="xl" variant="light" color="success">
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
            <Text span c="success">
              +{worktree.added}
            </Text>{" "}
            <Text span c="danger">
              −{worktree.removed}
            </Text>
          </Text>
          <div style={{ flex: 1 }} />
          {(!worktree.mergeable || baseBlocked) && (
            <Badge size="xs" variant="light" color="danger">
              {baseState === "dirty" ? "base changes" : baseState === "unavailable" ? "check needed" : "conflicts"}
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
              color={baseState === "clean" && worktree.mergeable ? "success" : "warn"}
            >
              {baseState === "clean" && worktree.mergeable ? <IconCheck size={10} /> : <IconAlertTriangle size={10} />}
            </ThemeIcon>
            <Text size="xs" style={{ flex: 1 }}>
              {baseState === "dirty"
                ? `${worktree.baseBranch} has ${worktree.baseChangeCount ?? "uncommitted"} uncommitted ${worktree.baseChangeCount === 1 ? "change" : "changes"}. Commit or stash them before merging locally.`
                : baseState === "unavailable"
                  ? `Cannot check whether ${worktree.baseBranch} is safe to update.`
                  : worktree.mergeable
                    ? `Merges cleanly into ${worktree.baseBranch}`
                    : `Conflicts with ${worktree.baseBranch}`}
            </Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {worktree.ahead > 0 && `${worktree.ahead} ahead`}
              {worktree.ahead > 0 && !worktree.clean && " · "}
              {/* Not "uncommitted": the stat now measures from the base, so
                  it counts the thread's commits too. */}
              {!worktree.clean && `+${worktree.added} −${worktree.removed}`}
            </Text>
          </Group>

          {!worktree.clean && (
            <Group gap={6} mt={8} wrap="nowrap" data-testid="gate-commit-row">
              <div style={{ flex: 1 }}>
              <Text size="xs" component="label" htmlFor="gate-commit-message">Commit message</Text>
              <TextInput
                id="gate-commit-message"
                size="xs"
                placeholder={
                  busy === "suggest"
                    ? "Drafting a message…"
                    : "e.g. fix: prevent duplicate sends"
                }
                value={message}
                onChange={(e) => setMessage(e.currentTarget.value)}
                aria-label="Commit message"
                data-testid="gate-commit-message"
              />
              <Text size="xs" c="dimmed">⌘↵ commits staged changes</Text>
              </div>
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
              <Button
                size="compact-xs"
                onClick={commit}
                disabled={!message.trim()}
                loading={busy === "commit"}
                data-testid="commit-thread-changes"
              >
                Commit changes
              </Button>
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
                  : !worktree.clean
                    ? "Commit this thread's changes before merging"
                  : baseState === "dirty"
                    ? `${worktree.baseBranch} has uncommitted changes. Commit or stash them before merging locally.`
                  : baseState === "unavailable"
                    ? `Cannot check whether ${worktree.baseBranch} is safe to update`
                  : !worktree.mergeable
                    ? "Resolve the conflicts with the base branch first"
                    : `Merge into ${worktree.baseBranch}`
              }
            >
              <div>
                <Button
                  size="compact-xs"
                  leftSection={<IconGitMerge size={13} />}
                  disabled={!canMerge}
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
              disabled={!canOpenPr}
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
