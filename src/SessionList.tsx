import { useMemo, useState } from "react";
import { Badge, Button, TextInput, Tooltip } from "@mantine/core";
import {
  IconPencil,
  IconPlus,
  IconSearch,
  IconSparkles,
} from "@tabler/icons-react";
import type { FleetRow, ThreadMeta, WorktreeStatus } from "./api";
import { AttentionPill, OverlapIcon } from "./fleetBadges";
import { ArchiveIcon } from "./archiving";

// Amendment 3's Vibe-only session list: the browse/search surface, distinct
// from the in-conversation thread-tab strip (which stays as the quick
// switcher). Hidden entirely in the Editor preset.

/** A short age label. Clamps future timestamps — clock skew across machines
 *  must never render "-3m ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The two times a thread row shows. Sorting uses "last touched", which
 *  includes opening the thread; these say what actually happened. `compact`
 *  drops the "ago" so the sidebar's narrow row keeps it to one line. */
export function activityLabel(
  createdAt: string,
  lastActivityAt?: string,
  now = Date.now(),
  compact = false,
): string {
  const t = (iso: string) => {
    const rel = relativeTime(iso, now);
    return compact ? rel.replace(/ ago$/, "") : rel;
  };
  const created = `Created ${t(createdAt)}`;
  if (!lastActivityAt) return `${created} · Not run yet`;
  return `${created} · ${compact ? "Active" : "Last active"} ${t(lastActivityAt)}`;
}

/** Live threads matching `query`. Archived ones are out of this list by
 *  design — it is the browse surface, and the History panel is where an
 *  archived thread is found again and brought back. */
export function filterThreads(threads: ThreadMeta[], query: string) {
  const live = threads.filter((t) => !t.archived);
  const needle = query.trim().toLowerCase();
  if (!needle) return live;
  return live.filter((t) => t.title.toLowerCase().includes(needle));
}

/** What a row's dot says about the thread, in priority order: an agent is
 *  working here / it stopped and left changes to look at / nothing pending.
 *
 *  "Changed" is deliberately not called "done" — uncommitted edits in a
 *  worktree are evidence that something happened, never evidence that it
 *  worked. Only a verify run can say that. */
export type ThreadState = "needs-attention" | "running" | "changed" | "idle";

/** How a thread's branch stands against the branch it was cut from, as the
 *  row's readiness badge. Distinct from [`ThreadState`], which is about the
 *  agent: a thread can be idle and still hold work that conflicts.
 *
 *  "Ready" here means "merges cleanly", never "correct" — the merge gate in
 *  the conversation is where verification is shown, and even there a green
 *  verify is a command's exit code, not a judgement. */
export const READINESS: Record<
  WorktreeStatus["state"],
  { label: (w: WorktreeStatus) => string; color: string; tip: string } | null
> = {
  clean: null,
  ahead: {
    label: (w) => (w.ahead > 0 ? `${w.ahead} ahead` : "uncommitted"),
    color: "success",
    tip: "Merges cleanly into its base branch",
  },
  conflict: {
    label: (w) => `conflicts w/ ${w.baseBranch}`,
    color: "danger",
    tip: "A trial merge into the base branch hit conflicts",
  },
  merged: { label: () => "merged", color: "neutral", tip: "Palisade merged this branch into its base" },
};

export function threadState(
  thread: ThreadMeta,
  liveThreadIds: Set<string>,
  worktree: WorktreeStatus | undefined,
  attentionThreadIds: Set<string> = new Set()
): ThreadState {
  if (attentionThreadIds.has(thread.id)) return "needs-attention";
  if (liveThreadIds.has(thread.id)) return "running";
  if (worktree && worktree.added + worktree.removed > 0) return "changed";
  return "idle";
}

/** The three bands the sidebar shares with the Fleet board, in the order a
 *  band earns your attention. A thread with no fleet row is idle: the backend
 *  having nothing to say about it is not the same as it being busy. */
export const FLEET_BANDS = [
  { key: "attention", label: "Needs attention" },
  { key: "running", label: "Running" },
  { key: "idle", label: "Idle" },
] as const;

