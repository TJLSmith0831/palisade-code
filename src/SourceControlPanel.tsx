import { useCallback, useEffect, useState } from "react";
import { ActionIcon, Button, Group, HoverCard, Loader, Menu, Modal as MantineModal, Stack, Text, Textarea, TextInput, Tooltip, UnstyledButton } from "@mantine/core";
import {
  IconArchive,
  IconArrowBackUp,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconEaseOutControlPoint,
  IconFolder,
  IconGitBranch,
  IconInfoCircle,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconSparkles,
} from "@tabler/icons-react";
import * as api from "./api";
import type { FileStatus, LogEntry } from "./api";
import { relativeTime } from "./SessionList";
import { errorKind } from "./errors";

// Amendment 7's Source Control panel: the primary git surface, behind the
// left rail's Source Control icon. Built from mockup.html's #panel-git.
//
// Status chips reuse the existing semantic tokens (--warn modified,
// --success added/untracked) and always carry their letter, so color is
// never the only signal (DESIGN.md's One Accent Rule + pair-color-with-text).

/** Git's two-char porcelain code → the single letter the chip shows. */
export function statusChip(code: string): { letter: string; tone: string } {
  const trimmed = code.trim();
  if (trimmed === "??" || trimmed.startsWith("A")) {
    return { letter: trimmed === "??" ? "U" : "A", tone: "success" };
  }
  if (trimmed.startsWith("D")) return { letter: "D", tone: "bad" };
  return { letter: "M", tone: "warn" };
}

/**
 * Whether the file has something in the index. Porcelain's *first* column is
 * the index and the second is the working tree, so " M" (edited, unstaged)
 * and "M " (staged) differ only by position — reading the trimmed code would
 * make every change look staged.
 */
export function isStaged(code: string): boolean {
  const index = code[0] ?? " ";
  return index !== " " && index !== "?";
}

/** `src-tauri/src/lsp.rs` → `{ name: "lsp.rs", dir: "src-tauri/src" }`. */
export function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { name: path, dir: "" }
    : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

export type GraphRow = {
  commit: api.GraphCommit;
  lane: number;
  laneColor: number;
  beforeLanes: string[];
  nextLanes: string[];
  /** Every visible segment entering the next row. The current commit maps to
   * its parent(s); passive lanes keep their own identity. */
  edges: { from: number; to: number; lane: number; color: number }[];
};

/**
 * Assign each commit a stable lane from its parent relationships.  Git's
 * graph output is intentionally compact: a branch is a lane, and a merge is
 * a lane that joins another one. Keeping this as data (rather than CSS's old
 * single vertical rule) makes those relationships visible in the panel.
 */
export function layoutGraph(commits: api.GraphCommit[]): GraphRow[] {
  type Lane = { hash: string; color: number };
  const lanes: Lane[] = [];
  let nextColor = 0;
  return commits.map((commit) => {
    let lane = lanes.findIndex(({ hash }) => hash === commit.hash);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push({ hash: commit.hash, color: nextColor++ });
    }
    const before = [...lanes];
    const beforeLanes = before.map(({ hash }) => hash);
    const laneColor = before[lane].color;
    const primaryParent = commit.parents[0];
    if (primaryParent) {
      lanes[lane] = { hash: primaryParent, color: laneColor };
      for (const parent of commit.parents.slice(1)) {
        if (!lanes.some(({ hash }) => hash === parent)) {
          lanes.splice(lane + 1, 0, { hash: parent, color: nextColor++ });
        }
      }
    } else {
      lanes.splice(lane, 1);
    }
    const next = [...lanes];
    const nextLanes = next.map(({ hash }) => hash);
    const edges = before.flatMap(({ hash, color }, from) => {
      if (hash === commit.hash) {
        return commit.parents.flatMap((parent) => {
          const to = next.findIndex(({ hash }) => hash === parent);
          return to === -1 ? [] : [{ from, to, lane, color: next[to].color }];
        });
      }
      const to = next.findIndex((candidate) => candidate.hash === hash);
      return to === -1 ? [] : [{ from, to, lane: from, color }];
    });
    return { commit, lane, laneColor, beforeLanes, nextLanes, edges };
  });
}

/** A repository with many long-lived branches can have dozens of live
 *  lanes. This panel is intentionally compact, so reserve room for the
 *  commit subject and collapse overflow lanes into the final visible lane.
 *  Shared by GraphLanes and the uncommitted-changes node above it so both
 *  draw lane 0 at the same x — otherwise their lines wouldn't line up. */
/**
 * How tall one commit row is, in pixels.
 *
 * Rows used to be a flat 24px with the subject, the metadata and the branch
 * badge all competing for one nowrap line. The subject lost: measured live it
 * rendered 91px of a 469px string, and because the ellipsis happened inside
 * the content box, the panel's own overflow-x had nothing to scroll to — the
 * text was unreachable rather than merely clipped.
 *
 * Each part has its own row now, so the height has to be computed rather than
 * fixed. It stays *deterministic* — derived from the ref count, never
 * measured — because the lane SVG beside it has to be exactly as tall as its
 * row for adjacent rows' lane paths to meet without a seam.
 */
