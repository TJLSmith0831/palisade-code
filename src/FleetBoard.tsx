import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Menu,
  Select,
  SegmentedControl,
  Skeleton,
  Text,
  Textarea,
  Tooltip,
  VisuallyHidden,
} from "@mantine/core";
import { IconAiAgent, IconDots, IconRoute } from "@tabler/icons-react";
import { listModels, type AgentCommand, type FleetRow, type ModelInfo } from "./api";
import { AttentionPill, OverlapBadge, VerifyBadge } from "./fleetBadges";
import { activityLabel, relativeTime } from "./SessionList";
import { ArchivingSpinner, useIsArchiving } from "./archiving";
import { MODE_SELECTOR_STYLES } from "./modeSelectorStyles";
import WorktreeModeBadge from "./WorktreeModeBadge";
import { ComposerTray, DropHint, imagePasteHandler } from "./ComposerTray";
import {
  handleSlashMenuKey,
  pickSkillIntoTray,
  SlashMenu,
  useInstalledSkills,
  useSlashMenu,
  withInstalled,
  withoutSigil,
} from "./SkillMenu";
import { buildPrompt } from "./slashCommands";

export type NewRunInput = {
  prompt: string;
  agentId?: string;
  /** Flows into the same `setThreadExecutor` model field the main
   *  composer's model picker writes. Undefined when the agent offers no
   *  models (or none is picked yet) — same as the main composer's default. */
  model?: string;
  mode: "spec" | "go";
  isolated: boolean;
  /** Stored image paths from the tray. */
  attachments?: string[];
};

export type FleetBoardProps = {
  rows: FleetRow[];
  loading: boolean;
  error?: string;
  /** The open project, named above the composer so the board says where a new
   *  run would land before you type it. */
  projectName?: string;
  /** Scopes the model probe to the open project, same as the main
   *  composer's `api.listModels(project.hash, agentId)` call. Wired from
   *  App.tsx as `project?.hash` — undefined falls back to the backend's
   *  home-directory probe. */
  projectHash?: string | null;
  agents: { id: string; name: string; installed: boolean }[];
  /** Threads with a live/busy session — the same optimistic set the sidebar's
   *  dot already trusts. See `groupFleet`. */
  liveThreadIds?: Set<string>;
  /** Threads whose title is still being written in the background. */
  titlePendingIds?: Set<string>;
  onOpen(threadId: string): void;
  onReview(threadId: string): void;
  onStop(threadId: string): void;
  /** Opens a playbook run — the board's Open for a `playbook` row. */
  onOpenRun(runId: string): void;
  /** Stops a playbook run — the board's Stop for a `playbook` row. */
  onCancelRun(runId: string): void;
  onArchiveRun(projectId: string, runId: string): void;
  onMerge(projectId: string, threadId: string): void;
  onOpenPr(projectId: string, threadId: string): void;
  onArchive(projectId: string, threadId: string): void;
  onNewRun(input: NewRunInput): void;
  /** Images dropped or pasted onto the board's composer (stored paths). */
  attachments?: string[];
  onRemoveAttachment?: (path: string) => void;
  onPasteImages?: (images: { dataBase64: string; ext: string }[]) => void;
  /** Other dropped files, sent as `@path` mentions. */
  files?: string[];
  onRemoveFile?: (path: string) => void;
  /** A file is being dragged over the window. */
  dragActive?: boolean;
  /** Skills live sessions have advertised. A new run has no session yet, so
   *  these plus the user's installed skills are what its `/` menu offers. */
  skillCommands?: AgentCommand[];
};

/** A playbook row's subtitle. The saved playbook's name says which script ran;
 *  the seed says what this run was actually asked to do, which is the thing
 *  that tells two runs of the same playbook apart. */
export function playbookSubtitle(row: FleetRow): string {
  const seed = row.seed?.trim();
  if (!seed) return "Playbook run";
  return `Playbook · ${seed.length > 60 ? `${seed.slice(0, 60)}…` : seed}`;
}

/** Split the fleet into the three bands the board renders. Attention rows are
 *  newest-first — the thing that just stopped and wants you is the thing you
 *  most likely came here for.
 *
 *  A session goes busy on the backend the instant a prompt is sent, but a
 *  row's own status only catches up on the next executor event or the slow
 *  poll (see useFleet) — so a run just started from this board's composer
 *  could sit under "Idle" for several seconds. `liveThreadIds` is the same
 *  optimistic flag the sidebar's dot already trusts; a thread row trusts it
 *  too, unless the row already says a permission prompt is waiting. */