/** Split threads into those bands, newest-touched first within each.
 *  Empty bands are dropped so the sidebar never heads a group over nothing. */
export function groupByFleet(
  threads: ThreadMeta[],
  rows: Map<string, FleetRow>
): { key: string; label: string; list: ThreadMeta[] }[] {
  return FLEET_BANDS.map(({ key, label }) => ({
    key,
    label,
    list: threads
      .filter((t) => (rows.get(t.id)?.status ?? "idle") === key)
      .sort(
        (a, b) =>
          Date.parse(rows.get(b.id)?.updatedAt ?? b.updatedAt) -
          Date.parse(rows.get(a.id)?.updatedAt ?? a.updatedAt)
      ),
  })).filter((band) => band.list.length > 0);
}

const STATE_LABEL: Record<ThreadState, string> = {
  "needs-attention": "Waiting on you",
  running: "Agent is working",
  changed: "Uncommitted changes in this thread's worktree",
  idle: "Idle",
};

export default function SessionList({
  threads,
  activeThread,
  liveThreadIds,
  attentionThreadIds = new Set(),
  worktrees,
  fleetRows,
  onNewThread,
  onSelect,
  onRename,
  onArchive,
  userOpened = false,
}: {
  threads: ThreadMeta[];
  activeThread: ThreadMeta | undefined;
  /** Threads with a live/busy session — drives the accent dot. */
  liveThreadIds: Set<string>;
  /** Threads blocked on a permission prompt (or other blocking question) —
   *  the loudest dot state, and what the aggregate count in the header sums. */
  attentionThreadIds?: Set<string>;
  /** Each thread's isolated worktree, keyed by thread id. Threads that have
   *  never run — and every thread in a non-git project — are absent. */
  worktrees: Map<string, WorktreeStatus>;
  /** The same rows the Fleet board renders. Absent — or missing this thread —
   *  and the row falls back to what the worktree alone can say. */
  fleetRows?: FleetRow[];
  onNewThread: () => void;
  onSelect: (thread: ThreadMeta) => void;
  onRename: (thread: ThreadMeta) => void;
  onArchive: (thread: ThreadMeta) => void;
  /** The user asked for this column, rather than it merely starting open.
   *  A narrow window folds it away by default; this exempts it from that. */
  userOpened?: boolean;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterThreads(threads, query), [threads, query]);

  // Keyed by thread so a row asks one question. Playbook runs are not
  // threads and never match — this is the thread list.
  const rowsByThread = useMemo(() => {
    const map = new Map<string, FleetRow>();
    for (const row of fleetRows ?? []) {
      if (row.kind === "thread") map.set(row.threadId, row);
    }
    return map;
  }, [fleetRows]);

  // Grouped the way the board groups: what wants you, what is moving, the
  // rest. The workspace name is already in the workspace picker.
  const groups = useMemo(
    () => groupByFleet(visible, rowsByThread),
    [visible, rowsByThread]
  );

  return (
    <aside
      className="ds-sessions"
      data-testid="session-list"
      data-user-opened={userOpened || undefined}
      aria-label="Agent Access"
    >
      <div className="ds-sessions-header">
        <Button
          variant="default"
          fullWidth
          leftSection={<IconPlus size={14} />}
          onClick={onNewThread}
          data-testid="session-new-thread"
        >
          New thread
        </Button>
        {attentionThreadIds.size > 0 && (
          <Tooltip label={`${attentionThreadIds.size} thread${attentionThreadIds.size === 1 ? "" : "s"} waiting on you`}>
            <span className="ds-sessions-attention-count" data-testid="session-attention-count">
              {attentionThreadIds.size}
            </span>
          </Tooltip>
        )}
      </div>

      <TextInput
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        placeholder="Search threads…"
        aria-label="Search threads"
        leftSection={<IconSearch size={14} />}
        mt={8}
        data-testid="session-search"
      />

      <div className="ds-sessions-list">
        {visible.length === 0 && (
          <div className="empty ds-sessions-empty" data-testid="session-list-empty">
            <p>{query ? "No threads match." : "No threads yet."}</p>
            {!query && (
              <Button variant="subtle" size="compact-sm" onClick={onNewThread}>
                Start one
              </Button>
            )}
          </div>
        )}
        {groups.map((group) => (
          <div key={group.key} data-testid={`session-group-${group.key}`}>
            <h2 className="ds-section-heading">{group.label}</h2>
            {group.list.map((thread) => {
              const worktree = worktrees.get(thread.id);
              const row = rowsByThread.get(thread.id);
              // The backend's verdict wins when it has one: it can see a
              // failed verify or a conflicting merge that no local diff stat
              // reveals.
              const state: ThreadState = row
                ? row.status === "attention"
                  ? "needs-attention"
                  : row.status
                : threadState(thread, liveThreadIds, worktree, attentionThreadIds);
              const diff = row?.diff ?? worktree;
              return (
              <div
                key={thread.id}
                className={`ds-session-item${
                  thread.id === activeThread?.id ? " active" : ""
                }`}
                role="button"
                tabIndex={0}
                aria-current={thread.id === activeThread?.id}
                onClick={() => onSelect(thread)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(thread);
                  }
                }}
                data-testid="session-item"
              >
                <div className="ds-session-title">
                  {/* Marks a name Palisade wrote from the opening turn, so a
                      title the user never chose does not read as one they
                      did. Renaming clears it. */}
                  {thread.titleSource === "auto" && (
                    <Tooltip label="Named from the first message" openDelay={400}>
                      <IconSparkles
                        size={11}
                        className="ds-session-spark"
                        aria-label="Auto-named"
                      />
                    </Tooltip>
                  )}
                  {thread.title}
                </div>
                <div className="ds-session-meta" data-testid="session-times">
                  {activityLabel(thread.createdAt, row?.lastActivityAt, Date.now(), true)}
                </div>
                <div className="ds-session-meta">
                  {diff && diff.added + diff.removed > 0 && (
                    <span className="ds-session-diff" data-testid="session-diff">
                      <span className="added">+{diff.added}</span>
                      <span className="removed">−{diff.removed}</span>
                    </span>
                  )}
                  {/* Overlap rides this line as a glyph rather than a second
                      pill: three lines is the row's budget, and attention is
                      the one thing worth a pill. */}
                  {row && <OverlapIcon overlap={row.overlap} />}
                </div>
                {row?.attention && (
                  <div className="ds-session-badges">
                    <AttentionPill attention={row.attention} />
                  </div>
                )}
                {worktree && (
                  <div
                    className="ds-session-branch"
                    title={row?.mergeTarget ? `${worktree.branch} → ${row.mergeTarget}` : worktree.branch}
                  >
                    {worktree.branch}
                    {READINESS[worktree.state] && (
                      <Tooltip label={READINESS[worktree.state]!.tip} openDelay={400}>
                        <Badge
                          size="xs"
                          radius="sm"
                          variant="light"
                          color={READINESS[worktree.state]!.color}
                          ml={6}
                          data-testid="session-readiness"
                          data-state={worktree.state}
                        >
                          {READINESS[worktree.state]!.label(worktree)}
                        </Badge>
                      </Tooltip>
                    )}
                    {/* After the badge, so a narrow row clips this first. */}
                    {row?.mergeTarget && ` → ${row.mergeTarget}`}
                  </div>
                )}
                {/* Same two verbs the Editor preset's History panel offers.
                    stopPropagation, or the row's own click selects too. */}
                <div className="ds-thread-actions">
                  <button
                    className="ds-thread-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRename(thread);
                    }}
                    title="Rename thread"
                    aria-label="Rename thread"
                    data-testid="session-rename"
                  >
                    <IconPencil size={13} />
                  </button>
                  <button
                    className="ds-thread-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      onArchive(thread);
                    }}
                    title="Archive thread"
                    aria-label="Archive thread"
                    data-testid="session-archive"
                  >
                    <ArchiveIcon threadId={thread.id} />
                  </button>
                </div>
                {(state !== "idle" || row) && (
                  <Tooltip label={STATE_LABEL[state]} openDelay={400}>
                    <span
                      className="ds-session-dot"
                      data-state={state}
                      data-testid="session-dot"
                      aria-label={STATE_LABEL[state]}
                    />
                  </Tooltip>
                )}
              </div>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}
