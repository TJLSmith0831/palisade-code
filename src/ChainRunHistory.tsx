import { useEffect, useState } from "react";
import { ActionIcon, Menu, Stack, Text } from "@mantine/core";
import { IconDots, IconExternalLink, IconRefresh } from "@tabler/icons-react";
import * as api from "./api";
import { CHAINS_CHANGED_EVENT } from "./ChainsPanel";

// Durable run history for one chain, rendered inline inside the Chains side
// panel (DESIGN.md's side-panel rule: this finds and opens a past run, it
// never edits one — editing a run's definition happens on the canvas via
// Re-run/Re-run from here, which only ever replay the run's own snapshot).

type Props = {
  projectHash: string;
  chainName: string;
  /** Opens a past run on the canvas in Review mode. */
  onOpenRun?: (runId: string) => void;
  /** Re-runs a past record; fromRole starts from that node's recorded inputs. */
  onRerun?: (runId: string, fromRole?: string) => void;
};

export default function ChainRunHistory({ projectHash, chainName, onOpenRun, onRerun }: Props) {
  const [runs, setRuns] = useState<api.ChainRunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRuns(null);
    setError(null);
    const load = () =>
      api
        .listChainRuns(projectHash, chainName)
        .then((next) => {
          if (live) setRuns(next);
        })
        .catch((err) => {
          if (live) setError(String(err));
        });
    void load();
    window.addEventListener(CHAINS_CHANGED_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(CHAINS_CHANGED_EVENT, load);
    };
  }, [projectHash, chainName]);

  if (error) {
    return (
      <Text size="xs" c="danger" p="xs" data-testid="chain-run-history-error">
        {error}
      </Text>
    );
  }

  if (runs === null) {
    return (
      <Text size="xs" c="dimmed" p="xs" data-testid="chain-run-history-loading">
        Loading run history…
      </Text>
    );
  }

  if (runs.length === 0) {
    return (
      <Text size="xs" c="dimmed" p="xs" data-testid="chain-run-history-empty">
        No runs yet for this chain.
      </Text>
    );
  }

  const sorted = [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  return (
    <Stack gap="xs" p="xs" data-testid="chain-run-history">
      {sorted.map((run) => (
        <RunRow key={run.id} run={run} onOpenRun={onOpenRun} onRerun={onRerun} />
      ))}
    </Stack>
  );
}

type OutcomeTone = "success" | "danger" | "warn" | "neutral";

/** Every terminal state names a reason (D18) — never a plain "done" badge. */
function outcomeLabel(run: api.ChainRunRecord): { text: string; tone: OutcomeTone } {
  const outcome = run.outcome;
  if (!outcome) {
    return run.endedAt
      ? { text: "Ended (no recorded outcome)", tone: "neutral" }
      : { text: "Running", tone: "neutral" };
  }
  switch (outcome.kind) {
    case "interrupted":
      return { text: "Interrupted — the app restarted mid-run.", tone: "warn" };
    case "completed":
      return { text: "Completed", tone: "success" };
    case "rejected":
      return { text: `Rejected at ${outcome.at}.`, tone: "danger" };
    case "gateFailed":
      return { text: `Gate failed after ${outcome.at}: \`${outcome.command}\` did not pass.`, tone: "danger" };
    case "capReached":
      return { text: `Cap reached: ${outcome.at} hit its cap of ${outcome.maxIterations} iterations.`, tone: "warn" };
    case "timedOut":
      return { text: `Timed out at ${outcome.at} after ${outcome.afterSeconds}s.`, tone: "danger" };
    case "retriesExhausted":
      return { text: `Retries exhausted at ${outcome.at} after ${outcome.attempts} attempts: ${outcome.message}`, tone: "danger" };
    case "cancelled":
      return { text: `Cancelled${outcome.at.length ? `: ${outcome.at.join(", ")}` : "."}`, tone: "neutral" };
    case "blocked":
      return { text: `Blocked: ${outcome.reason}`, tone: "warn" };
  }
}

/** Duration between a node's first and last recorded transition. */
function nodeTiming(history: api.ChainRunNodeHistory): string {
  const first = history.transitions[0];
  const last = history.transitions[history.transitions.length - 1];
  if (!first || !last) return "no activity recorded";
  const seconds = Math.max(0, (new Date(last.at).getTime() - new Date(first.at).getTime()) / 1000);
  return `${last.state.kind} · ${seconds.toFixed(1)}s`;
}

function RunRow({
  run,
  onOpenRun,
  onRerun,
}: {
  run: api.ChainRunRecord;
  onOpenRun?: (runId: string) => void;
  onRerun?: (runId: string, fromRole?: string) => void;
}) {
  const outcome = outcomeLabel(run);
  const roles = Object.keys(run.chainSnapshot.nodes);
  // Cost is per node, from the record's own history — never summed as a
  // run total, since an agent that doesn't report cost must not be coerced
  // into a silent 0.00 (D-d).
  const costed = roles
    .map((role) => ({ role, cost: run.nodes[role]?.cost ?? null }))
    .filter((entry): entry is { role: string; cost: { amount: number; currency: string } } => entry.cost !== null);

  return (
    <div className="ds-chain-row" data-testid={`chain-run-row-${run.id}`}>
      <div className="ds-chain-row-main">
        <span className="ds-chain-row-name">{new Date(run.startedAt).toLocaleString()}</span>
        <Text size="xs" data-outcome-tone={outcome.tone} c={outcome.tone}>
          {outcome.text}
        </Text>
      </div>

      <Stack gap={2}>
        {roles.map((role) => {
          const history = run.nodes[role];
          return (
            <Text key={role} size="xs" c="dimmed" className="ds-chain-node-meta">
              {role}: {history ? nodeTiming(history) : "no activity recorded"}
            </Text>
          );
        })}
      </Stack>

      {costed.length > 0 && (
        <Text size="xs" className="ds-chain-cost">
          Partial reported run cost ({costed.map((c) => c.role).join(", ")}):{" "}
          {costed.map((c) => `${c.cost.amount.toFixed(2)} ${c.cost.currency}`).join("; ")}
        </Text>
      )}

      <ActionIcon
        size="sm"
        variant="subtle"
        color="gray"
        aria-label={`Open run from ${run.startedAt}`}
        onClick={() => onOpenRun?.(run.id)}
      >
        <IconExternalLink size={14} />
      </ActionIcon>

      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label={`Actions for run from ${run.startedAt}`}
          >
            <IconDots size={14} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconRefresh size={14} />} onClick={() => onRerun?.(run.id, undefined)}>
            Re-run
          </Menu.Item>
          {roles.map((role) => (
            <Menu.Item key={role} onClick={() => onRerun?.(run.id, role)}>
              Re-run from {role}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
