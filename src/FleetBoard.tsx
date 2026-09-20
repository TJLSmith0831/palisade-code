import { useEffect, useState } from "react";
import {
  Button,
  Menu,
  Select,
  SegmentedControl,
  Switch,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { IconBox, IconDots, IconRoute } from "@tabler/icons-react";
import { listModels, type FleetRow, type ModelInfo } from "./api";
import { AttentionPill, OverlapBadge, VerifyBadge } from "./fleetBadges";
import { relativeTime } from "./SessionList";
import { ArchivingSpinner, useIsArchiving } from "./archiving";
import { MODE_SELECTOR_STYLES } from "./modeSelectorStyles";

export type NewRunInput = {
  prompt: string;
  agentId?: string;
  /** Flows into the same `setThreadExecutor` model field the main
   *  composer's model picker writes. Undefined when the agent offers no
   *  models (or none is picked yet) — same as the main composer's default. */
  model?: string;
  mode: "spec" | "go";
  isolated: boolean;
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
 *  most likely came here for. */
export function groupFleet(rows: FleetRow[]): {
  attention: FleetRow[];
  running: FleetRow[];
  idle: FleetRow[];
} {
  const attention = rows
    .filter((r) => r.status === "attention")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return {
    attention,
    running: rows.filter((r) => r.status === "running"),
    idle: rows.filter((r) => r.status === "idle"),
  };
}

function Row({
  row,
  onOpen,
  onReview,
  onStop,
  onMerge,
  onOpenPr,
  onArchive,
  onOpenRun,
  onCancelRun,
  onArchiveRun,
}: { row: FleetRow } & Pick<
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
            <IconBox size={14} aria-label={row.agentName ?? "Agent"} />
          )}
        </span>
      </Tooltip>

      <div className="fleet-row-main">
        <div className="fleet-row-title">{row.title}</div>
        <div className="fleet-row-meta">
          <span>
            {playbook
              ? playbookSubtitle(row)
              : `${row.projectName}${row.branch ? ` · ${row.branch}` : ""}`}
          </span>
          {/* A run writes in its thread's tree, so its own diff is always
              zero — a "+0 −0 · 0 files" on every playbook row is noise, not
              evidence. */}
          {!playbook && (
            <span className="fleet-diff" data-testid="fleet-diff">
              <span className="added">+{row.diff.added}</span>{" "}
              <span className="removed">−{row.diff.removed}</span> ·{" "}
              {row.diff.files} files
              {/* New files carry no line counts, so they are said, not
                  silently folded into a number that can't hold them. */}
              {(row.diff.untracked ?? 0) > 0 && ` · ${row.diff.untracked} new`}
            </span>
          )}
          <span>{relativeTime(row.updatedAt)}</span>
        </div>
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
          {row.status === "running" && (
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

export default function FleetBoard({
  rows,
  loading,
  error,
  projectName,
  projectHash,
  agents,
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
}: FleetBoardProps) {
  const installed = agents.filter((a) => a.installed);
  const [prompt, setPrompt] = useState("");
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
          // `current` is the agent's own default. Showing it prevents the
          // composer from looking unset while still honoring the agent.
          setModelId(state.current && state.models.some((model) => model.id === state.current) ? state.current : null);
        }
      })
      .catch(() => live && setModels([]))
      .finally(() => live && setModelsLoading(false));
    return () => {
      live = false;
    };
  }, [projectHash, agentId]);

  const groups = groupFleet(rows);
  const bands: { key: string; label: string; list: FleetRow[] }[] = [
    { key: "attention", label: "Needs attention", list: groups.attention },
    { key: "running", label: "Running", list: groups.running },
    { key: "idle", label: "Idle", list: groups.idle },
  ];

  const canStart = prompt.trim().length > 0 && installed.length > 0;

  return (
    <section className="fleet-board" aria-label="Fleet" data-testid="fleet-board">
      <div className="fleet-header">
        <Text size="sm" fw={600} className="fleet-header-project">
          {projectName ?? "Fleet"}
        </Text>
        <Text size="xs" c="dimmed" data-testid="fleet-counts">
          {groups.attention.length} need attention · {groups.running.length}{" "}
          running · {groups.idle.length} idle
        </Text>
      </div>

      <div className="fleet-composer">
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          placeholder="What should the agent do?"
          aria-label="New run prompt"
          rows={2}
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
          <Switch
            checked={isolated}
            onChange={(e) => setIsolated(e.currentTarget.checked)}
            label="Isolated worktree"
            data-testid="fleet-isolated"
          />
          <Button
            disabled={!canStart}
            data-testid="fleet-start"
            onClick={() => {
              onNewRun({
                prompt: prompt.trim(),
                agentId: agentId ?? undefined,
                model: modelId ?? undefined,
                mode,
                isolated,
              });
              setPrompt("");
            }}
          >
            Start run
          </Button>
        </div>
      </div>

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
