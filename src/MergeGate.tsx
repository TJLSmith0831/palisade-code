import { useCallback, useMemo, useState } from "react";
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

/** The in-chat merge gate: what this thread changed, whether it can land, and
 *  the two ways to land it.
 *
 *  It replaces the old one-line worktree strip, and the reason it is a gate
 *  rather than two buttons is the repo's rule that verification is the only
 *  evidence: the checklist states, in the same place as the Merge button,
 *  exactly what is known — the tree is clean, this commit has a verify run,
 *  a trial merge succeeded — and never restates any of that as "done" or
 *  "correct". A verify run is reported as a command's exit code at a commit;
 *  it is deliberately *not* a blocker, because a green test says nothing
 *  about whether the merge itself is safe, which is what this gate is for. */

type Props = {
  projectHash: string;
  threadId: string;
  worktree: api.WorktreeStatus;
  /** Verification runs for this project — the gate picks the newest one that
   *  ran at the worktree's current HEAD. */
  verifications: api.VerificationRun[];
  /** Opens the Source Control panel on this thread's worktree. */
  onViewDiff?: () => void;
  /** The worktree changed underneath us (a commit, a merge): re-poll. */
  onChanged?: () => void;
  onError?: (message: string) => void;
};

/** The newest verify run that ran at exactly this commit. An older run is not
 *  evidence about the code as it stands now, so it is reported as "not run at
 *  this commit" rather than quietly shown as a pass. */
export function verifyAtHead(
  runs: api.VerificationRun[],
  threadId: string,
  head: string | null,
): api.VerificationRun | null {
  if (!head) return null;
  const matching = runs.filter(
    (run) => run.threadId === threadId && run.gitHead === head,
  );
  return matching.length ? matching[matching.length - 1] : null;
}

type Check = {
  key: string;
  passed: boolean;
  label: string;
  value: string;
};

export default function MergeGate({
  projectHash,
  threadId,
  worktree,
  verifications,
  onViewDiff,
  onChanged,
  onError,
}: Props) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"commit" | "merge" | "pr" | null>(null);
  const fail = useCallback(
    (err: unknown) => onError?.(describeError(err)),
    [onError],
  );

  const verify = useMemo(
    () => verifyAtHead(verifications, threadId, worktree.head),
    [verifications, threadId, worktree.head],
  );

  const checks: Check[] = [
    {
      key: "clean",
      passed: worktree.clean,
      label: "Worktree clean",
      value: worktree.clean
        ? "nothing uncommitted"
        : `+${worktree.added} −${worktree.removed} uncommitted`,
    },
    {
      key: "verify",
      passed: verify?.exitCode === 0,
      label: verify ? `verify: ${verify.name}` : "verify",
      value: !verify
        ? "not run at this commit"
        : verify.exitCode === 0
          ? "exited 0"
          : `exited ${verify.exitCode}`,
    },
    {
      key: "mergeable",
      passed: worktree.mergeable,
      label: `Mergeable into ${worktree.baseBranch}`,
      value: worktree.mergeable
        ? `${worktree.ahead} ahead`
        : "conflicts — resolve before merging",
    },
  ];

  // Merge is gated on the two facts a merge actually depends on. A failing or
  // missing verify run is shown, never used to block: it is evidence about
  // the code, not about whether the branch lands cleanly.
  const canMerge = worktree.clean && worktree.mergeable && worktree.ahead > 0;
  const pending = checks.filter((c) => !c.passed).length;

  /** Stage everything, then commit. Sequential on purpose — concurrent index
   *  writes collide on `.git/index.lock` (the same reason SourceControlPanel
   *  stages one file at a time). */
  const commitAll = async () => {
    if (!message.trim()) return;
    setBusy("commit");
    try {
      const files = await api.gitStatus(projectHash, threadId);
      for (const file of files) {
        await api.gitStageFile(projectHash, file.path, threadId);
      }
      await api.gitCommit(projectHash, message.trim(), threadId);
      setMessage("");
      onChanged?.();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    setBusy("commit");
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
      if (!result.merged) {
        // A conflict is a place to work, not an error: say where it is so a
        // session can be opened there and resolve it like any other change.
        onError?.(
          result.conflictPath
            ? `Merge conflicts — resolved in a worktree at ${result.conflictPath} (branch ${result.conflictBranch}).`
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
      const url = await api.openThreadPr(projectHash, threadId);
      await openUrl(url);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

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
          {pending > 0 && (
            <Badge size="xs" variant="light" color="yellow">
              {pending === 1 ? "1 check pending" : `${pending} checks pending`}
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
          {checks.map((check) => (
            <Group key={check.key} gap={8} py={4} wrap="nowrap" data-testid={`gate-check-${check.key}`}>
              <ThemeIcon
                size={16}
                radius="xl"
                variant="light"
                color={check.passed ? "teal" : "yellow"}
              >
                {check.passed ? <IconCheck size={10} /> : <IconAlertTriangle size={10} />}
              </ThemeIcon>
              <Text size="xs" style={{ flex: 1 }}>
                {check.label}
              </Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {check.value}
              </Text>
            </Group>
          ))}

          {/* The failing "clean" check is where the commit happens — a gate
              that refuses to merge without telling you how to proceed is a
              dead end. Palisade never writes the message on its own: Generate
              drafts it from the staged diff, the user reads it and commits. */}
          {!worktree.clean && (
            <Group gap={6} mt={8} wrap="nowrap" data-testid="gate-commit-row">
              <TextInput
                size="xs"
                style={{ flex: 1 }}
                placeholder="Describe what this thread changed…"
                value={message}
                onChange={(e) => setMessage(e.currentTarget.value)}
                aria-label="Commit message"
                data-testid="gate-commit-message"
              />
              <Button
                size="compact-xs"
                variant="default"
                onClick={generate}
                loading={busy === "commit" && !message}
              >
                Generate
              </Button>
              <Button
                size="compact-xs"
                onClick={commitAll}
                disabled={!message.trim()}
                loading={busy === "commit" && !!message}
                data-testid="gate-commit"
              >
                Commit
              </Button>
            </Group>
          )}

          <Group gap={8} mt={10} wrap="nowrap">
            {onViewDiff && (
              <Button size="compact-xs" variant="subtle" onClick={onViewDiff} data-testid="worktree-view-diff">
                View diff
              </Button>
            )}
            <div style={{ flex: 1 }} />
            <Tooltip
              label={
                worktree.ahead === 0
                  ? "Nothing committed to merge yet"
                  : !worktree.clean
                    ? "Commit this thread's changes first"
                    : !worktree.mergeable
                      ? "Resolve conflicts with the base branch first"
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