export function groupFleet(
  rows: FleetRow[],
  liveThreadIds: Set<string> = new Set()
): {
  attention: FleetRow[];
  running: FleetRow[];
  unreviewed: FleetRow[];
  idle: FleetRow[];
} {
  const status = (r: FleetRow) =>
    r.kind === "thread" && r.status !== "attention" && liveThreadIds.has(r.threadId)
      ? "running"
      : r.status;
  const newestFirst = (a: FleetRow, b: FleetRow) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return {
    attention: rows.filter((r) => status(r) === "attention").sort(newestFirst),
    running: rows.filter((r) => status(r) === "running"),
    unreviewed: rows.filter((r) => status(r) === "unreviewed").sort(newestFirst),
    idle: rows.filter((r) => status(r) === "idle"),
  };
}

function Row({
  row,
  running,
  naming = false,
  onOpen,
  onReview,
  onStop,
  onMerge,
  onOpenPr,
  onArchive,
  onOpenRun,
  onCancelRun,
  onArchiveRun,
}: {
  row: FleetRow;
  /** Whether this row landed in the board's "Running" band — already
   *  resolved by `groupFleet` (raw + optimistic), so Stop doesn't wait on
   *  the row's own status to catch up. */
  running: boolean;
  /** The title is still being written; show a skeleton, not the placeholder. */
  naming?: boolean;
} & Pick<
  FleetBoardProps,
  | "onOpen"
  | "onReview"
  | "onStop"
  | "onMerge"
  | "onOpenPr"
  | "onArchive"
  | "onOpenRun"
  | "onCancelRun"
  | "onArchiveRun"
>) {
  const mergeable = row.merge === "clean" && row.verify.state === "pass";
  // A playbook run is not a thread: it opens and stops by run id, and it has
  // no branch to merge, no PR to open and nothing to archive.
  const playbook = row.kind === "playbook";
  const runId = row.runId ?? row.threadId;
  // Keyed like the archive call itself: a playbook run archives by run id.
  const archiving = useIsArchiving(runId);
  const open = () => (playbook ? onOpenRun(runId) : onOpen(row.threadId));
  const stop = () => (playbook ? onCancelRun(runId) : onStop(row.threadId));

  return (
    <div
      className="fleet-row"
      data-busy={archiving || undefined}
      role="button"
      tabIndex={0}
      data-testid="fleet-row"
      data-thread={row.threadId}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          open();
        } else if (!playbook && (e.key === "r" || e.key === "R")) {
          e.preventDefault();
          onReview(row.threadId);
        }
      }}
    >
      <Tooltip
        label={
          playbook
            ? `Playbook · ${row.playbookName ?? row.title}`
            : row.agentName ?? row.agentId ?? "No agent"
        }
        openDelay={400}
      >
        <span className="fleet-agent" data-testid="fleet-agent">
          {playbook ? (
            <IconRoute size={14} aria-label="Playbook" />
          ) : (
            <IconAiAgent size={14} aria-label={row.agentName ?? "Agent"} />
          )}
        </span>
      </Tooltip>

      <div className="fleet-row-main">
        <div className="fleet-row-title">
          {naming ? (
            <Skeleton height={12} width="45%" my={3} role="status" aria-label="Naming thread" />
          ) : (
            row.title
          )}
        </div>
        <div className="fleet-row-meta">
          <span>
            {playbook
              ? playbookSubtitle(row)
              : `${row.projectName}${row.branch ? ` · ${row.branch}` : ""}${
                  row.mergeTarget ? ` → ${row.mergeTarget}` : ""
                }`}
          </span>
          {/* A run writes in its thread's tree, so its own diff is always
              zero — a "+0 −0 · 0 files" on every playbook row is noise, not
              evidence. */}
          {/* A branch with no worktree means the worktree is gone: there is
              nothing left to measure, so nothing is shown. */}
          {!playbook && !(row.branch && !row.worktreePath) && (
            <span className="fleet-diff" data-testid="fleet-diff">
              <span className="added">+{row.diff.added}</span>{" "}
              <span className="removed">−{row.diff.removed}</span> ·{" "}
              {row.diff.files} files
              {/* New files carry no line counts, so they are said, not
                  silently folded into a number that can't hold them. */}
              {(row.diff.untracked ?? 0) > 0 && ` · ${row.diff.untracked} new`}
            </span>
          )}
          {playbook && <span>{relativeTime(row.updatedAt)}</span>}
        </div>
        {/* Rows are ordered by last touched, which includes opening the
            thread, so the times shown are the two that are facts. */}
        {!playbook && (
          <div className="fleet-row-meta" data-testid="fleet-times">
            {activityLabel(row.createdAt, row.lastActivityAt)}
          </div>
        )}
      </div>

      <div className="fleet-row-badges">
        {row.attention && <AttentionPill attention={row.attention} />}
        {/* Verification is a thread's evidence. A run has no commit of its
            own to have verified, so the badge would only ever say the same
            nothing. */}
        {!playbook && <VerifyBadge verify={row.verify} />}
        <OverlapBadge overlap={row.overlap} />
      </div>

      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <button
            className="ds-icon-btn"
            aria-label={`Actions for ${row.title}`}
            data-testid="fleet-actions"
            disabled={archiving}
            onClick={(e) => e.stopPropagation()}
          >
            {archiving ? <ArchivingSpinner /> : <IconDots size={14} />}
          </button>
        </Menu.Target>
        <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
          <Menu.Item onClick={open}>Open</Menu.Item>
          {!playbook && (
            <Menu.Item onClick={() => onReview(row.threadId)}>Review</Menu.Item>
          )}
          {running && (
            <Menu.Item onClick={stop}>Stop</Menu.Item>
          )}
          {/* Merge, PR and Archive are a branch's story. A playbook run has
              no branch of its own. */}
          {!playbook &&
            (mergeable ? (
              <Menu.Item onClick={() => onMerge(row.projectId, row.threadId)}>Merge</Menu.Item>
            ) : (
              <Tooltip label="Merge needs a passing verify">
                <div>
                  <Menu.Item disabled data-testid="fleet-merge-disabled">
                    Merge
                  </Menu.Item>
                </div>
              </Tooltip>
            ))}
          {!playbook && (
            <Menu.Item onClick={() => onOpenPr(row.projectId, row.threadId)}>Open PR</Menu.Item>
          )}
          {!playbook && (
            <Menu.Item onClick={() => onArchive(row.projectId, row.threadId)}>Archive</Menu.Item>
          )}
          {playbook && row.archivable && (
            <Menu.Item onClick={() => onArchiveRun(row.projectId, runId)}>Archive</Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}

/** Fast loads never flash the skeleton. */
const SKELETON_DELAY_MS = 150;

/** Placeholder rows shaped like `Row`, so the board doesn't jump when real
 *  ones land. Delayed so a fast load never flashes them. */
function FleetSkeleton() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <div data-testid="fleet-skeleton">
      <VisuallyHidden role="status">Loading runs…</VisuallyHidden>
      <Skeleton height={12} width={72} mb="xs" />
      {[0, 1, 2].map((i) => (
        <div className="fleet-row" data-skeleton key={i}>
          <Skeleton circle height={16} />
          <div className="fleet-row-main" style={{ flex: 1 }}>
            <Skeleton height={12} width="45%" mb={8} />
            <Skeleton height={10} width="70%" />
          </div>
          <Skeleton height={18} width={64} radius="xl" />
        </div>
      ))}
    </div>
  );
}

