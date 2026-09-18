import { useState } from "react";
import {
  Badge,
  Button,
  Menu,
  Select,
  SegmentedControl,
  Switch,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { IconBox, IconDots } from "@tabler/icons-react";
import type { FleetRow, FleetAttention, FleetVerify } from "./api";
import { relativeTime } from "./SessionList";

export type NewRunInput = {
  prompt: string;
  agentId?: string;
  mode: "spec" | "go";
  isolated: boolean;
};

export type FleetBoardProps = {
  rows: FleetRow[];
  loading: boolean;
  error?: string;
  agents: { id: string; name: string; installed: boolean }[];
  onOpen(threadId: string): void;
  onReview(threadId: string): void;
  onStop(threadId: string): void;
  onMerge(threadId: string): void;
  onOpenPr(threadId: string): void;
  onArchive(threadId: string): void;
  onNewRun(input: NewRunInput): void;
};

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

const ATTENTION_LABEL: Record<FleetAttention, string> = {
  permission: "Needs permission",
  turn_done: "Turn finished",
  verify_failed: "Verify failed",
  merge_conflict: "Merge conflict",
  crashed: "Crashed",
};

/** Evidence, not opinion: a pass names the commit it was measured at, and
 *  "Not verified" is the honest default rather than a neutral blank. */
function verifyBadge(verify: FleetVerify) {
  if (verify.state === "pass") {
    return {
      label: `Verified at ${(verify.commit ?? "").slice(0, 7)}`,
      color: "success",
      tip: verify.command ?? "Verified",
    };
  }
  if (verify.state === "fail") {
    return {
      label: "Verify failed",
      color: "danger",
      tip: verify.command ?? "The verify command exited non-zero",
    };
  }
  return {
    label: "Not verified",
    color: "neutral",
    tip: "No verify command has run at this commit",
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
}: { row: FleetRow } & Pick<
  FleetBoardProps,
  "onOpen" | "onReview" | "onStop" | "onMerge" | "onOpenPr" | "onArchive"
>) {
  const verify = verifyBadge(row.verify);
  const mergeable = row.merge === "clean" && row.verify.state === "pass";
  const overlaps = row.overlap.length;

  return (
    <div
      className="fleet-row"
      role="button"
      tabIndex={0}
      data-testid="fleet-row"
      data-thread={row.threadId}
      onClick={() => onOpen(row.threadId)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen(row.threadId);
        } else if (e.key === "r" || e.key === "R") {
          e.preventDefault();
          onReview(row.threadId);
        }
      }}
    >
      <Tooltip label={row.agentName ?? row.agentId ?? "No agent"} openDelay={400}>
        <span className="fleet-agent" data-testid="fleet-agent">
          <IconBox size={14} aria-label={row.agentName ?? "Agent"} />
        </span>
      </Tooltip>

      <div className="fleet-row-main">
        <div className="fleet-row-title">{row.title}</div>
        <div className="fleet-row-meta">
          <span>
            {row.projectName}
            {row.branch ? ` · ${row.branch}` : ""}
          </span>
          <span className="fleet-diff" data-testid="fleet-diff">
            <span className="added">+{row.diff.added}</span>{" "}
            <span className="removed">−{row.diff.removed}</span> ·{" "}
            {row.diff.files} files
          </span>
          <span>{relativeTime(row.updatedAt)}</span>
        </div>
      </div>

      <div className="fleet-row-badges">
        {row.attention && (
          <Badge
            size="xs"
            radius="sm"
            variant="light"
            color="warn"
            data-testid="fleet-attention"
          >
            {ATTENTION_LABEL[row.attention]}
          </Badge>
        )}
        <Tooltip label={verify.tip} openDelay={400}>
          <Badge
            size="xs"
            radius="sm"
            variant="light"
            color={verify.color}
            data-testid="fleet-verify"
          >
            {verify.label}
          </Badge>
        </Tooltip>
        {overlaps > 0 && (
          <Tooltip
            label={row.overlap.flatMap((o) => o.files).join(", ")}
            openDelay={400}
          >
            <Badge
              size="xs"
              radius="sm"
              variant="light"
              color="neutral"
              data-testid="fleet-overlap"
            >
              {`Overlaps ${overlaps} thread${overlaps === 1 ? "" : "s"}`}
            </Badge>
          </Tooltip>
        )}
      </div>

      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <button
            className="ds-icon-btn"
            aria-label={`Actions for ${row.title}`}
            data-testid="fleet-actions"
            onClick={(e) => e.stopPropagation()}
          >
            <IconDots size={14} />
          </button>
        </Menu.Target>
        <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
          <Menu.Item onClick={() => onOpen(row.threadId)}>Open</Menu.Item>
          <Menu.Item onClick={() => onReview(row.threadId)}>Review</Menu.Item>
          {row.status === "running" && (
            <Menu.Item onClick={() => onStop(row.threadId)}>Stop</Menu.Item>
          )}
          {mergeable ? (
            <Menu.Item onClick={() => onMerge(row.threadId)}>Merge</Menu.Item>
          ) : (
            <Tooltip label="Merge needs a passing verify">
              <div>
                <Menu.Item disabled data-testid="fleet-merge-disabled">
                  Merge
                </Menu.Item>
              </div>
            </Tooltip>
          )}
          <Menu.Item onClick={() => onOpenPr(row.threadId)}>Open PR</Menu.Item>
          <Menu.Item onClick={() => onArchive(row.threadId)}>Archive</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}

export default function FleetBoard({
  rows,
  loading,
  error,
  agents,
  onOpen,
  onReview,
  onStop,
  onMerge,
  onOpenPr,
  onArchive,
  onNewRun,
}: FleetBoardProps) {
  const installed = agents.filter((a) => a.installed);
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState<string | null>(installed[0]?.id ?? null);
  const [mode, setMode] = useState<"spec" | "go">("spec");
  const [isolated, setIsolated] = useState(true);

  const groups = groupFleet(rows);
  const bands: { key: string; label: string; list: FleetRow[] }[] = [
    { key: "attention", label: "Needs attention", list: groups.attention },
    { key: "running", label: "Running", list: groups.running },
    { key: "idle", label: "Idle", list: groups.idle },
  ];

  const canStart = prompt.trim().length > 0 && installed.length > 0;

  return (
    <section className="fleet-board" aria-label="Fleet" data-testid="fleet-board">
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
          <SegmentedControl
            value={mode}
            onChange={(value) => setMode(value as "spec" | "go")}
            data={[
              { value: "spec", label: "Spec" },
              { value: "go", label: "Go" },
            ]}
            aria-label="Mode"
            data-testid="fleet-mode"
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
                />
              ))}
            </div>
          )
      )}
    </section>
  );
}