const SUBJECT_LINE_H = 15;
const META_H = 14;
const BADGE_H = 16;
const ROW_GAP = 2;
/**
 * Characters per line for the subject at the panel's default width. Measured
 * in the running app rather than estimated — the subject column is 164px and
 * the body face averages 5.96px a character there, so 27 fit on a line and
 * 25 is the safe number once wrapping breaks at spaces.
 *
 * A constant rather than a measurement on purpose: the lane SVG has to be
 * rendered at exactly its row's height in the same pass, and a ResizeObserver
 * would leave the two disagreeing for a frame every time the panel is
 * dragged. Widening the panel leaves a row slightly roomier than it needs;
 * narrowing it clips into the title attribute.
 *
 * Four lines covers a 100-character subject. Conventional ones are far
 * shorter and take one or two, so a row only costs the height its own
 * content asks for.
 */
const SUBJECT_CHARS_PER_LINE = 25;
const MAX_SUBJECT_LINES = 4;

export const subjectLines = (subject: string) =>
  Math.min(MAX_SUBJECT_LINES, Math.max(1, Math.ceil(subject.length / SUBJECT_CHARS_PER_LINE)));

/**
 * Branch names for a badge, shortened from the front.
 *
 * Generated names share a prefix and differ in their tail —
 * origin/claude/foo against origin/claude/bar — so the ordinary end-ellipsis
 * hides the only part that distinguishes them. Measured: the badge's name
 * column is 138px at its widest and the mono face averages 6.42px a
 * character there, so 21 is what fits.
 */
const BRANCH_BADGE_CHARS = 21;
export const shortRef = (ref: string) =>
  ref.length <= BRANCH_BADGE_CHARS ? ref : `…${ref.slice(-(BRANCH_BADGE_CHARS - 1))}`;

export const commitRowHeight = (subject: string, refCount: number) =>
  SUBJECT_LINE_H * subjectLines(subject) + META_H + BADGE_H * refCount +
  ROW_GAP * (refCount + 1);

function graphLaneGeometry(laneCount: number) {
  const visibleLanes = Math.min(laneCount, 3);
  return {
    visibleLanes,
    width: Math.max(20, visibleLanes * 10 + 6),
    x: (lane: number) => 6 + Math.min(lane, visibleLanes - 1) * 10,
  };
}

function GraphLanes({ row, laneCount, isFirstRow, height }: { row: GraphRow; laneCount: number; isFirstRow: boolean; height: number }) {
  const { visibleLanes, width, x } = graphLaneGeometry(laneCount);
  const laneClass = (color: number) => `lane-${Math.min(color, visibleLanes - 1)}`;
  return (
    <svg
      className="ds-sc-graph-lanes"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      data-testid="sc-graph-lane"
      // Decoration: the commit row beside this already carries the commit's
      // accessible name, and "commit graph lane 2" is nothing a reader can
      // act on. The aria-label that used to sit here was dead anyway —
      // aria-hidden wins when both are on the same element.
      aria-hidden="true"
    >
      {row.edges.map(({ from, to, color }, index) => {
        const isOwnEdge = from === row.lane;
        return (
          <g key={`${from}-${to}-${index}`}>
            {/* This row's own commit can be where a lane changes colour —
                a branch taking over a slot a merge just freed, say — so the
                incoming half (this row's own established colour, coming
                from above) and the outgoing half (the edge's colour,
                heading to its parent) aren't always the same. One path
                painted in only the outgoing colour left the incoming half
                either invisible or the wrong hue right where it met the
                node — the "doesn't quite connect" look. Splitting at the
                node draws each half in its own colour instead. The row
                above nothing (isFirstRow) has no incoming line to bridge to,
                so it's skipped there rather than left as a stray stub. */}
            {isOwnEdge && !isFirstRow && (
              <path
                className={`ds-sc-graph-line ${laneClass(row.laneColor)}`}
                d={`M ${x(from)} 0 L ${x(from)} 12`}
              />
            )}
            <path
              className={`ds-sc-graph-line ${laneClass(color)}`}
              d={
                isOwnEdge
                  ? `M ${x(from)} 12 C ${x(from)} ${height - 8}, ${x(to)} ${height - 6}, ${x(to)} ${height}`
                  : `M ${x(from)} 0 C ${x(from)} ${height - 8}, ${x(to)} ${height - 6}, ${x(to)} ${height}`
              }
            />
          </g>
        );
      })}
      <circle className={`ds-sc-graph-node ${laneClass(row.laneColor)}`} cx={x(row.lane)} cy="12" r="3.5" />
    </svg>
  );
}

/** The node every other IDE draws above HEAD for a dirty working tree, so
 *  the graph reads as the true head of history instead of stopping at the
 *  last commit. Dashed and a distinct colour rather than a lane colour —
 *  it isn't a commit yet, and shouldn't read as one. */