export default function FleetBoard({
  rows,
  loading,
  error,
  projectName,
  projectHash,
  agents,
  liveThreadIds,
  titlePendingIds,
  onOpen,
  onReview,
  onStop,
  onMerge,
  onOpenPr,
  onArchive,
  onOpenRun,
  onCancelRun,
  onArchiveRun,
  onNewRun,
  attachments = [],
  onRemoveAttachment,
  onPasteImages,
  files = [],
  onRemoveFile,
  dragActive = false,
  skillCommands = [],
}: FleetBoardProps) {
  const installed = agents.filter((a) => a.installed);
  const [prompt, setPrompt] = useState("");
  // The same `/` menu and tray the thread composer has (SkillMenu.tsx).
  const [caret, setCaret] = useState(0);
  const [skills, setSkills] = useState<string[]>([]);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const installedSkills = useInstalledSkills();
  const skillPool = useMemo(
    () => withInstalled(skillCommands, installedSkills),
    [skillCommands, installedSkills]
  );
  const menu = useSlashMenu(prompt, caret, skillPool);
  const pickSkill = (command: AgentCommand) => {
    if (!menu.slash) return;
    const next = pickSkillIntoTray(prompt, menu.slash, skills, command.name);
    setPrompt(next.text);
    setSkills(next.skills);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const trackCaret = (event: React.SyntheticEvent<HTMLTextAreaElement>) =>
    setCaret(event.currentTarget.selectionStart ?? 0);
  const [agentId, setAgentId] = useState<string | null>(installed[0]?.id ?? null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [mode, setMode] = useState<"spec" | "go">("spec");
  const [isolated, setIsolated] = useState(true);

  // Same `list_models` probe the main composer's model picker and the
  // playbook canvas's node editor use, re-read whenever the agent changes —
  // an old model choice means nothing to a new agent.
  useEffect(() => {
    setModelId(null);
    if (!agentId) {
      setModels([]);
      setModelsLoading(false);
      return;
    }
    let live = true;
    setModelsLoading(true);
    listModels(projectHash ?? null, agentId)
      .then((state) => {
        if (live) {
          setModels(state.models);
          // `current` is the model a new session would run — the agent's own
          // "default" option (Claude: "Default (recommended)") when it has one.
          const pick = state.current;
          setModelId(pick && state.models.some((model) => model.id === pick) ? pick : null);
        }
      })
      .catch(() => live && setModels([]))
      .finally(() => live && setModelsLoading(false));
    return () => {
      live = false;
    };
  }, [projectHash, agentId]);

  const groups = groupFleet(rows, liveThreadIds);
  const bands: { key: string; label: string; list: FleetRow[] }[] = [
    { key: "attention", label: "Needs attention", list: groups.attention },
    { key: "running", label: "Running", list: groups.running },
    { key: "unreviewed", label: "Unreviewed", list: groups.unreviewed },
    { key: "idle", label: "Idle", list: groups.idle },
  ];

  const canStart =
    (prompt.trim().length > 0 || skills.length > 0 || attachments.length > 0 || files.length > 0) &&
    installed.length > 0;

  return (
    <section
      className="fleet-board"
      aria-label="Fleet"
      aria-busy={loading && rows.length === 0}
      data-testid="fleet-board"
    >
      <div className="fleet-header">
        <Text className="fleet-header-project">
          {projectName ?? "Fleet"}
        </Text>
        <div className="fleet-statuses" aria-label="Fleet status" data-testid="fleet-counts">
          <div className="fleet-status" data-testid="fleet-count-attention">
            <span className="fleet-status-value">
              <span className="fleet-status-dot" data-status="attention" aria-hidden="true" />
              {groups.attention.length}
            </span>
            <span className="fleet-status-label">Needs attention</span>
          </div>
          <div className="fleet-status" data-testid="fleet-count-running">
            <span className="fleet-status-value">
              <span className="fleet-status-dot" data-status="running" aria-hidden="true" />
              {groups.running.length}
            </span>
            <span className="fleet-status-label">Running</span>
          </div>
          <div className="fleet-status" data-testid="fleet-count-unreviewed">
            <span className="fleet-status-value">
              <span className="fleet-status-dot" data-status="unreviewed" aria-hidden="true" />
              {groups.unreviewed.length}
            </span>
            <span className="fleet-status-label">Unreviewed</span>
          </div>
          <div className="fleet-status" data-testid="fleet-count-idle">
            <span className="fleet-status-value">
              <span className="fleet-status-dot" data-status="idle" aria-hidden="true" />
              {groups.idle.length}
            </span>
            <span className="fleet-status-label">Idle</span>
          </div>
        </div>
      </div>

      <div className={`fleet-composer${dragActive ? " drag-active" : ""}`}>
        <DropHint active={dragActive} />
        <SlashMenu menu={menu} onPick={pickSkill} />
        <ComposerTray
          projectHash={projectHash}
          skills={skills}
          attachments={attachments}
          files={files}
          commands={skillPool}
          installed={installedSkills}
          onRemoveSkill={(name) => setSkills(skills.filter((s) => s !== name))}
          onRemoveAttachment={(path) => onRemoveAttachment?.(path)}
          onRemoveFile={onRemoveFile}
        />
        <Textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.currentTarget.value);
            setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
          }}
          onSelect={trackCaret}
          onClick={trackCaret}
          onKeyDown={(event) => {
            if (
              event.key === "Backspace" &&
              skills.length > 0 &&
              event.currentTarget.selectionStart === 0 &&
              event.currentTarget.selectionEnd === 0
            ) {
              event.preventDefault();
              setSkills(skills.slice(0, -1));
              return;
            }
            handleSlashMenuKey(event, menu, pickSkill, (token) => {
              setPrompt(withoutSigil(prompt, token));
              setCaret(Math.max(0, caret - token.sigil.length));
            });
          }}
          onPaste={imagePasteHandler(onPasteImages)}
          placeholder="What should the agent do?"
          aria-label="New run prompt"
          rows={3}
          classNames={{ input: "fleet-prompt-input" }}
          data-testid="fleet-prompt"
        />
        <div className="fleet-composer-row">
          <Select
            value={agentId}
            onChange={setAgentId}
            data={installed.map((a) => ({ value: a.id, label: a.name }))}
            placeholder={installed.length ? "Agent" : "No agents installed"}
            aria-label="Agent"
            disabled={installed.length === 0}
            data-testid="fleet-agent-select"
          />
          <Select
            value={modelId}
            onChange={setModelId}
            data={models.map((m) => ({ value: m.id, label: m.name }))}
            placeholder={
              modelsLoading
                ? "Loading models…"
                : models.length
                  ? "Model"
                  : "No models offered"
            }
            aria-label="Model"
            disabled={modelsLoading || models.length === 0}
            data-testid="fleet-model-select"
          />
          <SegmentedControl
            value={mode}
            onChange={(value) => setMode(value as "spec" | "go")}
            data={[
              { value: "spec", label: "Spec" },
              { value: "go", label: "Go" },
            ]}
            aria-label="Mode"
            data-testid="fleet-mode"
            styles={MODE_SELECTOR_STYLES}
            classNames={{
              control: "mode-selector-control",
              label: "mode-selector-label",
            }}
          />
          <WorktreeModeBadge
            isolated={isolated}
            tooltip={
              isolated
                ? "Runs in its own git worktree — click to edit the project directly"
                : "Edits the project directory directly, so uncommitted changes there can be overwritten — click to isolate this run"
            }
            onClick={() => setIsolated(!isolated)}
            data-testid="fleet-isolated"
          />
          <Button
            disabled={!canStart}
            data-testid="fleet-start"
            onClick={() => {
              onNewRun({
                // Skills lead the prompt, the same as a thread's first turn.
                prompt: buildPrompt(
                  [prompt.trim(), ...files.map((f) => `@${f}`)].filter(Boolean).join(" "),
                  skills
                ),
                attachments,
                agentId: agentId ?? undefined,
                model: modelId ?? undefined,
                mode,
                isolated,
              });
              setPrompt("");
              setSkills([]);
            }}
          >
            Start run
          </Button>
        </div>
      </div>

      {loading && rows.length === 0 && !error && <FleetSkeleton />}

      {error && (
        <p className="fleet-error" role="alert" data-testid="fleet-error">
          {error}
        </p>
      )}

      {rows.length === 0 && !loading && !error && (
        <div className="empty fleet-empty" data-testid="fleet-empty">
          <p>No runs yet. Start one above.</p>
        </div>
      )}

      {bands.map(
        (band) =>
          band.list.length > 0 && (
            <div key={band.key} data-testid={`fleet-group-${band.key}`}>
              <h2 className="ds-section-heading">{band.label}</h2>
              {band.list.map((row) => (
                <Row
                  key={row.threadId}
                  row={row}
                  running={band.key === "running"}
                  naming={titlePendingIds?.has(row.threadId)}
                  onOpen={onOpen}
                  onReview={onReview}
                  onStop={onStop}
                  onMerge={onMerge}
                  onOpenPr={onOpenPr}
                  onArchive={onArchive}
                  onOpenRun={onOpenRun}
                  onCancelRun={onCancelRun}
                  onArchiveRun={onArchiveRun}
                />
              ))}
            </div>
          )
      )}
    </section>
  );
}