function UncommittedLane({ laneCount, height }: { laneCount: number; height: number }) {
  const { width, x } = graphLaneGeometry(laneCount);
  return (
    <svg
      className="ds-sc-graph-lanes"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
    >
      <path className="ds-sc-graph-line ds-sc-uncommitted-line" d={`M ${x(0)} 12 L ${x(0)} ${height}`} />
      <circle className="ds-sc-graph-node ds-sc-uncommitted-node" cx={x(0)} cy="12" r="3.5" />
    </svg>
  );
}

function Section({
  id,
  title,
  count,
  open,
  onToggle,
  actions,
  pinned,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  /** Stays above the scrollable body, e.g. the Graph's filter box — a
   *  control the reader needs while scrolling shouldn't scroll away with
   *  the list it's filtering. */
  pinned?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="ds-sc-section" data-testid={`sc-${id}-section`}>
      <div className="ds-sc-section-head">
        <button
          className="ds-sc-section-toggle"
          onClick={onToggle}
          aria-expanded={open}
          data-testid={`sc-toggle-${id}`}
        >
          {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          {title}
          {count !== undefined && <span className="ds-sc-count">{count}</span>}
        </button>
        {actions}
      </div>
      {open && pinned}
      {/* Own scroll, own cap: each section used to share one scroll area
          with the other two, so scrolling a long Graph moved Staged/Changes
          out of view entirely, and an unbounded list (or the Graph, which
          can be arbitrarily tall) pushed whatever came after it off-screen.
          Capping height and scrolling internally here means opening all
          three at once still keeps every section's header — and enough of
          its content — reachable without the others disappearing. */}
      {open && (
        <div className="ds-sc-section-body" data-testid={`sc-${id}-body`}>
          {children}
        </div>
      )}
    </section>
  );
}

function FileRow({
  file,
  action,
  onOpen,
  onAction,
  onDiscard,
}: {
  file: FileStatus;
  action: "stage" | "unstage";
  onOpen: () => void;
  onAction: () => void;
  /** Only unstaged rows offer it — a staged change has to be unstaged first. */
  onDiscard?: () => void;
}) {
  const { name, dir } = splitPath(file.path);
  const chip = statusChip(file.code);
  return (
    // The whole row opens the file, not just the filename: the row *looks*
    // clickable (it has a hover state and a pointer cursor), so a click on
    // the padding beside the name did nothing and read as unresponsive.
    <div
      className="ds-sc-file"
      data-testid="sc-file"
      onClick={onOpen}
      role="presentation"
    >
      <button
        className="ds-sc-file-open"
        onClick={(event) => {
          // The row handler already does this; without stopping here it
          // fires twice.
          event.stopPropagation();
          onOpen();
        }}
        title={file.path}
      >
        <span className="ds-sc-file-text">
          <span className="ds-sc-fname">{name}</span>
          <span className="ds-sc-fpath">{dir}</span>
        </span>
      </button>
      {onDiscard && (
        <Tooltip label="Discard changes" withinPortal>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label={`Discard ${file.path}`}
            onClick={(event) => {
              event.stopPropagation();
              onDiscard();
            }}
            data-testid={`sc-discard-${file.path}`}
          >
            <IconArrowBackUp size={14} />
          </ActionIcon>
        </Tooltip>
      )}
      <Tooltip
        label={action === "stage" ? "Stage this file" : "Unstage this file"}
        withinPortal
      >
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-label={`${action === "stage" ? "Stage" : "Unstage"} ${file.path}`}
          onClick={(event) => {
            // Staging is not opening — the row handler must not also fire.
            event.stopPropagation();
            onAction();
          }}
          data-testid={`sc-${action}-${file.path}`}
        >
          {action === "stage" ? <IconPlus size={14} /> : <IconMinus size={14} />}
        </ActionIcon>
      </Tooltip>
      <span
        className={`ds-sc-status ds-sc-status-${chip.tone}`}
        aria-label={`status ${chip.letter}`}
      >
        {chip.letter}
      </span>
    </div>
  );
}

export default function SourceControlPanel({
  projectHash,
  threadId,
  workingTrees,
  selectedTreeId,
  onOpenWorkingTreePicker,
  branch,
  refreshToken,
  onOpenFile,
  onReviewWorkingChanges,
  onSelectCommit,
  onSelectWorkingChanges,
  onOpenBranchPicker,
  onChanged,
  onError,
}: {
  projectHash: string;
  /** The active thread. Two jobs: it names the working tree this panel reads
   *  and writes — the thread's own worktree when it has one, the project root
   *  otherwise — and it names the provider/model Generate drafts with, so the
   *  draft runs on the agent the user picked rather than whatever was
   *  auto-detected. Every git call below passes it, so what gets staged and
   *  committed is always the tree whose rows are on screen. */
  threadId?: string | null;
  /** An explicit target list turns a previously implicit focus coupling into
   * an ordinary, inspectable user choice. Omitted temporarily by older
   * callers while they migrate to the selector. */
  workingTrees?: { id: string | null; label: string; branch: string }[];
  selectedTreeId?: string | null;
  /** Opens the app-level "Switch working tree" list — the same picker
   *  component the branch chip uses, so the two controls read as one
   *  system instead of a native `<select>` next to a custom modal. */
  onOpenWorkingTreePicker?: () => void;
  branch: string;
  /** Bumped by the app whenever the working tree may have changed. */
  refreshToken?: number;
  onOpenFile: (path: string, treeId?: string) => void;
  /** Sends the working diff to the active agent as a chat turn. */
  onReviewWorkingChanges: (treeId?: string) => void;
  /** A row in the graph was clicked — open that commit's diff. The click
   *  already moved `selectedGraphHash`'s highlight; this is what actually
   *  makes the click do something beyond that. */
  onSelectCommit: (commit: api.GraphCommit) => void;
  /** The graph's own "Uncommitted changes" node was clicked — every other
   *  IDE puts one above HEAD when the working tree is dirty, so the graph
   *  reads as the true head of history rather than stopping at the last
   *  commit. Opens the same working-tree diff Review Working Changes shows. */
  onSelectWorkingChanges: () => void;
  /** Opens the app-level "Switch branch" list. Optional so older callers
   *  keep working without it — when absent, the header just omits the
   *  branch chip rather than rendering a control that does nothing. */
  onOpenBranchPicker?: () => void;
  /** This panel wrote to the working tree. The diff pane renders the same
   *  tree from its own state, so without this it kept showing a file as
   *  unstaged that this panel had just staged — two views of one tree
   *  disagreeing, which is worse than either being slow. */
  onChanged?: () => void;
  onError: (message: unknown) => void;
}) {
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [, setLog] = useState<LogEntry[]>([]);
  const [graph, setGraph] = useState<api.GraphCommit[]>([]);
  const [graphHasMore, setGraphHasMore] = useState(false);
  /**
   * How many commits the graph has asked for.
   *
   * It used to ask for a flat 80 and say nothing about it, so a repository
   * with five thousand commits looked exactly like a shallow clone: the list
   * simply stopped, with no count and no way to go further.
   */
  const GRAPH_PAGE = 80;
  const [graphLimit, setGraphLimit] = useState(GRAPH_PAGE);
  const [graphFilter, setGraphFilter] = useState("");
  const [selectedGraphHash, setSelectedGraphHash] = useState<string | null>(null);
  // GIT-20/GIT-21: a non-git project made every reload reject identically
  // ("fatal: not a git repository") from both gitStatus and gitLog, each
  // separately calling onError — a burst of duplicate toasts with no way to
  // stop them, and no way to actually init the repo from the UI. Detected
  // once per reload and shown as a single graceful prompt instead.
  const [notARepo, setNotARepo] = useState(false);
  const [initializing, setInitializing] = useState(false);
  /** `[ahead, behind]` against the upstream, or null when there isn't one. */
  const [aheadBehind, setAheadBehind] = useState<[number, number] | null>(null);
  /** Distinguishes "level with upstream" from "there is no upstream" —
   *  both show no counts, but only one is worth explaining. */
  const [hasUpstream, setHasUpstream] = useState(true);
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<FileStatus[] | null>(null);
  const [stashes, setStashes] = useState<api.StashEntry[]>([]);
  /** Set while the "Stash changes" dialog is open. */
  const [stashDialog, setStashDialog] = useState<{ includeUntracked: boolean } | null>(null);
  const [stashMessage, setStashMessage] = useState("");
  // Independent, not exclusive: each of Staged Changes/Changes/Graph gets
  // its own capped, independently-scrolling body (.ds-sc-section-body), so
  // all three can stay open together without one growing into the others —
  // opening the Graph no longer has to close anything else.
  const [openSections, setOpenSections] = useState({
    staged: true,
    changes: true,
    stashes: true,
    graph: true,
  });

  const toggle = (key: keyof typeof openSections) =>
    setOpenSections((s) => ({ ...s, [key]: !s[key] }));

  /** The tree every call in this panel acts on. `null` and `undefined` both
   *  mean "the project root"; the IPC layer wants the latter. */
  // `undefined` means an older caller has not opted into explicit targeting;
  // `null` is the deliberate Project root choice and must not fall back to a
  // focused thread.
  const tree = selectedTreeId === undefined ? (threadId ?? undefined) : (selectedTreeId ?? undefined);

  const reload = useCallback(() => {
    api
      .gitStatus(projectHash, tree)
      .then((value) => {
        setNotARepo(false);
        setFiles(value);
      })
      .catch((err) => {
        // Was a regex over whatever text reached here. git's own wording is
        // classified once, in Rust, and arrives as a kind.
        if (errorKind(err) === "notAGitRepo") {
          setNotARepo(true);
          return;
        }
        onError(err);
      });
    api
      .gitLog(projectHash, 12, tree)
      .then(setLog)
      .catch((err) => {
        // "Not a git repository" is reported once already, via gitStatus
        // above — a second identical toast from the same cause is noise.
        if (errorKind(err) === "notAGitRepo") return;
        onError(err);
      });
    api
      .gitStashList(projectHash, tree)
      .then((value) => setStashes(value ?? []))
      .catch(() => setStashes([]));
    // No upstream is a normal state, not an error — no counts, no banner.
    api.gitAheadBehind(projectHash, tree).then(
      (value) => {
        setAheadBehind(value);
        setHasUpstream(value !== null);
      },
      () => {
        setAheadBehind(null);
        setHasUpstream(false);
      }
    );
  }, [projectHash, tree, onError]);

  useEffect(reload, [reload, refreshToken]);

  // Its own effect so "Load more" (which only bumps graphLimit) doesn't
  // re-fetch status/log/ahead-behind too.
  //
  // Asks for one commit past graphLimit so a repo whose history ends exactly
  // on a page boundary can tell "there is more" from "that was all of it"
  // without an extra round trip.
  useEffect(() => {
    api
      .gitGraph(projectHash, graphLimit + 1)
      .then((commits) => {
        setGraph(commits.slice(0, graphLimit));
        setGraphHasMore(commits.length > graphLimit);
      })
      .catch(onError);
  }, [projectHash, graphLimit, onError, refreshToken]);

  const [ahead, behind] = aheadBehind ?? [0, 0];
  const staged = files.filter((f) => isStaged(f.code));
  const unstaged = files.filter((f) => !isStaged(f.code));
  const graphRows = layoutGraph(graph).filter(({ commit }) => {
    const needle = graphFilter.trim().toLowerCase();
    return !needle || [commit.subject, commit.author, ...commit.refs, commit.hash]
      .some((value) => value.toLowerCase().includes(needle));
  });
  const graphLaneCount = Math.max(1, ...graphRows.flatMap((row) => [row.beforeLanes.length, row.nextLanes.length]));
  // Every other IDE puts a node for the working tree above HEAD when it's
  // dirty, so the graph reads as the true head of history rather than
  // stopping at the last commit. Hidden while filtering — it isn't a
  // commit the filter's subject/author/hash/ref match can apply to.
  const showUncommittedNode = files.length > 0 && graphFilter.trim() === "";

  const act = (run: Promise<unknown>) =>
    run
      .then(() => {
        reload();
        onChanged?.();
      })
      .catch(onError);

  /** Git takes an exclusive lock on the index, so staging N files is N
   *  sequential calls. `Promise.all` raced them and half failed with
   *  "Unable to create '.git/index.lock': File exists". */
  const forEachSequentially = async (
    entries: FileStatus[],
    run: (path: string) => Promise<unknown>
  ) => {
    for (const entry of entries) await run(entry.path);
  };

  const discard = () => {
    if (!confirmDiscard) return;
    const files = confirmDiscard;
    setConfirmDiscard(null);
    act(
      forEachSequentially(files, (path) =>
        api.gitDiscardFile(projectHash, path, files.find((f) => f.path === path)?.code === "??", tree)
      )
    );
  };

  const stash = () => {
    if (!stashDialog) return;
    const { includeUntracked } = stashDialog;
    setStashDialog(null);
    act(api.gitStashPush(projectHash, stashMessage, includeUntracked, tree));
    setStashMessage("");
  };

  const generate = () => {
    setGenerating(true);
    api
      .draftCommitMessage(projectHash, tree ?? null)
      .then(setMessage)
      .catch(onError)
      .finally(() => setGenerating(false));
  };

  const commit = () => {
    if (!message.trim() || staged.length === 0) return;
    setCommitting(true);
    api
      .gitCommit(projectHash, message.trim(), tree)
      .then(() => {
        setMessage("");
        reload();
        onChanged?.();
      })
      .catch(onError)
      .finally(() => setCommitting(false));
  };

  return (
    <div className="ds-sc" data-testid="source-control-panel">
      <div className="ds-panel-head">
        <div className="ds-sc-head-title">
          <span>Source Control</span>
          <HoverCard width={260} shadow="md" openDelay={150} withinPortal>
            <HoverCard.Target>
              <ActionIcon
                variant="subtle"
                size="sm"
                aria-label="What's the difference between branch and working tree?"
              >
                <IconInfoCircle size={15} />
              </ActionIcon>
            </HoverCard.Target>
            <HoverCard.Dropdown>
              <Stack gap={10}>
                <Group gap={8} align="flex-start" wrap="nowrap">
                  <IconGitBranch size={14} className="ds-sc-info-icon" />
                  <div>
                    <Text size="xs" fw={600}>Branch</Text>
                    <Text size="xs" c="dimmed">
                      Which git branch is checked out. Switching it moves
                      the branch itself, wherever it's checked out.
                    </Text>
                  </div>
                </Group>
                <Group gap={8} align="flex-start" wrap="nowrap">
                  <IconFolder size={14} className="ds-sc-info-icon" />
                  <div>
                    <Text size="xs" fw={600}>Working tree</Text>
                    <Text size="xs" c="dimmed">
                      Which copy of the repo you're looking at — the
                      project root, or a thread's own isolated worktree.
                    </Text>
                  </div>
                </Group>
              </Stack>
            </HoverCard.Dropdown>
          </HoverCard>
        </div>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" size="sm" aria-label="Stash actions" data-testid="sc-stash-menu">
              <IconArchive size={15} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              disabled={files.length === 0}
              onClick={() => setStashDialog({ includeUntracked: false })}
              data-testid="sc-stash"
            >
              Stash…
            </Menu.Item>
            <Menu.Item
              disabled={files.length === 0}
              onClick={() => setStashDialog({ includeUntracked: true })}
              data-testid="sc-stash-untracked"
            >
              Stash (include untracked)…
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" size="sm" aria-label="Remote actions">
              <IconEaseOutControlPoint size={15} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {/* fetch/pull/push live here rather than as primary buttons —
                Amendment 7 supersedes the old git-btn cluster. */}
            <Menu.Item
              onClick={() => act(api.gitFetch(projectHash, tree))}
            >
              Fetch
            </Menu.Item>
            {!hasUpstream && (
              <Menu.Item disabled data-testid="sc-no-upstream">
                No upstream yet — Push will set one
              </Menu.Item>
            )}
            <Menu.Item
              onClick={() => act(api.gitPull(projectHash, tree))}
              data-testid="sc-pull"
            >
              Pull{behind > 0 ? ` ${behind}` : ""}
            </Menu.Item>
            <Menu.Item
              onClick={() => act(api.gitPush(projectHash, tree))}
              data-testid="sc-push"
            >
              Push{ahead > 0 ? ` ${ahead}` : ""}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>

      {notARepo ? (
        <div className="ds-panel-body">
          <Stack gap="xs" p="xs" data-testid="sc-not-a-repo">
            <Text size="xs" c="dimmed">
              This folder isn't a git repository yet.
            </Text>
            <Button
              size="xs"
              variant="default"
              loading={initializing}
              data-testid="sc-git-init"
              onClick={() => {
                setInitializing(true);
                api
                  .gitInit(projectHash)
                  .then(() => {
                    setNotARepo(false);
                    reload();
                  })
                  .catch(onError)
                  .finally(() => setInitializing(false));
              }}
            >
              Initialize repository
            </Button>
          </Stack>
        </div>
      ) : (
      <>
      {/* Fixed action area: the working-tree selector, composer, and the two
          primary buttons stay reachable no matter how tall Staged
          Changes/Changes/Graph grow below — those three share their own
          scrollable body instead of this one. */}
      <div className="ds-panel-body">
        {onOpenBranchPicker && (
          <div className="ds-sc-target">
            <span>Branch</span>
            <UnstyledButton
              className="ds-sc-target-btn"
              onClick={onOpenBranchPicker}
              aria-label={`Switch branch: ${branch}`}
              title={branch}
            >
              <IconGitBranch size={13} />
              <span className="ds-sc-target-btn-label">{branch}</span>
            </UnstyledButton>
          </div>
        )}
        {workingTrees && onOpenWorkingTreePicker && (() => {
          const current =
            workingTrees.find(
              (wt) => (wt.id ?? null) === (selectedTreeId ?? null)
            ) ?? workingTrees[0];
          return (
            <div className="ds-sc-target">
              <span>Working tree</span>
              <UnstyledButton
                className="ds-sc-target-btn"
                onClick={onOpenWorkingTreePicker}
                aria-label={`Switch working tree: ${current.label}`}
                title={`${current.label} · ${current.branch}`}
              >
                <IconFolder size={13} />
                <span className="ds-sc-target-btn-label">
                  {current.label} · {current.branch}
                </span>
              </UnstyledButton>
              <small>Commits, staging, and sync apply here.</small>
            </div>
          );
        })()}
        <div className="ds-sc-commit-box">
          <Text size="xs" component="label" htmlFor="sc-commit-message">
            Commit message
          </Text>
          <Textarea
            id="sc-commit-message"
            value={message}
            onChange={(e) => setMessage(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                e.preventDefault();
                commit();
              }
            }}
            placeholder="e.g. fix: prevent duplicate sends"
            aria-label="Commit message"
            rows={3}
            data-testid="sc-commit-message"
          />
          <div className="ds-sc-commit-actions">
            <Text size="xs" c="dimmed">⌘↵ commits staged changes</Text>
            <Button
              size="compact-xs"
              variant="light"
              leftSection={
                generating ? <Loader size={11} /> : <IconSparkles size={13} />
              }
              disabled={generating}
              onClick={generate}
              data-testid="sc-generate"
            >
              {generating ? "Drafting…" : "Generate"}
            </Button>
          </div>
        </div>

        <Button
          fullWidth
          leftSection={<IconCheck size={14} />}
          disabled={!message.trim() || staged.length === 0 || committing}
          onClick={commit}
          data-testid="sc-commit"
        >
          Commit{staged.length > 0 ? ` ${staged.length}` : ""}
        </Button>
        <Button
          fullWidth
          variant="default"
          mt={6}
          leftSection={<IconSparkles size={14} />}
          onClick={() => onReviewWorkingChanges(tree)}
          data-testid="sc-review"
        >
          Review Working Changes
        </Button>
      </div>

      <div className="ds-panel-body">
        <Section
          id="staged"
          title="Staged Changes"
          count={staged.length}
          open={openSections.staged}
          onToggle={() => toggle("staged")}
          actions={
            staged.length > 0 && (
              <Tooltip label="Unstage all" withinPortal>
                <ActionIcon
                  variant="subtle"
                  size="sm"
                  aria-label="Unstage all"
                  onClick={() =>
                    act(
                      forEachSequentially(staged, (path) =>
                        api.gitUnstageFile(projectHash, path, tree)
                      )
                    )
                  }
                  data-testid="sc-unstage-all"
                >
                  <IconMinus size={15} />
                </ActionIcon>
              </Tooltip>
            )
          }
        >
          {staged.length === 0 && <p className="empty">Nothing staged.</p>}
          {staged.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              action="unstage"
              onOpen={() => onOpenFile(file.path, tree)}
              onAction={() => act(api.gitUnstageFile(projectHash, file.path, tree))}
            />
          ))}
        </Section>

        <Section
          id="changes"
          title="Changes"
          count={unstaged.length}
          open={openSections.changes}
          onToggle={() => toggle("changes")}
          actions={
            <div className="ds-sc-row-icons">
              {unstaged.length > 0 && (
                <Tooltip label="Stage all" withinPortal>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label="Stage all"
                    onClick={() =>
                      act(
                        forEachSequentially(unstaged, (path) =>
                          api.gitStageFile(projectHash, path, tree)
                        )
                      )
                    }
                    data-testid="sc-stage-all"
                  >
                    <IconCheck size={15} />
                  </ActionIcon>
                </Tooltip>
              )}
              {unstaged.length > 0 && (
                <Tooltip label="Discard all changes" withinPortal>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label="Discard all changes"
                    onClick={() => setConfirmDiscard(unstaged)}
                    data-testid="sc-discard-all"
                  >
                    <IconArrowBackUp size={15} />
                  </ActionIcon>
                </Tooltip>
              )}
              <Tooltip label="Refresh" withinPortal>
                <ActionIcon
                  variant="subtle"
                  size="sm"
                  aria-label="Refresh"
                  onClick={reload}
                  data-testid="sc-refresh"
                >
                  <IconRefresh size={15} />
                </ActionIcon>
              </Tooltip>
            </div>
          }
        >
          {unstaged.length === 0 && <p className="empty">No changes.</p>}
          {unstaged.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              action="stage"
              onOpen={() => onOpenFile(file.path, tree)}
              onAction={() => act(api.gitStageFile(projectHash, file.path, tree))}
              onDiscard={() => setConfirmDiscard([file])}
            />
          ))}
        </Section>

        {stashes.length > 0 && (
          <Section
            id="stashes"
            title="Stashes"
            count={stashes.length}
            open={openSections.stashes}
            onToggle={() => toggle("stashes")}
          >
            {stashes.map((entry) => (
              <div className="ds-sc-file" data-testid="sc-stash-row" key={entry.name}>
                <span className="ds-sc-file-text" title={entry.message}>
                  <span className="ds-sc-fname">{entry.message}</span>
                  <span className="ds-sc-fpath">{entry.name}</span>
                </span>
                {([
                  ["apply", "Apply", <IconPlus size={14} />],
                  ["pop", "Pop", <IconArrowBackUp size={14} />],
                  ["drop", "Drop", <IconMinus size={14} />],
                ] as const).map(([action, label, icon]) => (
                  <Tooltip key={action} label={`${label} stash`} withinPortal>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      aria-label={`${label} ${entry.name}`}
                      onClick={() => act(api.gitStashAction(projectHash, action, entry.name, tree))}
                      data-testid={`sc-stash-${action}-${entry.name}`}
                    >
                      {icon}
                    </ActionIcon>
                  </Tooltip>
                ))}
              </div>
            ))}
          </Section>
        )}

        <Section
          id="graph"
          title="Graph"
          open={openSections.graph}
          onToggle={() => toggle("graph")}
          pinned={
            <TextInput
              size="xs"
              value={graphFilter}
              onChange={(event) => setGraphFilter(event.currentTarget.value)}
              placeholder="Filter commits or branches"
              aria-label="Filter commit graph"
              mb={4}
            />
          }
        >
          <div className="ds-sc-graph" data-testid="sc-graph">
            {showUncommittedNode && (
              <UnstyledButton
                className="ds-sc-commit ds-sc-commit-uncommitted"
                aria-label={`Review working changes — ${files.length} file${files.length === 1 ? "" : "s"} changed`}
                data-testid="sc-uncommitted-row"
                onClick={onSelectWorkingChanges}
              >
                <UncommittedLane laneCount={graphLaneCount} height={commitRowHeight("", 0)} />
                <div className="ds-sc-commit-text">
                  <span className="ds-sc-commit-msg">Uncommitted changes</span>
                  <span className="ds-sc-commit-meta">
                    <span className="ds-sc-commit-author">
                      {files.length} file{files.length === 1 ? "" : "s"} changed
                    </span>
                  </span>
                </div>
              </UnstyledButton>
            )}
            {graph.length === 0 && <p className="empty">No commits yet.</p>}
            {graph.length > 0 && graphRows.length === 0 && <p className="empty">No matching commits.</p>}
            {graphRows.map((row, index) => {
              const entry = row.commit;
              const selected = selectedGraphHash === entry.hash;
              return (
              <UnstyledButton
                key={entry.hash}
                className={`ds-sc-commit${index === 0 ? " current" : ""}${selected ? " selected" : ""}`}
                aria-label={`View commit ${entry.subject}`}
                aria-pressed={selected}
                data-testid="sc-commit-row"
                style={{ height: commitRowHeight(entry.subject, entry.refs.length) }}
                onClick={() => {
                  setSelectedGraphHash(entry.hash);
                  onSelectCommit(entry);
                }}
              >
                <GraphLanes row={row} laneCount={graphLaneCount} isFirstRow={index === 0 && !showUncommittedNode} height={commitRowHeight(entry.subject, entry.refs.length)} />
                <div className="ds-sc-commit-text">
                  <span
                    className="ds-sc-commit-msg"
                    title={entry.subject}
                    style={{ WebkitLineClamp: subjectLines(entry.subject) }}
                  >
                    {entry.subject}
                  </span>
                  {/* One chip per ref rather than one chip holding every ref
                      joined by a separator: a commit that is both HEAD and the
                      tip of three branches produced a 699px nowrap string in a
                      138px row, so none of the names was readable. */}
                  {entry.refs.map((ref) => (
                    <span key={ref} className="ds-sc-branch-badge" title={ref}>
                      <IconGitBranch size={11} />
                      <span className="ds-sc-branch-badge-name">{shortRef(ref)}</span>
                    </span>
                  ))}
                  <span className="ds-sc-commit-meta">
                    <span className="ds-sc-commit-author" title={entry.author}>{entry.author}</span>
                    <span className="ds-sc-commit-age">{relativeTime(entry.date)}</span>
                    <span className="ds-sc-commit-hash" title={entry.hash}>{entry.hash.slice(0, 7)}</span>
                  </span>
                </div>
              </UnstyledButton>
              );
            })}
          </div>
          {/* Truthful rather than approximate: the count is what is actually
              loaded, and the button appears only when a commit past the
              current page was actually seen. */}
          <Group gap={8} px={4} pt={4} justify="space-between" data-testid="sc-graph-footer">
            <Text size="xs" c="dimmed">
              {graph.length} commit{graph.length === 1 ? "" : "s"}
              {graphHasMore ? "" : " · all of them"}
            </Text>
            {graphHasMore && (
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => setGraphLimit((n) => n + GRAPH_PAGE)}
                data-testid="sc-graph-load-more"
              >
                Load {GRAPH_PAGE} more
              </Button>
            )}
          </Group>
        </Section>
      </div>
      </>
      )}

      {confirmDiscard && (
        <MantineModal
          opened
          onClose={() => setConfirmDiscard(null)}
          title={
            confirmDiscard.length === 1
              ? `Discard changes to "${confirmDiscard[0].path}"?`
              : `Discard changes to ${confirmDiscard.length} files?`
          }
          transitionProps={{ duration: 0 }}
        >
          <Text size="sm">
            This can't be undone.
            {confirmDiscard.some((f) => f.code === "??") &&
              " Untracked files are deleted."}
          </Text>
          <Group justify="flex-end" gap="sm" mt="lg">
            <Button size="xs" variant="default" onClick={() => setConfirmDiscard(null)}>
              Cancel
            </Button>
            <Button size="xs" color="danger" onClick={discard} data-testid="confirm-discard" autoFocus>
              Discard
            </Button>
          </Group>
        </MantineModal>
      )}

      {stashDialog && (
        <MantineModal
          opened
          onClose={() => setStashDialog(null)}
          title={stashDialog.includeUntracked ? "Stash changes (include untracked)" : "Stash changes"}
          transitionProps={{ duration: 0 }}
        >
          <TextInput
            size="xs"
            value={stashMessage}
            onChange={(event) => setStashMessage(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") stash();
            }}
            placeholder="Message (optional)"
            aria-label="Stash message"
            data-autofocus
            data-testid="sc-stash-message"
          />
          <Group justify="flex-end" gap="sm" mt="lg">
            <Button size="xs" variant="default" onClick={() => setStashDialog(null)}>
              Cancel
            </Button>
            <Button size="xs" onClick={stash} data-testid="confirm-stash">
              Stash
            </Button>
          </Group>
        </MantineModal>
      )}
    </div>
  );
}
